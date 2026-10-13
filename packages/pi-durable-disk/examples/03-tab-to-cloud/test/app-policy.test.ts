// A host that is not the robot page tells the page what its agent is: its own instructions (replacing the robot page's, or added to them) and the extensions to leave out. The server sends them
// in the attach (`attached.app`), and the page applies them when it creates the root conversation: harness.root() and admitNotice only apply an agent on creation, so a host that runs the
// agent later (a VM) cannot change what the browser gave it. Over a real pi-durable Harness with the model scripted to say what it was given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { agentRegistry, rootAgent, type AppPolicy } from "../agent.ts";
import { scriptedCloud, type SeenRequest } from "../tab/scripted-cloud.ts";

async function firstRequest(app: AppPolicy | undefined): Promise<{ instructions: string; tools: string[] }> {
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  const models = createModels();
  const seen: SeenRequest[] = [];
  let instructions = "";
  models.setProvider(scriptedCloud("m", [{ reply: (system: string) => { instructions = system; return "ok"; } }], seen));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  try {
    const root = await harness.root(ctx, { agent: rootAgent("m", { registry, robotCode: false, ...(app ? { app } : {}) }) });
    await (await root.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
    return { instructions, tools: seen[0]?.tools ?? [] };
  } finally {
    await harness.close(ctx);
  }
}

test("with no app policy the root is what it always was: the robot page's instructions and every tool", async () => {
  const r = await firstRequest(undefined);
  assert.match(r.instructions, /creature|robot/i);
  assert.ok(r.tools.includes("set_color") && r.tools.includes("read") && r.tools.includes("computer"), r.tools.join());
});

test("replace-mode instructions are the root's instructions, and the robot page's are gone", async () => {
  const r = await firstRequest({ instructions: { mode: "replace", text: "  You are a poet. Answer in verse.  " } });
  assert.match(r.instructions, /<instructions>\nYou are a poet\. Answer in verse\.\n<\/instructions>/, "trimmed, and the harness's own wrapper around it");
  assert.doesNotMatch(r.instructions, /creature|robot|teach/i);
});

test("append-mode instructions come after the robot page's, which stay", async () => {
  const r = await firstRequest({ instructions: { mode: "append", text: "Also: be brief." } });
  assert.match(r.instructions, /creature|robot/i);
  assert.ok(r.instructions.indexOf("Also: be brief.") > r.instructions.search(/creature|robot/i), "after the page's own");
  assert.match(r.instructions, /Also: be brief\.\n<\/instructions>/, "the last thing in the instructions");
});

test("an extension left out takes its tools with it, and the others stay", async () => {
  const r = await firstRequest({ withoutExtensions: ["robot-tools", "computer"] });
  assert.ok(!r.tools.includes("set_color") && !r.tools.includes("do") && !r.tools.includes("computer"), r.tools.join());
  assert.ok(r.tools.includes("read") && r.tools.includes("bash") && r.tools.includes("go_offline"), r.tools.join());
});

test("an extension that is not installed is an error that lists what is", () => {
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  assert.throws(() => rootAgent("m", { registry, app: { withoutExtensions: ["robot-tool"] } }), (e: Error) => /unknown extension "robot-tool"/.test(e.message) && /coding-tools/.test(e.message) && /robot-tools/.test(e.message));
  assert.throws(() => rootAgent("m", { app: { withoutExtensions: ["computer"] } }), /registry/, "without a registry the names cannot be checked: said, not ignored");
});

// The page creates its root from the attach: the server's app policy is what it applies.
test("the tab's root agent applies the attach's app policy, and is the robot page's without one", async () => {
  const { rootAgentFor } = await import("../tab/runtime.ts");
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  const given = rootAgentFor({ model: "m", app: { instructions: { mode: "replace", text: "You are a poet." }, withoutExtensions: ["computer"] } }, { registry, robotCode: false });
  assert.equal(given.instructions, "You are a poet.");
  assert.deepEqual((given.extensions as { remove: { name: string }[] }).remove.map((e) => e.name), ["computer"]);
  const plain = rootAgentFor({ model: "m" }, { registry, robotCode: false });
  assert.match(plain.instructions ?? "", /creature|robot/i);
  assert.equal(plain.extensions, undefined);
});
