import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertInstallation } from "../../src/db/installations";
import { S } from "../../src/strings";
import { clearTables } from "../db/helpers";
import { type Agent, type AgentSocket, connect, seedAgent as seedAgentIn } from "./agent-socket";

const INSTALLATION = 43;
const RUN = "run_tail";
const JOB = "build";

interface SseEvent {
  event: string;
  data: unknown;
}

/** A viewer's end of GET /tail: parses the event stream, skipping keepalive comments. */
class Viewer {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(readonly res: Response) {
    if (!res.body) throw new Error("tail response has no body");
    this.reader = res.body.getReader();
  }

  /** The next event, or null once the hub closed the stream. */
  async next(): Promise<SseEvent | null> {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end !== -1) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (block.startsWith(":")) continue;
        const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]));
        return { event: fields.event ?? "", data: JSON.parse(fields.data ?? "null") };
      }
      const { done, value } = await this.reader.read();
      if (done) return null;
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

async function openTail(agent: Agent, offset = 0): Promise<Viewer> {
  const res = await agent.stub.fetch(`https://do/tail?${new URLSearchParams({ run_id: RUN, job: JOB, offset: String(offset) })}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-store");
  return new Viewer(res);
}

function logFrame(offset: number, text: string, eof = false): Record<string, unknown> {
  const bytes = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  return { v: 1, type: "log", run_id: RUN, job: JOB, offset, bytes, eof };
}

async function online(): Promise<{ agent: Agent; sock: AgentSocket }> {
  const agent = await seedAgentIn(INSTALLATION);
  const sock = await connect(agent);
  await sock.hello();
  return { agent, sock };
}

beforeEach(async () => {
  await clearTables();
  await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
});

describe("AgentDO GET /tail", () => {
  it("subscribes the agent from the viewer's offset and relays log frames as events until eof", async () => {
    const { agent, sock } = await online();
    const viewer = await openTail(agent, 7);
    expect(await sock.next()).toEqual({ v: 1, type: "log_subscribe", run_id: RUN, job: JOB, offset: 7 });

    // A UTF-8 character split across two frames arrives whole.
    const text = "ok \u00e9\n";
    const bytes = new TextEncoder().encode(text);
    const split = bytes.length - 2;
    sock.send({ ...logFrame(7, ""), bytes: btoa(String.fromCharCode(...bytes.subarray(0, split))) });
    expect(await viewer.next()).toEqual({ event: "log", data: { offset: 7, text: "ok " } });
    sock.send({ ...logFrame(7 + split, ""), bytes: btoa(String.fromCharCode(...bytes.subarray(split))) });
    expect(await viewer.next()).toEqual({ event: "log", data: { offset: 7 + split, text: "\u00e9\n" } });

    sock.send(logFrame(7 + bytes.length, "\u001b[31mdone\u001b[0m\n", true));
    expect(await viewer.next()).toEqual({ event: "log", data: { offset: 7 + bytes.length, text: "\u001b[31mdone\u001b[0m\n" } });
    expect(await viewer.next()).toEqual({ event: "eof", data: {} });
    expect(await viewer.next()).toBeNull();
  });

  it("sends offline and closes the stream when the agent disconnects", async () => {
    const { agent, sock } = await online();
    const viewer = await openTail(agent);
    expect(await sock.next()).toMatchObject({ type: "log_subscribe", offset: 0 });

    sock.ws.close(1000, "bye");
    expect(await viewer.next()).toEqual({ event: "offline", data: {} });
    expect(await viewer.next()).toBeNull();
  });

  it("answers offline at once when no agent is connected", async () => {
    const agent = await seedAgentIn(INSTALLATION);
    const viewer = await openTail(agent);
    expect(await viewer.next()).toEqual({ event: "offline", data: {} });
    expect(await viewer.next()).toBeNull();
  });

  it("shares one subscription between two viewers and unsubscribes when the last leaves", async () => {
    const { agent, sock } = await online();
    const first = await openTail(agent);
    expect(await sock.next()).toMatchObject({ type: "log_subscribe", run_id: RUN, job: JOB });

    sock.send(logFrame(0, "line 1\n"));
    expect(await first.next()).toEqual({ event: "log", data: { offset: 0, text: "line 1\n" } });
    // A late viewer replays what the tail already relayed instead of subscribing again.
    const second = await openTail(agent);
    expect(await second.next()).toEqual({ event: "log", data: { offset: 0, text: "line 1\n" } });

    // The first viewer leaving keeps the subscription for the second.
    await first.cancel();
    sock.send(logFrame(7, "line 2\n"));
    expect(await second.next()).toEqual({ event: "log", data: { offset: 7, text: "line 2\n" } });

    // One log_subscribe in all: the next frame the agent sees is the unsubscribe.
    await second.cancel();
    expect(await sock.next()).toEqual({ v: 1, type: "log_unsubscribe", run_id: RUN, job: JOB });
  });

  it("unsubscribes a log frame nobody watches", async () => {
    const { sock } = await online();
    sock.send(logFrame(0, "stray\n"));
    expect(await sock.next()).toEqual({ v: 1, type: "log_unsubscribe", run_id: RUN, job: JOB });
  });

  it("rejects a log frame whose bytes are not base64", async () => {
    const { sock } = await online();
    sock.send({ ...logFrame(0, ""), bytes: "not base64!" });
    expect(await sock.next()).toMatchObject({ code: "bad_frame", message: S.agentLogFrameInvalid });
  });

  it("rejects a tail request without run, job or a valid offset", async () => {
    const agent = await seedAgentIn(INSTALLATION);
    for (const query of ["job=build", "run_id=run_1", "run_id=run_1&job=build&offset=-1", "run_id=run_1&job=build&offset=1.5"]) {
      const res = await agent.stub.fetch(`https://do/tail?${query}`);
      expect(res.status, query).toBe(400);
    }
  });
});
