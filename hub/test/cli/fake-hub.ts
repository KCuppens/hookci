/** Answers for the Slack App step, keyed by its exact questions. */
export const SLACK_ANSWERS = {
	"Slack Signing Secret": "8f14e45fceea167a5a36dedd4bea2543",
	"Slack Client ID": "1234567890.9876543210",
	"Slack Client Secret": "c9f0f895fb98ab9159f51fd0297e236d",
};

/** A self-hosted hub's GET /v1/info body for the fake GitHub's default app. */
export function hubInfo(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "hookci-hub",
		version: "0.3.0",
		mode: "self_hosted",
		protocol_versions: [1],
		github_app: { slug: "acme-hookci" },
		slack: { enabled: true },
		...over,
	};
}

/** One answer to GET /v1/info: a response, or a network error. */
export type InfoReply = { status: number; body?: unknown } | { networkError: string };

export interface FakeHub {
	fetchFn: typeof fetch;
	/** Every /v1/info URL fetched, in order. */
	infoUrls: string[];
}

/**
 * A fetch answering `GET <hub>/v1/info` with `replies` in turn, the last one
 * repeating, and passing every other request (the fake GitHub) to `fallback`.
 */
export function fakeHub(replies: InfoReply[] = [{ status: 200, body: hubInfo() }], fallback: typeof fetch = fetch): FakeHub {
	const infoUrls: string[] = [];
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (new URL(url).pathname !== "/v1/info") return fallback(input, init);
		const reply = replies[Math.min(infoUrls.length, replies.length - 1)];
		infoUrls.push(url);
		if (!reply) throw new Error("fakeHub needs at least one reply");
		if ("networkError" in reply) throw new TypeError(reply.networkError);
		return Response.json(reply.body ?? {}, { status: reply.status });
	}) as typeof fetch;
	return { fetchFn, infoUrls };
}
