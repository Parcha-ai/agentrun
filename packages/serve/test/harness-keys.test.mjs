// A plan-billed recipe's keys, saved for its harness alone (harness-keys.ts): each a sealed row of the one store named
// harness:<harness>:<KEY>, bound to the recipe file it was saved for; a value replaced or removed kept sealed for the cut;
// a claim opens its own recipe's alone and lays them where no copy of the environment carries them. A real store on a
// temp file.
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
// `digest`: the recipe file's sha256 as the server loaded it (harness-table.ts PlanRecipe).
const ACME = { id: "acme", label: "Acme Agent", keys: ["ACME_API_KEY", "ACME_ORG"], digest: "a".repeat(64) };
const OTHER = { id: "other", label: "Other Agent", keys: ["ACME_API_KEY"], digest: "b".repeat(64) };
const notFound = (e) => e instanceof ApiError && e.status === 404;
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
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), { ACME_API_KEY: VALUE });
  assert.deepEqual(await openHarnessKeys(store, SEAL, OTHER), {}, "the other harness gets nothing");
  assert.equal(await harnessKeysSaved(store, ACME), false, "one of two saved");
  assert.equal(await harnessKeysSaved(store, { ...ACME, keys: ["ACME_API_KEY"] }), true);
  assert.equal(await harnessKeysSaved(store, OTHER), false);
  assert.equal(await harnessKeysSaved(store, { ...ACME, keys: [] }), false, "a recipe with no keys is never saved");
});

test("a key is bound to the recipe file it was saved for: a later file of the same id and key never opens it, and the view asks for it again", async (t) => {
  const { store, file, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  await keys.save(ACME, "ACME_ORG", { value: ORG });
  // The owner points --harness-recipe at another file that takes the id `acme` and names the same keys.
  const NEXT = { ...ACME, digest: "c".repeat(64) };
  assert.deepEqual(await openHarnessKeys(store, SEAL, NEXT), {}, "a claim on the later file opens none");
  assert.equal(await harnessKeysSaved(store, NEXT), false, "nor counts them saved");
  assert.equal(await harnessKeysSaved(store, ACME), true, "the file they were saved for still has them");
  const later = new HarnessKeysOverStore(store, SEAL, [NEXT], file);
  await later.load();
  const view = later.view(NEXT);
  assert.equal(view.ready, false);
  assert.deepEqual(view.keys.map((k) => k.set), [false, false]);
  assert.deepEqual(view.reenter, [{ name: "harness:acme:ACME_API_KEY", why: "recipe_changed" }, { name: "harness:acme:ACME_ORG", why: "recipe_changed" }]);
  assert.equal(harnessKeysSavedHere(file, "acme"), false, "the registry says so too");
  assert.ok(later.values().includes(VALUE) && later.values().includes(ORG), "still sealed, still cut");
  // Saved again for the later file, the same value binds to it, and only that key moves.
  await later.save(NEXT, "ACME_API_KEY", { value: VALUE });
  assert.deepEqual(await openHarnessKeys(store, SEAL, NEXT), { ACME_API_KEY: VALUE });
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), { ACME_ORG: ORG });
  assert.deepEqual(later.view(NEXT).reenter, [{ name: "harness:acme:ACME_ORG", why: "recipe_changed" }]);
});

test("a claim that read one recipe file's binding, then the bytes a save for another file of its id wrote meanwhile, opens nothing: the binding holds the digest of the bytes it was written with", async (t) => {
  const { store, file, keys } = await keysOn(t, { recipes: [ACME] });
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  const NEXT = { ...ACME, digest: "c".repeat(64) };
  const later = new HarnessKeysOverStore(store, SEAL, [NEXT], file);
  await later.load();
  // The claim's store: once it has read the bindings (ACME's), the later file's key is saved before it reads the bytes.
  let raced = false;
  const racing = {
    settings: store.settings,
    sealedKeys: {
      get: async (row) => {
        if (!raced) {
          raced = true;
          await later.save(NEXT, "ACME_API_KEY", { value: `${VALUE}-next` });
        }
        return store.sealedKeys.get(row);
      },
    },
  };
  assert.deepEqual(await openHarnessKeys(racing, SEAL, ACME), {}, "the later file's key never reaches a claim on the first");
  assert.ok(raced);
  assert.deepEqual(await openHarnessKeys(store, SEAL, NEXT), { ACME_API_KEY: `${VALUE}-next` }, "the file it was saved for opens it");
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), {});
});

test("a save whose value is put and whose binding write fails reads the store again: the cut holds the value, and the key reads not saved", async (t) => {
  const { store, file } = await storeOn(t);
  let failBinds = false;
  const flaky = {
    sealedKeys: store.sealedKeys,
    settings: {
      get: (...args) => store.settings.get(...args),
      put: async (...args) => {
        if (failBinds) {
          failBinds = false;
          throw new Error("the disk is full");
        }
        return store.settings.put(...args);
      },
    },
    flush: () => store.flush(),
  };
  const keys = new HarnessKeysOverStore(flaky, SEAL, [ACME], file);
  await keys.load();
  failBinds = true;
  await assert.rejects(keys.save(ACME, "ACME_API_KEY", { value: VALUE }), /the disk is full/);
  assert.ok(await store.sealedKeys.get(harnessKeyRow("acme", "ACME_API_KEY")), "the value was put");
  assert.ok(keys.values().includes(VALUE), "the cut holds the value the store holds");
  assert.equal(keys.view(ACME).keys[0].set, false, "bound to no recipe, so not saved");
  assert.deepEqual(keys.view(ACME).reenter, [{ name: "harness:acme:ACME_API_KEY", why: "not_bound" }], "and the view says it is bound to none, not to another recipe file");
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), {}, "and no claim opens it");
  // The next save, with the store well again, binds it.
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), { ACME_API_KEY: VALUE });
});

test("a recipe the server no longer names keeps its keys, sealed and cut and run by nothing: listed by its id, and a DELETE removes them", async (t) => {
  const { store, file, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  await keys.save(OTHER, "ACME_API_KEY", { value: `${VALUE}-other` });
  const later = new HarnessKeysOverStore(store, SEAL, [OTHER], file);
  await later.load();
  const listed = later.list().harnesses;
  assert.deepEqual(listed.map((h) => [h.id, h.named]), [["other", true], ["acme", false]], "named first, then each id kept");
  assert.deepEqual(later.unnamed(), ["acme"], "what capabilities name kept");
  const acme = listed[1];
  assert.deepEqual({ label: acme.label, keys: acme.keys, ready: acme.ready, kept: acme.kept.map((k) => [k.name, k.set, k.source]) },
    { label: "acme", keys: [], ready: false, kept: [["harness:acme:ACME_API_KEY", true, "console"]] });
  assert.ok(later.values().includes(VALUE), "its value is still cut");
  assert.throws(() => later.recipe("acme"), notFound, "a PUT never saves for it");
  await assert.rejects(later.remove(later.held("acme"), "ACME_ORG"), (e) => fieldsOf(e).some((i) => i.reason === "not_an_option" && i.message === "acme's keys are ACME_API_KEY."), "a key never kept for it is not one, and the refusal names the keys it has, never a recipe it runs on");
  await later.remove(later.held("acme"), "ACME_API_KEY");
  assert.equal(await store.sealedKeys.get(harnessKeyRow("acme", "ACME_API_KEY")), undefined, "its row is gone");
  assert.ok(later.values().includes(VALUE), "kept retired for the cut");
  assert.deepEqual(later.list().harnesses.map((h) => h.id), ["other"]);
  assert.deepEqual(later.unnamed(), []);
  assert.throws(() => later.held("acme"), notFound, "with nothing kept, a DELETE is a 404 again");
  assert.deepEqual(await openHarnessKeys(store, SEAL, OTHER), { ACME_API_KEY: `${VALUE}-other` }, "the named recipe's key never moved");
});

test("a key its recipe runs on no more is kept, listed beside the recipe's keys, and a DELETE removes it", async (t) => {
  const { store, file, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_ORG", { value: ORG });
  const SLIM = { ...ACME, keys: ["ACME_API_KEY"] };
  const later = new HarnessKeysOverStore(store, SEAL, [SLIM], file);
  await later.load();
  const view = later.view(SLIM);
  assert.deepEqual([view.keys.map((k) => k.name), view.kept.map((k) => [k.name, k.set])], [["harness:acme:ACME_API_KEY"], [["harness:acme:ACME_ORG", true]]]);
  assert.deepEqual(later.held("acme").keys, ["ACME_API_KEY", "ACME_ORG"]);
  // A PUT names the keys the recipe runs on (a DELETE, the keys the harness holds).
  await assert.rejects(later.save(SLIM, "ACME_ORG", { value: ORG }), (e) => fieldsOf(e).some((i) => i.reason === "not_an_option" && i.message === "Acme Agent runs on ACME_API_KEY."), "never saved again for it");
  await later.remove(later.held("acme"), "ACME_ORG");
  assert.equal(await store.sealedKeys.get(harnessKeyRow("acme", "ACME_ORG")), undefined);
  assert.deepEqual(later.view(SLIM).kept, []);
});

test("a row sealed under another seal key reads as not saved, never a clear fallback, and the view says its seal key changed", async (t) => {
  const { store, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  const other = randomBytes(32);
  assert.deepEqual(await openHarnessKeys(store, other, ACME), {});
  const again = new HarnessKeysOverStore(store, other, [ACME], "elsewhere");
  await again.load();
  assert.equal(again.view(ACME).keys[0].set, false);
  assert.deepEqual(again.view(ACME).reenter, [{ name: "harness:acme:ACME_API_KEY", why: "seal_key_changed" }]);
  assert.deepEqual(again.values(), []);
});

test("a key saved before keys were bound to a recipe file (beta.55, no binding row) reads not saved, opens for no claim, and the view says it is bound to none", async (t) => {
  const { store, file } = await storeOn(t);
  await store.sealedKeys.put(harnessKeyRow("acme", "ACME_API_KEY"), sealedHarnessKeyBytes(SEAL, "acme", "ACME_API_KEY", VALUE));
  const keys = new HarnessKeysOverStore(store, SEAL, [ACME], file);
  await keys.load();
  assert.equal(keys.view(ACME).keys[0].set, false);
  assert.deepEqual(keys.view(ACME).reenter, [{ name: "harness:acme:ACME_API_KEY", why: "not_bound" }]);
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), {});
  assert.ok(keys.values().includes(VALUE), "still cut");
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  assert.deepEqual(keys.view(ACME).reenter, [], "saved again, it binds");
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), { ACME_API_KEY: VALUE });
});

test("a damaged row under this server's seal key reads as not saved, and the view says it does not read", async (t) => {
  const { store, file, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  // Another row's bytes under this row's name: the seal key is the same, the AAD is not.
  await store.sealedKeys.put(harnessKeyRow("acme", "ACME_API_KEY"), sealedHarnessKeyBytes(SEAL, "acme", "ACME_ORG", VALUE));
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), {});
  const again = new HarnessKeysOverStore(store, SEAL, [ACME], file);
  await again.load();
  assert.deepEqual(again.view(ACME).reenter, [{ name: "harness:acme:ACME_API_KEY", why: "file_unreadable" }]);
});

test("a reload reads the saved and retired values back from the store", async (t) => {
  const { store, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  await keys.save(ACME, "ACME_API_KEY", { value: `${VALUE}-next` });
  const again = new HarnessKeysOverStore(store, SEAL, [ACME], "elsewhere");
  await again.load();
  assert.deepEqual(new Set(again.values()), new Set([VALUE, `${VALUE}-next`]));
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), { ACME_API_KEY: `${VALUE}-next` });
});

test("a replaced or removed value stays sealed for the cut, up to RETIRED_KEPT per key, and leaves the runs", async (t) => {
  const { store, keys } = await keysOn(t);
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  await keys.remove(ACME, "ACME_API_KEY");
  assert.ok(keys.values().includes(VALUE), "a removed value is still cut");
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), {}, "but no run gets it");
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
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), {}, "the remove, made last, is what holds");
  // A write that fails leaves the next one to run.
  await assert.rejects(keys.save(ACME, "NOT_A_KEY", { value: VALUE }));
  await keys.save(ACME, "ACME_API_KEY", { value: `${VALUE}-c` });
  assert.deepEqual(await openHarnessKeys(store, SEAL, ACME), { ACME_API_KEY: `${VALUE}-c` });
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
  await assert.rejects(() => keys.remove(keys.held("acme"), "NOT_ITS_KEY"), (e) => fieldsOf(e).some((i) => i.reason === "not_an_option"));
  assert.deepEqual(keys.values(), [], "nothing was saved");
});

test("a harness that is not a plan-billed recipe on this server, with no key kept for it, is a 404", async (t) => {
  assert.equal(planRecipeOr404([ACME], "acme"), ACME);
  assert.throws(() => planRecipeOr404([ACME], "goose"), (e) => notFound(e) && /--harness-recipe/.test(e.message));
  const { keys } = await keysOn(t);
  assert.throws(() => keys.held("goose"), notFound);
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
  await keys.remove(keys.held("acme"), "ACME_ORG");
  assert.equal(harnessKeysSavedHere(file, "acme"), false);
});

test("a remove clears a key's row that does not open here (sealed under another key), and its binding", async (t) => {
  const { store, keys } = await keysOn(t);
  const row = harnessKeyRow("acme", "ACME_API_KEY");
  await keys.save(ACME, "ACME_API_KEY", { value: VALUE });
  const elsewhere = new HarnessKeysOverStore(store, randomBytes(32), [ACME], "elsewhere");
  await elsewhere.load();
  const ONE = { ...ACME, keys: ["ACME_API_KEY"] };
  assert.equal(await harnessKeysSaved(store, ONE), true, "a count says saved");
  assert.equal(elsewhere.view(ACME).keys[0].set, false, "the view says not saved");
  await elsewhere.remove(elsewhere.held("acme"), "ACME_API_KEY");
  assert.equal(await store.sealedKeys.get(row), undefined, "the row is gone, so no count says saved");
  assert.equal(await harnessKeysSaved(store, ONE), false);
  // A row put back by hand under that name, bound to nothing, is never counted or opened.
  await store.sealedKeys.put(row, sealedHarnessKeyBytes(SEAL, "acme", "ACME_API_KEY", VALUE));
  assert.equal(await harnessKeysSaved(store, ONE), false);
  assert.deepEqual(await openHarnessKeys(store, SEAL, ONE), {});
});
