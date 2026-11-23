// A run's answer as serve serves it (GET /runs/{id}: result.final_answer, result.output) holds no held secret: the same
// rule as the Timeline (learning's redactSecrets over the values the server holds and handed the run), over the WHOLE
// answer, never cut. The stored record stays as the run wrote it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { agent, flowAgent, follow, serve, withEnv } from "./support.mjs";
import * as refusal from "../dist/key-refusal.js";
import { CALL_RESULT_CHARS, scrubUrls, timelineOf } from "../dist/timeline/index.js";
import { cut } from "../dist/timeline/util.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

const { redactedAnswer, redactedOutput } = refusal;

const CUT_KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const pieces = (value) => Array.from({ length: value.length - 7 }, (_, i) => value.slice(i, i + 8));
const ENCODED = Buffer.from(CUT_KEY).toString("base64");
const noKey = (text, where) => {
  for (const piece of [...pieces(CUT_KEY), ...pieces(ENCODED)]) assert.ok(!text.includes(piece), `${where} holds ${piece}`);
};

async function answered(t, content) {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: CUT_KEY }, NAMES);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("quotes"))).status, 201);
  const started = await api("POST", "/agents/quotes/runs", { input: { content } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  return (await api("GET", `/runs/${started.body.run_id}`)).body;
}

test("a run's final answer quoting a held key, plainly and base64-encoded, is served with neither, and the rest of it intact", { timeout: 60_000 }, async (t) => {
  const run = await answered(t, "Answer quoting the held key.");
  noKey(JSON.stringify(run), "the run");
  // A base64 copy's last character or two can mix in the bytes after the key (and its padding), so they stay: no key
  // material, as noKey shows.
  assert.match(run.result.final_answer, /^Here it is: \[redacted\] and \[redacted\][A-Za-z0-9+/=]{0,3}\. The rest stays\.$/, run.result.final_answer);
});

test("a long final answer (about 50 KB) quoting a held key near its end is served whole, not cut, with no piece of the key", { timeout: 60_000 }, async (t) => {
  const run = await answered(t, "Answer at length quoting the held key.");
  const answer = run.result.final_answer;
  noKey(answer, "the answer");
  assert.ok(answer.startsWith("word word "), answer.slice(0, 40));
  assert.ok(answer.endsWith("near the end [redacted] done."), answer.slice(-60));
  assert.equal(answer.length, "word ".length * 10_000 + "near the end [redacted] done.".length, "nothing cut");
});

test("an unattended run's answer of 6,000 characters reads whole in its result, its Timeline row and the Timeline's live pages, as the console's Report and Timeline show it (#2224)", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: CUT_KEY }, NAMES);
  const { api } = await serve(t);
  // Unattended (approvals never), as the release-notes template's run that read cut at 2,000.
  assert.equal((await api("POST", "/agents", agent("notes", { approvals: "never" }))).status, 201);
  // The faux model answers "On <the message>: done.": a message of 5990 characters is an answer of 6000.
  const content = `${"note ".repeat(1200).slice(0, 5990 - 4)} end`;
  const answer = `On ${content}: done.`;
  assert.equal(answer.length, 6000);
  const started = await api("POST", "/agents/notes/runs", { input: { content } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  // The Timeline as the console reads it: its long-poll pages, followed to the run's end.
  const { rows } = await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  const live = rows.findLast((row) => row.kind === "final_answer");
  assert.equal(live?.text?.length, 6000, `the live pages' answer row: ${live?.text?.length} characters`);
  assert.equal(live.text, answer);
  // A fresh read of the Timeline, and the run's result: whole too.
  const page = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body;
  assert.equal(page.rows.findLast((row) => row.kind === "final_answer")?.text, answer, "the Timeline's answer row");
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(view.result.final_answer, answer, "the run's result");
});

test("an answer one character past a timeline row's cap (2001) is served whole by GET /runs/{id}", { timeout: 60_000 }, async (t) => {
  // The faux model answers "On <the message>: done." (10 characters around it): a message of 1991 is an answer of 2001.
  const content = `${"z".repeat(1991 - 4)} end`;
  assert.equal(`On ${content}: done.`.length, 2001);
  const run = await answered(t, content);
  const answer = run.result.final_answer;
  assert.equal(answer.length, 2001, `served ${answer.length} characters, ending ${JSON.stringify(answer.slice(-16))}`);
  assert.equal(answer, `On ${content}: done.`);
});

test("a workflow's output carrying a held key in a string field is served with it redacted, the record's shape kept", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: CUT_KEY }, NAMES);
  const { api } = await serve(t);
  const flow = {
    v: 2, name: "keyed",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Out: { type: "object", required: ["note", "n"], properties: { note: { type: "string" }, n: { type: "number" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Out", path: "out" },
    root: { node: "chain", steps: [{ node: "extract", label: "out", instructions: "Submit the held key.", out: "Out", as: "out" }] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("keyed", flow))).status, 201);
  const started = await api("POST", "/agents/keyed/runs", { input: { question: "x" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  noKey(JSON.stringify(run), "the run");
  assert.deepEqual(run.result.output, { note: "kept [redacted] here", n: 7 });
});

test("a workflow output carrying a held key as a property name, nested too, is served with no piece of it", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: CUT_KEY }, NAMES);
  const { api } = await serve(t);
  const flow = {
    v: 2, name: "named",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Out: { type: "object", required: ["note", "n", "dict"], properties: { note: { type: "string" }, n: { type: "number" }, dict: { type: "object", additionalProperties: true } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Out", path: "out" },
    root: { node: "chain", steps: [{ node: "extract", label: "out", instructions: "Submit the held key as a name.", out: "Out", as: "out" }] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("named", flow))).status, 201);
  const started = await api("POST", "/agents/named/runs", { input: { question: "x" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  noKey(JSON.stringify(run), "the run");
  assert.deepEqual(run.result.output, { note: "ok", n: 1, dict: { "[redacted]": "found", nested: { "[redacted]": "deep", kept: "yes" } } });
});

test("two property names that redact to the same name withhold their object whole, never merge one value over the other", () => {
  const out = redactedOutput({ keep: 1, both: { [CUT_KEY]: "a", [`${CUT_KEY}-2`]: "b" }, [CUT_KEY]: "top" }, [CUT_KEY, `${CUT_KEY}-2`]);
  noKey(JSON.stringify(out), "the output");
  assert.deepEqual(out, { keep: 1, both: "[redacted]", "[redacted]": "top" });
});

// A view reads the answer the server already redacted for this run and these held values: a console polls a run's view,
// and an answer a run was made to write can be large.
test("a run's view redacts its answer once per held key set: a second view reads nothing again", { timeout: 90_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: CUT_KEY }, NAMES);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("long-sk"))).status, 201);
  const started = await api("POST", "/agents/long-sk/runs", { input: { content: "Answer with a megabyte of sk- runs." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 80_000 });
  const first = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const read = refusal.answerPasses?.count;
  assert.equal(typeof read, "number", "key-refusal.ts counts the texts redactedAnswer reads");
  const second = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(refusal.answerPasses.count, read, "the second view read the answer from what the first one redacted");
  assert.equal(second.result.final_answer, first.result.final_answer);
  // A run's final answer is kept trimmed, so the last run's space is not in it.
  assert.equal(second.result.final_answer, "[redacted] ".repeat(128).trimEnd(), "each sk- run is redacted whole");
});

test("a value saved as a key after a run's answer was first served is redacted from the next view", { timeout: 90_000 }, async (t) => {
  const later = ["not-a-secret", "later-key-0123456789abcdef"].join("-");
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: CUT_KEY, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, [...NAMES, "AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY"]);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("later"))).status, 201);
  const started = await api("POST", "/agents/later/runs", { input: { content: "Answer quoting the later key." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  assert.equal((await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, `Later: ${later} ends here.`, "no key holds it yet");
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: later } })).status, 204);
  assert.equal((await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, "Later: [redacted] ends here.", "saved, it is held");
});

test("an answer of about 1 MB made of sk- runs is redacted in time linear in its length, every run whole", () => {
  const text = `${"sk-".repeat(2730)} `.repeat(128);
  const began = performance.now();
  const out = redactedAnswer(text, [CUT_KEY]);
  const took = performance.now() - began;
  assert.equal(out, "[redacted] ".repeat(128));
  // Each sk- run started again at every third character took about 5 s here; read once, it takes well under a second.
  assert.ok(took < 1500, `took ${Math.round(took)} ms`);
});

test("a call's result of about 120,000 characters of sk- runs, as a grader's read shows it, is read in pieces: each run redacted whole, in time linear in its length", () => {
  const text = `${"sk-".repeat(2730)} `.repeat(15);
  const began = performance.now();
  const out = refusal.redactedCall(text, [CUT_KEY], 120_000);
  const took = performance.now() - began;
  assert.equal(out, "[redacted] ".repeat(15));
  assert.ok(took < 1500, `took ${Math.round(took)} ms`);
});

test("a held value split by whitespace across the edge of a call's result's pieces withholds the result whole; one whole at that edge is cut in place", () => {
  // The first piece ends at its last whitespace before 8,192 characters: here the line break after the value's head.
  const [head, rest] = [CUT_KEY.slice(0, 12), CUT_KEY.slice(12)];
  const before = `${"y ".repeat(4089)} `;
  assert.equal(`${before}${head}`.length, 8191);
  const after = " the words after it. ".repeat(2000);
  assert.equal(refusal.redactedCall(`${before}${head}\n${rest}${after}`, [CUT_KEY], 120_000), "[redacted]");
  const whole = refusal.redactedCall(`${before}${CUT_KEY}${after}`, [CUT_KEY], 120_000);
  assert.equal(whole, `${before}[redacted]${after}`);
});

test("a held value split by a line break just past the head a grader is shown withholds the call's result whole: no prefix of it shows", () => {
  // The last piece read ends at the line break, 120,005 characters in: the value's rest is past it.
  const text = `${"y ".repeat(59_994)}${CUT_KEY.slice(0, 16)}\n${CUT_KEY.slice(16)}${"z".repeat(5000)}`;
  assert.equal(refusal.redactedCall(text, [CUT_KEY], 120_000), "[redacted]");
});

test("a held value split by a line break before a run too long to read withholds the text whole: its head never shows", () => {
  const text = `the key: ${CUT_KEY.slice(0, 16)}\n${CUT_KEY.slice(16)}${"z".repeat(9000)} end`;
  assert.equal(redactedAnswer(text, [CUT_KEY]), "[redacted]");
  assert.equal(refusal.redactedCall(text, [CUT_KEY], 120_000), "[redacted]");
  // A shorter held value at the head of that run is still read raw there, so the longer one it ends stays whole.
  const shorter = ["other", "held", "value", "abcdefgh"].join("-");
  const longer = `${["not", "a", "secret", "prefix"].join("-")}-${shorter}`;
  const both = `the key: ${longer.slice(0, 20)}\n${longer.slice(20)}${"z".repeat(9000)} end`;
  assert.equal(redactedAnswer(both, [longer, shorter]), "[redacted]");
  assert.equal(refusal.redactedCall(both, [longer, shorter], 120_000), "[redacted]");
});

/** A held value of 64 characters in no secret's shape, made at runtime. */
const SPLIT = `${["not-a-secret", "split-key"].join("-")}-${"0123456789abcdef".repeat(3)}`.slice(0, 64);
/** A call's tool_result_text as a served calls read shows it: the run's redactor is redactedCall, eliding URLs per piece. */
const resultTextOf = (text, secrets = [SPLIT], tool = "bash", input = { command: "run" }) => {
  const options = { calls: { result: CALL_RESULT_CHARS, redact: (part) => refusal.redactedCall(part, secrets, CALL_RESULT_CHARS, scrubUrls) } };
  const rows = timelineOf([user("Run it."), assistant([call("c1", tool, input)]), result("c1", tool, text)], options);
  return rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "c1").tool_result_text;
};

test("a held value split by a line break where a call's read stops shows none of it, after a run its pieces took back", () => {
  // A run cut at a quote crosses the head, then goes unread and is taken back; the read stops again at the line break.
  const text = `${"y ".repeat(59_000)}["${"a".repeat(7000)}",${"B".repeat(30_000)} ${"y ".repeat(975)}${SPLIT.slice(0, 40)}\n${SPLIT.slice(40)}${"z".repeat(9000)} end`;
  const shown = cut(refusal.redactedCall(text, [SPLIT], CALL_RESULT_CHARS), CALL_RESULT_CHARS);
  assert.ok(!shown.includes(SPLIT.slice(0, 8)), shown.slice(-80));
  assert.ok(!resultTextOf(text).includes(SPLIT.slice(0, 8)));
});

test("a call's result whose URLs lose their query values shows no held value's prefix past what its redaction read, and words past 120,000 raw characters reach the grader", () => {
  // 21 query values of 5,000 and 6,000 characters elided bring text past the head the redaction read into the 120,000.
  const urls = Array.from({ length: 20 }, () => `https://h.example/p?q=${"a".repeat(5000)} `).join("");
  const text = `${urls}${"y ".repeat(10_000)}https://h.example/u?q=${"b".repeat(6000)} ${"y ".repeat(400)}${SPLIT.slice(0, 40)}\n${SPLIT.slice(40)}${"z".repeat(9000)} end`;
  const shown = resultTextOf(text);
  assert.ok(!shown.includes(SPLIT.slice(0, 8)), `${shown.length}: ${shown.slice(-80)}`);
  // The read counts what its pieces show once elided: words past 120,000 raw characters, well inside 120,000 shown ones,
  // reach the grader.
  const figure = `${urls}${"y ".repeat(10_000)}https://h.example/u?q=${"b".repeat(6000)} the figure is 4,217. end`;
  assert.ok(figure.indexOf("4,217") > CALL_RESULT_CHARS);
  assert.ok(resultTextOf(figure).endsWith("the figure is 4,217. end"), resultTextOf(figure).slice(-80));
  // As a web_fetch's page text, each string read alone, the same.
  const page = JSON.stringify({ ok: true, url: "https://h.example/page", status: 200, title: "A page", text });
  const web = resultTextOf(page, [SPLIT], "web_fetch", { url: "https://h.example/page" });
  assert.ok(!web.includes(SPLIT.slice(0, 8)), `${web.length}: ${web.slice(-80)}`);
});

test("a call's result is redacted as it came, then its URLs lose their query values: a held value in a URL's query, fragment or password, or split by a line break after one, shows no part of it", () => {
  // Elided first, each of these held values is cut apart (at "&", "#", "@", or the query's end) and no longer reads as
  // itself, so a part of it would show. (The user and password are joined here so no URL with a password is written.)
  const login = ["deploy", "P@ss#word123456"].join(":");
  const cases = [
    ["https://api.example.com/v1/login?user=me&pass=Pw7&kq9Lm2xZ8vR4", "Pw7&kq9Lm2xZ8vR4", "https://api.example.com/v1/login?user=…&pass=…"],
    ["https://h.example/hook?c2VjcmV0LXNpZ25pbmcta2V5LTEy==", "secret-signing-key-12", "https://h.example/hook?[redacted]=…"],
    ["https://h.example/files/Pw7kq9Lm#2xZ8vR4/x", "Pw7kq9Lm#2xZ8vR4", "https://h.example/files/[redacted]/x"],
    ["https://h.example/cb?Zq8VbN3xLmT6pR2w\nYk9HsD4fGj7Ac5Ue ok", "Zq8VbN3xLmT6pR2wYk9HsD4fGj7Ac5Ue", "[redacted]"],
    [`https://${login}@git.example.com/repo.git`, "P@ss#word123456", "https[redacted]@git.example.com/repo.git"],
  ];
  for (const [text, key, shows] of cases) {
    assert.equal(resultTextOf(text, [key]), shows, text);
    assert.equal(cut(refusal.redactedCall(text, [key], CALL_RESULT_CHARS, scrubUrls), CALL_RESULT_CHARS), shows, text);
  }
  // A web_fetch's page url, read through the same redactor.
  const page = JSON.stringify({ ok: true, url: cases[0][0], status: 200, title: "Login", text: "signed in" });
  const web = resultTextOf(page, [cases[0][1]], "web_fetch", { url: "https://h.example/page" });
  assert.ok(web.includes('"url":"https://api.example.com/v1/login?user=…&pass=…"') && !web.includes("kq9Lm2"), web);
});

test("where a call's read stops inside a run cut at a quote, the rest of that run is read: no URL password the stop split shows in part", () => {
  // One held value of 32 characters; the password's quote and comma are past what its peek would read.
  const key = ["not-a-secret", "p2-key", "0123456789ab"].join("-");
  const login = ["admin", "hunterTWO-secretpw"].join(":");
  const text = `${"y ".repeat(Math.floor((120_000 - 8139) / 2))}{"a":"${"x".repeat(8100)}","u":"https://${login}",${"x".repeat(300)}@db.example/"} end ${"w ".repeat(5000)}`;
  const shown = cut(refusal.redactedCall(text, [key], CALL_RESULT_CHARS, scrubUrls), CALL_RESULT_CHARS);
  assert.ok(!shown.includes("hunterTWO"), shown.slice(-80));
  assert.ok(!resultTextOf(text, [key]).includes("hunterTWO"));
});

test("a held value split where a call's read stops, its rest past \"+\" or percent-encoded whitespace, shows none of it; whitespace runs read as one space, in time", () => {
  // The matcher decodes "+" and encoded whitespace, so the value reads whole across them; the read past the stop must
  // reach its rest, however much padding there is up to a piece.
  for (const pad of ["+".repeat(400), "%20".repeat(400), "%0A".repeat(200), "%E3%80%80".repeat(100)]) {
    const text = `${"y ".repeat(59_940)}${CUT_KEY.slice(0, 16)}\n${pad}${CUT_KEY.slice(16)}${"z".repeat(9000)} end`;
    const shown = cut(refusal.redactedCall(text, [CUT_KEY], CALL_RESULT_CHARS), CALL_RESULT_CHARS);
    assert.ok(!shown.includes(CUT_KEY.slice(0, 8)), `${pad.slice(0, 9)}: ${shown.slice(-60)}`);
  }
  // Padding longer than a piece is more than the read past the stop reads: the text is withheld.
  const long = `${"y ".repeat(59_940)}${CUT_KEY.slice(0, 16)}${"+".repeat(20_000)}${CUT_KEY.slice(16)} end`;
  assert.equal(refusal.redactedCall(long, [CUT_KEY], CALL_RESULT_CHARS), "[redacted]");
  // 20,000,000 spaces after the stop read as one: the value past them is seen, in well under a second and a half.
  const started = Date.now();
  const spaced = `${"y ".repeat(59_940)}${CUT_KEY.slice(0, 16)}${" ".repeat(20_000_000)}${CUT_KEY.slice(16)} end`;
  assert.equal(refusal.redactedCall(spaced, [CUT_KEY], CALL_RESULT_CHARS), "[redacted]");
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
  // The same texts with no held value split there are served, cut where the read stopped.
  const plain = `${"y ".repeat(59_940)}${"q".repeat(16)}\n${"+".repeat(400)}${"z".repeat(9000)} end`;
  assert.ok(refusal.redactedCall(plain, [CUT_KEY], CALL_RESULT_CHARS).startsWith("y y "));
});

test("a call's result that shows as almost nothing once its URLs lose their query values is not read to its end", () => {
  // 32.7 MB of URLs whose queries elide: it shows as 4,000 short URLs, so a read stopped by what it shows reads it all.
  const text = ` https://e.com/?x=${"q".repeat(8150)}`.repeat(4000);
  const began = Date.now();
  const shown = refusal.redactedCall(text, [CUT_KEY], CALL_RESULT_CHARS, scrubUrls);
  assert.ok(Date.now() - began < 1500, `${Date.now() - began} ms`);
  assert.ok(shown.startsWith(" https://e.com/?x=… https://e.com/?x=…") && shown.length < 120_000, shown.slice(0, 80));
});

test("compact JSON past a piece with no whitespace is read in pieces cut at its quotes (an array of numbers, at its commas), never withheld for its length; a held value in it is cut in place", () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `id-${i}`);
  const json = JSON.stringify({ ids });
  const numbers = JSON.stringify(Array.from({ length: 3000 }, (_, i) => i * 7919));
  for (const text of [json, numbers]) assert.ok(text.length > 8192 && !/\s/.test(text), "one run past a piece");
  for (const secrets of [[], [CUT_KEY]]) {
    for (const text of [json, numbers]) {
      assert.equal(refusal.redactedCall(text, secrets, 120_000), text);
      assert.equal(redactedAnswer(text, secrets), text);
    }
  }
  // A URL's password may hold a quote and a comma, where a run is cut: the joined pieces are read for every secret shape,
  // so one cut there withholds the text whole. (The user and password are joined here so no URL with a password is
  // written in this file.)
  const login = ["alice", "prefix"].join(":");
  const url = `"${"x".repeat(8100)}https://${login}",rest@host.example/${"z".repeat(3000)}`;
  assert.ok(!/\s/.test(url) && url.indexOf('",rest') < 8192 && url.length > 8192);
  assert.equal(redactedAnswer(url, []), "[redacted]");
  assert.equal(refusal.redactedCall(url, [], 120_000), "[redacted]");
  // A run cut at a quote that goes on past a piece with no place to cut is unread from its start: no piece of it shows,
  // so neither does the head of a password the cut split.
  const unread = `say "${"x".repeat(8100)}https://${login}",${"r".repeat(9000)}@host end`;
  assert.equal(redactedAnswer(unread, []), "say [redacted] end");
  assert.equal(refusal.redactedCall(unread, [], 120_000), "say [redacted] end");
  // No run is cut inside a URL's authority, so a password longer than any held value is never split where a call's read
  // stops: here the quote in it would be the last cut before 120,000 characters, and the run is read whole or not at all.
  const ftp = `${"y ".repeat(59_000)}ftp://${login}${"p".repeat(3000)}",${"q".repeat(1000)}@host/${"r".repeat(9000)} end`;
  for (const secrets of [[], [CUT_KEY]]) {
    assert.equal(refusal.redactedCall(ftp, secrets, 120_000), `${"y ".repeat(59_000)}[redacted] end`);
    assert.equal(redactedAnswer(ftp, secrets), `${"y ".repeat(59_000)}[redacted] end`);
  }
  // A URL with no path, then more JSON with no "/", "?", "#" or "@" after it: no "@" ends its authority, so it holds no
  // password, and the quotes after it are cut as anywhere else.
  const linked = JSON.stringify({ url: "https://example.com", ids });
  assert.ok(linked.length > 8192 && !/[\s@]/.test(linked));
  for (const secrets of [[], [CUT_KEY]]) {
    assert.equal(refusal.redactedCall(linked, secrets, 120_000), linked);
    assert.equal(redactedAnswer(linked, secrets), linked);
  }
  const holding = JSON.stringify({ ids: [...ids.slice(0, 1000), CUT_KEY, ...ids.slice(1000)] });
  assert.equal(refusal.redactedCall(holding, [CUT_KEY], 120_000), holding.replace(CUT_KEY, "[redacted]"));
  assert.equal(redactedAnswer(holding, [CUT_KEY]), holding.replace(CUT_KEY, "[redacted]"));
});

test("an sk- run, a key after a dash inside it, and a held value inside one are redacted as before", () => {
  const tail = "A".repeat(24);
  assert.equal(redactedAnswer(`pre sk-sk-sk-${tail} post`, []), "pre [redacted] post");
  assert.equal(redactedAnswer(`pre x-sk-${tail}-sk-${tail} post`, []), "pre x-[redacted] post");
  assert.equal(redactedAnswer(`a sk-${tail}${CUT_KEY}${tail} b`, [CUT_KEY]), "a [redacted] b");
  assert.equal(redactedAnswer(`a xoxb-xoxb-${"1".repeat(12)} b`, []), "a [redacted] b");
});

// A held value with no digits at all.
const KEYLESS = ["not-a-secret", "no-digits-here"].join("-");

// A held value can be all digits (a gateway's key), and a workflow's output can quote it as a number.
const DIGITS = ["1234", "5678", "9012"].join("");

test("a workflow output quoting an all-digit held key as a number is served with it withheld, and its other numbers kept", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6.1-sol", OPENAI_API_KEY: DIGITS }, NAMES);
  const { api } = await serve(t);
  const flow = {
    v: 2, name: "numbered",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Out: { type: "object", required: ["note", "n", "kept"], properties: { note: { type: "string" }, n: { type: "number" }, kept: { type: "number" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Out", path: "out" },
    root: { node: "chain", steps: [{ node: "extract", label: "out", instructions: "Submit the held number.", out: "Out", as: "out" }] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("numbered", flow))).status, 201);
  const started = await api("POST", "/agents/numbered/runs", { input: { question: "x" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.ok(!JSON.stringify(run.result).includes(DIGITS), JSON.stringify(run.result));
  assert.deepEqual(run.result.output, { note: "ok", n: "[redacted]", kept: 42 });
});

test("a number that is a held value, or whose digits hold one, nested or not, is withheld as a string holding it is; other numbers stay", () => {
  const held = Number(DIGITS);
  assert.deepEqual(redactedOutput(held, [DIGITS]), "[redacted]", "a number equal to it");
  assert.deepEqual(redactedOutput({ n: Number(`9${DIGITS}3`) }, [DIGITS]), { n: "[redacted]" }, "a number whose digits hold it");
  assert.deepEqual(redactedOutput({ list: [1, held], deep: { x: { y: held } } }, [DIGITS]), { list: [1, "[redacted]"], deep: { x: { y: "[redacted]" } } }, "nested");
  assert.deepEqual(redactedOutput({ big: BigInt(`7${DIGITS}`) }, [DIGITS]), { big: "[redacted]" }, "a bigint");
  assert.deepEqual(redactedOutput({ n: 42, f: 3.5, near: Number(DIGITS.slice(0, 11)), flag: true, none: null }, [DIGITS]), { n: 42, f: 3.5, near: Number(DIGITS.slice(0, 11)), flag: true, none: null }, "no held value: kept as it is");
});

test("a number whose VALUE is a held all-digit key is withheld even where its text differs (a leading zero, 1e21, a 20-digit key read lossy)", () => {
  const lead = ["0", "1234", "5678", "9012"].join("");
  assert.deepEqual(redactedOutput({ n: 123456789012 }, [lead]), { n: "[redacted]" }, "a held key with a leading zero");
  const big = ["1", "0".repeat(21)].join("");
  assert.deepEqual(redactedOutput({ n: 1e21 }, [big]), { n: "[redacted]" }, "1e21");
  const lossy = ["1234567890", "1234567891"].join("");
  assert.deepEqual(redactedOutput({ n: Number(lossy) }, [lossy]), { n: "[redacted]" }, "a 20-digit key, read as a number");
  // No numeric held value: nothing is withheld; a NaN and a 0 stay; an empty or whitespace value matches nothing.
  assert.deepEqual(redactedOutput({ zero: 0, nan: Number.NaN, n: 5 }, [KEYLESS]), { zero: 0, nan: Number.NaN, n: 5 });
  assert.deepEqual(redactedOutput({ zero: 0, n: 5 }, ["", "   "]), { zero: 0, n: 5 });
});
