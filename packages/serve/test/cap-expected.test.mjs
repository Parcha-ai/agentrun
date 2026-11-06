// Expected-cost admission (cap_mode "expected", the default): a request's input is priced from the previous request's
// reported usage in the same conversation, its cached prefix (cache reads and cache writes) at the cache-read rate when
// that request ended less than 4 minutes ago, the rest at the input rate. A cap then pays for the requests a run makes,
// most of whose input is a cache read, instead of pausing near half of it. Output never crosses the cap (the clamp is
// kept); only a cache miss can, by at most the request's bound (its input uncached less its input expected), and the
// real cost is booked. cap_mode "strict" keeps the worst case: every input uncached. A faux model priced like Claude
// Sonnet 5.5 ($2 in, $10 out, $0.20 cache read, $2.50 cache write a million), its usage reported as Anthropic's API
// reports a growing conversation: each request reads the previous one's prompt from the cache. The clock is injected.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { capBefore, capModels, HELD_USD, inputBound, piOverhead, spentIn, useSpend } from "../dist/cap.js";
import { markRequests } from "../dist/request-start.js";
import { withOverCap } from "../dist/runs.js";

const SONNET = { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "anthropic-messages", provider: "anthropic", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, contextWindow: 1_000_000, maxTokens: 64_000 };
const CAP = 0.5;
/** The option a request's bound rides on to its marks (cap.ts BOUND_USD), read by its registered name. */
const BOUND_USD = Symbol.for("agentrun.serve.bound_usd");
const WARM_MS = 4 * 60_000;
/** The least output a request is sent with: the answer's 1,024 tokens, at $10 a million. */
const FLOOR_USD = 1_024 * 10 / 1e6;
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A conversation of the size the tester's ran: a 80,000-character task (about 20,000 tokens), each turn a tool call and
 *  a 4,000-character result. */
const conversation = () => ({ messages: [{ role: "user", content: `Audit the report below.\n${"The quarterly figures hold. ".repeat(2_858)}`, timestamp: 0 }] });
const resultOf = (k) => ({ role: "toolResult", toolCallId: `call-${k}`, toolName: "read", content: [{ type: "text", text: `Page ${k}: ${"a line of the page read back. ".repeat(133)}` }], isError: false, timestamp: 0 });
/** A prompt's tokens as the faux provider counts them: one per 4 bytes of what is sent. */
const promptTokens = (context) => Math.ceil(Buffer.byteLength(JSON.stringify(context), "utf8") / 4);
const usageOf = (input, cacheRead, cacheWrite, output) => {
  const usage = { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
  return { ...usage, cost: calculateCost(SONNET, { ...usage, cost: {} }) };
};
/** The worst case today's rule prices a request at: every input token at the cache write's $2.50, and `output` tokens. */
const worstOf = (context, output) => inputBound(JSON.stringify(context), piOverhead(SONNET, context)) * 2.5 / 1e6 + output * 10 / 1e6;

/** A Models whose every request answers at once with a tool call, its usage as Anthropic's cache reports it: the previous
 *  request's whole prompt read from the cache, the rest written to it, 3 tokens of input after the last breakpoint, 300
 *  of output. `miss(k)`: request k finds no cache (cold, or a cache the provider dropped), its whole prompt written.
 *  `hold(k)`: request k is held open, never answered. `clock`: each answer's timestamp. */
function sonnetModels({ miss = () => false, hold = () => false, clock = () => Date.now() } = {}) {
  const sent = [];
  let previous = 0;
  const send = (_model, context, options) => {
    const k = sent.length;
    sent.push({ options, context: structuredClone(context) });
    const events = createAssistantMessageEventStream();
    if (hold(k)) return events;
    const prompt = promptTokens(context);
    const read = miss(k) ? 0 : previous;
    previous = prompt;
    const message = { role: "assistant", content: [{ type: "toolCall", id: `call-${k}`, name: "read", arguments: { path: `page-${k}.txt` } }], api: SONNET.api, provider: SONNET.provider, model: SONNET.id, usage: usageOf(3, read, prompt - read - 3, 300), stopReason: "toolUse", timestamp: clock() };
    queueMicrotask(() => {
      events.push({ type: "done", reason: "toolUse", message });
      events.end(message);
    });
    return events;
  };
  return { models: { stream: send, streamSimple: send, complete: (...a) => send(...a).result(), completeSimple: (...a) => send(...a).result() }, sent };
}

/** Requests one after another on a growing conversation until the cap refuses one: what the answered ones cost, how many
 *  went, and the refusal. */
async function untilRefused(capped, context = conversation()) {
  let spent = 0;
  for (let k = 0; k < 400; k++) {
    const answer = await capped.streamSimple(SONNET, context).result();
    await settle();
    if (answer.stopReason === "error") return { spent, sent: k, refusal: answer.errorMessage };
    spent += answer.usage.cost.total;
    context.messages.push(answer, resultOf(k));
  }
  throw new Error("never refused");
}

test("pi: a $0.50 cap on a Sonnet-priced model whose requests read ~90% of their input from the cache spends at least 90% of the cap before it pauses, and never passes it", async (t) => {
  t.after(() => useSpend(undefined));
  const { models } = sonnetModels();
  const { spent, sent, refusal } = await untilRefused(await capModels(models, CAP, 0));
  assert.match(refusal, /^spend_cap_reached \(out of budget\): /);
  assert.ok(spent >= 0.9 * CAP, `spent $${spent.toFixed(4)} of the $${CAP} cap in ${sent} requests before it paused`);
  assert.ok(spent <= CAP, `never past the cap: $${spent}`);
});

test("pi strict (cap_mode \"strict\"): every input priced uncached, as before: the run never passes its cap and pauses where the worst case says, each request with no bound", async (t) => {
  t.after(() => useSpend(undefined));
  const { models, sent } = sonnetModels();
  const context = conversation();
  const { spent } = await untilRefused(await capModels(models, CAP, 0, { mode: "strict" }), context);
  assert.ok(spent <= CAP, `never past the cap: $${spent}`);
  // Today's rule: the refused request's input uncached and least output do not fit beside what was spent, and the last
  // one sent did beside what was spent before it.
  assert.ok(spent + worstOf(context, 1_024) > CAP, "the refused request's worst case does not fit");
  const before = { messages: context.messages.slice(0, -2) };
  assert.ok(spent - context.messages.at(-2).usage.cost.total + worstOf(before, 1_024) <= CAP, "the one before it fit");
  for (const { options } of sent) assert.equal(options[BOUND_USD] ?? 0, 0, "no bound under strict");
});

test("pi: the previous request's cache counts only when it ended less than 4 minutes ago: at 3:59.999 the request is held at its expected cost, at 4:00.001 at its worst case, as strict holds it", async (t) => {
  t.after(() => useSpend(undefined));
  const T0 = Date.parse("2026-11-06T12:00:00Z");
  /** The hold of a conversation's second request, sent `gap` ms after the first ended, under `mode`. */
  const secondHold = async (gap, mode) => {
    let now = T0;
    const { models, sent } = sonnetModels({ clock: () => now });
    const capped = await capModels(models, 5, 0, { now: () => now, ...(mode ? { mode } : {}) });
    const context = conversation();
    const first = await capped.streamSimple(SONNET, context).result();
    await settle();
    context.messages.push(first, resultOf(0));
    now = T0 + gap;
    await capped.streamSimple(SONNET, context).result();
    await settle();
    return { held: sent[1].options[HELD_USD], bound: sent[1].options[BOUND_USD] ?? 0 };
  };
  const warm = await secondHold(WARM_MS - 1);
  const cold = await secondHold(WARM_MS + 1);
  const strict = await secondHold(WARM_MS - 1, "strict");
  assert.ok(warm.held < cold.held, `warm $${warm.held} held below cold $${cold.held}`);
  assert.ok(warm.bound > 0, "a warm request carries its bound");
  assert.equal(cold.held, strict.held, "cold is priced as strict prices it");
  assert.equal(cold.bound, 0, "cold has nothing to overshoot");
});

test("pi: a cache miss on a request admitted at its expected cost books its real cost, past the cap, by no more than the bound it was sent with", async (t) => {
  t.after(() => useSpend(undefined));
  // Every request reads the cache until the run has spent $0.40 of its $0.50; the next finds none.
  let spent = 0;
  let missAt;
  const { models, sent } = sonnetModels({ miss: (k) => (missAt ??= spent >= 0.4 ? k : undefined) === k });
  let figures;
  const capped = await capModels(models, CAP, 0, { refused: async (f) => void (figures = f) });
  const context = conversation();
  for (let k = 0; k < 400; k++) {
    const answer = await capped.streamSimple(SONNET, context).result();
    await settle();
    if (answer.stopReason === "error") break;
    spent += answer.usage.cost.total;
    context.messages.push(answer, resultOf(k));
  }
  assert.ok(missAt !== undefined, `a request went out on a cache miss (spent $${spent.toFixed(4)})`);
  const bound = sent[missAt].options[BOUND_USD];
  assert.ok(bound > 0, `the miss was sent with a bound: ${bound}`);
  assert.ok(spent > CAP, `the miss passed the cap: $${spent}`);
  assert.ok(Math.abs(figures.spentUsd - spent) < 1e-12, `the real cost is booked, never clipped: ${figures.spentUsd} vs ${spent}`);
  assert.ok(spent - CAP <= bound + 1e-12, `by no more than its bound: over $${spent - CAP}, bound $${bound}`);
});

test("the over-cap row of a run that passed its cap on a cache miss says by how much and the most it could have, in cents: one row, in these words", () => {
  const usage = (usd) => ({ id: "1:usage", kind: "usage", summary: "Cost so far", seq: 9, text: null, usage: { usd, requests: 2 } });
  const rows = (usd) => [{ id: "1:3", kind: "final_answer", summary: "Done.", seq: 8, text: "Done." }, usage(usd)];
  const out = withOverCap(rows(0.5267564), 0.5, 0.19603125);
  assert.equal(out.filter((row) => row.id.endsWith(":over_cap")).length, 1, "one row");
  assert.equal(out[2].summary, "Went $0.03 over its cap on a cache miss (at most $0.20).");
  // No bound (strict, a cold request, or a cap passed some other way): the row says what it said, in cents.
  assert.equal(withOverCap(rows(0.5267564), 0.5, 0)[2].summary, "Spent $0.53, $0.03 over the run's cap of $0.50");
  assert.equal(withOverCap(rows(0.5267564), 0.5)[2].summary, "Spent $0.53, $0.03 over the run's cap of $0.50");
  // Over by more than the bound: not the cache miss's doing, so not in its words.
  assert.equal(withOverCap(rows(0.8), 0.5, 0.1)[2].summary, "Spent $0.80, $0.30 over the run's cap of $0.50");
  // A cap that is no whole number of cents is said in cents, never as a float's tail.
  assert.equal(withOverCap(rows(0.5), 0.38020940000000003)[2].summary, "Spent $0.50, $0.12 over the run's cap of $0.38");
});

/** A store holding `entries` in order, as a later process reads it. */
function storeOf(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "cap-expected-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO entries (conversation_id, record) VALUES (1, ?)");
  for (const entry of entries) put.run(JSON.stringify(entry));
  db.close();
  return file;
}

test("pi: a restart mid-request reads what this process held: the request in flight at its expected cost (its start mark's heldUsd), its bound beside it, never its worst case", async (t) => {
  t.after(() => useSpend(undefined));
  const marks = [];
  const { models, sent } = sonnetModels({ hold: (k) => k === 1 });
  const marked = await markRequests(models);
  const capped = await capModels(marked.models, 1, 0);
  marked.open({ harness: { commit: async (change) => change({ appendEntry: async (_conversation, entry) => void marks.push(entry) }) } });
  const context = conversation();
  const first = await capped.streamSimple(SONNET, context).result();
  await settle();
  const entries = [...marks, { kind: "pi.assistant", model: [first] }];
  context.messages.push(first, resultOf(0));
  void capped.streamSimple(SONNET, context);
  for (let i = 0; marks.length < 2; i++) {
    assert.ok(i < 100, "the second request's start is marked");
    await settle();
  }
  const held = sent[1].options[HELD_USD];
  // The rule, by hand: the first request's prompt read from the cache at $0.20, its 3 tokens of input and the bytes the
  // conversation grew by since it at $2.50, and the 64,000 tokens of output the cap leaves it at $10.
  const before = { messages: context.messages.slice(0, 1) };
  const grew = inputBound(JSON.stringify(context), piOverhead(SONNET, context)) - inputBound(JSON.stringify(before), piOverhead(SONNET, before));
  const expected = (first.usage.cacheRead + first.usage.cacheWrite) * 0.2 / 1e6 + (first.usage.input + grew) * 2.5 / 1e6 + 64_000 * 10 / 1e6;
  assert.ok(Math.abs(held - expected) < 1e-12, `held at its expected cost: ${held} vs ${expected}`);
  const start = marks[1];
  assert.equal(start.data.heldUsd, held, "its start mark holds what this process held");
  assert.ok(Math.abs(start.data.boundUsd - (worstOf(context, 64_000) - held)) < 1e-12, `and its bound: ${start.data.boundUsd}`);
  // The process dies here: a later one reads the cut request at its hold.
  entries.push(start);
  const read = spentIn(storeOf(t, entries));
  assert.ok(Math.abs(read - (first.usage.cost.total + held)) < 1e-12, `read again: ${read} vs ${first.usage.cost.total + held}`);
});

test("another harness (claude-agent, codex, opencode): the guard prices a request by the previous request's usage, by the same rule: a $0.50 cap spends at least 90% of itself before it refuses", async () => {
  const guard = await capBefore(CAP, SONNET);
  let spent = 0;
  let previous;
  let made = 0;
  for (let prompt = 20_000; made < 400; made++, prompt += 1_100) {
    const verdict = guard.beforeRequest({ spentUsd: spent, inFlight: [], inputTokensMax: prompt * 4, previous, model: SONNET.id });
    if (verdict && "refuse" in verdict) break;
    const read = previous ? previous.cachedTokens + previous.inputTokens : 0;
    const usage = usageOf(3, read, prompt - read - 3, 300);
    spent += usage.cost.total;
    previous = { cachedTokens: usage.cacheRead + usage.cacheWrite, inputTokens: usage.input, boundTokens: prompt * 4, endedAt: Date.now() };
  }
  assert.ok(spent >= 0.9 * CAP, `spent $${spent.toFixed(4)} of the $${CAP} cap in ${made} requests before it refused`);
  assert.ok(spent <= CAP);
});

test("another harness: the guard's admission carries what the request is held at (its expected cost), its bound, and its stopped figure, and strict holds the worst case with no bound", async () => {
  const at = Date.parse("2026-11-06T12:00:00Z");
  const previous = { cachedTokens: 20_000, inputTokens: 3, boundTokens: 80_000, endedAt: at };
  const request = { spentUsd: 0, inFlight: [], inputTokensMax: 84_400, previous, model: SONNET.id };
  const worstInput = 84_400 * 2.5 / 1e6;
  const expectedInput = 20_000 * 0.2 / 1e6 + (3 + 4_400) * 2.5 / 1e6;
  const warm = (await capBefore(1, SONNET, { now: () => at + WARM_MS - 1 })).beforeRequest(request);
  assert.equal(warm.outputTokensMax, 64_000);
  assert.ok(Math.abs(warm.holdUsd - (expectedInput + 0.64)) < 1e-12, `held at its expected cost: ${warm.holdUsd}`);
  assert.ok(Math.abs(warm.boundUsd - (worstInput - expectedInput)) < 1e-12, `its bound: ${warm.boundUsd}`);
  assert.ok(Math.abs(warm.stoppedUsd(100) - (expectedInput + 1_124 * 10 / 1e6)) < 1e-12, "stopped: its expected input, what streamed and the allowance");
  const cold = (await capBefore(1, SONNET, { now: () => at + WARM_MS + 1 })).beforeRequest(request);
  assert.ok(Math.abs(cold.holdUsd - (worstInput + 0.64)) < 1e-12, `4 minutes on, its worst case: ${cold.holdUsd}`);
  assert.equal(cold.boundUsd, 0);
  const strict = (await capBefore(1, SONNET, { mode: "strict", now: () => at })).beforeRequest(request);
  assert.deepEqual([strict.holdUsd, strict.boundUsd], [cold.holdUsd, 0], "strict: the worst case, no bound");
});
