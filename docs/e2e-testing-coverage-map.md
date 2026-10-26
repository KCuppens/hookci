# HookCI End-to-End Testing Coverage Map

This document establishes the end-to-end (E2E) testing coverage map and verification record across all surfaces of `hookci.com` (marketing and documentation) and `app.hookci.com` (the HookCI Control Plane, Dashboard, Agent Protocol, and MCP server).

---

## 1. System Architecture & Surface Inventory

HookCI operates across two distinct domains:

| Domain | Role | Tech Stack | Deployment Target |
| :--- | :--- | :--- | :--- |
| **`hookci.com`** | Marketing, documentation, feature comparisons, and pricing | Astro static site with client hydration | Cloudflare Pages |
| **`app.hookci.com`** | Dashboard, tenant isolation, GitHub/Slack integration, AgentDO coordination, live SSE streaming, MCP | Hono TypeScript worker, Cloudflare D1, Durable Objects, R2, KV | Cloudflare Workers |

---

## 2. Route & Surface Coverage Matrix

### 2.1 Public & Informational Endpoints (`hookci.com` & `app.hookci.com`)

| Surface / Route | Host | Auth / Protection | Status | Verification Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| `/` (Homepage) | `hookci.com` | Public | 200 OK | Crawler, browser fetch, link graph |
| `/compare/github-actions` | `hookci.com` | Public | 200 OK | Crawler |
| `/pricing` | `hookci.com` | Public | 200 OK | Crawler |
| `/docs/*` (35 pages) | `hookci.com` | Public | 200 OK | Recursive page crawl, anchor check |
| `/docs/search.json` | `hookci.com` | Public | 200 OK | JSON parse check |
| `/hookci.schema.json` | `hookci.com` | Public | 200 OK | JSON schema validation |
| `/robots.txt`, `/sitemap-index.xml` | `hookci.com` | Public | 200 OK | Schema crawler |
| `/healthz` | `app.hookci.com` | Public | 200 OK | Vitest (`e2e-coverage.test.ts`), live probe |
| `/v1/info` | `app.hookci.com` | Public | 200 OK | Vitest (`e2e-coverage.test.ts`), live probe |
| `/.well-known/security.txt` | `app.hookci.com` | Public | 200 OK | RFC 9116 text check |
| `/privacy`, `/terms`, `/support` | `app.hookci.com` | Public | 200 OK | Legal document HTML render check |
| `/` (Sign-in landing) | `app.hookci.com` | Public (Unauthenticated) | 200 OK | HTML form & branding validation |
| `/login` | `app.hookci.com` | Public | 303 Redirect | Redirects to GitHub OAuth authorize |
| `/app`, `/app/*` | `app.hookci.com` | Public | 308 Permanent | Canonical migration to `/:installationId/*` |

### 2.2 Dashboard Web Surfaces (`app.hookci.com/:installationId/*`)

| Surface / Route | Purpose | Access Control | Verification Mechanism |
| :--- | :--- | :--- | :--- |
| `/:installationId` | Tenant overview, recent runs, active agents | Session cookie & GitHub org membership | Vitest E2E Suite, multi-tenant isolation |
| `/:installationId/runs` | Runs list with status filters, pagination | Session cookie & GitHub org membership | Vitest E2E Suite |
| `/:installationId/runs/newer` | Dynamic run polling / swap endpoint | Session cookie & GitHub org membership | Polling loop test |
| `/:installationId/runs/:runId` | Run detail: duration ticker, job rows, inline logs | Session cookie & GitHub org membership | Live duration, inline log markup check |
| `/:installationId/runs/:runId/logs/:job/stream` | Live SSE log streaming for running jobs | Session cookie & GitHub org membership | EventSource stream test, cross-tenant 404 |
| `/:installationId/runs/:runId/logs/:job` | Static formatted HTML log viewer | Session cookie & GitHub org membership | Log line rendering, ANSI stripping check |
| `/:installationId/runs/:runId/logs/:job/download`| Raw uncompressed log download | Session cookie & GitHub org membership | Attachment content check |
| `/:installationId/agents` | Registered agents list and pairing CTA | Session cookie & GitHub org membership | Agent capacity, status rendering |
| `/:installationId/agents/pair` | Generate single-use pairing token | Session cookie + CSRF token | One-time token generation check |
| `/:installationId/agents/:agentId` | Agent detail: bindings, budget, hardware | Session cookie & GitHub org membership | Agent detail rendering |
| `/:installationId/repositories` | Connected repositories & agent bindings | Session cookie & GitHub org membership | Bindings table verification |
| `/:installationId/tokens` | API token management & MCP instructions | Session cookie & GitHub org membership | Token generation, secret display |
| `/:installationId/settings` | Slack workspace linking & notifications | Session cookie & GitHub org membership | Workspace link state check |

### 2.3 Dashboard Actions & Mutation Endpoints

| Route | Action | CSRF Protected | Verification Mechanism |
| :--- | :--- | :--- | :--- |
| `POST /:installationId/agents/pair` | Create pairing token | Yes | CSRF rejection (403), happy path |
| `POST /:installationId/agents/:agentId/budget` | Set CPU/memory capacity | Yes | CSRF rejection (403), D1 update |
| `POST /:installationId/agents/:agentId/revoke` | Revoke agent access | Yes | CSRF rejection (403), revoke stamp |
| `POST /:installationId/agents/:agentId/bindings/unbind` | Unbind repo from agent | Yes | CSRF rejection (403), binding delete |
| `POST /:installationId/repositories/bind` | Bind repo to agent | Yes | CSRF rejection (403), permission check |
| `POST /:installationId/tokens` | Issue scoped API token | Yes | CSRF rejection (403), sha256 hash |
| `POST /:installationId/tokens/:id/revoke` | Revoke API token | Yes | CSRF rejection (403), token invalidation |
| `POST /:installationId/runs/:runId/cancel` | Cancel in-flight run | Yes | CSRF rejection (403), state machine |
| `POST /:installationId/runs/:runId/retry` | Retry completed run | Yes | CSRF rejection (403), agent dispatch |
| `POST /:installationId/runs/:runId/approve` | Approve fork run | Yes | CSRF rejection (403), fork gate dispatch |

### 2.4 Agent Execution & Communication Protocol

| Endpoint | Method | Security | Purpose | Verification Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| `/v1/pair/redeem` | POST | Single-use pair token | Exchanges pair token for permanent agent credential | Vitest E2E Suite |
| `/v1/agent/connect` | WebSocket | Bearer `hci_agent_*` | AgentDO WebSocket connection, heartbeat, job dispatch | Vitest mock agent socket |
| `/v1/logs/:runId/:job` | PUT | Bearer `hci_agent_*` | Gzipped job log upload with byte & truncate headers | Vitest E2E Suite, R2 persistence |
| `/v1/agent/sinks` | POST | Bearer `hci_agent_*` | Sink delivery report | Auth check & event log |

### 2.5 MCP Protocol Endpoint

| Endpoint | Method | Security | Purpose | Verification Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| `/mcp` | POST | Bearer API Token | Remote MCP JSON-RPC protocol endpoint | Header auth test, tool discovery |
| `/mcp/:token` | POST | Path-based API Token | URL-fallback MCP protocol endpoint for simple clients | Path auth test, tool execution |

---

## 3. E2E Test Suite Specification (`test/e2e-coverage.test.ts`)

The dedicated Miniflare worker test suite covers all critical paths with zero external mocks on database or durable objects:

1. **`1. Public, Informational & Infrastructure Endpoints`**:
   - `/healthz` returns 200 with service name and version.
   - `/v1/info` returns 200 with protocol capabilities and version.
   - `/.well-known/security.txt`, `/privacy`, `/terms`, `/support` render valid content.
   - `/` serves login landing; `/login` directs to GitHub OAuth.
   - `/app` legacy paths return 308 permanent redirect to the root dashboard.
   - Unknown routes return 404 with custom branded markup.

2. **`2. Authentication & Tenant Boundary Protection`**:
   - Unauthenticated requests to `/:installationId/*` return 404 anti-enumeration.
   - Tenant B attempting to access Tenant A's pages returns 404 anti-enumeration.
   - Session tampering, invalid cookies, and forged signatures are rejected.

3. **`3. Dashboard Pages & Live Run View`**:
   - Authenticated sessions load Overview, Runs, Agents, Repositories, Tokens, and Settings.
   - Run Detail renders the setup job, duration attribute (`data-ms`), and streaming container (`pre[data-tail]`).

4. **`4. Agent Pairing & WebSocket Lifecycle`**:
   - Admin generates a pairing token via CSRF-protected POST.
   - Agent redeems pairing token at `/v1/pair/redeem` and receives permanent credentials.
   - Agent connects to `/v1/agent/connect` via WebSocket and completes handshake.
   - Agent appears active in the dashboard agent directory.

5. **`5. Run Lifecycle, Setup Job & Live SSE Log Streaming`**:
   - Run seeded with `setup` job and user workload jobs.
   - Agent uploads gzipped log chunks to `/v1/logs/:runId/:job`.
   - Log stream (`/runs/:runId/logs/setup/stream`) yields SSE events to authorized sessions and 404s foreign tenants.
   - Raw logs (`/runs/:runId/logs/setup/download`) and formatted HTML viewer render properly.

6. **`6. API Tokens, Settings & MCP Protocol`**:
   - Tenant issues an API token via the dashboard.
   - Token connects to `/mcp/:token` and discovers registered MCP tools (`tools/list`).
   - Token revocation prevents further MCP execution (returns 401).

7. **`7. Agent Management, Lifecycle & Revocation`**:
   - Admin updates agent budget allocation (`cpus`, `memory_gib`).
   - Admin revokes agent; database updates `revoked_at`.
   - Revoked agent is blocked from connecting.

---

## 4. Live Production Verification Record

Conducted on `https://hookci.com` and `https://app.hookci.com`:

```text
[LIVE PRODUCTION CHECK RESULTS]
1. Marketing & Documentation (hookci.com)
  - Crawled 35 documentation pages, search index, comparison pages, pricing:
    Status: 35/35 returned 200 OK.
  - Zero broken internal links discovered across the entire site graph.
  - Search document /docs/search.json validated with 35 index entries.
  - JSON schema /hookci.schema.json validated.

2. Public & Infrastructure Endpoints (app.hookci.com)
  - GET https://app.hookci.com/healthz -> 200 OK {"ok":true,"name":"hookci-hub"}
  - GET https://app.hookci.com/v1/info -> 200 OK {"name":"hookci-hub","version":"dev"}
  - GET https://app.hookci.com/robots.txt -> 200 OK Disallow: /
  - GET https://app.hookci.com/.well-known/security.txt -> 200 OK (RFC 9116)
  - GET https://app.hookci.com/privacy -> 200 OK (HTML render)
  - GET https://app.hookci.com/terms -> 200 OK (HTML render)
  - GET https://app.hookci.com/support -> 200 OK (HTML render)
  - GET https://app.hookci.com/ -> 200 OK (Sign-in landing)
  - GET https://app.hookci.com/login -> 303 Redirect -> github.com/login/oauth/authorize
  - GET https://app.hookci.com/app -> 308 Permanent Redirect -> /

3. Security & Anti-Enumeration (app.hookci.com)
  - GET https://app.hookci.com/173773263/runs (no session) -> 404 Not Found (Anti-enumeration passed)
  - GET https://app.hookci.com/nonexistent -> 404 Not Found
  - POST https://app.hookci.com/mcp without token -> 401 Unauthorized
  - POST https://app.hookci.com/v1/agent/sinks without auth -> 401 Unauthorized
  - POST https://app.hookci.com/v1/pair/redeem without body -> 400 Bad Request
```
