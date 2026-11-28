// Settings → Computers at its handler (computers.ts settingsComputerRoute), as serve's dispatch calls it: each route's
// answer, or its refusal as an ApiError (the status the dispatch sends), and capabilities.computers. Driven directly over
// a real store on a temp file, with no server and no port.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@parcha/agentrun-computer";
import { COMPUTER_SETTINGS_ROUTES, computerCapabilities, createComputerRoutes, settingsComputerRoute } from "../dist/computers.js";
import { ApiError } from "../dist/errors.js";
import { fakeFactories, KINDS, tools } from "./fixtures/computer-kinds.mjs";
import { storeOn } from "./store-helpers.mjs";

async function routes(t, mode = "local") {
  const { store } = await storeOn(t);
  return createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode });
}
const refused = (promise, code) => assert.rejects(promise, (error) => error instanceof ApiError && error.code === code, code);

test("the four routes by their operation names", () => {
  assert.deepEqual([...COMPUTER_SETTINGS_ROUTES], ["listComputers", "saveComputerKeys", "testComputer", "listComputerChoices"]);
});

test("listComputerChoices answers a provider's picked keys' choices; an unknown provider is not_found", async (t) => {
  const computers = await routes(t);
  assert.deepEqual(await settingsComputerRoute(computers, "listComputerChoices", { provider: "orgo" }), { choices: [{ key: "ORGO_WORKSPACE_ID", why: "Orgo needs ORGO_API_KEY saved: save it in Settings → Computers" }] });
  assert.deepEqual(await settingsComputerRoute(computers, "listComputerChoices", { provider: "docker" }), { choices: [] });
  await refused(settingsComputerRoute(computers, "listComputerChoices", { provider: "nobody" }), "not_found");
});

test("listComputers answers the view; saveComputerKeys a provider's view; testComputer its test", async (t) => {
  const computers = await routes(t);
  assert.deepEqual(await settingsComputerRoute(computers, "listComputers", {}), await computers.view());
  const saved = await settingsComputerRoute(computers, "saveComputerKeys", { provider: "phone-harness", body: { PHONE_HARNESS_API_KEY: "good-p" } });
  assert.deepEqual([saved.id, saved.ready], ["phone-harness", true]);
  assert.deepEqual(await settingsComputerRoute(computers, "testComputer", { provider: "phone-harness" }), { ok: true, detail: "phone-harness: 2 computers" });
});

test("listComputers for a request in a workspace lists none of the operator's paired computers, nor any as a provider of its kind", async (t) => {
  const { store } = await storeOn(t);
  const hello = { protocol: PROTOCOL_VERSION, version: "0.2.0", os: "macos", kind: "desktop", arch: "arm64", groups: ["apps", "ui", "screen", "input.pointer", "input.keys"] };
  const row = { id: "cmp-abc", name: "vesper-mac", hello, driver: "0.2.0", labels: {}, createdAt: 1, seenAt: null, revokedAt: null };
  const paired = { rows: async () => [row], viewOf: async (one) => ({ id: one.id, name: one.name, online: true }) };
  const computers = createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode: "local", paired });
  const providers = (view) => view.kinds.flatMap((kind) => kind.providers.map((provider) => provider.id));
  const whole = await settingsComputerRoute(computers, "listComputers", {});
  assert.deepEqual(whole.paired.map((one) => one.id), ["cmp-abc"]);
  assert.ok(providers(whole).includes("cmp-abc"), "unscoped, the paired computer is a provider of its kind");
  const scoped = await settingsComputerRoute(computers, "listComputers", { scoped: true });
  assert.deepEqual(scoped.paired, []);
  assert.ok(!providers(scoped).includes("cmp-abc"), "scoped, it is no provider");
  assert.deepEqual(providers(scoped), providers(whole).filter((id) => id !== "cmp-abc"), "every other provider as before");
});

test("refusals: an unknown provider is not_found; a body that is not an object, or a name the provider does not take, is input_invalid with its fields", async (t) => {
  const computers = await routes(t);
  await refused(settingsComputerRoute(computers, "saveComputerKeys", { provider: "nobody", body: {} }), "not_found");
  await refused(settingsComputerRoute(computers, "testComputer", { provider: "nobody" }), "not_found");
  for (const body of [undefined, null, [], "x"]) await refused(settingsComputerRoute(computers, "saveComputerKeys", { provider: "e2b", body }), "input_invalid");
  await assert.rejects(settingsComputerRoute(computers, "saveComputerKeys", { provider: "e2b", body: { OPENAI_API_KEY: "sk" } }), (error) => error instanceof ApiError && error.status === 422 && error.extra.fields?.[0]?.field === "OPENAI_API_KEY");
  await refused(settingsComputerRoute(computers, "nope", {}), "not_found");
});

test("capabilities.computers: the kinds this server offers, in the registry's order", async (t) => {
  assert.deepEqual(await computerCapabilities(await routes(t)), { kinds: ["none", "sandbox", "desktop", "phone", "browser"] });
  assert.deepEqual(await computerCapabilities(await routes(t, "disk")), { kinds: ["none", "sandbox", "desktop", "phone", "browser"] }, "Mode 2: Agent37's sandbox can start here (it registers the box image in the owner's workspace); Docker and Daytona mount no Archil disk, and Modal's and E2B's need Archil's image in the owner's account");
});
