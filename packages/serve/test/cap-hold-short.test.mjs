// The cap's tripwire for a hold that was too small: a paid request whose answer billed more input (input, cache reads and
// cache writes together) than the bound its hold was priced on writes one warn line, `event=cap_hold_short`, with the
// run, the request (its session and turn), the harness, the model, the bound, what it billed and, in USD, what was held,
// what it billed and the shortfall. Ids and figures only: no prompt, answer, header, key or token. A request billed at or
// under its bound writes none, and so does one whose usage gives no input count to compare (an answer that reported no
// usage, a ChatGPT plan's route, which the cap holds at $0 and never prices by its input). Billing, holds and refusals are
// as before.
// Here a stand-in CLI sends Codex requests through the kernel's model proxy under the Codex policy, on the run's own
// booking and cap; the provider is faked, each answer's usage written from the bound the request was admitted at. Each
// case that writes no line runs beside a request that does, in the same run, so it can't pass on a loop that logs nothing.
// No network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { codexPolicy } from "@parcha/agentrun-harness-codex";
import { observed, queue, recorder, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };

const KEY = "session-key-for-tests";
const CREDENTIAL = "provider-secret-for-tests";
const ANSWER = "Dear Dana, the answer text";
/** Codex's first request of a recorded session (run-adapters-codex's fixture): its own prompt and tools. */
const BODY = JSON.parse(readFileSync(new URL("../../run-adapters-codex/test/fixtures/roundtrip-request-1.json", import.meta.url), "utf8"));
const PROMPT = BODY.input.at(-1).content[0].text;
/** The session's model, priced by the token, and a ChatGPT plan's, never priced by its input. */
const MINI = { id: "gpt-5.4-mini", api: "openai-responses", price: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 }, outputCeiling: 128_000, reasoning: true };
const PLAN = { id: "gpt-plan-model", api: "openai-responses", price: { input: 1.25, output: 10 }, outputCeiling: 128_000, reasoning: true, plan: true };
const priceOf = (usage) => (usage.input * MINI.price.input + usage.cacheRead * MINI.price.cacheRead + (usage.cacheWrite ?? 0) * MINI.price.cacheWrite + usage.output * MINI.price.output) / 1e6;

/** An answer whose usage bills `input` tokens of input, `cached` of them read from the cache; with no `input`, an answer
 *  that reports no usage at all. */
function answer(input, cached = 0) {
  const usage = input === undefined ? {} : { usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: 19, output_tokens_details: { reasoning_tokens: 0 } } };
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: ANSWER })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", ...usage } })}\n\n`;
}

/** A CLI stand-in whose one turn sends each of `steps` in order through the session's model proxy (the plan's for a step
 *  `on: "plan"`), answered by `step.answer(bound)`, the bound its request was admitted at, then says "Done.". */
function proxiedCli(steps, bounds) {
  return {
    id: "stand-in-cli",
    check: () => [],
    async open(_spec, io) {
      const state = (await io.writer.read()).some((record) => record.kind === "stand-in.sent") ? "idle" : "new";
      const proxies = [];
      const proxyOf = async (plan) => {
        const model = plan ? PLAN.id : MINI.id;
        const asked = [];
        let answers = [];
        const proxy = await startModelProxy({
          policy: codexPolicy({ model, tools: ["lookup", "submit"], ...(plan ? { plan: true } : {}) }),
          model, origin: "https://provider.invalid", credential: () => CREDENTIAL, price: (_model, usage) => (plan ? null : priceOf(usage)), log: () => {},
          hooks: { ...io.models, beforeRequest: async (request) => (asked.push(request), io.models.beforeRequest(request)) },
          fetch: async () => {
            const bound = asked.at(-1).inputTokensMax;
            bounds.push(bound);
            return new Response(answers.shift()(bound), { status: 200, headers: { "content-type": "text/event-stream" } });
          },
        }, KEY);
        proxies.push(proxy);
        return { send: async (respond) => {
          answers.push(respond);
          const sent = await fetch(new URL("/v1/responses", proxy.url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify({ ...BODY, model }) });
          return { status: sent.status, text: await sent.text() };
        } };
      };
      let turn;
      return {
        get state() { return state; },
        async send() {
          await io.writer.append([{ kind: "stand-in.sent", data: null }]);
          turn = (async () => {
            const priced = await proxyOf(false);
            const plan = await proxyOf(true);
            for (const step of steps) {
              const sent = await (step.on === "plan" ? plan : priced).send(step.answer);
              assert.equal(sent.status, 200, sent.text);
            }
            io.onEvent({ type: "text", delta: "Done." });
            io.onEvent({ type: "turn_end", status: "completed" });
            return { status: "completed" };
          })();
        },
        async recover() {},
        async settleOpenTurn() {},
        turnEnd: () => turn,
        async interrupt() {},
        async close() { await Promise.all(proxies.map((proxy) => proxy.close())); },
      };
    },
  };
}

/** A logfmt line's fields. */
const fieldsOf = (line) => Object.fromEntries(line.trim().split(/\s+/).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));

/** Runs `steps` on one run under a $5 cap: the cap_hold_short lines it wrote (stderr, where the runner's warnings go), the
 *  bound each request was admitted at, and what was held for each (its runner.request's heldUsd), by turn. */
async function runSteps(t, steps) {
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    written.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  t.after(() => void (process.stderr.write = write));
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const bounds = [];
  const createLoop = createAdapterLoop(() => ({
    adapter: proxiedCli(steps, bounds),
    session: { key: "root", label: "root", system: [], tools: [], context: "fresh" },
    input: "Answer.",
    runCap: { capUsd: () => 5, modelOf: (id) => (id === MINI.id ? MINI : id === PLAN.id ? PLAN : undefined) },
    record: "loop",
    hooks: quiet,
  }));
  const runner = startRunner({ store: observed(opened.runners[0], recorder()), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return ["ended", "failed"].includes(now.state) && now.runner === null && now;
  }, "the run settled and released", 20_000);
  assert.equal(row.state, "ended", `the run ended as its answer says: ${row.summary}`);
  const records = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  const held = new Map(records.entries.filter((entry) => entry.kind === "runner.request").map((entry) => [entry.data.turn, entry.data.heldUsd]));
  const lines = written.join("").split("\n").filter((line) => line.includes("event=cap_hold_short"));
  return { lines, bounds, held };
}

test("a request billed past the bound its hold was priced on writes one warn line: the run, its session and turn, the harness, the model, the bound, what it billed and the dollars, and no content", async (t) => {
  // Most of its input read from the cache: the line compares the whole input billed, never its uncached part alone.
  const { lines, bounds, held } = await runSteps(t, [{ answer: (bound) => answer(bound + 1_000, bound - 500) }]);
  assert.equal(lines.length, 1, `one line: ${JSON.stringify(lines)}`);
  const [line] = lines;
  const fields = fieldsOf(line);
  assert.deepEqual(Object.keys(fields).sort(), ["at", "billed_tokens", "billed_usd", "bound_tokens", "event", "harness", "held_usd", "model", "run", "session", "short_usd", "turn"], `ids and figures only: ${line}`);
  const [bound] = bounds;
  assert.deepEqual(
    { event: fields.event, run: fields.run, session: fields.session, turn: fields.turn, harness: fields.harness, model: fields.model, bound_tokens: fields.bound_tokens, billed_tokens: fields.billed_tokens },
    { event: "cap_hold_short", run: "run-1", session: "root", turn: "1", harness: "stand-in-cli", model: MINI.id, bound_tokens: String(bound), billed_tokens: String(bound + 1_000) },
  );
  const billedUsd = priceOf({ input: 1_500, cacheRead: bound - 500, output: 19 });
  const near = (actual, expected, what) => assert.ok(Math.abs(Number(actual) - expected) <= 1e-6, `${what}: ${actual}, not ${expected}`);
  near(fields.held_usd, held.get(1), "held: the request's hold");
  near(fields.billed_usd, billedUsd, "billed: its price");
  near(fields.short_usd, billedUsd - held.get(1), "short: billed less held");
  for (const content of [PROMPT.slice(0, 40), ANSWER, KEY, CREDENTIAL, "Bearer", "authorization"]) assert.ok(!line.includes(content), `no ${JSON.stringify(content)} in ${line}`);
});

test("a request billed exactly its bound writes no line (the next one, past its bound, does)", async (t) => {
  const { lines } = await runSteps(t, [{ answer: (bound) => answer(bound, Math.floor(bound / 2)) }, { answer: (bound) => answer(bound + 1) }]);
  assert.deepEqual(lines.map((line) => fieldsOf(line).turn), ["2"], `only the second request's: ${JSON.stringify(lines)}`);
});

test("a request billed under its bound writes no line (the next one, past its bound, does)", async (t) => {
  const { lines } = await runSteps(t, [{ answer: (bound) => answer(bound - 1, Math.floor(bound / 2)) }, { answer: (bound) => answer(bound + 1) }]);
  assert.deepEqual(lines.map((line) => fieldsOf(line).turn), ["2"], `only the second request's: ${JSON.stringify(lines)}`);
});

test("a request whose usage gives no input count to compare writes no line: an answer that reported no usage, and a plan's route the cap never prices by its input (the next one, past its bound, does)", async (t) => {
  const { lines } = await runSteps(t, [
    { on: "plan", answer: (bound) => answer(bound + 1_000) },
    { answer: () => answer(undefined) },
    { answer: (bound) => answer(bound + 1) },
  ]);
  assert.deepEqual(lines.map((line) => fieldsOf(line).turn), ["3"], `only the third request's: ${JSON.stringify(lines)}`);
});

test("a capped workflow run's model node billed past the bound its hold was priced on writes one cap_hold_short warn line, as an agentic run's request does", { timeout: 120_000 }, async (t) => {
  const { flowAgent, follow, serve, serverLog, withEnv } = await import("./support.mjs");
  withEnv(t, {}, ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]);
  const log = serverLog(t);
  const { api } = await serve(t, { faux: new URL("./fixtures/faux-workflow-over-bound.mjs", import.meta.url).pathname });
  const flow = {
    v: 2, name: "once",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Answer", path: "answer" },
    root: { node: "extract", label: "only", instructions: "Answer the question.", out: "Answer", as: "answer" },
  };
  assert.equal((await api("POST", "/agents", flowAgent("once", flow))).status, 201);
  const started = await api("POST", "/agents/once/runs", { input: { question: "What is six times seven?" }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed", "cancelled", "input_required"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(run.status, "completed", JSON.stringify(run.error ?? run.pending));
  const lines = log.text().split("\n").filter((line) => line.includes("event=cap_hold_short"));
  assert.equal(lines.length, 1, `one line: ${JSON.stringify(lines)}`);
  const fields = fieldsOf(lines[0]);
  assert.deepEqual([fields.run, fields.harness, fields.turn, fields.billed_tokens], [runId, "workflow", "1", "1000000"], lines[0]);
  assert.ok(Number(fields.bound_tokens) < 1_000_000, `its bound: ${fields.bound_tokens}`);
  assert.ok(!lines[0].includes("six times seven") && !lines[0].includes("Answer the question"), `no content: ${lines[0]}`);
});
