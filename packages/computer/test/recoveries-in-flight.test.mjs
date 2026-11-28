// A lost create's recovery (recoverCreate) is known to its process while it runs (recoveriesInFlight): with the end of
// its own bound, and a `done` that settles once it has ended, whatever it ended in. A process about to exit waits on
// these, so a browser the recovery finds is released before the process goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverCreate, recoveriesInFlight } from "../dist/index.js";

const ok = (value) => ({ ok: true, value });

test("a recovery is in flight from its start to its end, with its own bound, and its done settles as it ends", async () => {
  let found;
  const finding = new Promise((resolve) => (found = resolve));
  const released = [];
  const before = Date.now();
  const recovering = recoverCreate("browser", () => finding, async (id) => (released.push(id), ok(undefined)), async () => {}, 2_000);
  const [one, ...others] = recoveriesInFlight();
  assert.equal(others.length, 0, "one recovery under way");
  assert.ok(one.by >= before + 2_000 && one.by <= Date.now() + 2_000, `its bound ends 2 s after its start: ${one.by - before}`);
  let settled = false;
  void one.done.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "not done while it looks for the browser");
  found(ok(["b-1"]));
  const words = await recovering;
  await one.done;
  assert.deepEqual(released, ["b-1"], "the browser it found was released");
  assert.match(words, /was released/);
  assert.deepEqual(recoveriesInFlight(), [], "none in flight once it ended");
});

test("a recovery whose search throws is done all the same, and no longer in flight", async () => {
  const recovering = recoverCreate("browser", async () => { throw new Error("the vendor went away"); }, async () => ok(undefined), async () => {}, 1_000);
  const [one] = recoveriesInFlight();
  await assert.rejects(recovering, /the vendor went away/);
  await one.done;
  assert.deepEqual(recoveriesInFlight(), []);
});
