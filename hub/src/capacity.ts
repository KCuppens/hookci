// The compute budget an agent reports (capacity frames) and the override the
// dashboard sets (budget frames): sanitizing what an agent claims, parsing what
// the hub stored, and validating what an administrator types.

import type { Capacity } from "./protocol";

/** Most running jobs one capacity report lists; further ones are dropped. */
export const MAX_CAPACITY_JOBS = 64;
/** Longest run id or job name kept in a report, in characters. */
const MAX_NAME_CHARS = 200;
/** Largest CPU budget the dashboard accepts. */
export const MAX_BUDGET_CPUS = 1024;
/** Smallest memory budget the dashboard accepts: 256 MiB. */
export const MIN_BUDGET_MEMORY_BYTES = 256 * 1024 * 1024;
/** Largest memory budget the dashboard accepts: 1 PiB, well inside the safe integers. */
export const MAX_BUDGET_MEMORY_BYTES = 2 ** 50;

/** What the hub keeps of a capacity frame. */
export type StoredCapacity = Omit<Capacity, "v" | "type">;

function nonNegative(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function bytes(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// PSI reports a percentage; -1 means the host does not report it.
function pressure(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < -1) return null;
	return Math.min(value, 100);
}

function name(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return Array.from(value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").trim()).slice(0, MAX_NAME_CHARS).join("");
}

/** Checks one capacity frame's values and keeps its fields only; null when any is the wrong type or out of range. */
export function sanitizeCapacity(frame: Capacity): StoredCapacity | null {
	if (!Array.isArray(frame.jobs) || typeof frame.backing_off !== "boolean") return null;
	const jobs: StoredCapacity["jobs"] = [];
	for (const job of frame.jobs.slice(0, MAX_CAPACITY_JOBS)) {
		if (typeof job !== "object" || job === null) return null;
		const runId = name(job.run_id);
		const jobName = name(job.job);
		const lane = name(job.lane);
		const minCpus = nonNegative(job.min_cpus);
		const grantedCpus = nonNegative(job.granted_cpus);
		const memoryBytes = bytes(job.memory_bytes);
		if (runId === null || jobName === null || lane === null || minCpus === null || grantedCpus === null || memoryBytes === null) return null;
		jobs.push({ run_id: runId, job: jobName, lane, min_cpus: minCpus, granted_cpus: grantedCpus, memory_bytes: memoryBytes });
	}
	const hostCpus = nonNegative(frame.host_cpus);
	const hostMemory = bytes(frame.host_memory_bytes);
	const budgetCpus = nonNegative(frame.budget_cpus);
	const budgetMemory = bytes(frame.budget_memory_bytes);
	const grantedCpus = nonNegative(frame.granted_cpus);
	const reserved = bytes(frame.reserved_memory_bytes);
	const available = bytes(frame.mem_available_bytes);
	const cpuPressure = pressure(frame.cpu_pressure);
	const memPressure = pressure(frame.mem_pressure);
	if (
		hostCpus === null ||
		hostMemory === null ||
		budgetCpus === null ||
		budgetMemory === null ||
		grantedCpus === null ||
		reserved === null ||
		available === null ||
		cpuPressure === null ||
		memPressure === null
	) {
		return null;
	}
	return {
		host_cpus: hostCpus,
		host_memory_bytes: hostMemory,
		budget_cpus: budgetCpus,
		budget_memory_bytes: budgetMemory,
		granted_cpus: grantedCpus,
		reserved_memory_bytes: reserved,
		mem_available_bytes: available,
		cpu_pressure: cpuPressure,
		mem_pressure: memPressure,
		backing_off: frame.backing_off,
		jobs,
	};
}

/** The capacity stored in an agent row's last_capacity, or null when there is none or it is unreadable. */
export function parseStoredCapacity(json: string | null): StoredCapacity | null {
	if (json === null) return null;
	try {
		return sanitizeCapacity({ v: 1, type: "capacity", ...JSON.parse(json) });
	} catch {
		return null;
	}
}

/** The budget override an administrator asked for; each part null means automatic. */
export interface BudgetOverride {
	cpus: number | null;
	memory_bytes: number | null;
}

/** Why a typed budget was refused. */
export type BudgetError = "cpus" | "memory";

function parsePositive(text: string): number | null {
	const trimmed = text.trim();
	if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
	return Number(trimmed);
}

/**
 * Reads the budget form: cpus in cores and memory_gib in GiB, each blank for automatic. CPUs must be
 * above 0 and at most MAX_BUDGET_CPUS; memory at least MIN_BUDGET_MEMORY_BYTES and at most MAX_BUDGET_MEMORY_BYTES.
 */
export function parseBudgetForm(cpusText: string, memoryGibText: string): BudgetOverride | BudgetError {
	let cpus: number | null = null;
	if (cpusText.trim() !== "") {
		cpus = parsePositive(cpusText);
		if (cpus === null || cpus <= 0 || cpus > MAX_BUDGET_CPUS) return "cpus";
	}
	let memory: number | null = null;
	if (memoryGibText.trim() !== "") {
		const gib = parsePositive(memoryGibText);
		if (gib === null) return "memory";
		memory = Math.round(gib * 1024 ** 3);
		if (memory < MIN_BUDGET_MEMORY_BYTES || memory > MAX_BUDGET_MEMORY_BYTES) return "memory";
	}
	return { cpus, memory_bytes: memory };
}
