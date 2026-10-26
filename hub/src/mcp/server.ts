// The remote MCP endpoint: authenticates an installation-scoped API token
// (see ../routes/mcp-auth.ts), then builds a fresh MCP server per request
// scoped to that installation and proxies the request through the SDK's
// Streamable HTTP transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import type { ApiTokenRow } from "../db/api-tokens";
import type { Env } from "../env";
import { HubError } from "../errors";
import { reportError } from "../observability";
import { authenticateMcpToken, touchMcpToken } from "../routes/mcp-auth";
import { registerMcpTools } from "./tools";

type AppContext = Context<{ Bindings: Env }>;

/** POST/GET/DELETE /mcp and /mcp/:token: bearer auth (header or path token), then the MCP Streamable HTTP transport. */
export async function handleMcpRequest(req: Request, env: Env, pathToken: string | undefined, waitUntil: (promise: Promise<unknown>) => void): Promise<Response> {
	let tokenRow: ApiTokenRow;
	try {
		tokenRow = await authenticateMcpToken(env, req.headers.get("authorization") ?? undefined, pathToken);
	} catch (err) {
		if (!(err instanceof HubError)) throw err;
		return new Response(JSON.stringify({ error: err.code }), { status: err.status, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });
	}
	touchMcpToken(env, tokenRow, Date.now(), waitUntil);

	const server = new McpServer({ name: "hookci-hub", version: env.HUB_VERSION });
	registerMcpTools(server, env, tokenRow.installation_id);

	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	await server.connect(transport);
	try {
		return await transport.handleRequest(req);
	} catch (err) {
		reportError(err, { component: "mcp", stage: "transport" });
		return new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { "content-type": "application/json" } });
	} finally {
		await transport.close().catch(() => undefined);
	}
}

/** GET/POST/DELETE /mcp: bearer token in the Authorization header. */
export function mcpRoute(c: AppContext): Promise<Response> {
	return handleMcpRequest(c.req.raw, c.env, undefined, c.executionCtx.waitUntil.bind(c.executionCtx));
}

/** GET/POST/DELETE /mcp/:token: path-fallback for clients that cannot set an Authorization header. */
export function mcpRouteWithToken(c: AppContext): Promise<Response> {
	return handleMcpRequest(c.req.raw, c.env, c.req.param("token"), c.executionCtx.waitUntil.bind(c.executionCtx));
}
