// What GET /v2/capabilities says a run takes now (harnesses[].ready_models): of the models a harness offers (`models`,
// each one a save takes), those whose provider is connected here. One whose key is not set stays in `models` (a save of
// it warns) and is never ready. The console's Model picker lists the ready ones. No network: nothing reaches a provider.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessOffers } from "../dist/harness.js";
import { scratch } from "./support.mjs";

const piOf = async (env) => (await harnessOffers(env)).find((h) => h.id === "pi");
const providerOf = (id) => id.split("/")[0];

test("ready_models: a connected provider's models are ready; one whose key is not set is offered but never ready", async (t) => {
  const data = await scratch(t);
  const openai = await piOf({ AGENTRUN_SERVE_DATA: data, OPENAI_API_KEY: "fake-test-key" });
  assert.ok(openai.ready_models.length > 0, "the OpenAI key makes OpenAI's models ready");
  assert.ok(openai.ready_models.every((m) => openai.models.includes(m)), "ready is a part of what is offered");
  assert.deepEqual([...new Set(openai.ready_models.map(providerOf))], ["openai"], `only OpenAI's are ready: ${openai.ready_models.join(", ")}`);
  const unkeyed = openai.models.filter((m) => !openai.ready_models.includes(m));
  assert.ok(unkeyed.length > 0, "another provider's models are offered too, lacking only their key");
  assert.ok(unkeyed.every((m) => providerOf(m) !== "openai"), `none of OpenAI's lacks its key: ${unkeyed.join(", ")}`);

  const both = await piOf({ AGENTRUN_SERVE_DATA: data, OPENAI_API_KEY: "fake-test-key", ANTHROPIC_API_KEY: "fake-test-key" });
  assert.deepEqual([...new Set(both.ready_models.map(providerOf))].sort(), ["anthropic", "openai"], "a second key adds its provider's");
});

test("ready_models is empty where no provider is connected, whatever is offered", async (t) => {
  const data = await scratch(t);
  const none = await piOf({ AGENTRUN_SERVE_DATA: data });
  assert.deepEqual(none.ready_models, []);
});
