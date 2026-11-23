// A totals read (turns: false, totals: true) keeps of each request its model and usage alone, as counts, while the file
// is read: the requests come out as a turns: false read's do, in their order, its later lines' usage over the first's,
// copies left out the same, and the read holds no Answer, call name, tool result or title for them.
import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { lineReader, parseHome, READERS } from "../dist/index.js";
import { anthropicUsage, at, claudeAnswer, claudeFile, claudeUser, codexFile, openaiUsage, tempHome, writeJsonl } from "./fixtures.mjs";

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
        if (k < 4 || (k === 4 && has & 2) || (k === 5 && has & 4)) usage[name] = counts.usage[i * 6 + k];
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
