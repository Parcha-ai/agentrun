// GET /v2/runs/{run_id}/computer's answer (computer-view.ts), one family for every kind: `live` with the run's computer
// kind, the viewer's link and who holds it, while a viewer is open (a running viewer is served even when its computer
// would resolve off now: the run holds the keys it started with); else `off` with why when there is no computer here (no
// kind); else `none` with its kind. Never a token but the viewer link's own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerView } from "../dist/computer-view.js";

const LINK = "/v2/runs/run-1/computer/live/v/AbCdEfGhIjKlMnOpQrStUv#t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("live, none and off, each with who holds the computer", async () => {
  const browser = { kind: "browser" };
  assert.deepEqual(await computerView({ viewer: async () => ({ kind: "browser", viewer: LINK }), computer: () => browser, hold: () => "agent" }), { state: "live", kind: "browser", viewer: LINK, hold: "agent" });
  assert.deepEqual(await computerView({ viewer: async () => ({ kind: "desktop", viewer: LINK }), computer: () => ({ kind: "desktop" }), hold: () => "person" }), { state: "live", kind: "desktop", viewer: LINK, hold: "person" });
  assert.deepEqual(await computerView({ viewer: async () => undefined, computer: () => ({ kind: "phone" }), hold: () => "pending" }), { state: "none", kind: "phone", hold: "pending" });
  assert.deepEqual(await computerView({ viewer: async () => undefined, computer: () => ({ off: "this run's agent has no computer" }), hold: () => "person" }), { state: "off", hold: "agent", why: "this run's agent has no computer" }, "off: nobody's to hold, no kind");
});

test("a viewer open is live whatever the computer resolves to now, and the computer is read only when none is open", async () => {
  let read = 0;
  const computer = () => (read++, { off: "no key" });
  assert.deepEqual(await computerView({ viewer: async () => ({ kind: "browser", viewer: LINK }), computer, hold: () => "agent" }), { state: "live", kind: "browser", viewer: LINK, hold: "agent" });
  assert.equal(read, 0);
});

test("with no hold seam the agent drives (the store-backed computer hold is not wired yet)", async () => {
  assert.deepEqual(await computerView({ viewer: async () => undefined, computer: () => ({ kind: "browser" }) }), { state: "none", kind: "browser", hold: "agent" });
});
