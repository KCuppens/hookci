// The compute budget of an agent on its pages: the chip of the agent list and the Capacity card
// with the budget form on the agent's own page.

import { type StoredCapacity, parseStoredCapacity } from "../capacity";
import type { AgentRow } from "../db/agents";
import { S } from "../strings";
import { agoHtml, dateOf } from "./dashboard";
import { escapeHtml } from "./layout";

const C = S.agents.capacity;
const e = escapeHtml;
const GIB = 1024 ** 3;

export const CAPACITY_CSS = `
.cap{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:4px;font-size:12.5px;font-weight:400;letter-spacing:0;color:light-dark(#5b658d,#8894be)}
.cap.stale{opacity:.65}
.cap .bo,.cg .bo{display:inline-block;padding:1px 8px;border-radius:7px;background:light-dark(#feeccb,#30230a);color:light-dark(#a7400a,#e3774a);font-size:12px;font-weight:500;line-height:20px;white-space:nowrap}
.cg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:13.4px}
.cg>div{min-width:0;padding:12px 14px;border:1px solid light-dark(#f0f3f6,#2f3336);border-radius:9px}
.cg h3{margin:0 0 8px;font-size:14.5px;font-weight:500;letter-spacing:-.29px;color:light-dark(#040715,#8d95aa)}
.cg dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 14px;margin:0;font-size:13.5px}
.cg dt{color:light-dark(#5e6886,#8a95b4)}
.cg dd{margin:0;text-align:right;overflow-wrap:anywhere;color:light-dark(#0d1428,#8a95b0)}
.cg progress{display:block;width:100%;height:8px;margin:6px 0 4px;border:0;border-radius:4px;background:light-dark(#eceef2,#262729);appearance:none;-webkit-appearance:none}
.cg progress::-webkit-progress-bar{border-radius:4px;background:light-dark(#eceef2,#262729)}
.cg progress::-webkit-progress-value{border-radius:4px;background:#0b68fc}
.cg progress::-moz-progress-bar{border-radius:4px;background:#0b68fc}
.cg small{display:block;font-size:12.5px;color:light-dark(#5f6a8a,#8895b6)}
.cn2{margin:10px 0 0;font-size:13px;color:light-dark(#5f6a8a,#8895b6)}
.cj{width:100%;margin-top:6px;border-collapse:collapse;font-size:13px}
.cj th{padding:4px 6px 4px 0;text-align:left;font-weight:500;color:light-dark(#5e6886,#8a95b4)}
.cj td{padding:4px 6px 4px 0;overflow-wrap:anywhere}
.cj .no{text-align:right;font-variant-numeric:tabular-nums}
.cf{display:grid;grid-template-columns:repeat(2,minmax(0,1fr)) auto;gap:12px;align-items:end;margin-top:10px}
.cf label{display:block;min-width:0;font-size:13px;color:light-dark(#5e6886,#8a95b4)}
.cf input{box-sizing:border-box;width:100%;height:39px;margin-top:4px;padding:0 10px;border:1px solid light-dark(#dfe2ea,#3d3f43);border-radius:9px;background:light-dark(#fff,#161b22);color:var(--ink);font:inherit;font-size:14px}
.cf .bs{display:flex;gap:10px}
.cf-p{margin:0;font-size:13px;line-height:19px;color:light-dark(#5f6a8a,#8895b6)}
@media (max-width:900px){
.cg{grid-template-columns:minmax(0,1fr)}
.cf{grid-template-columns:minmax(0,1fr)}
.cf .bs{flex-direction:column}
.cf .bs .bt{width:100%}
.cj{display:block;overflow-x:auto}
}
`;

function cores(n: number): string {
	return String(Number(n.toFixed(1)));
}

function gib(bytes: number): string {
	const v = bytes / GIB;
	return v >= 10 ? String(Math.round(v)) : String(Number(v.toFixed(1)));
}

function gibUnit(bytes: number): string {
	return `${gib(bytes)} GiB`;
}

/** The agent's last reported capacity, or null for one that never reported (or was revoked). */
function capacityOf(agent: Pick<AgentRow, "last_capacity" | "revoked_at">): StoredCapacity | null {
	return agent.revoked_at === null ? parseStoredCapacity(agent.last_capacity) : null;
}

/** "2/4 CPU · 8/16 GiB" with a Backing off badge, dimmed while the agent is offline; empty without a report. */
export function capacityChip(agent: Pick<AgentRow, "last_capacity" | "revoked_at" | "status">): string {
	const c = capacityOf(agent);
	if (!c) return "";
	const text = C.chip(cores(c.granted_cpus), cores(c.budget_cpus), gib(c.reserved_memory_bytes), c.budget_memory_bytes === 0 ? null : gibUnit(c.budget_memory_bytes));
	const live = agent.status === "online";
	const badge = live && c.backing_off ? `<span class="bo" title="${e(C.backingOffTip)}">${e(C.backingOff)}</span>` : "";
	return `<span class="cap${live ? "" : " stale"}"><span>${e(text)}</span>${badge}</span>`;
}

function pressureText(value: number): string {
	return value < 0 ? C.noPressure : `${Number(value.toFixed(1))}%`;
}

function usageBar(label: string, value: number, max: number, text: string): string {
	return `<div><span>${e(label)}</span><progress value="${Math.min(value, max)}" max="${Math.max(max, 1e-9)}" aria-label="${e(label)}"></progress><small>${e(text)}</small></div>`;
}

function jobsTable(c: StoredCapacity): string {
	if (c.jobs.length === 0) return `<p class="cn2">${e(C.noJobs)}</p>`;
	const J = C.jobCols;
	const rows = c.jobs
		.map(
			(j) =>
				`<tr><td>${e(j.job)}</td><td>${e(j.lane)}</td><td class="no">${e(cores(j.min_cpus))}</td><td class="no">${e(cores(j.granted_cpus))}</td><td class="no">${e(gibUnit(j.memory_bytes))}</td></tr>`,
		)
		.join("");
	return `<table class="cj"><thead><tr><th>${e(J.job)}</th><th>${e(J.lane)}</th><th class="no">${e(J.min)}</th><th class="no">${e(J.granted)}</th><th class="no">${e(J.memory)}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function budgetForm(agent: AgentRow, csrf: string, action: string): string {
	const F = C.form;
	const cpus = agent.budget_cpus === null ? "" : cores(agent.budget_cpus);
	const memory = agent.budget_memory_bytes === null ? "" : gib(agent.budget_memory_bytes);
	return (
		`<form class="cf" method="post" action="${e(action)}"><input type="hidden" name="csrf" value="${e(csrf)}">` +
		`<label>${e(F.cpus)}<input name="cpus" inputmode="decimal" value="${e(cpus)}" placeholder="auto" autocomplete="off"></label>` +
		`<label>${e(F.memory)}<input name="memory_gib" inputmode="decimal" value="${e(memory)}" placeholder="auto" autocomplete="off"></label>` +
		`<div class="bs"><button class="bt" type="submit" name="action" value="save">${e(F.save)}</button>` +
		`<button class="bt" type="submit" name="action" value="reset">${e(F.reset)}</button></div></form>`
	);
}

/** The Capacity card: host size, budget, live usage, per-job grants and the budget form. */
export function capacityCard(agent: AgentRow, now: number, csrf: string, base: string): string {
	const head = `<div class="ph2"><div><h2>${e(C.title)}</h2><p>${e(C.subtitle)}</p></div></div>`;
	const c = capacityOf(agent);
	if (!c) return `<section class="card pn mt" id="capacity">${head}<p class="cn2">${e(C.unavailable)}</p></section>`;
	const online = agent.status === "online";
	const seen =
		agent.last_capacity_at === null
			? ""
			: `<p class="cn2">${online ? "" : `${e(C.lastKnown)} `}${e(C.asOf)} ${agoHtml(agent.last_capacity_at, now, S.dashboard.ago.minutesLong)} (${e(dateOf(agent.last_capacity_at))}).</p>`;
	const overridden = agent.budget_cpus !== null || agent.budget_memory_bytes !== null;
	const badge = c.backing_off ? `<span class="bo" title="${e(C.backingOffTip)}">${e(C.backingOff)}</span>` : "";
	const budget =
		`<div><h3>${e(C.host)}</h3><dl><dt>${e(C.host)}</dt><dd>${e(C.hostValue(cores(c.host_cpus), c.host_memory_bytes === 0 ? C.noPressure : gibUnit(c.host_memory_bytes)))}</dd>` +
		`<dt>${e(C.budget)}</dt><dd>${e(C.hostValue(cores(c.budget_cpus), c.budget_memory_bytes === 0 ? C.noMemoryBudget : gibUnit(c.budget_memory_bytes)))}</dd>` +
		`<dt></dt><dd>${e(overridden ? C.override : C.automatic)}</dd></dl>${seen}</div>`;
	const usage =
		`<div><h3>${e(C.cpu)} / ${e(C.memory)} ${online ? badge : ""}</h3>` +
		`${usageBar(C.cpu, c.granted_cpus, c.budget_cpus, C.cpuUse(cores(c.granted_cpus), cores(c.budget_cpus)))}` +
		`${c.budget_memory_bytes === 0 ? `<div><span>${e(C.memory)}</span><small>${e(C.memoryUse(gibUnit(c.reserved_memory_bytes), null))}</small></div>` : usageBar(C.memory, c.reserved_memory_bytes, c.budget_memory_bytes, C.memoryUse(gibUnit(c.reserved_memory_bytes), gibUnit(c.budget_memory_bytes)))}` +
		`<dl><dt>${e(C.available)}</dt><dd>${e(c.mem_available_bytes === 0 ? C.noPressure : gibUnit(c.mem_available_bytes))}</dd>` +
		`<dt>${e(C.pressure)} ${e(C.pressureCpu)}</dt><dd>${e(pressureText(c.cpu_pressure))}</dd>` +
		`<dt>${e(C.pressure)} ${e(C.pressureMemory)}</dt><dd>${e(pressureText(c.mem_pressure))}</dd></dl></div>`;
	const jobs = `<div><h3>${e(C.jobs)}</h3>${jobsTable(c)}</div>`;
	const form = `<div><h3>${e(C.form.title)}</h3><p class="cf-p">${e(C.form.body)}</p>${budgetForm(agent, csrf, `${base}/agents/${encodeURIComponent(agent.agent_id)}/budget`)}${online ? "" : `<p class="cn2">${e(C.form.offline)}</p>`}</div>`;
	return `<section class="card pn mt" id="capacity">${head}<div class="cg">${budget}${usage}${jobs}${form}</div></section>`;
}
