// The GitHub Checks sink: one aggregate `zeroci` check run per commit plus a
// `zeroci/<job>` check run per job, with the job's annotations. In the AgentDO
// in-progress updates are coalesced (see checks/coalesce); in the Worker every
// update goes out at once.

import { type CheckUpdate, CheckUpdateCoalescer } from "../checks/coalesce";
import { aggregateFor, type CheckView, CONFIG_JOB, chunkAnnotations, configCheck, jobCheck, toGithubAnnotation } from "../checks/map";
import { getCheckRun, putCheckRun } from "../db/check-runs";
import { tenantDb } from "../db/tenant";
import { registerAlarmTask } from "../do/agent-hooks";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { onCheckConcluded } from "../deploy/chain";
import { HubError } from "../errors";
import { createCheckRun, updateCheckRun } from "../github/api";
import { GitHubApiError, GitHubClient, type GitHubRequester } from "../github/client";
import type { CheckRunConclusion, UpdateCheckRunBody } from "../github/types";
import { defaultFetcher } from "../http";
import { logEvent, reportError } from "../observability";
import { QUOTAS } from "../quotas";
import { S } from "../strings";
import { registerSinkFactory, type SinkHost } from "./index";
import { logJob } from "./runview";
import type { AgentView, Annotation, JobView, RunView, Sink } from "./types";

export const AGGREGATE_CHECK = "zeroci";
export const CONFIG_CHECK = "zeroci/config";

/**
 * The tail of the work each AgentDO is doing on one commit's checks. Calls
 * on a commit run one after another, so two of them never both find a check
 * run missing and create it twice. Keyed by the DO's storage because promises
 * must not cross Durable Objects.
 */
const commitQueues = new WeakMap<DurableObjectStorage, Map<string, Promise<void>>>();

export class ChecksSink implements Sink {
	readonly name = "checks";
	private readonly coalescer?: CheckUpdateCoalescer;

	constructor(
		private readonly env: Env,
		private readonly gh: GitHubClient,
		private readonly now: () => number,
		private readonly host?: SinkHost,
	) {
		if (host) this.coalescer = new CheckUpdateCoalescer(host, (u) => this.send(u));
	}

	async onRunUpdate(run: RunView): Promise<void> {
		if (!usesChecks(run)) return;
		const view = aggregateFor(run, this.env.HUB_ORIGIN);
		await this.inOrder(run.repoId, run.sha, () => this.push(run, AGGREGATE_CHECK, this.body(run, view, logJob(run)?.logLink)));
		if (view.status === "completed") await this.chainDeploys(run, view.conclusion);
	}

	/** Starts the push-to-deploy chain; its errors are logged and never touch the check. */
	private async chainDeploys(run: RunView, conclusion: CheckRunConclusion): Promise<void> {
		try {
			const sent = await onCheckConcluded(this.env, {
				installationId: run.installationId,
				repo: run.repo,
				sha: run.sha,
				ref: run.ref ?? "",
				event: run.event,
				conclusion,
			});
			if (sent > 0) logEvent("deploy_chain_dispatched", { installation_id: run.installationId, repo: run.repo, sha: run.sha, sent });
		} catch (err) {
			reportError(err, { installation_id: run.installationId, repo: run.repo, sha: run.sha, op: "deploy_chain" });
		}
	}

	/** Creates the aggregate and every job's check run that does not exist yet; updates none. */
	async onJobPlanned(run: RunView): Promise<void> {
		if (!usesChecks(run)) return;
		await this.inOrder(run.repoId, run.sha, async () => {
			await this.createMissing(run, AGGREGATE_CHECK, this.body(run, aggregateFor(run, this.env.HUB_ORIGIN), logJob(run)?.logLink));
			for (const job of run.jobs) await this.createMissing(run, checkName(job.name), this.jobBody(run, job));
		});
	}

	async onJobUpdate(run: RunView, job: JobView): Promise<void> {
		if (!usesChecks(run)) return;
		await this.inOrder(run.repoId, run.sha, () => this.push(run, checkName(job.name), this.jobBody(run, job)));
	}

	/**
	 * Sends the annotations 50 per update, each carrying the check's current
	 * title and summary, up to QUOTAS.annotationsPerJob per check run (per
	 * call in the Worker, which keeps no count).
	 */
	async onAnnotations(run: RunView, jobName: string, annotations: Annotation[]): Promise<void> {
		if (!usesChecks(run) || annotations.length === 0) return;
		const name = checkName(jobName);
		await this.inOrder(run.repoId, run.sha, async () => {
			const granted = this.coalescer
				? this.coalescer.reserveAnnotations(this.target(run, name), annotations.length, QUOTAS.annotationsPerJob)
				: Math.min(annotations.length, QUOTAS.annotationsPerJob);
			const job = run.jobs.find((j) => j.name === jobName) ?? { name: jobName, state: run.state };
			const body = this.jobBody(run, job, granted < annotations.length);
			for (const chunk of chunkAnnotations(annotations.slice(0, granted).map(toGithubAnnotation))) {
				await this.send({ ...this.target(run, name), body: { ...body, output: body.output && { ...body.output, annotations: chunk } } });
			}
		});
	}

	/** The aggregate check already says agent_offline through onRunUpdate. */
	async onAgentOffline(_agent: AgentView, _affected: RunView[]): Promise<void> {}

	/** Alarm task: sends the coalesced updates that are due; resolves true while some wait. */
	async flush(): Promise<boolean> {
		if (!this.host) return false;
		return new CheckUpdateCoalescer(this.host, (u) => this.inOrder(u.repoId, u.headSha, () => this.send(u))).flushDue();
	}

	private async push(run: RunView, name: string, body: UpdateCheckRunBody): Promise<void> {
		const update = { ...this.target(run, name), body };
		await (this.coalescer ? this.coalescer.push(update) : this.send(update));
	}

	private async createMissing(run: RunView, name: string, body: UpdateCheckRunBody): Promise<void> {
		const t = tenantDb(this.env.DB, run.installationId);
		if ((await getCheckRun(t, run.repoId, run.sha, name)) !== null) return;
		const [owner, repo] = ownerAndRepo(run.repo);
		const inst = await this.gh.installation(run.installationId, { repositoryIds: [run.repoId], permissions: { checks: "write" } });
		await this.create(inst, owner, repo, { ...this.target(run, name), body });
	}

	/**
	 * Updates the stored check run, creating it when there is none, when GitHub
	 * no longer has it (404), or when GitHub refuses to reopen it (422).
	 */
	private async send(u: CheckUpdate): Promise<void> {
		const [owner, repo] = ownerAndRepo(u.repo);
		const id = await getCheckRun(tenantDb(this.env.DB, u.installationId), u.repoId, u.headSha, u.name);
		const inst = await this.gh.installation(u.installationId, { repositoryIds: [u.repoId], permissions: { checks: "write" } });
		if (id === null) return this.create(inst, owner, repo, u);
		try {
			await updateCheckRun(inst, owner, repo, id, u.body);
		} catch (err) {
			const gone = err instanceof GitHubApiError && (err.githubStatus === 404 || (err.githubStatus === 422 && u.body.status !== "completed"));
			if (!gone) throw err;
			await this.create(inst, owner, repo, u);
		}
	}

	private async create(inst: GitHubRequester, owner: string, repo: string, u: CheckUpdate): Promise<void> {
		const created = await createCheckRun(inst, owner, repo, { ...u.body, name: u.name, head_sha: u.headSha });
		await putCheckRun(tenantDb(this.env.DB, u.installationId), { repo_id: u.repoId, head_sha: u.headSha, name: u.name, check_run_id: created.id });
	}

	private target(run: RunView, name: string): Omit<CheckUpdate, "body"> {
		return { installationId: run.installationId, repoId: run.repoId, repo: run.repo, headSha: run.sha, name };
	}

	private jobBody(run: RunView, job: JobView, truncated = false): UpdateCheckRunBody {
		const view = job.name === CONFIG_JOB ? configCheck(job) : jobCheck(job);
		const over = truncated || (this.coalescer?.annotationsSeen(this.target(run, checkName(job.name))) ?? 0) > QUOTAS.annotationsPerJob;
		return this.body(run, over ? { ...view, summary: `${view.summary}\n\n${S.checks.annotationsTruncated(QUOTAS.annotationsPerJob)}` } : view, job.logLink);
	}

	/** detailsUrl: the stable log link the check's Details opens. */
	private body(run: RunView, view: CheckView, detailsUrl: string | undefined): UpdateCheckRunBody {
		return {
			status: view.status,
			...(view.status === "completed" ? { conclusion: view.conclusion, completed_at: new Date(this.now()).toISOString() } : {}),
			external_id: run.runId ?? run.triggerId,
			...(detailsUrl ? { details_url: detailsUrl } : {}),
			output: { title: view.title, summary: view.summary },
			actions: view.actions ?? [],
		};
	}

	private async inOrder(repoId: number, sha: string, fn: () => Promise<void>): Promise<void> {
		if (!this.host) return fn();
		let queues = commitQueues.get(this.host.storage);
		if (!queues) commitQueues.set(this.host.storage, (queues = new Map()));
		const key = `${repoId}:${sha}`;
		const call = (queues.get(key) ?? Promise.resolve()).then(fn);
		const tail = call.catch(() => {});
		queues.set(key, tail);
		await tail.then(() => {
			if (queues.get(key) === tail) queues.delete(key);
		});
		return call;
	}
}

/** Checks runs only: deploys get no check runs, and a suspended installation has no token to write them with. */
function usesChecks(run: RunView): boolean {
	return run.target === "checks" && run.reason !== "suspended";
}

function checkName(job: string): string {
	return job === CONFIG_JOB ? CONFIG_CHECK : `${AGGREGATE_CHECK}/${job}`;
}

function ownerAndRepo(fullName: string): [string, string] {
	const slash = fullName.indexOf("/");
	if (slash <= 0) throw new HubError("bad_repo_name", 500, `repo name ${JSON.stringify(fullName)} is not owner/name`);
	return [fullName.slice(0, slash), fullName.slice(slash + 1)];
}

export function checksSinkFactory(env: Env, _installationId: number, host?: SinkHost): ChecksSink {
	const now = host ? () => host.now() : () => (env.__TEST_CLOCK ?? systemClock).now();
	return new ChecksSink(env, new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, now), now, host);
}

registerSinkFactory("checks", checksSinkFactory);
registerAlarmTask((dob) => checksSinkFactory(dob.bindings, dob.installationId, { storage: dob.state.storage, now: () => dob.clock.now() }).flush());
