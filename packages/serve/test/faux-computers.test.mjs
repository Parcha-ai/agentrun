// --faux's computers (faux-computers.ts): the built-in fake kind registry serve swaps in under --faux, so the console's
// real-browser flows drive Settings → Computers and a run's desktop with no Docker and no provider. Three providers:
// faux-sandbox (ready once its one key is saved; its test passes), faux-broken (its test fails with plain words), and
// faux-desktop (a desktop whose run computer answers a screenshot and input, with a live view serve itself answers).
// Driven here through createComputerRoutes over a real store on a temp file; nothing listens and nothing is sent.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { KEY_TABLE } from "../dist/computer-keys.js";
import { createComputerRoutes } from "../dist/computers.js";
import { FAUX_VIEW_PATH, fauxComputers } from "../dist/faux-computers.js";
import { storeOn } from "./store-helpers.mjs";

const SERVE = "http://serve.test:4777";
const FAUX = fauxComputers({ viewerBase: SERVE });

async function routes(t) {
  const { store } = await storeOn(t);
  return createComputerRoutes({ store, sealKey: randomBytes(32), kinds: FAUX.kinds, factories: FAUX.factories, keyTable: FAUX.keyTable, tools: () => [], mode: "local" });
}
const providersOf = (view) => view.kinds.flatMap((kind) => kind.providers.map((one) => [kind.kind, one.id]));
const providerOf = (view, kind, id) => view.kinds.find((one) => one.kind === kind).providers.find((one) => one.id === id);
const entryOf = (id) => FAUX.kinds.PROVIDERS.find((one) => one.id === id);

test("under --faux, Settings → Computers lists the three faux providers and nothing else", async (t) => {
  const view = await (await routes(t)).view();
  assert.deepEqual(providersOf(view), [["sandbox", "faux-sandbox"], ["sandbox", "faux-broken"], ["desktop", "faux-desktop"]]);
  assert.deepEqual(providerOf(view, "sandbox", "faux-sandbox"), { id: "faux-sandbox", name: "Faux sandbox", metered: false, secrets: [{ name: "computer:faux-sandbox:FAUX_SANDBOX_KEY", set: false, source: null, changed_at: null }], required: ["computer:faux-sandbox:FAUX_SANDBOX_KEY"], ready: false, why: "Faux sandbox needs FAUX_SANDBOX_KEY saved: save it in Settings → Computers (PUT /v2/computers/faux-sandbox/keys)" });
  assert.deepEqual(view.kinds.map((kind) => [kind.kind, kind.offered]), [["none", true], ["sandbox", true], ["desktop", true], ["phone", false], ["browser", false]]);
});

test("saving faux-sandbox's one key makes it ready, and its test then passes", async (t) => {
  const computers = await routes(t);
  assert.equal((await computers.test("faux-sandbox")).ok, false, "not before its key is saved");
  const saved = await computers.saveKeys("faux-sandbox", { FAUX_SANDBOX_KEY: "any-value-1" });
  assert.equal(saved.ready, true);
  assert.equal(providerOf(await computers.view(), "sandbox", "faux-sandbox").ready, true);
  assert.deepEqual(await computers.test("faux-sandbox"), { ok: true, detail: "Faux sandbox: the faux account answered (no computer was made)" });
});

test("faux-broken's test fails with plain words", async (t) => {
  const answer = await (await routes(t)).test("faux-broken");
  assert.equal(answer.ok, false);
  assert.match(answer.why, /^Faux broken could not be reached: try again in a moment\. \(the vendor said: .+\)$/);
});

test("faux-desktop's run computer answers a screenshot and input, and its live view is serve's own page until the release", async () => {
  const desktop = await FAUX.launch(entryOf("faux-desktop"), { kind: "desktop", keys: {} });
  assert.deepEqual(desktop.groups, ["screen", "input.pointer", "input.keys"]);
  const shot = await desktop.client.call("screen.shot", {});
  assert.equal(shot.ok, true);
  assert.equal(Buffer.from(shot.value.data, "base64").subarray(1, 4).toString(), "PNG");
  assert.deepEqual([shot.value.width, shot.value.height, shot.value.eof], [1280, 800, true]);
  assert.deepEqual(await desktop.client.call("input.actions", { actions: [{ type: "click", at: [1, 1] }] }), { ok: true, value: { done: 1 } });
  assert.equal((await desktop.client.call("apps.list", {})).error.code, "unsupported");
  const view = new URL((await desktop.stream({ viewOnly: true })).url);
  const drive = new URL((await desktop.stream({ viewOnly: false })).url);
  assert.deepEqual([view.origin, drive.origin], [SERVE, SERVE], "on serve's own address");
  assert.deepEqual([view.pathname, drive.pathname], [`${FAUX_VIEW_PATH}/${desktop.id}/view`, `${FAUX_VIEW_PATH}/${desktop.id}/drive`]);
  assert.match(FAUX.viewPage(view.pathname), /Faux desktop .* watching \(view only\)/);
  assert.match(FAUX.viewPage(drive.pathname), /driving \(taken over\)/);
  assert.equal(FAUX.viewPage(`${FAUX_VIEW_PATH}/faux-desktop-999/view`), undefined, "no page for a desktop never started");
  assert.equal(FAUX.viewPage("/v2/computers"), undefined, "nothing outside its path");
  await desktop.release();
  assert.equal(FAUX.viewPage(view.pathname), undefined, "the view is gone once the computer is released");
});

test("faux-sandbox and faux-broken start no computer, in words", async () => {
  for (const id of ["faux-sandbox", "faux-broken"]) await assert.rejects(FAUX.launch(entryOf(id), { kind: "sandbox", keys: {} }), /starts no computer/);
});

test("the faux providers are not in the real key table: only --faux's own table names them", () => {
  assert.deepEqual(Object.keys(KEY_TABLE.keys).filter((id) => id.startsWith("faux-")), []);
  assert.deepEqual(Object.keys(FAUX.keyTable.keys).sort(), ["faux-broken", "faux-desktop", "faux-sandbox"]);
});
