// A provider that refuses the run's key (401) reads, in the run's error, as the key by name and where to set it, never
// the provider's raw answer and never the key: on the OpenRouter route for every harness (the texts below are what
// pi-ai, the pinned Claude CLI and the pinned Codex binary each said for OpenRouter's 401 {"error":{"message":"User not
// found"}}), on a direct provider, and on serve's gateway. A pi run through a loopback gateway that answers 401 ends
// with those words as its error.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { agent, follow, serve, withEnv } from "./support.mjs";
import { readCost, redactedAnswer, redactedCall } from "../dist/key-refusal.js";
import { marksOf, scanned, shownIn } from "../dist/redact/match.js";
import { CALL_RESULT_CHARS, scrubUrls } from "../dist/timeline/index.js";
import { cut } from "../dist/timeline/util.js";
import { COSTLY, COSTLY_PARTS, fill, PIECE, PY_HEAD, PY_REST, READ_MOST, READING, sparse, VALUE, WORK, wrapped } from "./fixtures/key-refusal-work.mjs";
import { coverTally, uncovered } from "./fixtures/marks-cover.mjs";

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
  // An OSC holding an apostrophe that ends a string, the next string after it: a call's stop falls on a string's
  // opening quote, and the view that reads the strings' escapes twice joins the strings from there (the fuzz's seed 4).
  ["Python's ESC, ] and t written twice, an apostrophe, Python's [, JSON's BEL, ending a string", `${B}x1b${B}${B}x5d'${B}${B}x74${B}x5b${B}u0007", "`, ["json", "jj"]],
  ["Python's ESC and JSON's ] written twice, an apostrophe, HTML's slash, JSON's ESC, Python's backslash written twice, ending a string", `${B}${B}x1b${B}${B}u005d '&#47;${B}u001b${B}${B}x5c", "`, ["json"]],
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

// What the reads cost, and the bounds on it (READING, READ_MOST, WORK), are set out in fixtures/key-refusal-work.mjs,
// beside the texts the reads cost most on. READING is measured, not built in: this test holds it.
test("one reading of a stretch visits at most READING characters per character of it, read as if it starts inside every kind of terminal sequence, folded or not", () => {
  const over = [];
  let most = 0;
  for (const [what, stretch] of [
    ["padding every view reads apart", sparse(PIECE)],
    ["a JSON string holding a dict never closed", `"{'a': '${fill("ab ", PIECE - 9)}`],
    // The costliest measured (174.8, as if it starts inside every kind of sequence): the again join's reading, built
    // from each of its starts and openers.
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

// The work count of the texts the reads cost most on (fixtures/key-refusal-work.mjs) runs in parts, one test file each
// (key-refusal-work-<k>.test.mjs): together they read every text, each in exactly one part.
test("the texts the reads cost most on: the work count's parts read every text exactly once, each part file its own part", () => {
  const files = readdirSync(new URL(".", import.meta.url)).filter((file) => /^key-refusal-work-\d+\.test\.mjs$/.test(file));
  assert.deepEqual(files.sort(), Array.from({ length: COSTLY_PARTS.length }, (_, i) => `key-refusal-work-${i + 1}.test.mjs`).sort());
  for (const file of files) {
    const k = Number(file.match(/\d+/)[0]);
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.deepEqual([...text.matchAll(/costlyWork\(t, (\d+)\)|costlyPartName\((\d+)\)/g)].map((m) => Number(m[1] ?? m[2])), [k, k], file);
  }
  assert.deepEqual(COSTLY_PARTS.flat().sort(), COSTLY.map(([what]) => what).sort());
  assert.ok(COSTLY_PARTS.every((part) => part.length > 0));
});

// A call's stop after prose, then a run too long to read of padding every view reads apart. With a lead-in of 8,092
// characters, the pieces that show the lead-in are redacted at about 50 characters per character of the text whatever
// follows; the read past the stop adds at most READ_MOST. Measured per character (in all, the read past the stop): no
// budget 768.7 and 247.9, and shown; this budget 228.3 and 181.8; before reads counted each view (e1e80a1694), 521.2 in
// all, and shown. With a lead-in of 250 characters, the read is most of it: 346.8 and 335.9 (no budget 929.8 and 457.9;
// e1e80a1694 476.8).
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

// String literals joined by the operators the join leaves out between two strings ("+", a line's ending backslash,
// or both): the values' pass reads the literals as one, so a read past a call's stop, or after a run too long to read,
// must read the operators as that pass does, as dropped between two strings. Each held value's head is a literal of its
// own, so the stop or the run's end stands outside it. [what, operator, literal between].
const JOINED_LITERALS = [
  ['"+" between empty literals', "+", ""],
  ['"+" between literals holding Python\'s ESC and a CSI', "+", `${B}x1b[31m`],
  ['"+" and a line\'s ending backslash between empty literals', `+${B}\n`, ""],
  ['"+" and a line\'s ending backslash between literals holding Python\'s ESC and a CSI', `+${B}\n`, `${B}x1b[31m`],
  ['a line\'s ending backslash, then "+", between empty literals', `${B}\n+ `, ""],
  ['a line\'s ending backslash, then "+", between literals holding Python\'s ESC and a CSI', `${B}\n+ `, `${B}x1b[31m`],
];
const joinedPad = (op, between, units) => `${op}'${between}'`.repeat(units) + op;

for (const [what, op, between] of JOINED_LITERALS) {
  test(`kr-9 (${what}): a held value split at a call's stop, 300 joined literals past the read after the stop, is withheld`, () => {
    let body = "";
    while (body.length < 8192 - 100) body += "word ";
    assert.equal(redactedCall(`${body}x = '${PY_HEAD}'${joinedPad(op, between, 300)}'${PY_REST} more'`, [`${PY_HEAD}${PY_REST}`], 200), "[redacted]");
  });

  test(`kr-10 (${what}): a held value whose head ends a run too long to read, 300 joined literals after it, and whose rest follows is withheld`, () => {
    const text = `x = (${"a".repeat(9000)},'${PY_HEAD}'${joinedPad(op, between, 300)}'${PY_REST} more')`;
    for (const out of [redactedCall(text, [`${PY_HEAD}${PY_REST}`], 100_000), redactedAnswer(text, [`${PY_HEAD}${PY_REST}`])]) assert.equal(out.includes(PY_REST), false);
  });
}

// Apostrophes between two letters a view reads as nothing (Hangul fillers): this reading takes each for prose's and
// opens no string, so its join shows it; main's reading, which the matcher reads too where the two pair the quotes
// otherwise, opens a string at each and drops it, and shows nothing between a held value's halves. [what, filler].
const PROSE_APOSTROPHES = [
  ["Hangul filler", "\u3164"],
  ["halfwidth Hangul filler", "\uffa0"],
  ["Hangul choseong filler", "\u115f"],
  ["Hangul jungseong filler", "\u1160"],
];

for (const [what, filler] of PROSE_APOSTROPHES) {
  const pad = `${filler}'${filler} `.repeat(300);
  test(`kr-9 (an apostrophe between two of the ${what}, 300 times): a held value split at a call's stop, the padding past the read after the stop, is withheld`, () => {
    let body = "";
    while (body.length < 8192 - 100) body += "word ";
    assert.equal(redactedCall(`${body}see ${PY_HEAD}${filler}${pad}${filler}${PY_REST} more`, [`${PY_HEAD}${PY_REST}`], 200), "[redacted]");
  });

  test(`kr-10 (an apostrophe between two of the ${what}, 300 times): a held value whose head ends a run too long to read, the padding after it, and whose rest follows is withheld`, () => {
    const text = `${"a".repeat(9000)}${PY_HEAD}${filler}${pad}${filler}${PY_REST} more`;
    for (const out of [redactedCall(text, [`${PY_HEAD}${PY_REST}`], 100_000), redactedAnswer(text, [`${PY_HEAD}${PY_REST}`])]) assert.equal(out.includes(PY_REST), false);
  });
}

// Not covered: the same literals where the stop falls inside the head's literal ('see <head>', cut at its space), or
// where the run too long to read starts inside it ('aaa...<head>'). The pass after the pieces reads them joined by a
// line break, and an apostrophe's string ends at a line break: past the stop, the literal's rest opens a string the
// operator after it stands in; and the run's tail, read without its opening quote, opens one at the head's closing
// quote. Either way no join reads the literals as one. Main's pass reads them so too and shows the rest of each shown
// row below. Pinned as found, [kr-9, kr-10] shown or not, so a change either way fails here.
const JOINED_PAST_THE_PASS = [
  [true, false],
  [true, false],
  [false, true],
  [false, true],
  [false, true],
  [false, true],
];

test("the joined literals above, the stop inside the head's literal or the run starting inside it: shown as pinned", () => {
  let body = "";
  while (body.length < 8192 - 100) body += "word ";
  const value = [`${PY_HEAD}${PY_REST}`];
  const found = JOINED_LITERALS.map(([, op, between]) => {
    const pad = joinedPad(op, between, 300);
    const long = `x = '${"a".repeat(9000)}${PY_HEAD}'${pad}'${PY_REST} more'`;
    return [redactedCall(`${body}'see ${PY_HEAD}'${pad}'${PY_REST} more'`, value, 200) !== "[redacted]", [redactedCall(long, value, 100_000), redactedAnswer(long, value)].some((out) => out.includes(PY_REST))];
  });
  assert.deepEqual(found, JOINED_PAST_THE_PASS);
});

// The smallest texts of the corpus (KEY_REFUSAL_PAD_CORPUS=all) and the fuzz's seeds 2 to 5 (KEY_REFUSAL_PAD_FUZZ=all)
// a rule of the marks was found missing on, each three times between a held value's halves: [what the marks missed,
// padding, wraps].
const MARKS_MISSED = [
  // A backslash no escape of JSON's starts, before JSON's ESC: a view reading the string again may read the two as
  // anything.
  ["a lone backslash before JSON's ESC, in a title ended by JSON's ESC and a lone backslash", `${B}${B}u001b]0;t${B}u001b${B}`, ["json"]],
  // A backslash run before "%" or "&": the percent-encoded ESC or the HTML backspace after it is read on its own.
  ["a backslash run before a percent-encoded ESC, in an OSC ended by U+009C", `%1B]\u009c${B}${B}u001b${B}${B}`, ALL_WRAPS],
  ["a backslash run before HTML's backspace, in an 8-bit OSC", `\u009d${B}${B}&#8;0${B}u0007`, ALL_WRAPS],
  // JSON's escape for a backslash, then a letter of JSON's escapes: a view reading the string again reads the two as
  // one control.
  ["JSON's backslash and n, in a title HTML's ESC opens and HTML's BEL ends", `&#27;]${B}u005cn&#7;`, ["json"]],
];

// The marks a read is cut with cover what every view hides (fixtures/marks-cover.mjs), over this file's padding: each
// between a held value's halves, in each way it is written above.
test("the padding above: where a view hides a character as a terminal does, a read that starts there is told a sequence may be open or a backspace follows", () => {
  const { tally, add } = coverTally();
  for (const [, pad, wraps] of MARKS_MISSED) for (const wrap of wraps) add(WRAPS[wrap](`see ${PY_HEAD}${pad.repeat(3)} ${PY_REST} more`));
  for (const [, pad, kind] of CONTROL_PADS) add(wrapped(kind, `see ${PY_HEAD} ${pad}${PY_REST} more`));
  for (const [, text, [head, rest]] of FOLLOWED_TITLES) add(text(`see ${head} `, `${rest} more`));
  add(endingAString(`see ${PY_HEAD} `, `${PY_REST} more`));
  for (const [, pad, wraps] of MIXED_PADS) for (const wrap of wraps) add(WRAPS[wrap](`see ${PY_HEAD}${pad.repeat(3)} ${PY_REST} more`));
  for (const [, kind, pad] of OUTSIDE_THE_READ) add(inKind(kind, `see ${PY_HEAD}${pad} ${PY_REST} more`));
  for (const [, filler] of PROSE_APOSTROPHES) add(`see ${PY_HEAD}${filler}${`${filler}'${filler} `.repeat(3)}${filler}${PY_REST} more`);
  // And a raw ESC whose CSI or escape the next literal holds, joined by each operator: the join reads the sequence
  // whole. Each also as a JSON string, its ESC JSON's escape and its line's ending backslash JSON's escaped one: the
  // view that decodes JSON's escapes reads that backslash, which ends an escape as it stands, where the join drops it.
  for (const [, op, between] of JOINED_LITERALS) {
    for (const fill of [between, `\u001b'${op}'[31m`, `\u001b('${op}'B`]) {
      const text = `x = '${PY_HEAD}'${joinedPad(op, fill, 3)}'${PY_REST} more'`;
      add(text);
      add(JSON.stringify({ a: text }));
    }
  }
  console.log(`# ${tally.texts} texts, ${tally.checked} hidden places checked, ${tally.misses} missed`);
  assert.ok(tally.checked > 0);
  assert.deepEqual(tally.missed, []);
});

// The place the check above found the marks missing, end to end: Python code in a JSON string, an ESC and "(" in one
// literal, then a line's ending backslash and a literal holding a space and 9,000 more of the escape's intermediate
// bytes and its final byte, then the held value's rest. The space ends a piece, and the 9,000 characters after it are a
// run too long to read: its head is read from a place inside the escape, which the view decoding JSON's escapes ended
// at the backslash where the join drops it. A read there told nothing is open counts the intermediates as shown, ends
// inside them, and the head of the held value, in the piece before, showed.
const ESCAPE_PAST_A_JOIN = JSON.stringify({ a: `x = '${PY_HEAD}'+${B}\n'\u001b('+${B}\n' ${"(".repeat(9000)}B'+${B}\n'${PY_REST} more'` });
for (const [what, read] of [
  ["an answer", (text, values) => redactedAnswer(text, values)],
  ["a call's result", (text, values) => cut(redactedCall(text, values, CALL_RESULT_CHARS, scrubUrls), CALL_RESULT_CHARS)],
]) {
  test(`kr-10 (an escape a line's ending backslash ends as JSON's escapes read it, its intermediates a run too long to read): ${what} split around it shows no part of the held value`, () => {
    const out = read(ESCAPE_PAST_A_JOIN, [`${PY_HEAD}${PY_REST}`]);
    assert.equal(out.includes(PY_HEAD) || out.includes(PY_REST), false);
  });
}

// A limit of the check, not of the marks: the view that reads percent-encoding and HTML's references together reads
// the U+FFFD an invalid percent-encoded byte decodes to and a no-break space after it as one character, ending where
// the space ends. Where a backspace strikes it out, the check counts the place before the space's end hidden, and no
// read that starts inside the space holds the struck character. Found in the fuzz's seed 4 and pinned as found (the
// fuzz leaves this padding out of its check), so a change either way fails here.
test("a struck U+FFFD a view reads with the no-break space after it is counted hidden at the space's end, as pinned", () => {
  const pad = "%9D\b&#160;\u0007";
  const missed = Object.fromEntries(ALL_WRAPS.map((wrap) => [wrap, uncovered(WRAPS[wrap](`see ${PY_HEAD}${pad.repeat(3)} ${PY_REST} more`)).missed]));
  assert.deepEqual(missed, { json: [58], py: [58], plain: [51], jj: [61] });
});

test("kr-11: control padding after a word, with no held value split around it, is shown (control)", () => {
  let body = "";
  while (body.length < 8192 - 100) body += "word ";
  const text = wrapped("json", `${body}see ${PY_HEAD} ${"\u0000".repeat(300)}zzzzzzzzzzzzzzzz more`);
  assert.equal(redactedCall(text, [`${PY_HEAD}${PY_REST}`], 200).startsWith(`{"a": "word word`), true);
});
