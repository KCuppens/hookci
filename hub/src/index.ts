// zeroci-hub: the Cloudflare Worker that agents report to and operators
// browse. This is a scaffold: only a health check exists so far. Later
// tickets add the run intake API, SSE/log streaming, and the dashboard UI.

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/healthz") {
			return new Response("ok", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		}

		return new Response("not found", {
			status: 404,
			headers: { "content-type": "text/plain" },
		});
	},
} satisfies ExportedHandler;
