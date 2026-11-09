// pi through the adapter: what a session carries to the model and what its next claim reads. The run's system text
// reaches every request as the system prompt; a host tool's images reach the model with its text (a screenshot); and an
// input pi stored as failed is a failed turn on the next claim, never a completed one, when the claim that ran it was
// lost before the run's end landed.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** A 1x1 PNG, as a screenshot tool would answer. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** One runner on one queued run, pi through the adapter on `script`; resolves with the run's final row. */
async function oneRun(t, setup, options) {
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const runner = startRunner({ store, createLoop: createAdapterLoop(piAdapterSpec(setup, options)), name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  return until(async () => {
    const now = await server.runs.get("run-1");
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end", 30_000);
}

test("a run's system text reaches the model as its system prompt, every part of it", async (t) => {
  const requests = [];
  const system = ["You are the run's agent: answer in the script's words.", "A second part, from the agent's guidance."];
  const row = await oneRun(t, { script: [{ say: "done" }], tools: {}, hooks: quiet }, { requests, system });
  assert.equal(row.state, "ended");
  assert.ok(requests.length >= 1, "the model was asked");
  for (const [i, body] of requests.entries()) {
    const sent = JSON.stringify(body.system ?? null);
    for (const part of system) assert.ok(sent.includes(JSON.stringify(part).slice(1, -1)), `request ${i} carries "${part}" in its system prompt: ${sent}`);
  }
});

test("a host tool's image reaches the model with its text, as an image block of its tool result", async (t) => {
  const requests = [];
  const tools = { shot: { name: "shot", replaySafe: true, ask: false, run: async () => "the page as it looks", images: [{ mimeType: "image/png", data: PIXEL }] } };
  const row = await oneRun(t, { script: [{ call: "shot" }, { say: "done" }], tools, hooks: quiet }, { requests });
  assert.equal(row.state, "ended");
  const answered = requests.find((body) => (body.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result")));
  assert.ok(answered, `a request carries the tool's result: ${JSON.stringify(requests.map((body) => body.messages))}`);
  const result = answered.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).find((part) => part.type === "tool_result");
  const blocks = Array.isArray(result.content) ? result.content : [{ type: "text", text: String(result.content) }];
  assert.ok(blocks.some((block) => block.type === "text" && block.text.includes("the page as it looks")), `its text: ${JSON.stringify(blocks)}`);
  const image = blocks.find((block) => block.type === "image");
  assert.ok(image, `an image block: ${JSON.stringify(blocks)}`);
  assert.equal(image.source?.media_type, "image/png");
  assert.equal(image.source?.data, PIXEL);
});

/** `store` whose renews are refused, as a starved store's: its claim runs out. */
const renewsRefused = (store) =>
  new Proxy(store, {
    get(target, key) {
      if (key === "renew" || key === "renewMany") return () => Promise.reject(new Error("the store stayed busy"));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** `journal` whose commit of the run's end never lands: a claim lost after pi stored the turn, before the run's end. */
const endNeverLands = (journal) =>
  new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "commit") return typeof value === "function" ? value.bind(target) : value;
      return (batches, ...rest) =>
        batches.flat().some((write) => write.type === "entry" && write.value?.kind === "agentrun.end") ? new Promise(() => {}) : value.call(target, batches, ...rest);
    },
  });

test("a run whose input pi stored as failed, its claim lost before the run's end, ends failed on the next claim, never ended", async (t) => {
  const { server, runners: [one, two] } = await stores({ runners: 2 });
  const record = recorder();
  await queue(server, "run-1");
  // Every request is refused upstream for good: pi stores the run's input unanswered, a failed turn.
  const refusing = async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "the request was refused upstream" } }), { status: 400, headers: { "content-type": "application/json" } });
  const spec = piAdapterSpec({ script: [], tools: {}, hooks: quiet }, { fetch: refusing });
  const inner = createAdapterLoop(spec);
  // The first runner: its end never lands and its renews are refused, so its claim runs out with the failed turn stored.
  const lost = startRunner({ store: renewsRefused(observed(one, record)), createLoop: (deps) => inner({ ...deps, journal: (claim) => endNeverLands(deps.journal(claim)) }), name: "runner-a", leaseMs: 1_500, renewEveryMs: 300, stopMarginMs: 500, pollMs: 20, commandPollMs: 30 });
  t.after(() => lost.kill());
  await until(() => record.claims.find((claim) => claim.runId === "run-1" && claim.runner === "runner-a"), "the first claim", 10_000);
  // The next runner claims it once that lease ran out, from "running", the input stored and settled.
  const next = startRunner({ store: observed(two, record), createLoop: inner, name: "runner-b", ...TIMING });
  t.after(() => next.close());
  const row = await until(async () => {
    const now = await server.runs.get("run-1");
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end on the next claim", 30_000).catch(async (error) => {
    throw new Error(`${error.message}: the run is ${JSON.stringify(await server.runs.get("run-1"))}, claimed ${record.claims.length} times`);
  });
  assert.ok(record.claims.some((claim) => claim.runId === "run-1" && claim.runner === "runner-b"), "the next runner claimed it");
  assert.equal(row.state, "failed", `a failed turn ends the run failed, never ended: ${JSON.stringify(row)}`);
  assert.match(row.summary ?? "", /no answer/, "in the loop's words for a turn with no answer");
});
