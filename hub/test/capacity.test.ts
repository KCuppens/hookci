import { describe, expect, it } from "vitest";
import { MAX_CAPACITY_JOBS, parseBudgetForm, parseStoredCapacity, sanitizeCapacity } from "../src/capacity";
import type { Capacity } from "../src/protocol";
import { capacityFrame, GIB } from "./helpers/capacity";

describe("sanitizeCapacity", () => {
  it("keeps a valid report's fields and drops anything else on the frame", () => {
    const stored = sanitizeCapacity({ ...capacityFrame(), extra: 1 } as Capacity);
    expect(stored).toEqual({ ...capacityFrame(), v: undefined, type: undefined });
    expect(stored).not.toHaveProperty("extra");
    expect(stored).not.toHaveProperty("v");
  });

  it("cuts the job list to the limit", () => {
    const job = { run_id: "r", job: "j", lane: "main", min_cpus: 1, granted_cpus: 1, memory_bytes: 1 };
    const stored = sanitizeCapacity(capacityFrame({ jobs: Array.from({ length: 200 }, () => job) }));
    expect(stored?.jobs).toHaveLength(MAX_CAPACITY_JOBS);
  });

  it.each([
    ["a negative cpu count", { host_cpus: -1 }],
    ["a non-integer byte count", { host_memory_bytes: 1.5 }],
    ["a string number", { budget_cpus: "8" as unknown as number }],
    ["pressure below -1", { cpu_pressure: -5 }],
    ["a non-boolean backing_off", { backing_off: 1 as unknown as boolean }],
    ["jobs that are not an array", { jobs: {} as unknown as Capacity["jobs"] }],
    ["a job with a negative grant", { jobs: [{ run_id: "r", job: "j", lane: "main", min_cpus: 1, granted_cpus: -1, memory_bytes: 1 }] }],
  ])("refuses %s", (_name, over) => {
    expect(sanitizeCapacity(capacityFrame(over as Partial<Capacity>))).toBeNull();
  });
});

describe("parseStoredCapacity", () => {
  it("reads back what was stored and treats null or junk as no report", () => {
    const stored = sanitizeCapacity(capacityFrame());
    expect(parseStoredCapacity(JSON.stringify(stored))).toEqual(stored);
    expect(parseStoredCapacity(null)).toBeNull();
    expect(parseStoredCapacity("{")).toBeNull();
    expect(parseStoredCapacity("{}")).toBeNull();
  });
});

describe("parseBudgetForm", () => {
  it("reads cores and GiB, and blank as automatic", () => {
    expect(parseBudgetForm("6", "12")).toEqual({ cpus: 6, memory_bytes: 12 * GIB });
    expect(parseBudgetForm("2.5", "")).toEqual({ cpus: 2.5, memory_bytes: null });
    expect(parseBudgetForm(" ", " ")).toEqual({ cpus: null, memory_bytes: null });
  });

  it.each(["0", "-1", "abc", "1025", "1e3"])("refuses cpus %s", (text) => {
    expect(parseBudgetForm(text, "")).toBe("cpus");
  });

  it.each(["0.1", "-4", "x", "2000000"])("refuses memory %s GiB", (text) => {
    expect(parseBudgetForm("", text)).toBe("memory");
  });

  it("accepts the bounds", () => {
    expect(parseBudgetForm("1024", "0.25")).toEqual({ cpus: 1024, memory_bytes: 0.25 * GIB });
  });
});
