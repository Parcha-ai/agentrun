// Pins (they pass at the cutover tip; no fix rides with them). pi through the adapter: a journal commit that fails in the
// middle of a turn (the store's transaction ran past its deadline, StoreDeadline, so nothing of it was written) fails pi's
// Session. The run never stays working with nobody on it: the adapter loop writes its end failed, in pi's words, and
// releases it, after one claim, as main's loop does (adapter-loop's "a failure with no end written yet"). Two commits: the
// one that starts pi's generation, and a deferred progress commit of a streaming answer's partial (a 1 MB answer's
// failed this way when the proxy held the runner's thread).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { MAX_RESTARTS, suiteTools } = await import("../dist/runner/conformance/harness.js");
const { StoreDeadline } = await import("../dist/store/store.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** pi's words for a Session a storage error failed, as the run's end keeps them. */
const SESSION_FAILED = "Session failed after a storage error; close and reopen it";
after(closeOpenSessions);

/** `journal` whose first commit that `fails` picks throws StoreDeadline, writing nothing, as a transaction past its
 *  deadline does; `failed` counts them. Every other call is the journal's own. */
const deadlineOnce = (journal, fails, failed) =>
  new Proxy(journal, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "commit") return value.bind(target);
      return (batches, ...rest) => {
        if (failed.count === 0 && fails(batches)) {
          failed.count++;
          return Promise.reject(new StoreDeadline(10_000));
        }
        return value.call(target, batches, ...rest);
      };
    },
  });

/** A commit that starts pi's generation (its task running): the turn is under way. */
const startsGeneration = (batches) => batches.flat().some((write) => write.type === "task" && write.value?.kind === "pi.generation" && write.value?.state?.status === "running");

/** A commit of pi's streamed partial alone (a deferred progress commit: it changes only documents). */
const partialOnly = (batches) => {
  const writes = batches.flat();
  return writes.length > 0 && writes.every((write) => write.type === "document.change");
};

/** Anthropic's Messages answer `text` in `pieces` deltas, `gapMs` apart: long enough for pi to commit its partial. */
function slowOrigin(text, pieces, gapMs) {
  const encoder = new TextEncoder();
  const event = (value) => encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(event({ type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }));
        controller.enqueue(event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        const size = Math.ceil(text.length / pieces);
        for (let at = 0; at < text.length; at += size) {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          controller.enqueue(event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(at, at + size) } }));
        }
        controller.enqueue(event({ type: "content_block_stop", index: 0 }));
        controller.enqueue(event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }));
        controller.enqueue(event({ type: "message_stop" }));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

/** One run through the adapter loop with `fails` picking the commit that runs past its deadline: its row once it is out of
 *  working and released, how many commits failed, and how often it was claimed. */
async function endedAfterDeadline(t, fetch, fails) {
  const opened = await stores({ runners: 1 });
  const record = recorder();
  await queue(opened.server, "run-1");
  const { tools } = suiteTools();
  const failed = { count: 0 };
  const inner = createAdapterLoop(piAdapterSpec({ script: [{ say: "done" }], tools, hooks: quiet }, fetch ? { fetch } : {}), { restartLimit: MAX_RESTARTS });
  const createLoop = (deps) => inner({ ...deps, journal: (claim) => deadlineOnce(deps.journal(claim), fails, failed) });
  const runner = startRunner({ store: observed(opened.runners[0], record), createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return now.state !== "queued" && now.state !== "working" && now.runner === null && now;
  }, "the run left working and was released", 20_000).catch(async (error) => {
    throw new Error(`${error.message}: the run is ${JSON.stringify(await opened.server.runs.get("run-1"))}, claimed ${record.claims.length} times, ${failed.count} commit failed`);
  });
  return { row, failed: failed.count, claims: record.claims.filter((claim) => claim.runId === "run-1").length };
}

test("pin: a commit that starts pi's generation, past the store's deadline, ends the run failed in pi's words, never working", { timeout: 60_000 }, async (t) => {
  const { row, failed, claims } = await endedAfterDeadline(t, undefined, startsGeneration);
  assert.equal(failed, 1, "one commit ran past its deadline");
  assert.deepEqual([row.state, row.summary], ["failed", SESSION_FAILED], JSON.stringify(row));
  assert.equal(claims, 1, "claimed once");
});

test("pin: a progress commit of a streaming answer, past the store's deadline, ends the run failed in pi's words, never working", { timeout: 60_000 }, async (t) => {
  let generating = false;
  const fails = (batches) => {
    if (startsGeneration(batches)) generating = true;
    return generating && partialOnly(batches);
  };
  // About 3 s of streaming: pi stores a deferred partial within its progress.persistWithinMs (1 s), so one lands mid-answer.
  const { row, failed, claims } = await endedAfterDeadline(t, slowOrigin("word ".repeat(600), 60, 50), fails);
  assert.equal(failed, 1, "one progress commit ran past its deadline");
  assert.deepEqual([row.state, row.summary], ["failed", SESSION_FAILED], JSON.stringify(row));
  assert.equal(claims, 1, "claimed once");
});
