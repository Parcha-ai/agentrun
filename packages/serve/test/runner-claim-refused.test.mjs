// A claim its spec refuses (loop-contract.ts ClaimRefused) ends the run failed in the refusal's words, once, even when the
// claim is a resume from a park: the adapter loop writes the end itself, so the runner never takes it for a resume that
// failed (runner.ts resumeFailed: back to parked, its waking row retried after a backoff). Two refusals: a handed browser
// sign-in that won't read back (runs.ts UNREADABLE_SIGN_IN, sign-ins-store.ts handedSignInReadsBack) and an MCP pin
// refused on resume (mcp-claim.ts McpClaimRefused, now a ClaimRefused). Waited on by the runner's own events.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { queue, stores } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { ClaimRefused } = await import("../dist/runner/loop-contract.js");
const { McpClaimRefused } = await import("../dist/runner/mcp-claim.js");
const { META_REASON } = await import("../dist/mcp-meta.js");
const { UNREADABLE_SIGN_IN } = await import("../dist/run-view.js");
const { endedReason } = await import("../dist/store/store.js");
const { handedSignInReadsBack, pointerHash } = await import("../dist/sign-ins-store.js");

const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** A test seal key, no real one. */
const KEY = randomBytes(32);

/** A run parked after an earlier claim was handed a sign-in that is kept nowhere now, woken by a steer; one runner whose
 *  spec is `specOf`. Resolves with the runner's first release of the run, the spec's calls, and the run's row then. */
async function resumed(t, specOf, { stop = false } = {}) {
  const opened = await stores();
  await queue(opened.server, "run-1");
  const earlier = await opened.server.claim("run-1", "runner-earlier", { leaseMs: 60_000 });
  await opened.server.runs.update(earlier, { signInHanded: [pointerHash(`ctx-${randomBytes(8).toString("hex")}`)] });
  await opened.server.release(earlier, { state: "parked" });
  await opened.server.command("run-1", { kind: "steer", body: { content: "Go on." } });
  // A person's stop, queued before the resume's claim.
  const stopRow = stop ? await opened.server.command("run-1", { kind: "stop" }) : undefined;
  const calls = [];
  const events = [];
  let released;
  const first = new Promise((resolve) => (released = resolve));
  const runner = startRunner({
    store: opened.runners[0],
    name: "runner-1",
    ...TIMING,
    createLoop: createAdapterLoop(async (claim) => {
      calls.push(claim.from);
      return specOf(opened.runners[0], claim);
    }),
    onEvent: (event) => {
      events.push(event);
      if (event.type === "released" && event.runId === "run-1") released(event);
    },
  });
  t.after(() => runner.close());
  const release = await first;
  const commands = await opened.server.commands("run-1", 0);
  return { release, calls, events, row: await opened.server.runs.get("run-1"), stop: stopRow && commands.find((row) => row.id === stopRow.id) };
}

test("a claim resuming from a park whose handed sign-in won't read back ends failed in UNREADABLE_SIGN_IN, once, with no resume retry", async (t) => {
  const r = await resumed(t, async (store, claim) => {
    if (!(await handedSignInReadsBack(store, KEY, await store.runs.get(claim.runId)))) throw new ClaimRefused(UNREADABLE_SIGN_IN);
    throw new Error("the sign-in read back: not this test's case");
  });
  assert.deepEqual(r.calls, ["parked"], "one claim, a resume from the park");
  assert.equal(r.release.end, "failed", `ended failed, not parked again for a retry: ${JSON.stringify(r.release)}`);
  assert.equal(r.row.state, "failed", JSON.stringify(r.row));
  assert.equal(r.row.summary, UNREADABLE_SIGN_IN);
  assert.equal(r.row.backoffUntil ?? null, null, "no resume backoff");
  assert.equal(r.events.filter((event) => event.type === "released" && event.runId === "run-1").length, 1, "exactly one end");
});

test("a claim resuming from a park whose MCP pin is refused on resume ends failed in the refusal's words, once, with no resume retry; a stop queued before it is answered that the run already failed", async (t) => {
  const words = `mcp:fake/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${META_REASON}`;
  const r = await resumed(t, async () => {
    throw new McpClaimRefused(words);
  }, { stop: true });
  assert.deepEqual(r.calls, ["parked"]);
  assert.equal(r.release.end, "failed", `ended failed, not parked again for a retry: ${JSON.stringify(r.release)}`);
  assert.equal(r.row.state, "failed", JSON.stringify(r.row));
  assert.equal(r.row.summary, words);
  assert.equal(r.row.backoffUntil ?? null, null, "no resume backoff");
  assert.equal(r.events.filter((event) => event.type === "released" && event.runId === "run-1").length, 1, "exactly one end");
  // The stop is answered in the words the store refuses a final run's untaken rows with: the run had already failed.
  assert.ok(r.stop, "the stop row is there");
  assert.notEqual(r.stop.takenAt, null, "answered");
  assert.equal(r.stop.refused, endedReason("failed"));
  assert.equal(r.stop.refused, "the run failed before this command was taken");
  assert.ok(!/ctx-|mcp-token|https?:/.test(r.stop.refused), "no pointer in its words");
});
