// The hub end of one paired agent's WebSocket. Holds the socket with the
// hibernation API, negotiates the protocol, keeps the hub to agent outbox and
// the inbound high-water marks in the DO's SQLite, and detects the agent going
// offline with the single alarm.

import { DurableObject } from "cloudflare:workers";
import { createCheckStateTable } from "../checks/coalesce";
import { markAgentOffline, touchAgent } from "../db/agents";
import { type TenantDb, tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { reportError } from "../observability";
import {
	type Frame,
	type Interrupt,
	type LogSubscribe,
	ProtocolError,
	type ProtocolErrorFrame,
	type Token,
	type Trigger,
	encodeFrame,
	parseFrame,
} from "../protocol";
import { S } from "../strings";
import { frameHandler, isAgentFrame } from "./agent-frames";
import { clearOfflineDm, registeredAlarmTasks, registeredOfflineHooks } from "./agent-hooks";
import {
	ALARM_INTERVAL_MS,
	CLOSE,
	MAX_BAD_FRAMES_PER_MINUTE,
	MAX_FRAME_BYTES,
	MAX_FRAMES_PER_SECOND,
	OFFLINE_AFTER_MS,
	PING,
	PONG,
	PROTOCOL_MAX,
	PROTOCOL_MIN,
	SEEN_WRITE_INTERVAL_MS,
	negotiate,
} from "./agent-protocol";
import { createTriggersTable, registerRunLifecycle } from "./agent-runs";
import { doRoute } from "./agent-routes";
import { type Clock, systemClock } from "./clock";
import { agentVersions } from "../version";

type Unsequenced<F> = F & { seq?: never };
/** A hub to agent frame for send(), which assigns seq (and hub_seq on a trigger). */
export type OutboundFrame =
	| Omit<Trigger, "seq" | "hub_seq">
	| Unsequenced<Interrupt>
	| Unsequenced<Token>
	| Unsequenced<LogSubscribe>
	| Unsequenced<ProtocolErrorFrame>;

export interface AgentStatus {
	online: boolean;
	last_seen_at: number | null;
	protocol: number | null;
	agent_version: string | null;
	outbox_depth: number;
}

// The schema version is kept in meta: DO SQLite refuses PRAGMA user_version.
const SCHEMA_VERSION = "schema_version";
// Step i moves the DO schema from version i to i + 1. Append, never edit.
const MIGRATIONS: ((sql: SqlStorage) => void)[] = [
	(sql) => {
		sql.exec(
			"CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, frame TEXT NOT NULL, created_at INTEGER NOT NULL)",
		);
		sql.exec("CREATE TABLE hwm (direction TEXT PRIMARY KEY CHECK (direction IN ('in', 'out')), seq INTEGER NOT NULL)");
	},
	createTriggersTable,
	createCheckStateTable,
];

registerRunLifecycle();

type MetaKey =
	| typeof SCHEMA_VERSION
	| "agent_id"
	| "installation_id"
	| "protocol"
	| "agent_version"
	| "connected_at"
	| "last_seen_at"
	| "last_d1_seen_write";

interface RateWindow {
	start: number;
	count: number;
}

// Per-socket state, kept in the socket's attachment so it survives hibernation.
interface SocketState {
	hello: boolean;
	lastMessageAt: number;
	frames: RateWindow;
	badFrames: RateWindow;
}

function socketState(ws: WebSocket): SocketState {
	// Only connect() attaches to these sockets, always a SocketState.
	return ws.deserializeAttachment() as SocketState;
}

/** Counts one event in w's fixed window of windowMs; false once the count passes limit. */
function countInWindow(w: RateWindow, now: number, windowMs: number, limit: number): boolean {
	if (now - w.start >= windowMs) {
		w.start = now;
		w.count = 0;
	}
	w.count += 1;
	return w.count <= limit;
}

// UTF-8 needs at least one byte per UTF-16 unit and at most three, so only
// strings in between need encoding to measure.
function tooLarge(text: string): boolean {
	if (text.length > MAX_FRAME_BYTES) return true;
	return text.length * 3 > MAX_FRAME_BYTES && new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES;
}

function decode(message: string | ArrayBuffer): Frame | ProtocolError {
	if (typeof message !== "string") return new ProtocolError("bad_frame", S.agentFrameNotText);
	if (tooLarge(message)) return new ProtocolError("bad_frame", S.agentFrameTooLarge);
	try {
		return parseFrame(message);
	} catch (err) {
		if (err instanceof ProtocolError) return err;
		throw err;
	}
}

function isSeq(value: unknown, min: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function sendError(ws: WebSocket, code: ProtocolErrorFrame["code"], message: string): void {
	ws.send(encodeFrame({ v: 1, type: "error", code, message }));
}

/** One per paired agent, named by agent_id (`AGENT_DO.idFromName(agentId)`). */
export class AgentDO extends DurableObject<Env> {
	readonly sql: SqlStorage;
	// Inbound messages are handled one at a time, in arrival order, so seq
	// dedupe and frame handlers never interleave across awaits.
	private inbox: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		void ctx.blockConcurrencyWhile(async () => this.migrate());
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

	get clock(): Clock {
		return this.env.__TEST_CLOCK ?? systemClock;
	}

	/** The DO state, for waitUntil and alarms. */
	get state(): DurableObjectState {
		return this.ctx;
	}

	get bindings(): Env {
		return this.env;
	}

	get agentId(): string {
		return this.meta("agent_id") ?? "";
	}

	get installationId(): number {
		return Number(this.meta("installation_id"));
	}

	tenant(): TenantDb {
		return tenantDb(this.env.DB, this.installationId);
	}

	/**
	 * Binds a DO that has not seen its agent yet to agentId; afterwards true
	 * only for the same agent and installation.
	 */
	adopt(agentId: string, installationId: number): boolean {
		const known = this.meta("agent_id");
		if (known === null) {
			this.setMeta("agent_id", agentId);
			this.setMeta("installation_id", String(installationId));
			return true;
		}
		return known === agentId && this.installationId === installationId;
	}

	private migrate(): void {
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			const version = Number(this.meta(SCHEMA_VERSION) ?? 0);
			for (const step of MIGRATIONS.slice(version)) step(this.sql);
			this.setMeta(SCHEMA_VERSION, String(MIGRATIONS.length));
		});
	}

	private meta(key: MetaKey): string | null {
		return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
	}

	private setMeta(key: MetaKey, value: string): void {
		this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
	}

	private hwm(direction: "in" | "out"): number {
		return this.sql.exec<{ seq: number }>("SELECT seq FROM hwm WHERE direction = ?", direction).toArray()[0]?.seq ?? 0;
	}

	private setHwm(direction: "in" | "out", seq: number): void {
		this.sql.exec("INSERT INTO hwm (direction, seq) VALUES (?, ?) ON CONFLICT (direction) DO UPDATE SET seq = excluded.seq", direction, seq);
	}

	/** The open socket that completed hello, if any. */
	private liveSocket(): WebSocket | undefined {
		return this.ctx.getWebSockets().find((ws) => ws.readyState === WebSocket.OPEN && socketState(ws).hello);
	}

	isOnline(): boolean {
		return this.liveSocket() !== undefined;
	}

	/** Appends frame to the outbox with the next seq, sends it if the agent is connected, and returns the seq. */
	async send(frame: OutboundFrame): Promise<number> {
		const text = this.ctx.storage.transactionSync(() => {
			const seq = this.sql
				.exec<{ seq: number }>("INSERT INTO outbox (type, frame, created_at) VALUES (?, '', ?) RETURNING seq", frame.type, this.clock.now())
				.one().seq;
			const stamped = encodeFrame(frame.type === "trigger" ? { ...frame, seq, hub_seq: seq } : { ...frame, seq });
			this.sql.exec("UPDATE outbox SET frame = ? WHERE seq = ?", stamped, seq);
			return { seq, stamped };
		});
		this.liveSocket()?.send(text.stamped);
		return text.seq;
	}

	/** Closes every open socket with code, first sending error to each when given. */
	disconnect(code: number, reason: string, error?: Unsequenced<ProtocolErrorFrame>): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			if (error) ws.send(encodeFrame(error));
			ws.close(code, reason);
		}
	}

	status(): AgentStatus {
		const live = this.liveSocket();
		const lastSeen = this.meta("last_seen_at");
		const protocol = this.meta("protocol");
		return {
			online: live !== undefined,
			last_seen_at: live ? this.lastActivity(live) : lastSeen === null ? null : Number(lastSeen),
			protocol: protocol === null ? null : Number(protocol),
			agent_version: this.meta("agent_version"),
			outbox_depth: this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM outbox").one().n,
		};
	}

	override async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/connect") return this.acceptSocket(request);
		if (request.method === "GET" && path === "/status") return Response.json(this.status());
		const route = request.method === "POST" ? doRoute(path.slice(1)) : undefined;
		if (route) return route(this, request);
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	private async acceptSocket(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return Response.json({ error: "upgrade_required" }, { status: 426 });
		}
		const agentId = request.headers.get("x-zeroci-agent-id");
		const installationId = request.headers.get("x-zeroci-installation-id");
		if (!agentId || !installationId) return Response.json({ error: "bad_request" }, { status: 400 });

		for (const old of this.ctx.getWebSockets()) {
			if (old.readyState === WebSocket.OPEN) old.close(CLOSE.replaced, "replaced");
		}
		const now = this.clock.now();
		this.setMeta("agent_id", agentId);
		this.setMeta("installation_id", installationId);
		this.setMeta("connected_at", String(now));

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [agentId]);
		server.serializeAttachment({
			hello: false,
			lastMessageAt: now,
			frames: { start: now, count: 0 },
			badFrames: { start: now, count: 0 },
		} satisfies SocketState);
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
		return new Response(null, { status: 101, webSocket: client });
	}

	override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
		// Activity and the frame rate count on arrival, so a slow handler
		// neither hides a flood nor ages the connection.
		const now = this.clock.now();
		const state = socketState(ws);
		state.lastMessageAt = now;
		const allowed = countInWindow(state.frames, now, 1000, MAX_FRAMES_PER_SECOND);
		ws.serializeAttachment(state);
		if (!allowed) {
			sendError(ws, "rate_limited", S.agentRateLimited);
			ws.close(CLOSE.rateLimited, "rate_limited");
			return Promise.resolve();
		}
		const handled = this.inbox.then(() => this.onMessage(ws, message, now));
		// A failure surfaces through handled; the queue itself must keep going.
		this.inbox = handled.catch(() => undefined);
		return handled;
	}

	private async onMessage(ws: WebSocket, message: string | ArrayBuffer, now: number): Promise<void> {
		if (ws.readyState !== WebSocket.OPEN) return;
		const state = socketState(ws);
		const frame = decode(message);
		if (!state.hello) {
			await this.onHello(ws, state, frame, now);
			return;
		}
		if (frame instanceof ProtocolError) {
			this.badFrame(ws, state, frame.message, now);
			return;
		}
		ws.serializeAttachment(state);

		if (frame.type === "ack") {
			if (!isSeq(frame.upto, 0)) {
				this.badFrame(ws, state, S.agentFrameLacksSeq("ack"), now);
				return;
			}
			this.sql.exec("DELETE FROM outbox WHERE seq <= ?", frame.upto);
			this.setHwm("out", Math.max(this.hwm("out"), frame.upto));
		} else if (frame.type === "hello") {
			this.badFrame(ws, state, S.agentHelloRepeated, now);
			return;
		} else if (!isAgentFrame(frame)) {
			this.badFrame(ws, state, S.agentFrameNotFromAgent(frame.type), now);
			return;
		} else if (!isSeq(frame.seq, 1)) {
			this.badFrame(ws, state, S.agentFrameLacksSeq(frame.type), now);
			return;
		} else {
			const done = this.hwm("in");
			if (frame.seq <= done) {
				ws.send(encodeFrame({ v: 1, type: "ack", upto: done }));
			} else {
				const handler = frameHandler(frame.type);
				if (handler) {
					try {
						await handler(this, frame);
					} catch (err) {
						reportError(err, { agent_id: this.agentId, installation_id: this.installationId, frame_type: frame.type, seq: frame.seq });
					}
				}
				this.setHwm("in", frame.seq);
				ws.send(encodeFrame({ v: 1, type: "ack", upto: frame.seq }));
			}
		}
		await this.writeSeen(now, false);
	}

	private async onHello(ws: WebSocket, state: SocketState, frame: Frame | ProtocolError, now: number): Promise<void> {
		if (frame instanceof ProtocolError || frame.type !== "hello") {
			sendError(ws, "bad_frame", frame instanceof ProtocolError ? frame.message : S.agentHelloFirst);
			ws.close(CLOSE.badFrame, "bad_frame");
			return;
		}
		const negotiated = negotiate(frame);
		if (!negotiated.ok) {
			ws.send(encodeFrame(negotiated.error));
			ws.close(CLOSE.badFrame, "protocol_unsupported");
			return;
		}
		const inbound = frame.inbound_hwm ?? 0;
		if (typeof frame.agent_version !== "string" || !isSeq(inbound, 0)) {
			sendError(ws, "bad_frame", S.agentHelloFirst);
			ws.close(CLOSE.badFrame, "bad_frame");
			return;
		}

		const changed =
			this.meta("protocol") !== String(negotiated.protocol) || this.meta("agent_version") !== frame.agent_version;
		this.setMeta("protocol", String(negotiated.protocol));
		this.setMeta("agent_version", frame.agent_version);
		this.setMeta("last_seen_at", String(now));
		clearOfflineDm(this.ctx.storage);
		state.hello = true;
		ws.serializeAttachment(state);

		ws.send(
			encodeFrame({
				v: 1,
				type: "welcome",
				hub_version: this.env.HUB_VERSION,
				protocol_min: PROTOCOL_MIN,
				protocol_max: PROTOCOL_MAX,
				agent_id: this.agentId,
				installation_id: this.installationId,
				...agentVersions(this.env),
			}),
		);
		this.sql.exec("DELETE FROM outbox WHERE seq <= ?", inbound);
		this.setHwm("out", inbound);
		for (const row of this.sql.exec<{ frame: string }>("SELECT frame FROM outbox ORDER BY seq")) ws.send(row.frame);

		await this.writeSeen(now, changed);
	}

	private badFrame(ws: WebSocket, state: SocketState, message: string, now: number): void {
		sendError(ws, "bad_frame", message);
		if (!countInWindow(state.badFrames, now, 60_000, MAX_BAD_FRAMES_PER_MINUTE)) ws.close(CLOSE.badFrame, "bad_frame");
		ws.serializeAttachment(state);
	}

	/**
	 * Writes online, last_seen_at, protocol and agent_version to D1 when force
	 * is set, when D1 still has the agent offline, or SEEN_WRITE_INTERVAL_MS
	 * after the last write. meta.last_d1_seen_write is present exactly while
	 * D1 has the agent online.
	 */
	private async writeSeen(now: number, force: boolean): Promise<void> {
		const last = this.meta("last_d1_seen_write");
		if (!force && last !== null && now - Number(last) < SEEN_WRITE_INTERVAL_MS) return;
		this.setMeta("last_d1_seen_write", String(now));
		try {
			await touchAgent(this.tenant(), this.agentId, {
				protocolVersion: Number(this.meta("protocol")),
				agentVersion: this.meta("agent_version") ?? "",
				lastSeenAt: now,
			});
		} catch (err) {
			this.sql.exec("DELETE FROM meta WHERE key = 'last_d1_seen_write'");
			reportError(err, { agent_id: this.agentId, installation_id: this.installationId, op: "touch_agent" });
		}
	}

	/** Latest sign of life on ws: its last auto-answered ping or its last message. */
	private lastActivity(ws: WebSocket): number {
		const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
		return Math.max(pinged, socketState(ws).lastMessageAt);
	}

	/**
	 * Marks the agent offline in D1 and runs the offline hooks, once per
	 * online period: only when D1 has it online, which hello establishes.
	 */
	private async markOffline(lastSeenAt: number): Promise<void> {
		if (this.meta("last_d1_seen_write") === null) return;
		this.sql.exec("DELETE FROM meta WHERE key = 'last_d1_seen_write'");
		this.setMeta("last_seen_at", String(lastSeenAt));
		try {
			await markAgentOffline(this.tenant(), this.agentId, lastSeenAt);
		} catch (err) {
			reportError(err, { agent_id: this.agentId, installation_id: this.installationId, op: "mark_offline" });
		}
		for (const hook of registeredOfflineHooks()) {
			try {
				await hook(this);
			} catch (err) {
				reportError(err, { agent_id: this.agentId, installation_id: this.installationId, op: "offline_hook" });
			}
		}
	}

	/** Called once ws is gone: offline, unless another socket has taken over. */
	private async socketGone(ws: WebSocket): Promise<void> {
		if (this.ctx.getWebSockets().some((other) => other !== ws && other.readyState === WebSocket.OPEN)) return;
		await this.markOffline(this.lastActivity(ws));
	}

	override async webSocketClose(ws: WebSocket): Promise<void> {
		await this.socketGone(ws);
	}

	override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		reportError(error, { agent_id: this.agentId, installation_id: this.installationId, op: "websocket" });
		await this.socketGone(ws);
	}

	override async alarm(): Promise<void> {
		const now = this.clock.now();
		for (const ws of this.ctx.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN || now - this.lastActivity(ws) <= OFFLINE_AFTER_MS) continue;
			ws.close(CLOSE.pingTimeout, "ping_timeout");
			await this.socketGone(ws);
		}
		let pending = false;
		for (const task of registeredAlarmTasks()) {
			try {
				if (await task(this, now)) pending = true;
			} catch (err) {
				pending = true;
				reportError(err, { agent_id: this.agentId, installation_id: this.installationId, op: "alarm_task" });
			}
		}
		if (pending || this.ctx.getWebSockets().some((ws) => ws.readyState === WebSocket.OPEN)) {
			// A task may have asked for an earlier alarm than the regular tick; keep it.
			const next = now + ALARM_INTERVAL_MS;
			const set = await this.ctx.storage.getAlarm();
			if (set === null || set <= now || set > next) await this.ctx.storage.setAlarm(next);
		}
	}
}
