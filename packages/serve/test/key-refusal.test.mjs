// A provider that refuses the run's key (401) reads, in the run's error, as the key by name and where to set it, never
// the provider's raw answer and never the key: on the OpenRouter route for every harness (the texts below are what
// pi-ai, the pinned Claude CLI and the pinned Codex binary each said for OpenRouter's 401 {"error":{"message":"User not
// found"}}), on a direct provider, and on serve's gateway. A pi run through a loopback gateway that answers 401 ends
// with those words as its error.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { agent, follow, serve, withEnv } from "./support.mjs";

const KEY = `not-a-secret-${"openrouter-key"}`;
const ONLY = { OPENROUTER_API_KEY: KEY };
const OPENROUTER = "OpenRouter refused OPENROUTER_API_KEY (401: User not found): set it where AgentRun starts, or save it in Settings → Model keys.";
/** What each harness said for OpenRouter's 401, as the run's error row carries it. */
const SAID = {
  pi: '401: {"message":"User not found","code":401}',
  "pi, an Anthropic model": '401 {"error":{"message":"User not found","code":401}}',
  "claude-agent": "claude-agent: Failed to authenticate. API Error: 401 User not found",
  codex: "codex: unexpected status 401 Unauthorized: User not found, url: http://127.0.0.1:43269/v1/responses",
};
/** What each harness said for OpenRouter's 401 on 2026-11-04, on this route with a dummy key (#1537's live-proof dry run):
 *  pi-ai's chat completions, the pinned Claude CLI and the pinned Codex binary, as each run's error carried it. */
const SAID_LIVE = {
  pi: '401: {"message":"User not found.","code":401}',
  "claude-agent": "claude-agent: Failed to authenticate. API Error: 401 User not found.",
  codex: "codex: unexpected status 401 Unauthorized: User not found., url: http://127.0.0.1:37839/v1/responses",
};
/** pi-ai's words for serve's gateway's 401 (AGENT_MODEL_BASE_URL, its Responses API): the provider's name, then the
 *  status in parentheses. */
const SAID_GATEWAY = 'agent-model API error (401): {"message":"User not found","code":401}';
/** Errors holding a bare 401 that is no provider's status: a count, a file name, a duration, money, and another service's
 *  HTTP 401 (a tool's fetch). None of them is a refused model key. */
const NOT_REFUSALS = {
  "a count": "the tool returned 401 rows",
  "a file name": "write failed: ENOENT: no such file or directory, open 'report-401.txt'",
  "a duration": "timed out after 401 ms",
  money: "spend_cap_reached: the next model request was not sent: the run has spent $401 of its $500 cap",
  "another service's 401": "GET https://example.com/x answered 401",
};
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

test("kr-1: on OpenRouter's key alone, a 401 names OPENROUTER_API_KEY and where to set it, on every harness, with the provider's first sentence only", async () => {
  const { keyRefusal, runKeyOf } = await import("../dist/key-refusal.js");
  for (const [harness, text] of [["pi", SAID.pi], ["pi", SAID["pi, an Anthropic model"]], ["claude-agent", SAID["claude-agent"]], ["codex", SAID.codex]]) {
    assert.equal(keyRefusal(text, runKeyOf(ONLY, harness)), OPENROUTER, `${harness}: ${text}`);
  }
  assert.equal(keyRefusal('401 {"error":{"message":"User not found. Check the key. Then retry."}}', runKeyOf(ONLY)), OPENROUTER, "the first sentence only");
});

test("kr-2: a direct provider's 401 names its own key; serve's gateway names its key, set where AgentRun starts; a key's value is never echoed; anything else is left as it is", async () => {
  const { keyRefusal, runKeyOf } = await import("../dist/key-refusal.js");
  assert.equal(keyRefusal(SAID["claude-agent"], runKeyOf({ ANTHROPIC_API_KEY: "a" }, "claude-agent")), "Anthropic refused ANTHROPIC_API_KEY (401: User not found): set it where AgentRun starts, or save it in Settings → Model keys.");
  assert.equal(keyRefusal(SAID.codex, runKeyOf({ OPENAI_API_KEY: "o" }, "codex")), "OpenAI refused OPENAI_API_KEY (401: User not found): set it where AgentRun starts, or save it in Settings → Model keys.");
  assert.equal(keyRefusal(SAID.pi, runKeyOf({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "m" })), "The gateway at AGENT_MODEL_BASE_URL refused AGENT_MODEL_API_KEY (401: User not found): set it where AgentRun starts.");
  assert.equal(keyRefusal(`401 {"error":{"message":"Key ${KEY} is not valid"}}`, runKeyOf(ONLY), [KEY]), "OpenRouter refused OPENROUTER_API_KEY (401: Key [redacted] is not valid): set it where AgentRun starts, or save it in Settings → Model keys.");
  assert.equal(keyRefusal("429 rate limited", runKeyOf(ONLY)), undefined, "not a refused key");
  assert.equal(keyRefusal("codex: the run took 4012 ms", runKeyOf(ONLY, "codex")), undefined, "401 inside another number is not a status");
});

test("kr-3: a pi run whose gateway refuses its key (401) fails with the key named and where to set it, not the provider's JSON", { timeout: 60_000 }, async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "User not found", code: 401 } })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  withEnv(t, { AGENT_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/api`, AGENT_MODEL: "openai/gpt-6-sol", AGENT_MODEL_API_KEY: KEY, AGENT_MODEL_PRICE: "1,2,0.5" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("refused"))).status, 201);
  const started = await api("POST", "/agents/refused/runs", { input: { content: "Say hi." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["failed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(run.error?.message, "The gateway at AGENT_MODEL_BASE_URL refused AGENT_MODEL_API_KEY (401: User not found): set it where AgentRun starts.", JSON.stringify(run.error));
  assert.ok(!JSON.stringify(run).includes(KEY), "the key is nowhere in the run");
});

test("kr-4: a key the provider echoes across the cut at 200 characters leaves no part of itself in the error", async () => {
  const { keyRefusal, runKeyOf } = await import("../dist/key-refusal.js");
  const secretPart = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
  const key = `not-a-secret-${secretPart}`;
  // The key starts at the detail's 176th character, so the 200-character cut falls inside it.
  const said = keyRefusal(`401 {"error":{"message":"${"y".repeat(175)} ${key} is not a valid key here"}}`, runKeyOf(ONLY), [key]);
  assert.ok(said?.startsWith("OpenRouter refused OPENROUTER_API_KEY (401: "), said);
  for (let at = 0; at + 8 <= secretPart.length; at++) assert.ok(!said.includes(secretPart.slice(at, at + 8)), `"${secretPart.slice(at, at + 8)}" of the key is in: ${said}`);
});

test("kr-5: each 401 shape the harnesses give today is a refused key: OpenRouter's through pi-ai, the Claude CLI and the Codex binary, and pi-ai's for serve's gateway", async () => {
  const { keyRefusal, runKeyOf } = await import("../dist/key-refusal.js");
  for (const [harness, text] of Object.entries(SAID_LIVE)) assert.equal(keyRefusal(text, runKeyOf(ONLY, harness)), OPENROUTER, `${harness}: ${text}`);
  assert.equal(keyRefusal(SAID_GATEWAY, runKeyOf({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "m" })), "The gateway at AGENT_MODEL_BASE_URL refused AGENT_MODEL_API_KEY (401: User not found): set it where AgentRun starts.");
});

for (const [what, text] of Object.entries(NOT_REFUSALS)) {
  test(`kr-6 (${what}): an error holding a bare 401 that is no provider's status is left as it is, on every harness: ${text}`, async () => {
    const { keyRefusal, runKeyOf } = await import("../dist/key-refusal.js");
    for (const harness of ["pi", "claude-agent", "codex"]) {
      // As each harness's run error carries it: claude-agent's and codex's adapters name the harness first.
      const said = harness === "pi" ? text : `${harness}: ${text}`;
      assert.equal(keyRefusal(said, runKeyOf(ONLY, harness)), undefined, said);
    }
  });
}
