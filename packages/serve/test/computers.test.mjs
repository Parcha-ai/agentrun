// Settings → Computers, the serve side (computers.ts), over a stand-in kind registry (fixtures/computer-kinds.mjs) and the
// one store: the kinds this server offers in each folder mode, each provider's keys saved or not (never a value), a key
// save that takes only a provider's declared names, sealed in the store, an account test, and the refusal a run meets at
// its claim when its computer cannot be had, in words that name the setting to fill.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { claimRefusal, computersView, KeysRefused, saveProviderKeys, testProvider } from "../dist/computers.js";
import { getSealedKey } from "../dist/server-keys.js";
import { standInRegistry } from "./fixtures/computer-kinds.mjs";
import { storeOn } from "./store-helpers.mjs";

async function setup(t) {
  const { store } = await storeOn(t);
  return { store, keys: { store, sealKey: randomBytes(32) }, ...standInRegistry() };
}

const kindOf = (view, kind) => view.kinds.find((one) => one.kind === kind);
const providerOf = (view, kind, id) => kindOf(view, kind).providers.find((one) => one.id === id);

test("Mode 1 (run folders on this machine): a sandbox is Docker's alone; a desktop, phone or browser is any provider's, ready once its keys are saved", async (t) => {
  const { keys, registry } = await setup(t);
  const view = await computersView(registry, keys, "local");
  assert.deepEqual(view.kinds.map((kind) => kind.kind), ["none", "sandbox", "desktop", "phone", "browser"]);
  assert.deepEqual([kindOf(view, "none").offered, kindOf(view, "none").providers], [true, []]);
  assert.deepEqual(kindOf(view, "sandbox").groups, ["exec", "files", "processes"]);
  assert.deepEqual(kindOf(view, "desktop").tools, ["screenshot", "computer_input"], "the kind's tools, from the kernel registry");
  assert.deepEqual(providerOf(view, "sandbox", "docker"), { id: "docker", name: "Docker", keys: [], ready: true });
  assert.equal(providerOf(view, "sandbox", "daytona").ready, false);
  assert.match(providerOf(view, "sandbox", "daytona").why, /Daytona can't mount this server's run folders/);
  assert.deepEqual(providerOf(view, "phone", "phone-harness"), { id: "phone-harness", name: "Phone harness", keys: [{ name: "PHONE_HARNESS_API_KEY", required: true, saved: false }], ready: false, why: "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)" });
  assert.equal(kindOf(view, "sandbox").offered, true);
});

test("Mode 2 (run folders on the owner's disk): Docker's sandbox is refused, a sandbox that mounts the disk is offered", async (t) => {
  const { keys, registry } = await setup(t);
  const view = await computersView(registry, keys, "disk");
  assert.match(providerOf(view, "sandbox", "docker").why, /Docker can't mount the owner's disk/);
  assert.equal(providerOf(view, "sandbox", "daytona").why, "Daytona needs DAYTONA_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/daytona/keys)");
  assert.equal(providerOf(view, "desktop", "docker").ready, true, "a desktop holds no folder unless its provider mounts it");
});

test("a key save takes only the provider's declared names, seals each in the store, answers names and saved flags only, and null removes", async (t) => {
  const { store, keys, registry } = await setup(t);
  await assert.rejects(saveProviderKeys(registry, keys, "local", "browserbase", { BROWSERBASE_API_KEY: "good-a", OPENAI_API_KEY: "sk-x" }), (error) => error instanceof KeysRefused && error.fields.map((f) => [f.field, f.reason]).join() === "OPENAI_API_KEY,not_allowed");
  assert.deepEqual(await store.sealedKeys.all(), [], "nothing saved when any name is refused");
  const saved = await saveProviderKeys(registry, keys, "local", "browserbase", { BROWSERBASE_API_KEY: "good-secret-a", BROWSERBASE_PROJECT_ID: "good-proj" });
  assert.deepEqual(saved, { id: "browserbase", name: "Browserbase", keys: [{ name: "BROWSERBASE_API_KEY", required: true, saved: true }, { name: "BROWSERBASE_PROJECT_ID", required: true, saved: true }], ready: true });
  assert.ok(!JSON.stringify(saved).includes("good-secret-a"), "never echoed");
  assert.equal(await getSealedKey(store, keys.sealKey, "BROWSERBASE_API_KEY"), "good-secret-a", "sealed, and opens with the server's key");
  assert.ok(!Buffer.from((await store.sealedKeys.get("BROWSERBASE_API_KEY"))).toString("latin1").includes("good-secret-a"), "the store holds ciphertext only");
  assert.equal((await saveProviderKeys(registry, keys, "local", "browserbase", { BROWSERBASE_PROJECT_ID: null })).ready, false, "null removes");
  assert.equal(await saveProviderKeys(registry, keys, "local", "nope", {}), undefined, "an unknown provider");
  await assert.rejects(saveProviderKeys(registry, { store, sealKey: undefined }, "local", "e2b", { E2B_API_KEY: "good-e" }), (error) => error instanceof KeysRefused && error.fields[0].reason === "unavailable");
});

test("a provider's test reads its account once with its saved keys, and says why when it cannot", async (t) => {
  const { keys, registry, tested } = await setup(t);
  assert.deepEqual(await testProvider(registry, keys, "e2b"), { ok: false, why: "E2B needs E2B_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/e2b/keys)" });
  assert.deepEqual(tested, [], "no account read with a key missing");
  await saveProviderKeys(registry, keys, "local", "e2b", { E2B_API_KEY: "good-e" });
  assert.deepEqual(await testProvider(registry, keys, "e2b"), { ok: true, detail: "e2b: account read" });
  await saveProviderKeys(registry, keys, "local", "e2b", { E2B_API_KEY: "bad-e" });
  assert.deepEqual(await testProvider(registry, keys, "e2b"), { ok: false, why: "e2b refused the key" });
  assert.deepEqual(tested, [["e2b", ["E2B_API_KEY"]], ["e2b", ["E2B_API_KEY"]]]);
});

test("at the claim: a computer this server cannot give is refused in words that name the setting to fill", async (t) => {
  const { keys, registry } = await setup(t);
  assert.equal(await claimRefusal(registry, keys, "local", { kind: "none" }), undefined);
  assert.equal(await claimRefusal(registry, keys, "local", { kind: "sandbox", provider: "docker" }), undefined);
  assert.match(await claimRefusal(registry, keys, "local", { kind: "sandbox", provider: "daytona" }), /can't mount this server's run folders.*Settings → Computers/);
  assert.match(await claimRefusal(registry, keys, "disk", { kind: "sandbox", provider: "docker" }), /can't mount the owner's disk/);
  assert.equal(await claimRefusal(registry, keys, "local", { kind: "phone", provider: "phone-harness" }), "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)");
  assert.match(await claimRefusal(registry, keys, "local", { kind: "browser", provider: "e2b" }), /E2B does not serve a browser computer/);
  assert.match(await claimRefusal(registry, keys, "local", { kind: "desktop", provider: "orgo" }), /names the provider orgo, which this server does not have/);
  await saveProviderKeys(registry, keys, "local", "phone-harness", { PHONE_HARNESS_API_KEY: "good-p" });
  assert.equal(await claimRefusal(registry, keys, "local", { kind: "phone", provider: "phone-harness" }), undefined);
});
