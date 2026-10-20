// Internal POST routes on the AgentDO (`POST https://do/<path>`), reachable
// only from the Worker through the AGENT_DO binding.

import type { AgentDO } from "./agent";

export type DoRoute = (dob: AgentDO, req: Request) => Promise<Response>;

const routes = new Map<string, DoRoute>();

/** Serves `POST https://do/<path>` with fn, replacing any earlier route; returns a function that removes it. */
export function registerDoRoute(path: string, fn: DoRoute): () => void {
	routes.set(path, fn);
	return () => {
		if (routes.get(path) === fn) routes.delete(path);
	};
}

export function doRoute(path: string): DoRoute | undefined {
	return routes.get(path);
}
