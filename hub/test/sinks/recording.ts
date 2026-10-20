import { registerSinkFactory } from "../../src/sinks";
import type { AgentView, Annotation, JobView, RunView, Sink } from "../../src/sinks/types";

export type SinkCall =
  | { op: "onRunUpdate"; run: RunView }
  | { op: "onJobPlanned"; run: RunView }
  | { op: "onJobUpdate"; run: RunView; job: JobView }
  | { op: "onAnnotations"; run: RunView; job: string; annotations: Annotation[] }
  | { op: "onAgentOffline"; agent: AgentView; affected: RunView[] };

export interface RecordingSink {
  /** Every sink call, in the order made. */
  calls: SinkCall[];
  /** Unregisters the sink. */
  undo: () => void;
}

/** Registers a sink that records each call as it is made; undo removes it. */
export function recordSink(name = "recording"): RecordingSink {
  const calls: SinkCall[] = [];
  const sink: Sink = {
    name,
    onRunUpdate: async (run) => {
      calls.push({ op: "onRunUpdate", run });
    },
    onJobPlanned: async (run) => {
      calls.push({ op: "onJobPlanned", run });
    },
    onJobUpdate: async (run, job) => {
      calls.push({ op: "onJobUpdate", run, job });
    },
    onAnnotations: async (run, job, annotations) => {
      calls.push({ op: "onAnnotations", run, job, annotations });
    },
    onAgentOffline: async (agent, affected) => {
      calls.push({ op: "onAgentOffline", agent, affected });
    },
  };
  return { calls, undo: registerSinkFactory(name, () => sink) };
}
