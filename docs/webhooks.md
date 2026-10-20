# Webhooks

A webhook sink POSTs a JSON document to your HTTPS endpoint each time a run
changes state. Every request is signed, so you can check it came from your
HookCI hub and was not replayed.

## Endpoint rules

The URL must be `https://`, on the default port (443), with no user name or
password in it. The hub refuses hosts that point at private networks:
`localhost`, `*.localhost`, `*.internal`, `*.local`, the IPv4 ranges
`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`169.254.0.0/16`, `100.64.0.0/10`, `0.0.0.0/8`, the IPv6 addresses `::1`,
`fc00::/7`, `fe80::/10` and IPv4-mapped forms of the IPv4 ranges, and the
hub's own host name. The hub does not resolve DNS names before sending; a
name that resolves to a private address is stopped because Cloudflare's
egress does not reach private ranges.

## Payload (version 1)

```json
{
  "v": 1,
  "type": "run.updated",
  "delivery_id": "01JB2Z6V3N8K4Q7M5T9W0XYZAB",
  "sent_at": "2026-10-20T12:00:05.000Z",
  "run": {
    "id": "01JB2Z5R0A1B2C3D4E5F6G7H8J",
    "repo": "acme/api",
    "sha": "4f2a9c0e1d7b3a5c6e8f9a0b1c2d3e4f5a6b7c8d",
    "ref": "refs/heads/main",
    "event": "push",
    "pr": null,
    "target": "main",
    "state": "failed",
    "terminal": true,
    "jobs": [
      { "name": "lint", "state": "success", "duration_ms": 8200 },
      { "name": "test", "state": "failed", "duration_ms": 61400 }
    ],
    "started_at": "2026-10-20T11:58:40.000Z",
    "finished_at": "2026-10-20T12:00:04.000Z",
    "log_url": null
  }
}
```

| Field | Meaning |
| --- | --- |
| `v` | Payload version. Breaking changes raise it; new fields may appear in version 1 at any time, so ignore fields you do not know. |
| `type` | Always `run.updated`. |
| `delivery_id` | Unique per queued update; the same across retries of that update. |
| `sent_at` | When this attempt was made (ISO 8601, UTC). |
| `run.id` | The run id (before an agent accepts the run, its trigger id). |
| `run.event` | `push`, `pull_request` or `manual`. |
| `run.pr` | Pull request number, or `null`. |
| `run.target` | The branch or deploy target the run is for, or `null`. |
| `run.state` | One of `received`, `gated`, `pending`, `superseded`, `queued`, `running`, `success`, `failed`, `cancelled`, `skipped`, `interrupted`, `verifying`, `rolling_back`. |
| `run.terminal` | `true` once the state will not change again. |
| `run.jobs[].duration_ms` | Job duration in milliseconds, or `null` while unknown. |
| `run.log_url` | A stable link to the run's logs, or `null`. Never a short-lived signed log link. |

## Headers

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `HookCI-Hookshot/1` |
| `X-HookCI-Event` | `run.updated` |
| `X-HookCI-Delivery` | The payload's `delivery_id` |
| `X-HookCI-Timestamp` | Unix time in seconds when the request was signed |
| `X-HookCI-Signature` | `sha256=` followed by the lowercase hex HMAC-SHA256 |

## Signature

The hub generates the secret (`hciwh_` and 64 hex characters) and shows it
once when you create the webhook. The signature is HMAC-SHA256, keyed with
the secret, over the timestamp, a dot, and the raw request body:

```
sha256=hex(HMAC_SHA256(secret, X-HookCI-Timestamp + "." + body))
```

Verify against the raw body bytes, before any JSON parsing. Compare in
constant time. Reject requests whose timestamp is more than 5 minutes away
from your clock, which stops replays of old requests.

### Node

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyHookCI(secret, timestamp, body, signature) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### Go

```go
import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"strconv"
	"time"
)

func VerifyHookCI(secret, timestamp string, body []byte, signature string) bool {
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || math.Abs(float64(time.Now().Unix()-ts)) > 300 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(body)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}
```

## Delivery

- At least once: the same update may arrive more than once. Deduplicate by
  `X-HookCI-Delivery`.
- Latest wins per run: if a run changes again before an update is delivered,
  only the newer state is sent. A request goes out only when the run's state
  differs from the last one delivered to your endpoint.
- Respond with any 2xx status within 10 seconds.
- Redirects are not followed; a 3xx counts as a failure.
- 5xx responses, timeouts and network errors are retried after 30 s, 2 m,
  10 m, 1 h and 6 h, then the update is given up. A 429 is retried after its
  `Retry-After` seconds when present.
- Other 4xx responses fail the update without retry.
- 410 Gone disables the webhook; no further updates are sent to it.
