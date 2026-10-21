import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import githubApp from "../manifests/github-app.json";
import slackYaml from "../manifests/slack-app.yml?raw";
import "../src/slack/events";
import { SLACK_BOT_SCOPES } from "../src/slack/oauth";
import { registeredEventTypes } from "../src/slack/registry";
import { HANDLED_GITHUB_EVENTS } from "../src/webhook/handlers";

interface SlackManifest {
  features: { slash_commands: { command: string; url: string }[] };
  oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } };
  settings: { event_subscriptions: { request_url: string; bot_events: string[] }; interactivity: { request_url: string } };
}

const slackApp = parse(slackYaml) as SlackManifest;
const HOST = "https://ci.webuno.io";

// GitHub delivers these to every App whether or not the manifest subscribes to them,
// and rejects a manifest that lists them in default_events.
const ALWAYS_DELIVERED = ["installation", "installation_repositories", "github_app_authorization"];

describe("Slack App manifest", () => {
  it("asks for exactly SLACK_BOT_SCOPES and never chat:write.public", () => {
    expect(slackApp.oauth_config.scopes.bot).toEqual(SLACK_BOT_SCOPES.split(","));
    expect(slackApp.oauth_config.scopes.bot).toEqual([
      "chat:write",
      "commands",
      "channels:read",
      "groups:read",
      "im:write",
      "users:read",
      "users:read.email",
    ]);
    expect(slackApp.oauth_config.scopes.bot).not.toContain("chat:write.public");
  });

  it("subscribes to exactly the registered Events API handlers", () => {
    expect([...slackApp.settings.event_subscriptions.bot_events].sort()).toEqual(registeredEventTypes().sort());
  });

  it("declares the /hookci slash command", () => {
    expect(slackApp.features.slash_commands.map((c) => c.command)).toEqual(["/hookci"]);
  });
});

describe("GitHub App manifest", () => {
  it("subscribes to exactly the events the webhook dispatch table handles", () => {
    expect([...githubApp.default_events, ...ALWAYS_DELIVERED].sort()).toEqual([...HANDLED_GITHUB_EVENTS].sort());
  });

  it("requests write access to checks only", () => {
    const perms = Object.entries(githubApp.default_permissions);
    expect(perms.filter(([, level]) => level === "write").map(([name]) => name)).toEqual(["checks"]);
    for (const [, level] of perms.filter(([name]) => name !== "checks")) expect(level).toBe("read");
  });
});

describe("manifest URLs", () => {
  // The GitHub "url" is the App's homepage, not a hub endpoint.
  const urls = [
    githubApp.hook_attributes.url,
    githubApp.redirect_url,
    ...githubApp.callback_urls,
    githubApp.setup_url,
    ...slackApp.features.slash_commands.map((c) => c.url),
    ...slackApp.oauth_config.redirect_urls,
    slackApp.settings.event_subscriptions.request_url,
    slackApp.settings.interactivity.request_url,
  ];

  it.each(urls)("%s is on the production host and served by a hub route", async (url) => {
    expect(url.startsWith(`${HOST}/`)).toBe(true);
    const path = new URL(url).pathname;
    const statuses = await Promise.all(
      ["GET", "POST"].map(async (method) => (await exports.default.fetch(`https://hub.test${path}`, { method })).status),
    );
    expect(statuses.some((s) => s !== 404)).toBe(true);
  });
});
