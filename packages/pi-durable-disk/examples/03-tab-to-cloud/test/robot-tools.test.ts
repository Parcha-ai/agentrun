// The robot's tools over a real Harness with a real (Node) environment: each call edits creature/robot.json in the workspace, the result says whether the brain still fits, and every host registers them in the same place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { agentRegistry, rootAgent } from "../agent.ts";
import { GO_ONLINE_TOOL } from "../offline-tools.ts";
import { ROBOT_FILE, ROBOT_TOOLS } from "../robot-tools.ts";
import { BODY_CHANGED, LOOKS_ONLY, parseRobot, type RobotState } from "../robot-model.ts";
import { scriptedCloud, type ScriptedTurn, type SeenRequest } from "../tab/scripted-cloud.ts";

async function rig(script: ScriptedTurn[], before?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "robot-tools-"));
  before?.(dir);
  const env = new NodeExecutionEnv({ cwd: dir, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" } });
  const durable: string[] = [];
  const registry = agentRegistry(async () => void durable.push("flush"), { switchTool: false });
  const models = createModels();
  const seen: SeenRequest[] = [];
  models.setProvider(scriptedCloud("cloud-big", script, seen));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
  const root = await harness.root(ctx, { agent: rootAgent("cloud-big") });
  const results = async () => ((await root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { role: string; isError?: boolean; toolName?: string; content?: { text?: string }[] }[] }[]).filter((e) => e.kind === "pi.tool-result").reverse().map((e) => ({ name: e.model![0]!.toolName, error: e.model![0]!.isError === true, text: e.model![0]!.content?.map((c) => c.text ?? "").join("") ?? "" }));
  const ask = async (text: string) => void (await (await root.submit({ type: "input", content: text }, ctx)).wait(ctx));
  return { dir, registry, durable, ask, results, state: () => parseRobot(readFileSync(join(dir, ROBOT_FILE), "utf8")) as RobotState, close: async () => { await harness.close(ctx); rmSync(dir, { recursive: true, force: true }); } };
}

test("every host registers the nine robot tools, in the schema's order, right after go_online and before the computer", () => {
  const names = agentRegistry(async () => undefined, {}).snapshot().tools().map((t) => `${t.extension.name}/${t.tool.name}`);
  const at = names.findIndex((n) => n.endsWith(`/${GO_ONLINE_TOOL}`));
  assert.deepEqual(names.slice(at + 1, at + 1 + ROBOT_TOOLS.length), ROBOT_TOOLS.map((t) => `robot-tools/${t}`));
  assert.ok(names.findIndex((n) => n.endsWith("/computer")) > at + ROBOT_TOOLS.length, "the computer tool comes after");
});

test("the tools' schemas carry the enums and bounds the model is told", () => {
  const tool = (name: string) => agentRegistry(async () => undefined, {}).snapshot().tools().find((t) => t.tool.name === name)!.tool.parameters as { properties: Record<string, { enum?: unknown[]; minimum?: number; maximum?: number; maxLength?: number }>; required?: string[] };
  assert.deepEqual(tool("set_color").properties.part!.enum, ["torso", "legs", "front_legs", "back_legs", "all"]);
  assert.deepEqual(tool("set_color").properties.color!.enum, ["red", "orange", "yellow", "green", "blue", "purple", "pink", "white", "black", "gray", "brown"]);
  assert.deepEqual(tool("set_color").required, ["part", "color"], "argument order: part, color");
  assert.deepEqual(tool("set_legs").properties.pairs!.enum, [2, 3]);
  assert.deepEqual(tool("morph").properties.preset!.enum, ["dog", "spider", "giraffe", "lizard", "stubby", "original"]);
  assert.equal(tool("scale").properties.factor!.minimum, 0.5);
  assert.equal(tool("resize").properties.factor!.maximum, 2);
  assert.equal(tool("rename").properties.name!.maxLength, 24);
  assert.deepEqual(tool("reset").required ?? [], []);
});

test("a looks-only call writes the state file and says the brain still fits; the workspace is made durable after each tool", async () => {
  const r = await rig([{ call: { name: "set_color", arguments: { part: "legs", color: "red" } } }, { text: "Done." }]);
  await r.ask("make the legs red");
  assert.deepEqual(r.state().look.legs, ["red", "red", "red"]);
  const [res] = await r.results();
  assert.equal(res!.text, `The legs are now red. ${LOOKS_ONLY}`);
  assert.equal(res!.error, false);
  assert.ok(r.durable.length >= 1, "write-through ran for a robot tool");
  await r.close();
});

test("a body call, a refusal and a no-op: the file changes only for the first; the refusal is an error result with the limit", async () => {
  const r = await rig([
    { call: { name: "resize", arguments: { part: "leg_length", factor: 1.5 } } },
    { call: { name: "resize", arguments: { part: "torso_length", factor: 2 } } },
    { call: { name: "set_legs", arguments: { pairs: 2 } } },
    { text: "Done." },
  ]);
  await r.ask("longer legs, then a much longer body, then four legs");
  const after = r.state();
  assert.deepEqual(after.design.legs.map((l) => l.thigh), [0.3, 0.3]);
  assert.equal(after.design.torso.length, 0.5, "the refused resize changed nothing");
  assert.equal(after.edits, 1, "only one change counted");
  const res = await r.results();
  assert.match(res[0]!.text, /^The legs are now 0\.60 m long \(x1\.5\)\./);
  assert.ok(res[0]!.text.endsWith(BODY_CHANGED));
  assert.equal(res[1]!.error, true);
  assert.equal(res[1]!.text, "Not done: torso_length would be 1.00 m, the most allowed is 0.90 m (about x1.8).");
  assert.match(res[2]!.text, /^No change: the robot already has 4 legs\./);
  await r.close();
});

test("the robot starts as the body the user drew when the page published it (creature/design.json), and reset returns to it", async () => {
  const drawn = { version: 1, name: "blobby", legDof: 3, torso: { length: 0.6, width: 0.3, height: 0.14 }, legs: [{ x: 0.7, thigh: 0.12, shin: 0.12, radius: 0.03 }, { x: -0.7, thigh: 0.12, shin: 0.12, radius: 0.03 }] };
  const r = await rig([{ call: { name: "morph", arguments: { preset: "spider" } } }, { call: { name: "reset", arguments: {} } }, { text: "Done." }], (dir) => {
    mkdirSync(join(dir, "creature"), { recursive: true });
    writeFileSync(join(dir, "creature/design.json"), JSON.stringify(drawn));
  });
  await r.ask("make it a spider, then undo everything");
  const s = r.state();
  assert.equal(s.original.name, "blobby");
  assert.deepEqual(s.design.torso, drawn.torso, "reset put the drawn body back");
  assert.equal(s.name, "blobby");
  const res = await r.results();
  assert.match(res[0]!.text, /^The robot is now a spider\./);
  assert.match(res[1]!.text, /^Everything is back to the robot the user drew\./);
  await r.close();
});

test("a robot file this module did not write is refused, never overwritten", async () => {
  const r = await rig([{ call: { name: "set_face", arguments: { face: "happy" } } }, { text: "Done." }], (dir) => {
    mkdirSync(join(dir, "creature"), { recursive: true });
    writeFileSync(join(dir, ROBOT_FILE), "not json");
  });
  await r.ask("give it a face");
  const [res] = await r.results();
  assert.equal(res!.error, true);
  assert.match(res!.text, /^Not done: creature\/robot\.json is not a robot state this tool can read\./);
  assert.equal(readFileSync(join(r.dir, ROBOT_FILE), "utf8"), "not json");
  await r.close();
});

test("with no first edit there is no file: a refused call writes nothing", async () => {
  const r = await rig([{ call: { name: "set_face", arguments: { face: "grumpy" } } }, { text: "Done." }]);
  await r.ask("give it a face");
  assert.equal(existsSync(join(r.dir, ROBOT_FILE)), false);
  await r.close();
});
