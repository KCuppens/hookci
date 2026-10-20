import { HubError } from "../errors";

const JOB_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Throws bad_job_name (400) unless job matches `^[A-Za-z0-9._-]{1,64}$` and is not `.` or `..`. */
export function checkJobName(job: string): void {
	if (!JOB_NAME.test(job) || job === "." || job === "..") throw new HubError("bad_job_name", 400, `job name ${JSON.stringify(job.slice(0, 80))}`);
}

/** The R2 key of one job's gzipped log; the job name is checked with checkJobName. */
export function logKey(installationId: number, runId: string, job: string): string {
	checkJobName(job);
	return `logs/${installationId}/${runId}/${job}.log.gz`;
}
