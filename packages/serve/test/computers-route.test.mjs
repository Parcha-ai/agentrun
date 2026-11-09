// Settings → Computers at its handler (computers.ts settingsComputerRoute), as serve's dispatch calls it: each route's
// answer, or its refusal as an ApiError (the status the dispatch sends), and capabilities.computers. Driven directly over
// a real store on a temp file, with no server and no port.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { COMPUTER_SETTINGS_ROUTES, computerCapabilities, createComputerRoutes, settingsComputerRoute } from "../dist/computers.js";
import { ApiError } from "../dist/errors.js";
import { fakeFactories, KINDS, tools } from "./fixtures/computer-kinds.mjs";
import { storeOn } from "./store-helpers.mjs";

async function routes(t, mode = "local") {
  const { store } = await storeOn(t);
  return createComputerRoutes({ store, sealKey: randomBytes(32), kinds: KINDS, factories: fakeFactories().factories, tools, mode });
}
const refused = (promise, code) => assert.rejects(promise, (error) => error instanceof ApiError && error.code === code, code);

test("the three routes by their operation names", () => {
  assert.deepEqual([...COMPUTER_SETTINGS_ROUTES], ["listComputers", "saveComputerKeys", "testComputer"]);
});

test("listComputers answers the view; saveComputerKeys a provider's view; testComputer its test", async (t) => {
  const computers = await routes(t);
  assert.deepEqual(await settingsComputerRoute(computers, "listComputers", {}), await computers.view());
  const saved = await settingsComputerRoute(computers, "saveComputerKeys", { provider: "phone-harness", body: { PHONE_HARNESS_API_KEY: "good-p" } });
  assert.deepEqual([saved.id, saved.ready], ["phone-harness", true]);
  assert.deepEqual(await settingsComputerRoute(computers, "testComputer", { provider: "phone-harness" }), { ok: true, detail: "phone-harness: 2 computers" });
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
  assert.deepEqual(await computerCapabilities(await routes(t, "disk")), { kinds: ["none", "sandbox", "desktop", "phone", "browser"] }, "Mode 2: Daytona, Modal and E2B mount the owner's disk from Archil, so the sandbox is offered");
});
