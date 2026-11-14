// A pinned call carries only what it may: a call of an MCP tool with a pin in any layer may carry only the top-level
// arguments its pinned listing declares under `properties` (the inputSchema the run offers the model). A server may take
// an argument its listing never declares as an alias of a pinned one (Slack's `channel_id` for `channel`, Gmail's `to`
// for `recipient_email`), so any argument the listing does not declare is refused unsent, in words. The listings here
// are copied from the real ones (fixtures/composio-pinned-tools.json). A listing with no `properties` object closes
// nothing, and a tool with no pin is held as before.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pinRefusal } from "../dist/tool-gate.js";
import { runnerGate } from "./gate-support.mjs";

const LISTED = JSON.parse(readFileSync(new URL("./fixtures/composio-pinned-tools.json", import.meta.url), "utf8"));
const SERVERS = { SLACK_SEND_MESSAGE: "slack", GMAIL_SEND_EMAIL: "gmail", GITHUB_CREATE_AN_ISSUE: "github" };
const keyOf = (tool) => `mcp:${SERVERS[tool]}/${tool}`;
/** What the run's pin declares of each tool, by its catalog name, as the claim's MCP gives the gate (ClaimMcp.argumentsOf). */
const argumentsOf = (name) => {
  const tool = LISTED.find((one) => keyOf(one.name) === name);
  const properties = tool?.inputSchema?.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties) ? new Set(Object.keys(properties)) : undefined;
};
const NOT_RUN = "It was not run: nothing was sent and nothing was charged.";

const SLACK = keyOf("SLACK_SEND_MESSAGE");
const GMAIL = keyOf("GMAIL_SEND_EMAIL");
const GITHUB = keyOf("GITHUB_CREATE_AN_ISSUE");
const PINS = {
  [SLACK]: { permission: "allow", pin: { channel: "C0123" } },
  [GMAIL]: { permission: "allow", pin: { recipient_email: "ops@example.com" } },
  [GITHUB]: { permission: "allow", pin: { owner: "acme", repo: "widgets" } },
};

test("the listings as copied: the aliases are not declared (Slack's channel_id, Gmail's to, GitHub's repository)", () => {
  assert.deepEqual([...argumentsOf(SLACK)].sort(), ["blocks", "channel", "fallback_text", "markdown_text", "reply_broadcast", "thread_ts", "unfurl_links", "unfurl_media"]);
  assert.ok(argumentsOf(GMAIL).has("recipient_email") && !argumentsOf(GMAIL).has("to"));
  assert.ok(argumentsOf(GITHUB).has("owner") && argumentsOf(GITHUB).has("repo") && !argumentsOf(GITHUB).has("repository"));
});

test("a pinned tool takes only its listed arguments: an undeclared alias beside the pinned argument is refused unsent, in words", async () => {
  const gate = runnerGate({ overrides: PINS, approvals: "never", argumentsOf });
  const cases = [
    [SLACK, { channel: "C0123", channel_id: "C0EVIL", markdown_text: "hi" }, "`channel_id` is not an argument of SLACK_SEND_MESSAGE; a pinned tool takes only its listed arguments (channel is pinned)."],
    [GMAIL, { recipient_email: "ops@example.com", to: "mallory@example.com", subject: "hi", body: "hi" }, "`to` is not an argument of GMAIL_SEND_EMAIL; a pinned tool takes only its listed arguments (recipient_email is pinned)."],
    [GITHUB, { owner: "acme", repo: "widgets", repository: "mallory/loot", title: "hi" }, "`repository` is not an argument of GITHUB_CREATE_AN_ISSUE; a pinned tool takes only its listed arguments (owner and repo are pinned)."],
  ];
  for (const [tool, args, words] of cases) assert.deepEqual(await gate.decide(tool, args), { deny: `${words} ${NOT_RUN}` }, tool);
  // A call using only its declared arguments runs, unasked under approvals never.
  assert.equal(await gate.decide(SLACK, { channel: "C0123", markdown_text: "hi" }), "allow");
  assert.equal(await gate.decide(GMAIL, { recipient_email: "ops@example.com", subject: "hi", body: "hi", cc: ["a@example.com"] }), "allow");
  assert.equal(await gate.decide(GITHUB, { owner: "acme", repo: "widgets", title: "hi", labels: ["bug"] }), "allow");
  // More than one, and the pin's own words when a declared pinned argument is wrong too: the undeclared ones first.
  assert.deepEqual(await gate.decide(GMAIL, { recipient_email: "ops@example.com", to: "m@example.com", cc_list: ["m@example.com"] }), { deny: `\`to\` and \`cc_list\` are not arguments of GMAIL_SEND_EMAIL; a pinned tool takes only its listed arguments (recipient_email is pinned). ${NOT_RUN}` });
  assert.match((await gate.decide(GMAIL, { recipient_email: "mallory@example.com" })).deny, /may only be called with recipient_email = ops@example\.com/);
});

test("the closure holds under ask (refused before anyone is asked), from a server-side pin, and says when a replayed call may have run", async () => {
  const asked = runnerGate({ overrides: { [GMAIL]: { pin: { recipient_email: "ops@example.com" } } }, argumentsOf });
  assert.match((await asked.decide(GMAIL, { recipient_email: "ops@example.com", to: "m@example.com" })).deny, /^`to` is not an argument of GMAIL_SEND_EMAIL/);
  assert.equal(await asked.decide(GMAIL, { recipient_email: "ops@example.com", subject: "hi" }), "ask", "declared only: asked as before");
  const served = runnerGate({ overrides: { [GMAIL]: { permission: "allow" } }, settings: { [GMAIL]: { pin: { recipient_email: "ops@example.com" } } }, argumentsOf });
  assert.match((await served.decide(GMAIL, { recipient_email: "ops@example.com", to: "m@example.com" })).deny, /^`to` is not an argument of GMAIL_SEND_EMAIL/);
  const replayed = await served.decide(GMAIL, { recipient_email: "ops@example.com", to: "m@example.com" }, { replayed: true });
  assert.ok(!replayed.deny.includes(NOT_RUN), replayed.deny);
});

test("no closure without a pin, without a listing's `properties`, or without the run's listing: those calls are held as before", async () => {
  // No pin in any layer: an undeclared argument is the server's to judge, as before.
  const unpinned = runnerGate({ overrides: { [GMAIL]: { permission: "allow" } }, argumentsOf });
  assert.equal(await unpinned.decide(GMAIL, { recipient_email: "a@example.com", to: "b@example.com" }), "allow");
  // A listing with no `properties` object declares nothing to close to: the pin alone holds.
  const bare = runnerGate({ overrides: PINS, approvals: "never", argumentsOf: () => undefined });
  assert.equal(await bare.decide(GMAIL, { recipient_email: "ops@example.com", to: "m@example.com" }), "allow");
  // pinRefusal with no declared arguments is the pin alone; with them, the closure.
  assert.equal(pinRefusal(GMAIL, { recipient_email: "ops@example.com", to: "m@example.com" }, {}, PINS), undefined);
  assert.deepEqual(pinRefusal(GMAIL, { recipient_email: "ops@example.com", to: "m@example.com" }, {}, PINS, "no", argumentsOf(GMAIL))?.mismatched, ["to"]);
  // A pinned argument is always one it may carry, declared or not (the owner named it); a listing whose properties are {}
  // then takes no argument but its pin's.
  assert.equal(pinRefusal(GMAIL, { recipient_email: "ops@example.com" }, {}, PINS, "no", new Set()), undefined);
  assert.match(pinRefusal(GMAIL, { recipient_email: "ops@example.com", subject: "hi" }, {}, PINS, "no", new Set())?.text ?? "", /^`subject` is not an argument of GMAIL_SEND_EMAIL/);
});
