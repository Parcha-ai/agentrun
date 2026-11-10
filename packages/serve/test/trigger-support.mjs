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

/** A case whose firing must run on a runner that dispatches it and delivers its commands: the fired run executes, reaches a
 *  state (working, parked on a person, waiting on a tool-call approval or at its door), and the firing reads or messages it.
 *  The switch starts the run (fires against its own store), but running it is the runner's; these turn on when it does. */
export const RUN_EXEC = "waits on running a fired run on the runner (dispatch and command delivery)";
/** A case whose trigger target is a message_run: the message is delivered to an existing run over the store. */
export const MESSAGE_RUN = "waits on delivering a message_run target over the store";
/** A case that starts the server as its CLI does (a child process): until the server opens its own store at the cutover, a
 *  server started so has none, and its triggers routes answer unavailable. */
export const CLI_STORE = "the server opens its own store at the cutover (a CLI-started server has none until then)";

/** What a server that went down between a firing's run (or message) and its settle leaves: the firing `key` of trigger `id`
 *  due again in the store with no run named, while what it started stays under the firing's key (its run's origin row, or
 *  its message's command row). The engine starts a run (or queues a message) and settles its firing in two transactions,
 *  so a kill between them leaves exactly this; a restart's drive must find what is there, never start or send it twice.
 *  `store`: a handle on the server's store (serve()'s), the server itself closed. */
export async function leftDue(store, id, key, extra = {}) {
  const settled = await store.triggers.settle(id, key, { status: "due", runId: null, ...extra });
  assert.ok(settled, `firing ${key} of ${id} is in the store`);
}
export const keyOf = (kind, id, what) => `fir_${createHash("sha256").update(`${kind}\n${id}\n${what}`).digest("hex").slice(0, 32)}`;
export const schedule = (id, source, extra = {}) => ({ name: "nightly", source: { kind: "schedule", ...source }, target: { kind: "start_run", agent_id: id, input: { content: "Say hello." }, max_cost_usd: 0.5 }, ...extra });

export async function made(api, id, extra) {
  assert.equal((await api("POST", "/agents", agent(id, extra))).status, 201);
}

/** The store's refusal of a firing's run (its run row is not there), on a firing still due or one that failed of it. */
const runRowMissing = (f) => /FOREIGN KEY constraint failed/.test(`${f.reason ?? ""} ${f.error?.message ?? ""}`);

/** The trigger's firings, newest first, once it holds at least `n` and none is still due. A firing whose run row the store
 *  refused ends the wait at once, under RUN_EXEC's words: the case waits on running a fired run, and waiting out the bound
 *  would only cost its time. Any other firing that does not settle waits the whole bound and fails as it would. */
export async function firings(api, id, n) {
  for (const end = Date.now() + 30_000; ; await sleep(50)) {
    const { status, body } = await api("GET", `/triggers/${id}/firings`);
    assert.equal(status, 200, JSON.stringify(body));
    const refused = body.firings.find(runRowMissing);
    if (refused) throw new Error(`${RUN_EXEC}: the store refused firing ${refused.key}'s run row (${refused.status})`);
    if (body.firings.length >= n && body.firings.every((f) => f.status !== "due")) return body.firings;
    assert.ok(Date.now() < end, `no ${n} settled firings: ${JSON.stringify(body.firings)}`);
  }
}

