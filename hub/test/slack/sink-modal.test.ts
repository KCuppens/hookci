import { describe, expect, it } from "vitest";
import { buildSinkAddModal, isSlackViewSubmission, parseSinkAddSubmission, SINK_ADD_CALLBACK_ID } from "../../src/slack/sink-modal";
import { S } from "../../src/strings";

const BOT_TOKEN = `123456789:AAH${"t".repeat(32)}`;

/** The modal for acme/api as Slack submits it, with fields filled in as the user typed them. */
function submitted(fields: Record<string, string>) {
  const values = Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [
      field,
      { [field]: field === "kind" ? { type: "radio_buttons", selected_option: { value } } : { type: "plain_text_input", value } },
    ]),
  );
  return { callback_id: SINK_ADD_CALLBACK_ID, private_metadata: buildSinkAddModal("acme/api", "C0CHAN").private_metadata, state: { values } };
}

describe("buildSinkAddModal", () => {
  it("names its submission and carries the repo and channel back in private_metadata", () => {
    const view = buildSinkAddModal("acme/api", "C0CHAN");
    expect(view).toMatchObject({ type: "modal", callback_id: SINK_ADD_CALLBACK_ID, submit: { text: S.slack.sinkModal.submit } });
    expect(JSON.parse(view.private_metadata ?? "")).toEqual({ repo: "acme/api", channel: "C0CHAN" });
    expect(view.title?.text.length).toBeLessThanOrEqual(24);
  });

  it("has a kind choice of Telegram, Webhook or Linear and one input per field, keyed by field", () => {
    const blocks = buildSinkAddModal("acme/api", "C0CHAN").blocks as { type: string; block_id?: string; element?: { action_id: string; options?: { value: string }[] } }[];
    const inputs = blocks.filter((b) => b.type === "input");
    const fields = ["kind", "bot_token", "chat_id", "webhook_url", "linear_api_key", "linear_team", "linear_assignee_email", "label"];
    expect(inputs.map((b) => b.block_id)).toEqual(fields);
    expect(inputs.map((b) => b.element?.action_id)).toEqual(fields);
    expect(inputs[0]?.element?.options?.map((o) => o.value)).toEqual(["telegram", "webhook", "linear"]);
  });
});

describe("parseSinkAddSubmission", () => {
  it("turns a Telegram submission into the config service's input, trimmed", () => {
    const parsed = parseSinkAddSubmission(submitted({ kind: "telegram", bot_token: ` ${BOT_TOKEN} `, chat_id: "-1001234567890", label: " CI " }));
    expect(parsed).toEqual({
      repo: "acme/api",
      channel: "C0CHAN",
      input: { kind: "telegram", repo: "acme/api", botToken: BOT_TOKEN, chatId: "-1001234567890", label: "CI" },
    });
  });

  it("turns a webhook submission into the config service's input and leaves out an empty label", () => {
    const parsed = parseSinkAddSubmission(submitted({ kind: "webhook", webhook_url: "https://hooks.example.com/zeroci", label: "  " }));
    expect(parsed).toEqual({ repo: "acme/api", channel: "C0CHAN", input: { kind: "webhook", repo: "acme/api", url: "https://hooks.example.com/zeroci" } });
  });

  it("names the missing token and chat id of a Telegram sink", () => {
    expect(parseSinkAddSubmission(submitted({ kind: "telegram" }))).toEqual({
      errors: { bot_token: S.slack.sinkModal.needBotToken, chat_id: S.slack.sinkModal.needChatId },
    });
  });

  it("names the missing URL of a webhook sink, whatever the Telegram fields hold", () => {
    expect(parseSinkAddSubmission(submitted({ kind: "webhook", bot_token: BOT_TOKEN }))).toEqual({ errors: { webhook_url: S.slack.sinkModal.needWebhookUrl } });
  });

  it("turns a Linear submission into the config service's input, ignoring the other kinds' fields", () => {
    const parsed = parseSinkAddSubmission(
      submitted({
        kind: "linear",
        linear_api_key: " lin_api_abc123 ",
        linear_team: "ENG",
        linear_assignee_email: " dana@acme.test ",
        bot_token: BOT_TOKEN,
        webhook_url: "https://hooks.example.com/zeroci",
        label: "deploys",
      }),
    );
    expect(parsed).toEqual({
      repo: "acme/api",
      channel: "C0CHAN",
      input: { kind: "linear", repo: "acme/api", apiKey: "lin_api_abc123", teamKey: "ENG", assigneeEmail: "dana@acme.test", label: "deploys" },
    });
    expect(parseSinkAddSubmission(submitted({ kind: "linear", linear_api_key: "lin_api_abc123", linear_team: "ENG" }))).toEqual({
      repo: "acme/api",
      channel: "C0CHAN",
      input: { kind: "linear", repo: "acme/api", apiKey: "lin_api_abc123", teamKey: "ENG" },
    });
  });

  it("names a missing API key and team, and a lowercase team, of a Linear sink", () => {
    expect(parseSinkAddSubmission(submitted({ kind: "linear", chat_id: "-100" }))).toEqual({
      errors: { linear_api_key: S.slack.sinkModal.needLinearApiKey, linear_team: S.slack.sinkModal.needLinearTeam },
    });
    expect(parseSinkAddSubmission(submitted({ kind: "linear", linear_api_key: "lin_api_abc123", linear_team: "eng" }))).toEqual({
      errors: { linear_team: S.slack.sinkModal.badLinearTeam },
    });
  });

  it("asks for a kind when none is chosen", () => {
    expect(parseSinkAddSubmission(submitted({ webhook_url: "https://hooks.example.com/zeroci" }))).toEqual({ errors: { kind: S.slack.sinkModal.chooseKind } });
  });

  it("refuses a submission whose private_metadata it did not write", () => {
    for (const metadata of [undefined, "", "acme/api", JSON.stringify({ repo: "acme/api" })]) {
      const view = { ...submitted({ kind: "webhook", webhook_url: "https://hooks.example.com/zeroci" }), private_metadata: metadata };
      expect(parseSinkAddSubmission(view)).toEqual({
        errors: { kind: S.slack.sinkModal.expired },
      });
    }
  });
});

describe("isSlackViewSubmission", () => {
  it("accepts a submitted view and refuses shapes the parse cannot read", () => {
    expect(isSlackViewSubmission(submitted({ kind: "telegram" }))).toBe(true);
    expect(isSlackViewSubmission({ private_metadata: "{}" })).toBe(true);
    expect(isSlackViewSubmission(null)).toBe(false);
    expect(isSlackViewSubmission({ private_metadata: 7 })).toBe(false);
    expect(isSlackViewSubmission({ state: { values: { kind: "telegram" } } })).toBe(false);
    expect(isSlackViewSubmission({ state: { values: { kind: { kind: null } } } })).toBe(false);
  });
});
