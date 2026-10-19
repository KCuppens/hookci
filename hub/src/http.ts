/**
 * Outbound HTTP. Code that calls GitHub, Slack or any other service takes a
 * Fetcher argument so tests can pass a fake instead of reaching the network.
 */
export type Fetcher = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export const defaultFetcher: Fetcher = (input, init) => fetch(input, init);
