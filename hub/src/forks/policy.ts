// Whether a trigger is a fork pull request. Which forks may run is decided
// by policy/trust.ts from the base ref's `.zeroci.yml`.

import type { HubTrigger } from "../github/normalize";

export function isForkPr(pr: HubTrigger["pr"]): boolean {
	return pr?.fork === true;
}
