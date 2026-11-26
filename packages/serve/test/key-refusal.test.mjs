// A provider that refuses the run's key (401) reads, in the run's error, as the key by name and where to set it, never
// the provider's raw answer and never the key: on the OpenRouter route for every harness (the texts below are what
// pi-ai, the pinned Claude CLI and the pinned Codex binary each said for OpenRouter's 401 {"error":{"message":"User not
// found"}}), on a direct provider, and on serve's gateway. A pi run through a loopback gateway that answers 401 ends
// with those words as its error.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { agent, follow, serve, withEnv } from "./support.mjs";
import { redactedAnswer, redactedCall } from "../dist/key-refusal.js";

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
  withEnv(t, { AGENT_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/api`, AGENT_MODEL: "openai/gpt-6.1-sol", AGENT_MODEL_API_KEY: KEY, AGENT_MODEL_PRICE: "1,2,0.5" }, NAMES);
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

// Python's "\x20" is a space to the view that reads a single-quoted dict through Python's escapes, so padding of it
// between a held value's head and its rest is nothing there: the read past a call's stop, and the tail of a run too long
// to read, count it as the view does, and the value reads whole.
const [PY_HEAD, PY_REST] = [["Wc3M", "hT8q", "Lz5N", "rB1v"].join(""), ["Xe6K", "pJ4d", "Ys9G", "fA2u"].join("")];
const PY_PAD = String.raw`\x20`.repeat(60);

test("kr-7: a held value split at a call's stop in a single-quoted string, Python's \\x20 padding past the read after the stop, is withheld", () => {
  let text = "{'a': '";
  while (text.length < 8192 - 100) text += "word ";
  text += `see ${PY_HEAD} ${PY_PAD}${PY_REST} more'}`;
  assert.equal(redactedCall(text, [`${PY_HEAD}${PY_REST}`], 200), "[redacted]");
});

test("kr-8: a held value whose head ends a run too long to read, Python's \\x20 padding after it, and whose rest follows is withheld", () => {
  const text = `'${"a".repeat(9000)}${PY_HEAD}${PY_PAD} ${PY_REST} more'`;
  for (const out of [redactedCall(text, [`${PY_HEAD}${PY_REST}`], 100_000), redactedAnswer(text, [`${PY_HEAD}${PY_REST}`])]) assert.equal(out.includes(PY_REST), false);
});

// A control character that is no whitespace (a NUL, U+0001, an escape, a delete) is nothing to the views, as it stands
// and as JSON's or Python's escape writes it, so padding of it between a held value's head and its rest is nothing
// too: the read past a call's stop, and the tail of a run too long to read, count it as the views do, and the value
// reads whole. Each padding is longer than what the read after the stop takes when each control counts as a character.
const CONTROL_PADS = [
  ["raw NULs", "\u0000".repeat(300), "json"],
  ["raw U+0001 to U+001F and DEL", Array.from({ length: 300 }, (_, i) => String.fromCharCode([1, 8, 14, 27, 31, 127][i % 6])).join(""), "json"],
  ["JSON's \\u0001", String.raw`\u0001`.repeat(300), "json"],
  ["Python's \\x01", String.raw`\x01`.repeat(250), "python"],
  // U+FFFF, a noncharacter, shows as a box at most: the views drop it in the text (only a join's own separator is one).
  ["raw U+FFFF", "\uffff".repeat(300), "json"],
  ["JSON's \\uffff", String.raw`\uffff`.repeat(300), "json"],
  // A terminal sequence shows as nothing in a terminal, and a backspace strikes out the character before it.
  ["raw CSI colours", "\u001b[0m".repeat(300), "json"],
  ["JSON's \\u001b CSI colours", String.raw`\u001b[1;31m`.repeat(300), "json"],
  ["raw OSC titles", "\u001b]0;t\u0007".repeat(300), "json"],
  ["backspace overstrikes", "Z\b".repeat(300), "json"],
  ["backspace overstrikes of a character past U+FFFF", "\u{10400}\b".repeat(300), "json"],
  // The same sequences in each escaped form the views decode: each counts as nothing there too.
  ["percent-encoded CSI colours", "%1B%5B%30%6D".repeat(300), "json"],
  ["percent-encoded ESC, then the rest as it stands", "%1B%5B0m".repeat(300), "json"],
  ["Python's \\x1b CSI colours", String.raw`\x1b[0m`.repeat(250), "python"],
  ["HTML's &#27; CSI colours", "&#27;[0m".repeat(300), "json"],
  ["HTML's &#x1b; CSI colours", "&#x1b;[0m".repeat(300), "json"],
  ["raw 8-bit CSI colours", "\u009b0m".repeat(300), "json"],
  ["JSON's \\u009b CSI colours", String.raw`\u009b0m`.repeat(300), "json"],
  ["percent-encoded 8-bit CSI colours", "%C2%9B%30%6D".repeat(300), "json"],
  // A NUL inside a sequence is ignored by a terminal: the sequence still ends at its final byte.
  ["raw CSI colours with a NUL inside", "\u001b[0\u0000m".repeat(300), "json"],
  ["JSON's \\u001b CSI colours with a \\u0000 inside", String.raw`\u001b[0\u0000m`.repeat(300), "json"],
  ["percent-encoded CSI colours with a NUL inside", "%1B%5B%30%00%6D".repeat(300), "json"],
  ["raw OSC titles with a NUL inside", "\u001b]0;\u0000t\u0007".repeat(300), "json"],
  // A blank that takes a cell, struck out with the character before it; a character past ASCII inside a CSI.
  ["braille blank overstrikes", "Z\u2800\b\b".repeat(300), "json"],
  ["space overstrikes", "Z \b\b".repeat(300), "json"],
  ["raw CSI colours with a character past ASCII inside", "\u001b[0\u00e9m".repeat(300), "json"],
  ["percent-encoded CSI colours with a character past ASCII inside", "%1B%5B%30%C3%A9%6D".repeat(300), "json"],
  // A percent-encoded U+FFFD is a character past ASCII like any other, and bytes that are no UTF-8 read as U+FFFD.
  ["percent-encoded CSI colours with U+FFFD inside", "%1B%5B0%EF%BF%BDm".repeat(300), "json"],
  ["percent-encoded CSI colours with a byte that is no UTF-8 inside", "%1B%5B0%FFm".repeat(300), "json"],
  // A byte order mark is whitespace and default-ignorable: a terminal sequence passes over it, percent-encoded too.
  ["percent-encoded CSI colours with a byte order mark inside", "%1B%5B0%EF%BB%BFm".repeat(300), "json"],
  ["percent-encoded OSC titles with a byte order mark inside", "%1B%5D0%3Bt%EF%BB%BF%07".repeat(300), "json"],
  ["percent-encoded escapes with a byte order mark inside", "%1B(%EF%BB%BFB".repeat(300), "json"],
  // What a join view drops inside an escape (a colon, a no-break space) leaves the escape whole there.
  ["raw escapes with a colon inside", "\u001b(:B".repeat(300), "json"],
  ["raw escapes with a no-break space inside", "\u001b(\u00a0B".repeat(300), "json"],
  // Characters that show as a box or a blank: U+FFFE, the braille blank, a lone surrogate as JSON's escape.
  ["raw U+FFFE", "\ufffe".repeat(300), "json"],
  ["raw braille blanks", "\u2800".repeat(300), "json"],
  ["JSON's \\ud800", String.raw`\ud800`.repeat(300), "json"],
];
const wrapped = (kind, body) => (kind === "python" ? `{'a': '${body}'}` : `{"a": "${body}"}`);

for (const [what, pad, kind] of CONTROL_PADS) {
  test(`kr-9 (${what}): a held value split at a call's stop, control padding past the read after the stop, is withheld`, () => {
    let body = "";
    while (body.length < 8192 - 100) body += "word ";
    assert.equal(redactedCall(wrapped(kind, `${body}see ${PY_HEAD} ${pad}${PY_REST} more`), [`${PY_HEAD}${PY_REST}`], 200), "[redacted]");
  });

  test(`kr-10 (${what}): a held value whose head ends a run too long to read, control padding after it, and whose rest follows is withheld`, () => {
    const text = wrapped(kind, `${"a".repeat(9000)}${PY_HEAD}${pad} ${PY_REST} more`);
    for (const out of [redactedCall(text, [`${PY_HEAD}${PY_REST}`], 100_000), redactedAnswer(text, [`${PY_HEAD}${PY_REST}`])]) assert.equal(out.includes(PY_REST), false);
  });
}

test("kr-11: control padding after a word, with no held value split around it, is shown (control)", () => {
  let body = "";
  while (body.length < 8192 - 100) body += "word ";
  const text = wrapped("json", `${body}see ${PY_HEAD} ${"\u0000".repeat(300)}zzzzzzzzzzzzzzzz more`);
  assert.equal(redactedCall(text, [`${PY_HEAD}${PY_REST}`], 200).startsWith(`{"a": "word word`), true);
});
