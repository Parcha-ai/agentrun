// A plan-billed recipe's keys, saved for its harness alone (harness-keys.ts): each a sealed row of the one store named
// harness:<harness>:<KEY>; a value replaced or removed kept sealed for the cut; a claim opens its own harness's alone and
// lays them where no copy of the environment carries them. A real store on a temp file.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import {
  HarnessKeysOverStore, RETIRED_KEPT, harnessKeyRow, harnessKeysSaved, harnessKeysSavedHere, keysLaid, layHarnessKeys,
  openHarnessKeys, planRecipeOr404, sealedHarnessKeyBytes,
} from "../dist/harness-keys.js";
import { ApiError } from "../dist/errors.js";

const SEAL = randomBytes(32);
const ACME = { id: "acme", label: "Acme Agent", keys: ["ACME_API_KEY", "ACME_ORG"] };
const OTHER = { id: "other", label: "Other Agent", keys: ["ACME_API_KEY"] };
const VALUE = "acme-key-0123456789";
const ORG = "acme-org-abcdefgh";

async function keysOn(t, { recipes = [ACME, OTHER], seal = SEAL } = {}) {
  const { store, file } = await storeOn(t);
  const keys = new HarnessKeysOverStore(store, seal, recipes, file);
  await keys.load();
  return { store, file, keys };
}

const fieldsOf = (e) => (e instanceof ApiError ? e.extra.fields ?? [] : []);

test("a harness key is sealed at rest under its harness's own name, and the view names it, never its value", async (t) => {
  const { store, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  const bytes = await store.sealedKeys.get(harnessKeyRow("acme", "ACME_API_KEY"));
  assert.ok(bytes instanceof Uint8Array && !Buffer.from(bytes).toString("utf8").includes(VALUE), "sealed, not in the clear");
  assert.equal(harnessKeyRow("acme", "ACME_API_KEY"), "harness:acme:ACME_API_KEY");
  const view = keys.list();
  assert.ok(!JSON.stringify(view).includes(VALUE), "the listing never holds the value");
  const acme = view.harnesses.find((h) => h.id === "acme");
  assert.deepEqual(acme.keys.map((k) => [k.name, k.set, k.source ?? null]), [["harness:acme:ACME_API_KEY", true, "console"], ["harness:acme:ACME_ORG", false, null]]);
  assert.equal(acme.ready, false, "one of two keys saved is not ready");
  await keys.save(ACME, "ACME_ORG", { value: ORG });
  assert.equal(keys.view(ACME).ready, true, "every key saved is ready");
  assert.equal(keys.view(OTHER).ready, false, "a key of the same name saved for another harness is not this one's");
});

test("a claim opens its own harness's keys alone: the same key name saved for another harness never reaches it", async (t) => {
  const { store, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  assert.deepEqual(await openHarnessKeys(store, SEAL, "acme", ACME.keys), { ACME_API_KEY: VALUE });
  assert.deepEqual(await openHarnessKeys(store, SEAL, "other", OTHER.keys), {}, "the other harness gets nothing");
  assert.equal(await harnessKeysSaved(store, "acme", ACME.keys), false, "one of two saved");
  assert.equal(await harnessKeysSaved(store, "acme", ["ACME_API_KEY"]), true);
  assert.equal(await harnessKeysSaved(store, "other", OTHER.keys), false);
  assert.equal(await harnessKeysSaved(store, "acme", []), false, "a recipe with no keys is never saved");
});

test("a row sealed under another seal key reads as not saved, never a clear fallback", async (t) => {
  const { store, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  const other = randomBytes(32);
  assert.deepEqual(await openHarnessKeys(store, other, "acme", ["ACME_API_KEY"]), {});
  const again = new HarnessKeysOverStore(store, other, [ACME], "elsewhere");
  await again.load();
  assert.equal(again.view(ACME).keys[0].set, false);
  assert.deepEqual(again.values(), []);
});

test("a reload reads the saved and retired values back from the store", async (t) => {
  const { store, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  await keys.save(ACME, "ACME_API_KEY", { value: `${VALUE}-next` });
  const again = new HarnessKeysOverStore(store, SEAL, [ACME], "elsewhere");
  await again.load();
  assert.deepEqual(new Set(again.values()), new Set([VALUE, `${VALUE}-next`]));
  assert.deepEqual(await openHarnessKeys(store, SEAL, "acme", ["ACME_API_KEY"]), { ACME_API_KEY: `${VALUE}-next` });
});

test("a replaced or removed value stays sealed for the cut, up to RETIRED_KEPT per key, and leaves the runs", async (t) => {
  const { store, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  await keys.remove(ACME, "ACME_API_KEY");
  assert.ok(keys.values().includes(VALUE), "a removed value is still cut");
  assert.deepEqual(await openHarnessKeys(store, SEAL, "acme", ["ACME_API_KEY"]), {}, "but no run gets it");
  const rows = (await store.sealedKeys.all()).map((r) => r.name);
  assert.ok(rows.some((n) => n.startsWith("harness-retired:acme:ACME_API_KEY:")), "kept as a retired row");
  assert.ok(!rows.includes(harnessKeyRow("acme", "ACME_API_KEY")));
  for (let i = 0; i < RETIRED_KEPT + 3; i++) await keys.save(ACME, "ACME_API_KEY", { value: `${VALUE}-${i}` });
  const retired = (await store.sealedKeys.all()).filter((r) => r.name.startsWith("harness-retired:acme:ACME_API_KEY:"));
  assert.equal(retired.length, RETIRED_KEPT, "the oldest beyond the cap leave");
  assert.ok(!keys.values().includes(VALUE), "the first value left with them");
  assert.ok(keys.values().includes(`${VALUE}-${RETIRED_KEPT + 1}`), "the last replaced is kept");
  await keys.save(ACME, "ACME_API_KEY", { value: `${VALUE}-${RETIRED_KEPT + 2}` });
  assert.equal((await store.sealedKeys.all()).filter((r) => r.name.startsWith("harness-retired:")).length, RETIRED_KEPT, "saving the same value retires nothing");
});

test("writes to a key that overlap run one after another: every value a claim could have opened is retired, the last one saved", async (t) => {
  const { store, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  // Three writes at once, none awaited before the next starts: each replaces the one before it, in the order made.
  await Promise.all([keys.save(ACME, "ACME_API_KEY", { value: `${VALUE}-a` }), keys.save(ACME, "ACME_API_KEY", { value: `${VALUE}-b` }), keys.remove(ACME, "ACME_API_KEY")]);
  assert.deepEqual(new Set(keys.values()), new Set([VALUE, `${VALUE}-a`, `${VALUE}-b`]), "each value replaced is still cut");
  const again = new HarnessKeysOverStore(store, SEAL, [ACME], "elsewhere");
  await again.load();
  assert.deepEqual(new Set(again.values()), new Set([VALUE, `${VALUE}-a`, `${VALUE}-b`]), "and kept sealed in the store");
  assert.deepEqual(await openHarnessKeys(store, SEAL, "acme", ["ACME_API_KEY"]), {}, "the remove, made last, is what holds");
  // A write that fails leaves the next one to run.
  await assert.rejects(keys.save(ACME, "NOT_A_KEY", { value: VALUE }));
  await keys.save(ACME, "ACME_API_KEY", { value: `${VALUE}-c` });
  assert.deepEqual(await openHarnessKeys(store, SEAL, "acme", ["ACME_API_KEY"]), { ACME_API_KEY: `${VALUE}-c` });
});

test("a save refuses an unknown key, a body that is not { value }, and a value no cut could hold, never echoing it", async (t) => {
  const { keys } = await keysOn(t);
  const refused = async (key, body, field, reason) => {
    await assert.rejects(() => keys.save(ACME, key, body), (e) => {
      assert.ok(e instanceof ApiError && e.status === 422, `${field} ${reason}: 422`);
      assert.ok(fieldsOf(e).some((i) => i.field === field && i.reason === reason), `${field} ${reason}: ${JSON.stringify(fieldsOf(e))}`);
      assert.ok(!JSON.stringify({ message: e.message, extra: e.extra }).includes("Zq9-secret"), "no refusal holds the value");
      return true;
    });
  };
  await refused("NOT_ITS_KEY", { value: "Zq9-secret-1234" }, "key", "not_an_option");
  await refused("ACME_API_KEY", "Zq9-secret-1234", "value", "wrong_type");
  await refused("ACME_API_KEY", { value: "Zq9-secret-1234", extra: 1 }, "extra", "unknown");
  await refused("ACME_API_KEY", {}, "value", "missing");
  await refused("ACME_API_KEY", { value: 12345678 }, "value", "wrong_type");
  await refused("ACME_API_KEY", { value: "Zq9-secret 1234" }, "value", "invalid");
  await refused("ACME_API_KEY", { value: "Zq9-secret\n1234" }, "value", "invalid");
  await refused("ACME_API_KEY", { value: "Zq9-s" }, "value", "too_short");
  await refused("ACME_API_KEY", { value: `Zq9-secret${"x".repeat(1100)}` }, "value", "too_long");
  await assert.rejects(() => keys.remove(ACME, "NOT_ITS_KEY"), (e) => fieldsOf(e).some((i) => i.reason === "not_an_option"));
  assert.deepEqual(keys.values(), [], "nothing was saved");
});

test("a harness that is not a plan-billed recipe on this server is a 404", () => {
  assert.equal(planRecipeOr404([ACME], "acme"), ACME);
  assert.throws(() => planRecipeOr404([ACME], "goose"), (e) => e instanceof ApiError && e.status === 404 && /--harness-recipe/.test(e.message));
});

test("laid keys are found by a direct read alone: no spread or copy carries them, and an enumerable variable never counts", () => {
  const env = { PATH: "/bin" };
  assert.equal(keysLaid(env, ACME.keys), false);
  layHarnessKeys(env, { ACME_API_KEY: VALUE });
  assert.equal(env.ACME_API_KEY, VALUE, "a direct read finds it");
  assert.equal(keysLaid(env, ["ACME_API_KEY"]), true);
  assert.equal(keysLaid(env, ACME.keys), false, "every key, or none");
  assert.deepEqual({ ...env }, { PATH: "/bin" }, "a spread never carries it");
  assert.ok(!Object.keys(env).includes("ACME_API_KEY") && !JSON.stringify(env).includes(VALUE), "nor keys() or JSON");
  assert.equal(keysLaid({ ACME_API_KEY: VALUE }, ["ACME_API_KEY"]), false, "an operator's own variable of the same name is not a saved key");
  assert.equal(keysLaid({}, []), false, "no keys is never laid");
});

test("the server's registry says which harnesses have every key saved, in step with each write, for its own data directory alone", async (t) => {
  const { keys, file } = await keysOn(t);
  const { keys: beside, file: besideFile } = await keysOn(t);
  assert.equal(harnessKeysSavedHere(file, "acme"), false);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  await keys.save(ACME, "ACME_ORG", { value: ORG });
  assert.equal(harnessKeysSavedHere(file, "acme"), true);
  assert.equal(harnessKeysSavedHere(file, "other"), false);
  // Another server in this process, on its own data, saved none: its registry is its own, and its writes leave this one's.
  assert.equal(harnessKeysSavedHere(besideFile, "acme"), false);
  await beside.save(OTHER, "ACME_API_KEY", { value: VALUE });
  assert.equal(harnessKeysSavedHere(besideFile, "other"), true);
  assert.equal(harnessKeysSavedHere(file, "acme"), true, "a write beside it clears nothing of this one's");
  await keys.remove(ACME, "ACME_ORG");
  assert.equal(harnessKeysSavedHere(file, "acme"), false);
});

test("a remove clears a key's row that does not open here (sealed under another key), which the snapshot never held", async (t) => {
  const { store, keys } = await keysOn(t);
  const row = harnessKeyRow("acme", "ACME_API_KEY");
  await store.sealedKeys.put(row, sealedHarnessKeyBytes(randomBytes(32), "acme", "ACME_API_KEY", VALUE));
  assert.equal(await harnessKeysSaved(store, "acme", ["ACME_API_KEY"]), true, "a count says saved");
  assert.equal(keys.view(ACME).keys[0].set, false, "the view says not saved");
  await keys.remove(ACME, "ACME_API_KEY");
  assert.equal(await store.sealedKeys.get(row), undefined, "the row is gone, so no count says saved");
  assert.equal(await harnessKeysSaved(store, "acme", ["ACME_API_KEY"]), false);
});
