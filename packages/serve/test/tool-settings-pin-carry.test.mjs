// An agent's tool setting reaches its run's gate whole: what the agent's revision stores for a tool (its permission and any
// other key a setting carries, such as an argument pin) is kept as it was given, and the gate of a run on that revision is
// handed exactly that setting. The cutover moves agents and runs into the one store; this pins that nothing on the way
// drops a setting's keys.
//
// The pin below is a PLACEHOLDER shape until the argument pin's own form lands (an agent-level `pin` in toolSettings: at
// most 8 argument -> JSON scalar). Replace PIN with that exact form, and add the API's acceptance and the gate's refusal of
// a differing argument, when it does.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Agents } from "../dist/agents.js";
import { runGate } from "../dist/tool-gate.js";
import { agent, scratch } from "./support.mjs";

const PIN = { to: "C0123" };
const SETTING = { permission: "allow", pin: PIN };

test("a tool setting's keys are stored with the revision as they were given, a pin included", async (t) => {
  const agents = new Agents(join(await scratch(t), "agents"));
  t.after(() => agents.close());
  const created = await agents.create(agent("pinned", { tool_settings: { web_fetch: SETTING } }));
  assert.deepEqual(created.revision.body.toolSettings, { web_fetch: SETTING });
  const read = await agents.get("pinned");
  assert.deepEqual(read.revision.body.toolSettings, { web_fetch: SETTING }, "and read back the same");
});

test("the gate of a run on that revision is handed the setting whole, the pin included", async (t) => {
  const agents = new Agents(join(await scratch(t), "agents"));
  t.after(() => agents.close());
  const { revision } = await agents.create(agent("pinned", { tool_settings: { web_fetch: SETTING } }));
  const root = join(await scratch(t), "data", "runs", "run-1");
  const gate = runGate({ root, work: join(root, "work") }, "run-1", revision);
  assert.deepEqual(gate["overrides"], { web_fetch: SETTING });
});

test.todo("the API takes an agent definition whose tool setting has a pin (its schema names pin)");
test.todo("the gate refuses a call whose pinned argument differs from the pin, and runs one that matches");
