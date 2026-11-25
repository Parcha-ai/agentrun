// A totals read (turns: false, totals: true) keeps of each request its model and usage alone, as counts, while the file
// is read: the requests come out as a turns: false read's do, in their order, its later lines' usage over the first's,
// copies left out the same, and the read holds no Answer, call name, tool result or title for them.
import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { atOf } from "../dist/counts.js";
import { lineReader, READERS } from "../dist/index.js";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, codexAnswer, codexContext, codexFile, codexMeta, codexTokens, codexUser, jsonl, openaiUsage, parseHome, piAnswer, piFile, piMeta, piUser, tempHome, writeJsonl } from "./fixtures.mjs";

const USAGE = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning"];

/** A totals read's requests as Answers' model and usage: each one's model as named (else none), its usage as read. */
function fromCounts({ counts, requests }) {
  assert.deepEqual(requests, []);
  const out = [];
  for (let i = 0; i < counts.n; i += 1) {
    const at = counts.model[i];
    const has = counts.has[i];
    let usage;
    if (has & 1) {
      usage = {};
      USAGE.forEach((name, k) => {
        if (k < 4 || (k === 4 && has & 2) || (k === 5 && has & 4)) usage[name] = counts.values[i * 7 + k];
      });
    }
    out.push({ model: at === -1 ? undefined : counts.models[at], usage });
  }
  return out;
}
const fromRequests = ({ requests }) => requests.map(({ model, usage }) => ({ model, usage: usage && Object.fromEntries(USAGE.filter((name) => usage[name] !== undefined).map((name) => [name, usage[name]])) }));
/** A session as a totals read gives it: no title (it keeps none). */
const untitled = ({ sourceTitle: _title, ...session }) => session;

/** Each file read in order with each kind of read, each kind sharing its own seen: the same requests and sessions. */
async function same(reader, files) {
  const seen = { plain: new Set(), totals: new Set() };
  for (const file of files) {
    const plain = await reader.read({ file }, undefined, { turns: false, seen: seen.plain });
    const totals = await reader.read({ file }, undefined, { turns: false, totals: true, seen: seen.totals });
    assert.equal(totals.sessions.length, plain.sessions.length);
    plain.sessions.forEach((read, s) => {
      assert.deepEqual(fromCounts(totals.sessions[s]), fromRequests(read), file);
      assert.deepEqual(untitled(totals.sessions[s].session), untitled(read.session), file);
    });
    // The read held no request as an Answer, nor a name, title, uuid or result to make turns of.
    const { state } = totals.cursor;
    assert.deepEqual(state.answers, []);
    assert.equal(state.names.size, 0);
    if (state.own.keyed) assert.equal(state.own.keyed.size, 0);
    if (state.own.results) assert.equal(state.own.results.size + state.own.items.size, 0);
  }
  return seen;
}

// A seeded generator: the same records every run.
function random(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Claude Code lines with a request's lines apart (results, other requests between), a key back long after, keys with no
 *  request id, the CLI's own turns, failures, no usage, a line written twice, 1h cache writes. */
function claudeRecords(rnd, prefix, n) {
  const pick = (k) => Math.floor(rnd() * k);
  const out = [];
  const open = [];
  let i = 0;
  for (let r = 0; r < n; r += 1) {
    const model = ["claude-fixture-1", "claude-fixture-2", "<synthetic>"][rnd() < 0.05 ? 2 : pick(2)];
    open.push({ msg: `msg_${prefix}${r}`, req: rnd() < 0.1 ? undefined : `req_${prefix}${r}`, model, lines: 1 + pick(3), failed: model === "<synthetic>" && rnd() < 0.5 });
    while (open.length && (rnd() < 0.6 || r === n - 1)) {
      const k = rnd() < 0.8 ? open.length - 1 : pick(open.length);
      const q = open[k];
      q.lines -= 1;
      const usage = rnd() < 0.1 ? undefined : anthropicUsage(pick(100), q.lines === 0 ? 1000 + pick(100) : pick(10), pick(1000), 40, rnd() < 0.3 ? pick(40) : undefined);
      const block = rnd() < 0.5 ? { type: "tool_use", id: `toolu_${prefix}${r}_${i}`, name: "Bash", input: { command: "ls" } } : { type: "text", text: rnd() < 0.1 ? "" : "Done." };
      const line = { ...claudeAnswer({ uuid: `${prefix}-a${i}`, msg: q.msg, req: q.req, usage, i, model: q.model, block }), ...(q.failed ? { isApiErrorMessage: true } : {}) };
      out.push(line);
      if (rnd() < 0.05) out.push(line);
      if (block.type === "tool_use") out.push(claudeUser({ uuid: `${prefix}-r${i}`, text: [{ type: "tool_result", tool_use_id: block.id, content: "ok" }], i }));
      if (rnd() < 0.1) out.push(claudeUser({ uuid: `${prefix}-u${i}`, text: "Go on.", i }));
      i += 1;
      if (q.lines === 0) open.splice(k, 1);
      if (rnd() < 0.3) break;
    }
  }
  // A key back long after its request: its usage is the request's now.
  const back = out.find((line) => line.type === "assistant" && line.requestId);
  if (back) out.push({ ...back, uuid: `${prefix}-late`, message: { ...back.message, usage: anthropicUsage(7, 7777) } });
  out.push({ type: "ai-title", aiTitle: "A title", sessionId: "s" }, { type: "summary", summary: "A summary", leafUuid: `${prefix}-a0` });
  return out;
}

test("Claude Code: a totals read's requests are a turns: false read's, its copies the same", async (t) => {
  const home = await tempHome(t);
  const rnd = random(7);
  const first = claudeRecords(rnd, "f", 400);
  // A resumed session's file: a copy of the first's records, then its own.
  const second = [...first.filter((line) => line.type === "assistant" || line.type === "user").slice(0, 300), ...claudeRecords(rnd, "s", 300)];
  const a = await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-00000000000a"), first);
  const b = await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-00000000000b"), second);
  const seen = await same(READERS["claude-code"], [a, b]);
  assert.deepEqual([...seen.totals].sort(), [...seen.plain].sort());
});

test("Claude Code: a request copied under uuids of its own, and a line with no message id, are read alike by a totals read and a turns: false read", async (t) => {
  const home = await tempHome(t);
  const first = [
    claudeAnswer({ uuid: "k-a1", msg: "msg_k1", req: "req_k1", usage: anthropicUsage(10, 1), i: 1, block: { type: "tool_use", id: "toolu_k1", name: "Bash", input: {} } }),
    claudeAnswer({ uuid: "k-a2", msg: "msg_k1", req: "req_k1", usage: anthropicUsage(10, 9), i: 2 }),
    claudeAnswer({ uuid: "k-a3", msg: "msg_k2", usage: anthropicUsage(20, 2), i: 3 }),
  ];
  // A resumed session's file: the first's requests again, each line under a uuid of its own (a copy by its request's key
  // alone), a line with no message id and nothing in it (no request), one with no message id and text (a request), then
  // a request of its own.
  const second = [
    ...first.map((line, k) => ({ ...line, uuid: `k-b${k}` })),
    claudeAnswer({ uuid: "k-b3", usage: anthropicUsage(5, 5), i: 4, block: { type: "text", text: "" } }),
    claudeAnswer({ uuid: "k-b4", usage: anthropicUsage(6, 6), i: 5 }),
    claudeAnswer({ uuid: "k-b5", msg: "msg_k3", req: "req_k3", usage: anthropicUsage(7, 7), i: 6 }),
  ];
  const a = await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-00000000000c"), first);
  const b = await writeJsonl(claudeFile(home, "00000000-0000-4000-8000-00000000000d"), second);
  const reader = READERS["claude-code"];
  const seen = await same(reader, [a, b]);
  assert.deepEqual([...seen.totals].sort(), [...seen.plain].sort());
  // And what each holds: the first file's two requests, the second's three copies and two requests of its own.
  const kept = new Set();
  const reads = [];
  for (const file of [a, b]) reads.push((await reader.read({ file }, undefined, { turns: false, totals: true, seen: kept })).sessions[0]);
  assert.deepEqual(
    reads.map(({ counts, session }) => [counts.n, session.copies]),
    [
      [2, 0],
      [2, 3],
    ],
  );
  assert.deepEqual(
    reads.map((read) => fromCounts(read).map(({ usage }) => usage.output)),
    [
      [9, 2],
      [6, 7],
    ],
  );
});

/** Codex lines: turns that change the model, calls and their results (the open request's and others'), usage after the
 *  results, token counts that repeat their total, token_usage_records with a response twice, an aborted turn. */
function codexRecords(rnd, records) {
  const pick = (k) => Math.floor(rnd() * k);
  const out = [{ type: "session_meta", timestamp: at(0), payload: { id: "thread-1", cwd: "/work/fixture", model_provider: "openai" } }];
  let total = 0;
  let calls = 0;
  const response = (type, payload, i) => ({ type, timestamp: at(i), payload });
  for (let i = 1; i < 2000; i += 1) {
    const r = rnd();
    if (r < 0.04) out.push(response("turn_context", { model: ["gpt-fixture", "gpt-other", "other/model"][pick(3)], effort: "high", cwd: "/work/fixture" }, i));
    else if (r < 0.1) out.push(response("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `Do ${i}.` }] }, i));
    else if (r < 0.25) out.push(response("response_item", { type: "reasoning", summary: [] }, i));
    else if (r < 0.4) out.push(response("response_item", { type: "function_call", name: "shell", arguments: "{}", call_id: `call_${(calls += 1)}` }, i));
    else if (r < 0.5) out.push(response("response_item", { type: "function_call_output", call_id: `call_${Math.max(1, calls - pick(3))}`, output: "Exit code: 0\nOutput:\nok" }, i));
    else if (r < 0.58) out.push(response("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: rnd() < 0.2 ? "" : "Done." }] }, i));
    else if (r < 0.75 && !records) {
      const last = openaiUsage(1000 + pick(1000), pick(500), pick(300), pick(100));
      if (rnd() > 0.15) total += 1;
      out.push(response("event_msg", { type: "token_count", info: rnd() < 0.05 ? null : { last_token_usage: last, total_token_usage: { total } } }, i));
    } else if (r < 0.75) out.push(response("token_usage_record", { response_id: `resp_${pick(i)}`, usage: openaiUsage(500 + pick(500), pick(200), pick(100)) }, i));
    else if (r < 0.78) out.push(response("event_msg", { type: "item_completed", item: { id: `call_${calls}`, status: "failed" } }, i));
    else if (r < 0.8) out.push(response("event_msg", { type: "turn_aborted" }, i));
  }
  return out;
}

test("Codex: a totals read's requests are a turns: false read's, by token counts and by usage records", async (t) => {
  const home = await tempHome(t);
  const counted = await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-00-a.jsonl"), codexRecords(random(11), false));
  const recorded = await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-00-b.jsonl"), codexRecords(random(12), true));
  await same(READERS.codex, [counted, recorded]);
});

test("Codex: a late result of an earlier request's call leaves the open request open, in every kind of read and from a cursor", async (t) => {
  const home = await tempHome(t);
  const records = [
    codexMeta("thread-late"),
    codexContext(1),
    codexUser("Go.", 2),
    { type: "response_item", timestamp: at(3), payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "call_a" } },
    codexTokens(openaiUsage(100, 0, 10), openaiUsage(100, 0, 10), 4),
    { type: "response_item", timestamp: at(5), payload: { type: "reasoning", summary: [] } },
    // The first request's call's result, after its usage: the second request, open, is no request of that call's.
    { type: "response_item", timestamp: at(6), payload: { type: "function_call_output", call_id: "call_a", output: "ok" } },
    codexAnswer("Done.", 7),
    codexTokens(openaiUsage(200, 0, 20), openaiUsage(300, 0, 30), 8),
  ];
  const file = await writeJsonl(codexFile(home, "rollout-2026-01-01T00-00-00-late.jsonl"), records);
  const reader = READERS.codex;
  const outputs = (read) => (read.counts ? fromCounts(read) : fromRequests(read)).map(({ usage }) => usage?.output);
  for (const options of [{}, { turns: false }, { turns: false, totals: true }]) assert.deepEqual(outputs((await reader.read({ file }, undefined, options)).sessions[0]), [10, 20], JSON.stringify(options));
  // Two passes, the first ending after each line in turn: the second goes on from its cursor.
  const text = jsonl(records);
  for (let cut = text.indexOf("\n") + 1; cut < text.length; cut = text.indexOf("\n", cut) + 1) {
    await writeFile(file, text.slice(0, cut));
    const first = await reader.read({ file }, undefined, { turns: false, totals: true });
    await appendFile(file, text.slice(cut));
    const next = await reader.read({ file }, first.cursor, { turns: false, totals: true });
    assert.equal(next.resumed, true);
    assert.deepEqual(outputs(next.sessions[0]), [10, 20], `from byte ${cut}`);
  }
});

test("a totals read goes on from its cursor as it read, and no read of another kind goes on from it", async (t) => {
  const home = await tempHome(t);
  const rnd = random(3);
  const lines = claudeRecords(rnd, "c", 200);
  const file = await writeJsonl(claudeFile(home), lines.slice(0, 150));
  const reader = READERS["claude-code"];
  const kept = new Set();
  const first = await reader.read({ file }, undefined, { turns: false, totals: true, seen: kept });
  // An unfinished last line: read, but the cursor stays before it.
  await appendFile(file, `${lines.slice(150).map((line) => JSON.stringify(line)).join("\n")}`);
  const whole = await reader.read({ file }, undefined, { turns: false, totals: true, seen: new Set() });
  const resumed = await reader.read({ file }, first.cursor, { turns: false, totals: true, seen: kept });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(fromCounts(resumed.sessions[0]), fromCounts(whole.sessions[0]));
  for (const options of [{ turns: false }, { turns: true }]) assert.equal((await reader.read({ file }, first.cursor, options)).resumed, false);
  const plain = await reader.read({ file }, undefined, { turns: false });
  assert.equal((await reader.read({ file }, plain.cursor, { turns: false, totals: true })).resumed, false);
  // A pi file: its requests as counts too.
  const pi = join(home, "pi.jsonl");
  await writeFile(pi, "");
  assert.equal((await READERS.pi.read({ file: pi }, undefined, { turns: false, totals: true })).sessions[0].counts.n, 0);
});

test("a source of the caller's own that asks for no totals read is totalled from its answers, a turn's usage set after it was added kept", async (t) => {
  const home = await tempHome(t);
  await writeFile(join(home, "mine.jsonl"), [{ t: "req" }, { t: "usage" }].map((record) => `${JSON.stringify({ ...record, timestamp: at(0) })}\n`).join(""));
  // Its request's usage comes on a later line, set on the turn it added then.
  const mine = lineReader({
    source: "mine",
    name: "Mine",
    harness: "fixture",
    files: async (dir) => [join(dir, "mine.jsonl")],
    start: () => ({}),
    record(value, when, { state, add }) {
      if (value.t === "req") add((state.own.open = { role: "assistant", text: "", calls: [], at: when, model: "fixture-model" }));
      else if (value.t === "usage") state.own.open.usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
    },
    idOf: () => "mine-1",
  });
  for (const state of [undefined, {}]) {
    const [session] = await parseHome(home, { sources: ["mine"], readers: { ...READERS, mine }, catalog: false, ...(state ? { state } : {}) });
    assert.deepEqual([session.calls, session.tokens.input, session.tokens.output], [1, 100, 50], state ? "with a state" : "without");
  }
});

// Each request's time, as a turns read gives it (its first record's, else the latest before it, else 0): a totals
// read's counts carry it too, for what buckets requests by time.
const timesOf = ({ counts, requests }) => (counts ? Array.from({ length: counts.n }, (_, i) => atOf(counts, i)) : requests.map((request) => request.at));

const time = (i) => Date.parse(at(i));
const untimed = ({ timestamp: _time, ...record }) => record;
const item = (i, payload) => ({ type: "response_item", timestamp: at(i), payload });
const usageRecord = (i, id, usage) => ({ type: "token_usage_record", timestamp: at(i), payload: { response_id: id, usage } });
const OTHER = "00000000-0000-4000-8000-000000000002";
const piUntimed = (answer) => ({ ...untimed(answer), message: untimed(answer.message) });
const piAt = (answer, i) => ({ ...answer, message: { ...answer.message, timestamp: time(i) } });

// Each source's files: their records and each request's time. A request over two lines (its first line's time), a line
// with no time (the latest before it), a usage with no request of its own (its line's), a request of a file with no time.
const TIMED = {
  "claude-code": (home) => [
    [claudeFile(home), [claudeUser({ uuid: "u1", text: "Go.", i: 0 }), claudeAnswer({ uuid: "a1", msg: "m1", req: "r1", usage: anthropicUsage(10, 1), i: 1 }), claudeAnswer({ uuid: "a2", msg: "m1", req: "r1", usage: anthropicUsage(10, 5), i: 4, block: { type: "tool_use", id: "t1", name: "Bash", input: {} } }), untimed(claudeAnswer({ uuid: "a3", msg: "m2", req: "r2", usage: anthropicUsage(20, 5) })), claudeUser({ uuid: "u2", text: "More.", i: 6 }), claudeAnswer({ uuid: "a4", msg: "m3", req: "r3", usage: anthropicUsage(30, 5), i: 7 })], [time(1), time(4), time(7)]],
    [claudeFile(home, OTHER), [untimed(claudeAnswer({ uuid: "b1", msg: "n1", req: "q1", usage: anthropicUsage(1, 1), session: OTHER }))], [0]],
  ],
  codex: (home) => [
    [codexFile(home), [codexMeta("thread-times"), codexContext(1), codexUser("Go.", 2), item(3, { type: "reasoning", summary: [] }), item(4, { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" }), item(5, { type: "function_call_output", call_id: "c1", output: "ok" }), codexTokens(openaiUsage(100, 0, 10), openaiUsage(100, 0, 10), 6), codexTokens(openaiUsage(50, 0, 5), openaiUsage(150, 0, 15), 8), untimed(codexTokens(openaiUsage(20, 0, 2), openaiUsage(170, 0, 17))), codexAnswer("Done.", 10)], [time(3), time(8), time(8), time(10)]],
    [codexFile(home, "rollout-2026-01-01T00-00-01-records.jsonl"), [codexMeta("thread-records"), codexContext(1), codexUser("Go.", 2), codexAnswer("Done.", 3), usageRecord(4, "resp_1", openaiUsage(100, 0, 10)), usageRecord(6, "resp_2", openaiUsage(50, 0, 5)), untimed(usageRecord(0, "resp_3", openaiUsage(20, 0, 2)))], [time(3), time(6), time(6)]],
    [codexFile(home, "rollout-2026-01-01T00-00-02-untimed.jsonl"), [codexMeta("thread-untimed"), codexContext(1), codexUser("Go.", 2), codexAnswer("Done.", 3), codexTokens(openaiUsage(10, 0, 1), openaiUsage(10, 0, 1), 4)].map(untimed), [0]],
  ],
  pi: (home) => [
    [piFile(home), [piMeta(), piUser("Go.", 1), piAnswer({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 2), piAt(piAnswer({ input: 20, output: 5, cacheRead: 0, cacheWrite: 0 }, 5), 3), { ...piAnswer({ input: 30, output: 5, cacheRead: 0, cacheWrite: 0 }, 6), message: untimed(piAnswer({ input: 30, output: 5, cacheRead: 0, cacheWrite: 0 }, 6).message) }, piUntimed(piAnswer({ input: 40, output: 5, cacheRead: 0, cacheWrite: 0 }, 7))], [time(2), time(3), time(6), time(6)]],
    [piFile(home, "pi-session-2"), [untimed(piMeta("pi-session-2")), piUntimed(piAnswer({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }))], [0]],
  ],
};

for (const [source, filesOf] of Object.entries(TIMED)) {
  test(`${source}: a totals read's counts carry each request's time, a turns read's, from its start and from a cursor`, async (t) => {
    const home = await tempHome(t);
    const reader = READERS[source];
    for (const [file, records, times] of filesOf(home)) {
      await writeJsonl(file, records);
      const read = async (options, cursor) => (await reader.read({ file }, cursor, options)).sessions[0];
      assert.deepEqual(timesOf(await read({})), times, `${file}: a turns read`);
      assert.deepEqual(timesOf(await read({ turns: false })), times, `${file}: a turns: false read`);
      assert.deepEqual(timesOf(await read({ turns: false, totals: true })), times, `${file}: a totals read`);
      // Two passes, the first ending halfway through each line in turn: the second goes on from its cursor.
      const text = jsonl(records);
      for (let start = 0; start < text.length; start = text.indexOf("\n", start) + 1) {
        const cut = start + Math.floor((text.indexOf("\n", start) - start) / 2);
        await writeFile(file, text.slice(0, cut));
        const first = await reader.read({ file }, undefined, { turns: false, totals: true });
        await appendFile(file, text.slice(cut));
        const next = await reader.read({ file }, first.cursor, { turns: false, totals: true });
        assert.equal(next.resumed, true);
        assert.deepEqual(timesOf(next.sessions[0]), times, `${file}: a totals read gone on from byte ${cut}`);
      }
    }
  });
}
