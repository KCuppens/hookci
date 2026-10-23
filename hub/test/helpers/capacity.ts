import type { Capacity } from "../../src/protocol";

export const GIB = 1024 ** 3;

export function capacityFrame(over: Partial<Capacity> = {}): Capacity {
  return {
    v: 1,
    type: "capacity",
    host_cpus: 16,
    host_memory_bytes: 32 * GIB,
    budget_cpus: 8,
    budget_memory_bytes: 16 * GIB,
    granted_cpus: 5,
    reserved_memory_bytes: 4 * GIB,
    mem_available_bytes: 20 * GIB,
    cpu_pressure: 1.5,
    mem_pressure: -1,
    backing_off: false,
    jobs: [{ run_id: "r1", job: "unit", lane: "main", min_cpus: 2, granted_cpus: 5, memory_bytes: 4 * GIB }],
    ...over,
  };
}
