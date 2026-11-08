// Settings → Computers, the serve side (computers.ts): createComputerRoutes over a real store on a temp file and a
// stand-in kind registry by its own names (fixtures/computer-kinds.mjs), with the account test and the claim's options
// through computer-keys.ts over fake provider modules. The kinds this server offers in each folder mode, each provider's
// keys saved or not (never a value), a key save that takes only a provider's declared names, sealed in the store, an
// account test whose failures are plain words, and the refusal a run meets at its claim when its computer cannot be had,
// in words that name the setting to fill, else the options its provider is made with. No provider is ever called.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createComputerRoutes, KeysRefused } from "../dist/computers.js";
import { getSealedKey } from "../dist/server-keys.js";
import { fakeFactories, KINDS, tools } from "./fixtures/computer-kinds.mjs";
import { storeOn } from "./store-helpers.mjs";

async function setup(t, { mode = "local", settings, ...given } = {}) {
  const sealKey = "sealKey" in given ? given.sealKey : randomBytes(32);
  const { store } = await storeOn(t);
  const fake = fakeFactories();
  const routes = createComputerRoutes({ store, sealKey, kinds: KINDS, factories: fake.factories, ...(settings ? { settings } : {}), tools, mode });
  return { store, sealKey, routes, ...fake };
}

const kindOf = (view, kind) => view.kinds.find((one) => one.kind === kind);
const providerOf = (view, kind, id) => kindOf(view, kind).providers.find((one) => one.id === id);

test("Mode 1 (run folders on this machine): a sandbox is Docker's alone; a desktop, phone or browser is any provider's, ready once its keys are saved", async (t) => {
  const { routes } = await setup(t);
  const view = await routes.view();
  assert.deepEqual(view.kinds.map((kind) => kind.kind), ["none", "sandbox", "desktop", "phone", "browser"]);
  assert.deepEqual([kindOf(view, "none").offered, kindOf(view, "none").providers], [true, []]);
  assert.deepEqual(kindOf(view, "sandbox").groups, ["exec", "files", "processes"]);
  assert.deepEqual(kindOf(view, "desktop").groups, ["screen", "input.pointer", "input.keys", "exec", "files", "processes", "apps", "stream"], "required, then optional");
  assert.deepEqual(kindOf(view, "desktop").tools, ["screenshot", "computer_input"], "the kind's tools, from the kernel registry");
  assert.deepEqual(kindOf(view, "sandbox").providers.map((one) => one.id), ["docker", "daytona", "modal", "e2b"], "the providers whose capabilities serve the kind");
  assert.deepEqual(providerOf(view, "sandbox", "docker"), { id: "docker", name: "Docker", keys: [], ready: true });
  assert.equal(providerOf(view, "sandbox", "daytona").ready, false);
  assert.match(providerOf(view, "sandbox", "daytona").why, /Daytona can't mount this server's run folders/);
  assert.deepEqual(providerOf(view, "phone", "phone-harness"), { id: "phone-harness", name: "Phone harness", keys: [{ name: "PHONE_HARNESS_API_KEY", required: true, saved: false }], ready: false, why: "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)" });
  assert.equal(kindOf(view, "sandbox").offered, true);
});

test("Mode 2 (run folders on the owner's disk): Docker's sandbox is refused, a sandbox that mounts the disk is offered", async (t) => {
  const { routes } = await setup(t, { mode: "disk" });
  const view = await routes.view();
  assert.match(providerOf(view, "sandbox", "docker").why, /Docker can't mount the owner's disk/);
  assert.match(providerOf(view, "sandbox", "modal").why, /Modal can't mount the owner's disk/);
  assert.equal(providerOf(view, "sandbox", "daytona").why, "Daytona needs DAYTONA_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/daytona/keys)");
  assert.equal(kindOf(view, "sandbox").offered, true);
  assert.equal(providerOf(view, "desktop", "docker").ready, true, "a desktop holds no folder unless its provider mounts it");
});

test("a kind no provider can serve here is not offered, and says why", async (t) => {
  const { store } = await storeOn(t);
  const kinds = { ...KINDS, PROVIDERS: KINDS.PROVIDERS.filter((one) => one.id === "docker" || one.id === "modal") };
  const view = await createComputerRoutes({ store, sealKey: undefined, kinds, factories: fakeFactories().factories, tools, mode: "disk" }).view();
  assert.deepEqual([kindOf(view, "sandbox").offered, kindOf(view, "sandbox").why], [false, "no provider of a sandbox computer can reach this server's run folders"]);
  assert.deepEqual([kindOf(view, "phone").offered, kindOf(view, "phone").why, kindOf(view, "phone").providers], [false, "no provider serves a phone computer", []]);
});

test("a key save takes only the provider's declared names, seals each in the store, answers names and saved flags only, and null removes", async (t) => {
  const { store, sealKey, routes } = await setup(t);
  await assert.rejects(routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: "good-a", OPENAI_API_KEY: "sk-x" }), (error) => error instanceof KeysRefused && error.fields.map((f) => [f.field, f.reason]).join() === "OPENAI_API_KEY,not_allowed");
  await assert.rejects(routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: 7 }), (error) => error instanceof KeysRefused && error.fields[0].reason === "wrong_type");
  assert.deepEqual(await store.sealedKeys.all(), [], "nothing saved when any name is refused");
  const saved = await routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: "good-secret-a", BROWSERBASE_PROJECT_ID: "good-proj" });
  assert.deepEqual(saved, { id: "browserbase", name: "Browserbase", keys: [{ name: "BROWSERBASE_API_KEY", required: true, saved: true }, { name: "BROWSERBASE_PROJECT_ID", required: true, saved: true }], ready: true });
  assert.ok(!JSON.stringify(saved).includes("good-secret-a"), "never echoed");
  assert.ok(!JSON.stringify(await routes.view()).includes("good-secret-a"), "nor in the view");
  assert.equal(await getSealedKey(store, sealKey, "BROWSERBASE_API_KEY"), "good-secret-a", "sealed, and opens with the server's key");
  assert.ok(!Buffer.from(await store.sealedKeys.get("BROWSERBASE_API_KEY")).toString("latin1").includes("good-secret-a"), "the store holds ciphertext only");
  assert.equal((await routes.saveKeys("browserbase", { BROWSERBASE_PROJECT_ID: null })).ready, false, "null removes");
  assert.equal(await routes.saveKeys("nope", {}), undefined, "an unknown provider");
});

test("with no seal key the server keeps no key, and says how to give it one", async (t) => {
  const { routes } = await setup(t, { sealKey: undefined });
  await assert.rejects(routes.saveKeys("e2b", { E2B_API_KEY: "good-e" }), (error) => error instanceof KeysRefused && error.fields[0].reason === "unavailable" && /AGENTRUN_SEAL_KEY/.test(error.message));
});

test("a provider's test opens its saved keys, makes it with them through computer-keys, and reads its account once; failures are its plain words, with no key", async (t) => {
  const { routes, built } = await setup(t, { settings: { modalApp: "runs-app" } });
  assert.deepEqual(await routes.test("e2b"), { ok: false, why: "E2B needs E2B_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/e2b/keys)" });
  assert.deepEqual(built, [], "nothing made with a key missing");
  await routes.saveKeys("e2b", { E2B_API_KEY: "good-e" });
  assert.deepEqual(await routes.test("e2b"), { ok: true, detail: "e2b: 2 computers" });
  assert.deepEqual(built.at(-1), ["e2b", { apiKey: "good-e" }]);
  await routes.saveKeys("e2b", { E2B_API_KEY: "bad-e2b-secret" });
  const refused = await routes.test("e2b");
  assert.equal(refused.ok, false);
  assert.match(refused.why, /^E2B refused the saved key: check E2B_API_KEY in Settings → Computers\./);
  assert.ok(!refused.why.includes("bad-e2b-secret"), "the key never comes back");
  await routes.saveKeys("daytona", { DAYTONA_API_KEY: "down-daytona-secret", DAYTONA_API_URL: "https://d.example/api" });
  const unreachable = await routes.test("daytona");
  assert.match(unreachable.why, /^Daytona could not be reached/);
  assert.ok(!unreachable.why.includes("down-daytona-secret"));
  assert.deepEqual(built.at(-1), ["daytona", { apiKey: "down-daytona-secret", apiUrl: "https://d.example/api" }]);
  await routes.saveKeys("modal", { MODAL_TOKEN_ID: "ak-1", MODAL_TOKEN_SECRET: "good-m" });
  assert.deepEqual(await routes.test("modal"), { ok: true, detail: "modal: 2 computers" });
  assert.deepEqual(built.at(-1), ["modal", { tokenId: "ak-1", tokenSecret: "good-m", app: "runs-app" }], "the server's own setting with the keys");
  assert.deepEqual(await routes.test("docker"), { ok: true, detail: "docker: 2 computers" }, "Docker takes no key");
  await routes.saveKeys("browserbase", { BROWSERBASE_API_KEY: "good-b", BROWSERBASE_PROJECT_ID: "good-p" });
  assert.equal((await routes.test("browserbase")).ok, false, "a provider with no module here is not tested");
  assert.equal(await routes.test("nope"), undefined);
});

test("the claim's options: computer_unavailable with the refusal's words, else the provider's create() options from its saved keys", async (t) => {
  const { routes } = await setup(t);
  assert.equal(await routes.claimOptions({ kind: "none" }), undefined);
  assert.deepEqual(await routes.claimOptions({ kind: "phone", provider: "phone-harness" }), { ok: false, error: { code: "computer_unavailable", message: "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)" } });
  await routes.saveKeys("phone-harness", { PHONE_HARNESS_API_KEY: "good-p" });
  assert.deepEqual(await routes.claimOptions({ kind: "phone", provider: "phone-harness" }), { ok: true, options: { apiKey: "good-p" } });
  assert.deepEqual(await routes.claimOptions({ kind: "sandbox", provider: "docker" }), { ok: true, options: {} });
  assert.equal((await routes.claimOptions({ kind: "sandbox", provider: "daytona" })).error.code, "computer_unavailable");
});

test("at the claim: a computer this server cannot give is refused in words that name the setting to fill", async (t) => {
  const { routes } = await setup(t);
  assert.equal(await routes.claimRefusal({ kind: "none" }), undefined);
  assert.equal(await routes.claimRefusal({ kind: "sandbox", provider: "docker" }), undefined);
  assert.match(await routes.claimRefusal({ kind: "sandbox", provider: "daytona" }), /can't mount this server's run folders.*Settings → Computers/);
  assert.equal(await routes.claimRefusal({ kind: "phone", provider: "phone-harness" }), "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)");
  assert.equal(await routes.claimRefusal({ kind: "browser", provider: "e2b" }), "E2B does not serve a browser computer (kind browser is a browser machine, not a linux one; kind browser needs the group cdp; kind browser is a browser machine, not a desktop one): set this agent's computer to one it serves (Settings → Computers)", "servingRefusals' words");
  assert.match(await routes.claimRefusal({ kind: "desktop", provider: "orgo" }), /names the provider orgo, which this server does not have/);
  await routes.saveKeys("phone-harness", { PHONE_HARNESS_API_KEY: "good-p" });
  assert.equal(await routes.claimRefusal({ kind: "phone", provider: "phone-harness" }), undefined);
});

test("at the claim in Mode 2: Docker's sandbox is refused", async (t) => {
  const { routes } = await setup(t, { mode: "disk" });
  assert.match(await routes.claimRefusal({ kind: "sandbox", provider: "docker" }), /can't mount the owner's disk/);
  assert.equal(await routes.claimRefusal({ kind: "desktop", provider: "docker" }), undefined);
});
