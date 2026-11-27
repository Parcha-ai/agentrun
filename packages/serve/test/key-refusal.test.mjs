// A provider that refuses the run's key (401) reads, in the run's error, as the key by name and where to set it, never
// the provider's raw answer and never the key: on the OpenRouter route for every harness (the texts below are what
// pi-ai, the pinned Claude CLI and the pinned Codex binary each said for OpenRouter's 401 {"error":{"message":"User not
// found"}}), on a direct provider, and on serve's gateway. A pi run through a loopback gateway that answers 401 ends
// with those words as its error.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { agent, follow, serve, withEnv } from "./support.mjs";
import { readCost, redactedAnswer, redactedCall } from "../dist/key-refusal.js";
import { marksOf, OPEN_OSC, scanned, shownIn } from "../dist/redact/match.js";
import { CALL_RESULT_CHARS, scrubUrls } from "../dist/timeline/index.js";
import { cut } from "../dist/timeline/util.js";
import { coverTally } from "./fixtures/marks-cover.mjs";

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
  // An escaped quote decodes to nothing in the view that reads a string written in a string, and a terminal sequence
  // with one inside reads whole there.
  ["JSON's \\u001b CSI colours with an escaped quote inside", String.raw`\u001b[0\"m`.repeat(300), "json"],
  ["JSON's \\u001b OSC titles with escaped quotes inside", String.raw`\u001b]0;\"t\"\u0007`.repeat(300), "json"],
  ["raw CSI colours with an escaped quote inside", '\u001b[0\\"m'.repeat(300), "json"],
  // Written in JSON twice, an escaped quote inside a CSI opened by HTML's or percent's ESC: only the view that decodes
  // percent, JSON and HTML escapes in the text as a whole reads each CSI whole.
  ["HTML's &#x1b; CSI colours with an escaped quote written in JSON twice inside", String.raw`&#x1b;[0\\"m`.repeat(300), "json"],
  ["percent-encoded CSI colours with an escaped quote written in JSON twice inside", String.raw`%1B[0\\"m`.repeat(250), "python"],
  // What a join view drops inside an escape (a colon, a no-break space) leaves the escape whole there.
  ["raw escapes with a colon inside", "\u001b(:B".repeat(300), "json"],
  ["raw escapes with a no-break space inside", "\u001b(\u00a0B".repeat(300), "json"],
  // An ESC written in another encoding inside a sequence: the decoding that reads it as one reads a sequence of its
  // own from there, which can end inside the next sequence's opener as the text decodes it. That opener still opens.
  ["JSON's \\u001b OSC titles with a percent-encoded ESC inside", `${String.raw`\u001b]0;t%1B`}\u0007`.repeat(300), "json"],
  ["Python's \\x1b OSC titles with a percent-encoded ESC inside", `${String.raw`\x1b]0;t%1B`}\u0007`.repeat(250), "python"],
  ["Python's \\x1b OSC titles with HTML's &#27; inside", `${String.raw`\x1b]0;t&#27;`}\u0007`.repeat(250), "python"],
  ["raw CSI colours with JSON's \\u001b written twice inside", `\u001b[0${String.raw`\\u001b`}m`.repeat(300), "json"],
  ["percent-encoded OSC titles with JSON's \\u001b written twice inside", `%1B]0;t${String.raw`\\u001b`}\u0007`.repeat(300), "json"],
  // In JSON written in JSON, an HTML-escaped OSC title holding an escaped quote and ended by a raw ST that ends a
  // string: only the view that reads the inner strings, decoding percent, JSON and HTML escapes, reads it whole.
  ["HTML's &#27; OSC titles holding an escaped quote, each ended by an ST that ends a string", `${String.raw`&#27;]0;t\\"`}\u001b${String.raw`\\", \"`}`.repeat(300), "json in json"],
  // A Python repr written in JSON: only the view that reads Python's escapes through JSON's reads each title whole (a
  // percent-encoded ESC is three characters there, and an escaped apostrophe one).
  ["Python's \\x1b OSC titles written in JSON, holding a percent-encoded ESC and an escaped apostrophe", String.raw`\\x1b]0;t%1B\'\u0007`.repeat(300), "json in json"],
  // Characters that show as a box or a blank: U+FFFE, the braille blank, a lone surrogate as JSON's escape.
  ["raw U+FFFE", "\ufffe".repeat(300), "json"],
  ["raw braille blanks", "\u2800".repeat(300), "json"],
  ["JSON's \\ud800", String.raw`\ud800`.repeat(300), "json"],
];
const wrapped = (kind, body) => (kind === "python" ? `{'a': '${body}'}` : kind === "json in json" ? `{"a": "[\\"${body}\\"]"}` : `{"a": "${body}"}`);

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

// A JSON writer writes ST (ESC and a backslash) as "\u001b" and two backslashes. Where the string's closing quote
// follows it, JSON's second level reads the two backslashes and the quote as one escaped quote, which decodes to
// nothing; the views that read one level read the ST, and an OSC title before it is a whole sequence there, however
// long.
const TITLE = `${String.raw`\u001b]0;`}${"x".repeat(250)}${String.raw`\u001b\\`}`;
const endingAString = (before, after) => `["${before}${TITLE}", "${after}"]`;
test("kr-9 (an OSC title ended by ST that ends a string): a held value split at a call's stop around it is withheld", () => {
  let body = "";
  while (body.length < 8192 - 100) body += "word ";
  assert.equal(redactedCall(endingAString(`${body}see ${PY_HEAD} `, `${PY_REST} more`), [`${PY_HEAD}${PY_REST}`], 200), "[redacted]");
});

test("kr-10 (an OSC title ended by ST that ends a string): a held value whose head ends a run too long to read, the title after it, and whose rest follows is withheld", () => {
  const long = endingAString(`${"a".repeat(9000)}${PY_HEAD}`, `${PY_REST} more`);
  for (const out of [redactedCall(long, [`${PY_HEAD}${PY_REST}`], 100_000), redactedAnswer(long, [`${PY_HEAD}${PY_REST}`])]) assert.equal(out.includes(PY_REST), false);
});

// An ST's backslash read with what follows it as one escape: JSON's second level reads "\\" and a letter of its
// escapes ("n", "t", "r", "b", "f", "/", or "u" and four hex digits) as one, and Python's "\\" and "x" and two hex
// digits; a raw ST's backslash and a letter read as JSON's escape. The views that read the text as it stands, or one
// level of escapes, read the ST there, and then the letter as the held value's own. Each title is past the read, the
// held value split right after it.
const X250 = "x".repeat(250);
const FROM_R = ["Wc3MhT8qLz5N", `rB1v${PY_REST}`];
const FOLLOWED_TITLES = [
  ["a raw OSC title ended by ST, then a letter, in terminal output", (before, after) => `${before}\u001b]0;${X250}\u001b\\${after}`, FROM_R],
  ["a JSON writer's OSC title ended by ST, then a letter", (before, after) => `["${before}${TITLE}${after}"]`, FROM_R],
  ["a JSON writer's OSC title ended by ST, then u and four hex digits", (before, after) => `["${before}${TITLE}${after}"]`, ["Wc3MhT8qLz5N", `uface${PY_REST}`]],
  ["a Python repr's OSC title ended by ST, then x and two hex digits", (before, after) => `['${before}${String.raw`\x1b]0;`}${X250}${String.raw`\x1b\\`}${after}']`, ["Wc3MhT8qLz5N", `xab${PY_REST}`]],
  ["a percent-encoded OSC title ended by a JSON writer's ST that ends a string", (before, after) => `["${before}%1B]0;${X250}%1B${String.raw`\\`}", "${after}"]`, FROM_R],
  ["an OSC title written in JSON twice, its ST's backslash once, that ends a string", (before, after) => `["${before}${String.raw`\\u001b]0;`}${X250}${String.raw`\\u001b\\`}", "${after}"]`, FROM_R],
  // A title whose ESCs are written in two encodings: only the view that decodes its opener and its ST, and reads no
  // ESC inside it, reads it whole.
  ["a raw OSC title holding a percent-encoded ESC, ended by a raw ST, then a letter", (before, after) => `${before}\u001b]0;${X250}%1B\u001b\\${after}`, FROM_R],
  ["a raw OSC title ended by a percent-encoded ESC and a backslash, then a letter", (before, after) => `${before}\u001b]0;${X250}%1B\\${after}`, FROM_R],
  ["a JSON writer's OSC title ended by a percent-encoded ESC and a JSON-escaped backslash, then a letter", (before, after) => `["${before}${String.raw`\u001b]0;`}${X250}%1B${String.raw`\\`}${after}"]`, FROM_R],
  // Two views read this title whole, the one that decodes JSON's two levels in the whole text and the one that does
  // in its strings; each read covers the other, and dropping both fails it.
  ["an OSC title written in JSON twice, holding a percent-encoded ESC, ended by an ST whose backslash is written as it stands, then x and two hex digits", (before, after) => `["${before}${String.raw`\\u001b]0;`}${X250}%1B${String.raw`\\u001b`}\\${after}"]`, ["Wc3MhT8qLz5N", `xab${PY_REST}`]],
];
for (const [what, text, [head, rest]] of FOLLOWED_TITLES) {
  test(`kr-9 (${what}): a held value split at a call's stop around it is withheld`, () => {
    let body = "";
    while (body.length < 8192 - 100) body += "word ";
    assert.equal(redactedCall(text(`${body}see ${head} `, `${rest} more`), [`${head}${rest}`], 200), "[redacted]");
  });

  test(`kr-10 (${what}): a held value whose head ends a run too long to read, the title after it, and whose rest follows is withheld`, () => {
    const long = text(`${"a".repeat(9000)}${head}`, `${rest} more`);
    for (const out of [redactedCall(long, [`${head}${rest}`], 100_000), redactedAnswer(long, [`${head}${rest}`])]) assert.equal(out.includes(PY_REST), false);
  });
}

// Padding whose sequences are written in more than one encoding at once: an opener, a terminator, or an ESC inside in
// another encoding than the rest, so that the views each read the padding their own way. One view reads a terminator
// where another reads it as the opener of the next sequence; one reads a unit's tail as part of a hidden sequence where
// another reads it as text; the view that reads a string written in a string drops a "]" or a "[" that another reads
// as a CSI's or an OSC's. Each padding is withheld by the matcher between a held value's halves (checked first), and
// then must be withheld 300 times over, past the read after a call's stop (kr-9) and after a run too long to read
// (kr-10), in each way the text can be written: in a JSON string, a Python repr's string, as it stands, and in a JSON
// string written in a JSON string.
const B = "\\";
const WRAPS = { json: (s) => `{"a": "${s}"}`, py: (s) => `{'a': '${s}'}`, plain: (s) => s, jj: (s) => `{"a": "[\\"${s}\\"]"}` };
const ALL_WRAPS = ["json", "py", "plain", "jj"];
const MIXED_PADS = [
  // A raw OSC ended by JSON's BEL, then an ST written as a percent-encoded ESC and JSON's backslash.
  ["a raw OSC title ended by JSON's \\u0007, then %1B and JSON's backslash", `\u001b]0;t${B}u0007%1B${B}${B}`, ALL_WRAPS],
  ["JSON's 8-bit OSC, HTML's ESC, a percent-encoded BEL, then t", `${B}u009d&#27;%07t`, ALL_WRAPS],
  ["a raw 8-bit OSC, a percent-encoded ESC, JSON's \\u0007 written twice, then B", `\u009d%1B${B}${B}u0007B`, ALL_WRAPS],
  ["a raw OSC title ended by JSON's \\u0007, then %1B and JSON's \\u0041", `\u001b]0;t${B}u0007%1B${B}u0041`, ALL_WRAPS],
  ["JSON's ESC ] ESC, then JSON's \\u0041 written twice", `${B}u001b${B}u005d${B}u001b${B}${B}u0041`, ["json"]],
  ["JSON's 8-bit OSC, a raw ESC, JSON's \\u006e written twice, JSON's \\u0007, ending a string", `${B}u009d\u001b${B}${B}u006e${B}u0007", "`, ALL_WRAPS],
  ["HTML's ESC and [, then ;]m", "&#27;&#91;;]m", ["json"]],
  // Read whole by one decoding only: JSON's escapes once (the first), JSON's escapes in the strings (the second).
  ["JSON's OSC title holding %07, Python's \\x07 and JSON's \\u0007 written twice, ended by JSON's \\u0007", `${B}u001b]0;t%07X${B}x07Y${B}${B}u0007Z${B}u0007`, ALL_WRAPS],
  ["JSON's OSC title holding %07 and Python's \\x07, ended by an ST written twice that ends a string", `${B}u001b]0;t%07a${B}x07b${B}${B}u001b${B}${B}", "`, ["json", "jj"]],
  // A raw OSC title holding a terminator, an ESC or a CAN in another encoding, then text, then a raw BEL.
  ...[
    ["JSON's \\u0007", `${B}u0007`],
    ["a percent-encoded BEL", "%07"],
    ["HTML's &#7;", "&#7;"],
    ["Python's \\x07", `${B}x07`],
    ["a percent-encoded ESC", "%1B"],
    ["JSON's \\u009c", `${B}u009c`],
    ["a percent-encoded CAN", "%18"],
  ].map(([what, inner]) => [`a raw OSC title holding ${what} and then XYZW, ended by a raw BEL`, `\u001b]0;t${inner}XYZW\u0007`, ALL_WRAPS]),
];
for (const [what, pad, wraps] of MIXED_PADS) {
  const value = `${PY_HEAD}${PY_REST}`;
  const held = (wrap) => assert.equal(redactedAnswer(WRAPS[wrap](`see ${PY_HEAD}${pad.repeat(3)} ${PY_REST} more`), [value]).includes(PY_REST), false, `the matcher withholds the padding, ${wrap}`);
  test(`kr-9 (${what}): a held value split at a call's stop around the padding is withheld, in ${wraps.join(", ")}`, () => {
    let body = "";
    while (body.length < 8092) body += "word ";
    const shown = [];
    for (const wrap of wraps) {
      held(wrap);
      if (redactedCall(WRAPS[wrap](`${body}see ${PY_HEAD} ${pad.repeat(300)} ${PY_REST} more`), [value], 200) !== "[redacted]") shown.push(wrap);
    }
    assert.deepEqual(shown, []);
  });

  test(`kr-10 (${what}): a held value whose head ends a run too long to read, the padding after it, and whose rest follows is withheld, in ${wraps.join(", ")}`, () => {
    const shown = [];
    for (const wrap of wraps) {
      held(wrap);
      const text = WRAPS[wrap](`${"a".repeat(9000)}${PY_HEAD}${pad.repeat(300)} ${PY_REST} more`);
      if (redactedAnswer(text, [value]).includes(PY_REST) || redactedCall(text, [value], 100_000).includes(PY_REST)) shown.push(wrap);
    }
    assert.deepEqual(shown, []);
  });
}

// Each sequence is read through the decodings that read its opener as one, and no other: one that reads "\u001b" as
// six characters would read on to the bound at each title. Counted as match.ts counts the characters each read visits.
test("the read after a run's head reads each title through the decodings that open it: 2,000 titles, raw, a JSON writer's, a Python repr's or percent-encoded, at most 48 characters visited per character", async () => {
  const { scanned } = await import("../dist/redact/match.js");
  const over = [];
  for (const [what, title] of [
    ["raw", "\u001b]0;t\u001b\\"],
    ["a JSON writer's", String.raw`\u001b]0;t\u001b\\`],
    ["a Python repr's", String.raw`\x1b]0;t\x1b\\`],
    ["percent-encoded", "%1B]0;t%1B%5C"],
  ]) {
    const text = wrapped("json", `${PY_HEAD}${title.repeat(2000)} ${PY_REST} more`);
    scanned.chars = 0;
    redactedAnswer(text, [`${PY_HEAD}${PY_REST}`]);
    if (scanned.chars > 48 * text.length) over.push(`${what}: ${scanned.chars} for ${text.length}`);
  }
  assert.deepEqual(over, []);
});

// What the reads cost. A read for the head or the tail of a run too long to read, or past a call's stop (key-refusal.ts
// peek, tailOf), reads its stretch through every view from every place its join can start, so padding every view reads
// apart and shows little of costs it hundreds of characters per character. It gives up, and the text is withheld, once
// it has visited its budget (READ_BUDGET, 92 pieces), checked after each reading: one view's reading of one stretch of
// at most a piece. So one read visits at most READ_MOST, and as a run is read only where it is longer than a piece, at
// most twice, the reads of a text visit at most READS_PER_CHARACTER per character of it, under the matcher's bound
// (WORK, redact-contract.test.mjs). READING is measured, not built in: the test below holds it.
const PIECE = 8192;
const BUDGET = 92;
const READING = 178;
const READ_MOST = (BUDGET + READING) * PIECE;
const READS_PER_CHARACTER = (2 * READ_MOST) / (PIECE + 1);
const WORK = 1024;
const ZWSP = "\u200b";
// Every decoder's family, so every view reads what follows.
const FAMILIES = String.raw`%41+\n\\xA&#65;'"\x41` + "\u001b[m";
const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** A run of `length` characters that every view reads apart and shows one character of in 39: `pad` between letters. */
const sparse = (length, pad = ZWSP) => {
  let text = FAMILIES;
  while (text.length < length) text += `${pad.repeat(Math.max(1, Math.floor(38 / pad.length)))}a`;
  return text.slice(0, length);
};
/** Runs of 8,300 such characters, one after another, about `size` characters in all. */
const runs = (size, pad) => Array.from({ length: Math.max(1, Math.round(size / 8301)) }, () => sparse(8300, pad)).join(" ");
const VALUE = `${PY_HEAD}${PY_REST}`;

test("one reading of a stretch visits at most READING characters per character of it, read as if it starts inside every kind of terminal sequence, folded or not", () => {
  const over = [];
  let most = 0;
  for (const [what, stretch] of [
    ["padding every view reads apart", sparse(PIECE)],
    // The costliest measured: a JSON string holding a single-quoted dict never closed.
    ["a JSON string holding a dict never closed", `"{'a': '${fill("ab ", PIECE - 9)}`],
    ["OSC titles ended by ST", fill("\u001b]0;t\u001b\\", PIECE)],
  ])
    for (const open of [0, 7])
      for (const fold of [false, true]) {
        const readings = shownIn(stretch, fold, undefined, stretch.length, open);
        for (let before = scanned.chars, done = false; !done; before = scanned.chars) {
          done = readings.next().done;
          const per = (scanned.chars - before) / stretch.length;
          most = Math.max(most, per);
          if (per > READING) over.push(`${what}, open ${open}, fold ${fold}: ${per.toFixed(1)}`);
        }
      }
  assert.deepEqual(over, []);
  assert.ok(most > READING - 1, `the most measured, ${most.toFixed(1)}, is READING`);
});

// The texts the reads cost most on, 32 KiB to 512 KiB, each read through an answer and a call's result: runs of padding
// every view reads apart (zero-width spaces, and the same as JSON's escapes written twice, as HTML references and
// percent-encoded, which the marks walk reads most), and a call's stop inside an OSC title never ended, so the read past
// it reads each view also as the title's own (shownIn's `open`). Each is withheld whole; each visits at most WORK per
// character in all, each of its reads at most READ_MOST, and its reads at most READS_PER_CHARACTER per character.
// The matcher's own worst texts read no run and stop no read: DENSE (redact-contract.test.mjs) is in for its total, and
// k100 for its reads alone. k100 (prose's apostrophe, then JSON strings each holding 100 single-quoted strings joined by
// "+") visits 1,022.6, 1,033.3 and 1,037.5 per character here, over WORK by the matcher's own n log n term (a view's
// finds each checked against its covered stretches by a search from the first), which a change to the matcher fixes.
const DENSE = ["q8Vx", "R2mT"].join("");
const ALL_FAMILIES_STRING = String.raw`"%41+&#65;\"\\x41\\'",`;
const K100 = `${ALL_FAMILIES_STRING}${`x's "{${"'q8VxR2mT'+".repeat(100)}}"+\\\n`.repeat(4)}`;
const COSTLY = [
  ["runs of zero-width spaces", (size) => runs(size)],
  ["runs of zero-width spaces in a JSON string", (size) => wrapped("json", runs(size))],
  ["runs of JSON's \\u200b written twice", (size) => runs(size, String.raw`\\u200b`)],
  ["runs of HTML's &#8203;", (size) => runs(size, "&#8203;")],
  ["runs of percent-encoded zero-width spaces", (size) => runs(size, "%E2%80%8B")],
  ["a call's stop inside an OSC title never ended", (size) => wrapped("json", `${"word ".repeat(1000)}${FAMILIES} \u001b]0;${fill(`${ZWSP.repeat(37)}a `, size - 5040)}`), true],
  ["DENSE", (size) => fill(`${ALL_FAMILIES_STRING}${`"${DENSE}",`.repeat(370)}`, size), false, [DENSE]],
  ["k100", (size) => fill(K100, size), false, [DENSE], "reads only"],
];
const READS = {
  "an answer": (text, values) => redactedAnswer(text, values),
  "a call's result": (text, values) => cut(redactedCall(text, values, CALL_RESULT_CHARS, scrubUrls), CALL_RESULT_CHARS),
  "a call's result shown to 200": (text, values) => redactedCall(text, values, 200),
};
test("the texts the reads cost most on visit at most WORK characters per character, each read at most READ_MOST, 32 KiB to 512 KiB", (t) => {
  assert.ok(READS_PER_CHARACTER < WORK);
  const over = [];
  for (const size of [32 * 1024, 128 * 1024, 512 * 1024])
    for (const [what, make, stop, values = [VALUE], readsOnly] of COSTLY) {
      const text = make(size);
      // The prefixed reading runs: the read past the stop starts inside the title.
      if (stop) assert.ok(marksOf(text).openAt(PIECE) & OPEN_OSC, what);
      for (const [reader, read] of Object.entries(READS)) {
        scanned.chars = 0;
        readCost.chars = 0;
        readCost.most = 0;
        const out = read(text, values);
        const [total, reads] = [scanned.chars / text.length, readCost.chars / text.length];
        t.diagnostic(`${size / 1024} KiB, ${what}, ${reader}: ${total.toFixed(1)} per character, reads ${reads.toFixed(1)}, most one read ${readCost.most.toFixed(0)}`);
        if (!readsOnly && total > WORK) over.push(`${size}, ${what}, ${reader}: ${total.toFixed(1)} per character`);
        if (reads > READS_PER_CHARACTER || readCost.most > READ_MOST) over.push(`${size}, ${what}, ${reader}: reads ${reads.toFixed(1)}, one ${readCost.most}`);
        // Withheld whole where the read gives up: every read of the runs, and the read past the stop in the title.
        const gives = values[0] === VALUE && (!stop || reader === "a call's result shown to 200");
        if (gives && out !== "[redacted]") over.push(`${size}, ${what}, ${reader}: shown`);
      }
    }
  assert.deepEqual(over, []);
});

// A call's stop after prose, then a run too long to read of padding every view reads apart. With a lead-in of 8,092
// characters, the pieces that show the lead-in are redacted at about 50 characters per character of the text whatever
// follows; the read past the stop adds at most READ_MOST. Measured per character (in all, the read past the stop): no
// budget 749.5 and 224.6; this budget 100.8 and 49.5; before reads counted each view (e1e80a1694), 520.2 in all. With a
// lead-in of 250 characters, the read is most of it: 107.1 and 91.3.
test("a call's stop after a lead-in of 8,092 or 250 characters, then padding every view reads apart, visits at most WORK per character, the read past the stop at most READ_MOST", () => {
  const over = [];
  let body = "";
  while (body.length < 8092) body += "word ";
  for (const [what, lead] of [["8,092", body], ["250", "word ".repeat(50)]]) {
    const text = wrapped("json", `${lead}${sparse(9000)}`);
    scanned.chars = 0;
    readCost.chars = 0;
    readCost.most = 0;
    if (redactedCall(text, [VALUE], 200) !== "[redacted]") over.push(`${what}: shown`);
    if (scanned.chars > WORK * text.length) over.push(`${what}: ${scanned.chars} for ${text.length}`);
    if (readCost.chars > READ_MOST) over.push(`${what}: the read past the stop visits ${readCost.chars}`);
  }
  assert.deepEqual(over, []);
});

// The walk that marks what stands outside a read (match.ts marksOf) reads the text once for all its streams: as many
// characters per character at 512 KiB as at 32 KiB, over text that opens and closes sequences in every encoding.
test("the marks walk visits as many characters per character at 512 KiB as at 32 KiB, over text that opens and closes terminal sequences in every encoding", () => {
  const unit = `\u001b[31ma\u001b[0m \u009b1m b\u001b]0;t\u0007 ${String.raw`\u001b[1m \\u001b]0;t\\u0007 \x1b[0m \\x1b(B`} %1B[0m %1B]0;t%1B%5C &#27;[0m &#x1b;]0;t&#7; x\b `;
  const per = {};
  for (const size of [32 * 1024, 512 * 1024]) {
    const text = fill(unit, size);
    scanned.chars = 0;
    const marks = marksOf(text);
    per[size] = scanned.chars / text.length;
    let open = 0;
    for (let at = 0; at < text.length; at += 7) if (marks.openAt(at) !== 0) open++;
    assert.ok(open > text.length / 14, `${open} of ${Math.ceil(text.length / 7)} places open`);
  }
  assert.ok(per[512 * 1024] - per[32 * 1024] < 0.01, JSON.stringify(per));
  assert.ok(per[512 * 1024] < 24, JSON.stringify(per));
});

// What stands outside a read decides what the views show of it. A backspace after the read strikes out characters
// inside it: the read counts as many more as there are backspaces after it (in any encoding), and one that would strike
// out what stands before the read withholds the text. A read that starts inside a terminal sequence (a call's stop, or
// a run's tail, inside a long title) shows nothing of it: the views read it after that sequence's opener. And a
// whitespace run inside a CSI is written short as every view reads it: a no-break space, a tab or a line break is no
// space there. Each padding below, between a held value's halves, is longer than the read takes when it counts it.
const OUTSIDE_THE_READ = [
  ["300 x and 300 backspaces", "plain", `${"x".repeat(300)}${"\b".repeat(300)}`],
  ["1,000 x and 1,000 backspaces", "plain", `${"x".repeat(1000)}${"\b".repeat(1000)}`],
  ["300 x and 300 JSON backspaces", "json", `${"x".repeat(300)}${String.raw`\b`.repeat(300)}`],
  ["1,000 x and 1,000 JSON backspaces", "json", `${"x".repeat(1000)}${String.raw`\b`.repeat(1000)}`],
  ["an OSC title of 300 words", "plain", `\u001b]0;${"word ".repeat(300)}\u0007`],
  ["an OSC title of 1,500 characters", "plain", `\u001b]0;${"t".repeat(1500)}\u0007`],
  ["a CSI holding 1,500 é", "plain", `\u001b[${"é".repeat(1500)}m`],
  ["300 CSIs holding a no-break space", "plain", "\u001b[ 1m".repeat(300)],
  ["300 CSIs holding a tab", "plain", "\u001b[1\t2m".repeat(300)],
  ["300 CSIs holding a line break", "plain", "\u001b[1\n2m".repeat(300)],
];
const inKind = (kind, body) => (kind === "plain" ? body : wrapped(kind, body));

for (const [what, kind, pad] of OUTSIDE_THE_READ) {
  test(`kr-9 (${what}): a held value split at a call's stop, the padding past the read after the stop, is withheld`, () => {
    let body = "";
    while (body.length < 8192 - 100) body += "word ";
    assert.equal(redactedCall(inKind(kind, `${body}see ${PY_HEAD} ${pad} ${PY_REST} more`), [`${PY_HEAD}${PY_REST}`], 200), "[redacted]");
  });

  test(`kr-10 (${what}): a held value whose head ends a run too long to read, the padding after it, and whose rest follows is withheld`, () => {
    const text = inKind(kind, `${"a".repeat(9000)}${PY_HEAD}${pad} ${PY_REST} more`);
    for (const out of [redactedCall(text, [`${PY_HEAD}${PY_REST}`], 100_000), redactedAnswer(text, [`${PY_HEAD}${PY_REST}`])]) assert.equal(out.includes(PY_REST), false);
  });
}

// The marks a read is cut with cover what every view hides (fixtures/marks-cover.mjs), over this file's padding: each
// between a held value's halves, in each way it is written above.
test("the padding above: where a view hides a character as a terminal does, a read that starts there is told a sequence may be open or a backspace follows", () => {
  const { tally, add } = coverTally();
  for (const [, pad, kind] of CONTROL_PADS) add(wrapped(kind, `see ${PY_HEAD} ${pad}${PY_REST} more`));
  for (const [, text, [head, rest]] of FOLLOWED_TITLES) add(text(`see ${head} `, `${rest} more`));
  add(endingAString(`see ${PY_HEAD} `, `${PY_REST} more`));
  for (const [, pad, wraps] of MIXED_PADS) for (const wrap of wraps) add(WRAPS[wrap](`see ${PY_HEAD}${pad.repeat(3)} ${PY_REST} more`));
  for (const [, kind, pad] of OUTSIDE_THE_READ) add(inKind(kind, `see ${PY_HEAD}${pad} ${PY_REST} more`));
  console.log(`# ${tally.texts} texts, ${tally.checked} hidden places checked, ${tally.misses} missed`);
  assert.ok(tally.checked > 0);
  assert.deepEqual(tally.missed, []);
});

test("kr-11: control padding after a word, with no held value split around it, is shown (control)", () => {
  let body = "";
  while (body.length < 8192 - 100) body += "word ";
  const text = wrapped("json", `${body}see ${PY_HEAD} ${"\u0000".repeat(300)}zzzzzzzzzzzzzzzz more`);
  assert.equal(redactedCall(text, [`${PY_HEAD}${PY_REST}`], 200).startsWith(`{"a": "word word`), true);
});
