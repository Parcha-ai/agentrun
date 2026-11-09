// The triggers' tests' own: a fake clock for the engine, a schedule's body, and a trigger's settled firings.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { agent } from "./support.mjs";

/** The triggers' clock: `to(time)` moves it, and fires the one timer the engine holds once its time has come. */
export function fakeClock(start) {
  const clock = {
    t: Date.parse(start),
    timer: null,
    now: () => clock.t,
    arm(fire, ms) {
      const held = { at: clock.t + ms, fire };
      clock.timer = held;
      return { clear: () => void (clock.timer === held && (clock.timer = null)) };
    },
    to(time) {
      clock.t = Date.parse(time);
      const held = clock.timer;
      if (held && held.at <= clock.t) {
        clock.timer = null;
        held.fire();
      }
    },
  };
  return clock;
}

/** A case whose firing starts a run: the store's firing row names that run, which E2's start inserts into the store (run_id's
 *  foreign key). Until then such a case is todo under these words, never skipped: it still runs. Its restart state, where it
 *  writes the old triggers file, moves to the store's rows with E2. With TRIGGER_E2_PROBE set these cases run (skip false),
 *  to see which pass now that the switch fires against the server's own store; the firing-scheduling ones do, the run-exec
 *  ones (a run that must dispatch, be messaged, or admit at its door) wait on E2r3. */
export const E2 = process.env.TRIGGER_E2_PROBE ? false : "E2's start inserts the store run (trigger_firings.run_id FK)";
/** A case whose message_run target names a run a caller started: the trigger reads that run from the store (its agent, and
 *  whether it is still there), which holds a run once E2's start inserts it. */
export const E2_RUN = process.env.TRIGGER_E2_PROBE ? false : "E2's start inserts the store run (a message_run target's run is read from the store)";
/** A case that starts the server as its CLI does (a child process): until the server opens its own store at the cutover, a
 *  server started so has none, and its triggers routes answer unavailable. */
export const CLI_STORE = "the server opens its own store at the cutover (a CLI-started server has none until then)";

export const keyOf = (kind, id, what) => `fir_${createHash("sha256").update(`${kind}\n${id}\n${what}`).digest("hex").slice(0, 32)}`;
export const schedule = (id, source, extra = {}) => ({ name: "nightly", source: { kind: "schedule", ...source }, target: { kind: "start_run", agent_id: id, input: { content: "Say hello." }, max_cost_usd: 0.5 }, ...extra });

export async function made(api, id, extra) {
  assert.equal((await api("POST", "/agents", agent(id, extra))).status, 201);
}

/** The store's refusal of a firing's run (the run row is not there: E2's start inserts it), on a firing still due or one
 *  that failed of it. */
const runRowMissing = (f) => /FOREIGN KEY constraint failed/.test(`${f.reason ?? ""} ${f.error?.message ?? ""}`);

/** The trigger's firings, newest first, once it holds at least `n` and none is still due. A firing the store refused its
 *  run row (E2) ends the wait at once, under E2's words: the case is todo for that, and waiting out the bound would only
 *  cost its time. Any other firing that does not settle waits the whole bound and fails as it would. */
export async function firings(api, id, n) {
  for (const end = Date.now() + 30_000; ; await sleep(50)) {
    const { status, body } = await api("GET", `/triggers/${id}/firings`);
    assert.equal(status, 200, JSON.stringify(body));
    const refused = body.firings.find(runRowMissing);
    if (refused) throw new Error(`${E2}: the store refused firing ${refused.key}'s run row (${refused.status})`);
    if (body.firings.length >= n && body.firings.every((f) => f.status !== "due")) return body.firings;
    assert.ok(Date.now() < end, `no ${n} settled firings: ${JSON.stringify(body.firings)}`);
  }
}

