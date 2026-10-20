import { describe, expect, it } from "vitest";
import { validateWebhookUrl } from "../../src/sinks/webhook";

const HUB = "ci.webuno.io";

describe("validateWebhookUrl", () => {
  it.each([
    ["not a url", "invalid"],
    ["https://", "invalid"],
    ["http://example.com/hook", "not_https"],
    ["ftp://example.com/hook", "not_https"],
    ["https://user:pw@example.com/hook", "invalid"],
    ["https://user@example.com/hook", "invalid"],
    ["https://example.com:8443/hook", "invalid"],
    ["https://localhost/hook", "private_host"],
    ["https://LOCALHOST./hook", "private_host"],
    ["https://app.localhost/hook", "private_host"],
    ["https://db.internal/hook", "private_host"],
    ["https://printer.local/hook", "private_host"],
    ["https://127.0.0.1/hook", "private_host"],
    ["https://127.9.9.9/hook", "private_host"],
    ["https://2130706433/hook", "private_host"],
    ["https://0x7f.1/hook", "private_host"],
    ["https://10.1.2.3/hook", "private_host"],
    ["https://172.16.0.1/hook", "private_host"],
    ["https://172.31.255.255/hook", "private_host"],
    ["https://192.168.1.1/hook", "private_host"],
    ["https://169.254.169.254/latest", "private_host"],
    ["https://100.64.0.1/hook", "private_host"],
    ["https://100.127.255.255/hook", "private_host"],
    ["https://0.0.0.0/hook", "private_host"],
    ["https://[::1]/hook", "private_host"],
    ["https://[0:0:0:0:0:0:0:1]/hook", "private_host"],
    ["https://[fc00::1]/hook", "private_host"],
    ["https://[fd12:3456::1]/hook", "private_host"],
    ["https://[fe80::1]/hook", "private_host"],
    ["https://[febf::1]/hook", "private_host"],
    ["https://[::ffff:127.0.0.1]/hook", "private_host"],
    ["https://[::ffff:10.0.0.1]/hook", "private_host"],
    ["https://[::ffff:a9fe:a9fe]/hook", "private_host"],
    ["https://ci.webuno.io/hook", "self"],
    ["https://CI.webuno.io./hook", "self"],
  ])("rejects %s as %s", (raw, code) => {
    expect(validateWebhookUrl(raw, HUB)).toEqual({ ok: false, code });
  });

  it.each([
    "https://example.com/hook",
    "https://example.com:443/x",
    "https://172.32.0.1/hook",
    "https://100.128.0.1/hook",
    "https://[2606:4700::1111]/hook",
    "https://[::ffff:8.8.8.8]/hook",
    "https://hooks.webuno.io/hook",
  ])("accepts %s", (raw) => {
    const r = validateWebhookUrl(raw, HUB);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.href).toBe(new URL(raw).href);
  });
});
