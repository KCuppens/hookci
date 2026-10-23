/**
 * Outbound HTTP. Code that calls GitHub, Slack or any other service takes a
 * Fetcher argument so tests can pass a fake instead of reaching the network.
 */
export type Fetcher = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export const defaultFetcher: Fetcher = (input, init) => fetch(input, init);

/** How long a call to a sink provider or to Slack's OAuth endpoints may take, its body included, before it is aborted as unreachable. */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** The JSON body of res, or null when it is not JSON; a timeout or a broken connection while reading still throws. */
export async function jsonOrNull(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch (err) {
		if (err instanceof SyntaxError) return null;
		throw err;
	}
}
