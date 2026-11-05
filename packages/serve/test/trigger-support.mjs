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

export const keyOf = (kind, id, what) => `fir_${createHash("sha256").update(`${kind}\n${id}\n${what}`).digest("hex").slice(0, 32)}`;
export const schedule = (id, source, extra = {}) => ({ name: "nightly", source: { kind: "schedule", ...source }, target: { kind: "start_run", agent_id: id, input: { content: "Say hello." }, max_cost_usd: 0.5 }, ...extra });

export async function made(api, id, extra) {
  assert.equal((await api("POST", "/agents", agent(id, extra))).status, 201);
}

/** The trigger's firings, newest first, once it holds at least `n` and none is still due. */
export async function firings(api, id, n) {
  for (const end = Date.now() + 30_000; ; await sleep(50)) {
    const { status, body } = await api("GET", `/triggers/${id}/firings`);
    assert.equal(status, 200, JSON.stringify(body));
    if (body.firings.length >= n && body.firings.every((f) => f.status !== "due")) return body.firings;
    assert.ok(Date.now() < end, `no ${n} settled firings: ${JSON.stringify(body.firings)}`);
  }
}

