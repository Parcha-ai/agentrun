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
import { createHash } from "node:crypto";
import { ROBOT_TEMPLATES } from "../robot-templates.ts";
import { buildRobot, provisionRobotFiles } from "../build-robot.ts";
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
  return { agent: () => root.agent(ctx), dir, registry, durable, ask, results, state: () => parseRobot(readFileSync(join(dir, ROBOT_FILE), "utf8")) as RobotState, close: async () => { await harness.close(ctx); rmSync(dir, { recursive: true, force: true }); } };
}

test("every host registers the nine robot tools, in the schema's order, right after go_online and before the computer", () => {
  const names = agentRegistry(async () => undefined, {}).snapshot().tools().map((t) => `${t.extension.name}/${t.tool.name}`);
  const at = names.findIndex((n) => n.endsWith(`/${GO_ONLINE_TOOL}`));
  assert.deepEqual(names.slice(at + 1, at + 1 + ROBOT_TOOLS.length), ROBOT_TOOLS.map((t) => `robot-tools/${t}`));
  assert.ok(names.findIndex((n) => n.endsWith("/computer")) > at + ROBOT_TOOLS.length, "the computer tool comes after");
});

test("the tools' schemas carry the enums and bounds the model is told", () => {
  const tool = (name: string) => agentRegistry(async () => undefined, {}).snapshot().tools().find((t) => t.tool.name === name)!.tool.parameters as { properties: Record<string, { enum?: unknown[]; minimum?: number; maximum?: number; maxLength?: number }>; required?: string[] };
  assert.deepEqual(tool("set_color").properties.part!.enum, ["all", "torso", "head", "neck", "tail", "legs", "front_legs", "back_legs", "arms", "wings", "eyes", "jaw", "belly", "plates", "horns", "spikes", "decoration"]);
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

test("update_robot over a real Harness: a combined ask is one call and one file write", async () => {
  const r = await rig([{ call: { name: "update_robot", arguments: { morph: "spider", color: "red" } } }, { text: "Done." }]);
  await r.ask("make it a red spider");
  const s = r.state();
  assert.equal(s.design.legs.length, 3);
  assert.equal(s.look.torso, "red");
  const res = await r.results();
  assert.equal(res.length, 1);
  assert.equal(res[0]!.text, `The robot is now a spider. The whole robot is now red. ${BODY_CHANGED}`);
  await r.close();
});

test("do(skill) reads the skills that came home from home/skills.json: a skill it has is set in the state file, one it has not is refused naming what it can do, and with nothing home it says so", async () => {
  const skillsJson = JSON.stringify({ version: 1, body_mjcf_sha256: "x", default: "walk", skills: { walk: { policy: "skills/walk.json", command: 0.5, label: "walk" }, sprint: { policy: "skills/sprint.json", command: 1.2, label: "sprint" } } });
  const r = await rig([{ call: { name: "do", arguments: { skill: "sprint" } } }, { call: { name: "do", arguments: { skill: "spin" } } }, { text: "Done." }], (dir) => {
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home/skills.json"), skillsJson);
  });
  await r.ask("sprint, then spin");
  assert.equal(r.state().skill, "sprint");
  const res = await r.results();
  assert.equal(res[0]!.text, "The robot is now doing sprint. The body is unchanged: the walking brain still fits.");
  assert.equal(res[1]!.error, true);
  assert.equal(res[1]!.text, "Not done: the robot has not learned spin; it can do walk, sprint.");
  await r.close();
  const none = await rig([{ call: { name: "do", arguments: { skill: "walk" } } }, { text: "Done." }]);
  await none.ask("walk");
  assert.match((await none.results())[0]!.text, /^Not done: no skill has come home yet/);
  assert.equal(existsSync(join(none.dir, ROBOT_FILE)), false);
  await none.close();
  const single = await rig([{ call: { name: "do", arguments: { skill: "walk" } } }, { text: "Done." }], (dir) => { mkdirSync(join(dir, "home"), { recursive: true }); writeFileSync(join(dir, "home/policy.json"), "{}"); });
  await single.ask("walk");
  assert.equal(single.state().skill, "walk", "a run with only home/policy.json has the one skill, walk");
  await single.close();
});

const DINO_BODY = { name: "dino", tag_list: ["torso", "head", "neck", "tail", "legs", "front_legs", "back_legs", "eyes", "plates"], legs: 4 };
const withBody = (dir: string) => { mkdirSync(join(dir, "robot"), { recursive: true }); writeFileSync(join(dir, "robot/body.json"), JSON.stringify(DINO_BODY)); };

test("on a robot built from code the look tools work on its tags through the real tools, the flat form refuses a preset with the one sentence (the shape tools themselves are not offered), and the first edit takes the body's name", async () => {
  const r = await rig([
    { call: { name: "set_color", arguments: { part: "plates", color: "orange" } } },
    { call: { name: "set_color", arguments: { part: "wings", color: "red" } } },
    { call: { name: "update_robot", arguments: { morph: "dog" } } },
    { text: "Done." },
  ], withBody);
  await r.ask("paint the plates orange");
  const [a, b, c] = await r.results();
  assert.equal(a!.text, `The plates are now orange. ${LOOKS_ONLY}`);
  assert.equal(r.state().look.tags?.plates, "orange");
  assert.equal(r.state().name, "dino", "the name the body file gave it");
  assert.equal(b!.error, true);
  assert.match(b!.text, /^Not done: this robot has no wings; its parts are: whole robot, torso, head, neck, tail, legs, front legs, back legs, eyes, plates\.$/);
  assert.equal(c!.error, true);
  assert.equal(c!.text, "Not done: this robot is built from code (robot/body.mjs), so its size, legs and shape change by editing that file, not with this tool.");
  await r.close();
});

test("build_robot puts the helper files in the workspace, says there is no robot yet, then reports what the page found; MuJoCo's error comes back as the tool result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "build-robot-"));
  try {
    const env = new NodeExecutionEnv({ cwd: dir, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" } });
    const sha = (t: string) => Promise.resolve(createHash("sha256").update(t).digest("hex"));
    const first = await buildRobot(env as never, ctx as never, { sha256: sha });
    assert.equal(first.isError, false);
    assert.match(first.text, /^No robot is built yet\. The helper files are in place \(robot\/lib\.mjs, robot\/build\.mjs, robot\/examples\/dog\.mjs, robot\/examples\/dino\.mjs\)\. Write robot\/body\.mjs/);
    for (const [path, content] of Object.entries(ROBOT_TEMPLATES)) assert.equal(readFileSync(join(dir, "robot", path), "utf8"), content, path);
    assert.deepEqual(await provisionRobotFiles(env as never, ctx as never), [], "nothing to write the second time");
    writeFileSync(join(dir, "robot/body.xml"), "<mujoco/>");
    writeFileSync(join(dir, "robot/body.json"), JSON.stringify(DINO_BODY));
    const xmlSha = await sha("<mujoco/>");
    writeFileSync(join(dir, "robot/build.json"), JSON.stringify({ sha: xmlSha, ok: true, errors: [], warnings: ["it is leaning after 3 s at its stand angles (up 0.7)"], report: { pieces: 32, joints: 18, motors: 8, mass_kg: 10.99, settled_height_m: 0.389, tags: ["torso", "legs"] } }));
    const built = await buildRobot(env as never, ctx as never, { sha256: sha, timeoutMs: 200, sleep: async () => undefined });
    assert.equal(built.isError, false);
    assert.equal(built.text, "Built dino: 32 pieces, 8 motors, 10 spring joints, 10.99 kg, stands 0.389 m high. Tags: torso, legs. Warning: it is leaning after 3 s at its stand angles (up 0.7)");
    writeFileSync(join(dir, "robot/build.json"), JSON.stringify({ sha: xmlSha, ok: false, errors: ["MuJoCo: Error: XML Error: Schema violation: unrecognized attribute 'sizee' in element geom"], warnings: [] }));
    const bad = await buildRobot(env as never, ctx as never, { sha256: sha, timeoutMs: 200, sleep: async () => undefined });
    assert.equal(bad.isError, true);
    assert.equal(bad.text, "Not built: MuJoCo: Error: XML Error: Schema violation: unrecognized attribute 'sizee' in element geom");
    writeFileSync(join(dir, "robot/build.json"), JSON.stringify({ sha: "an older body", ok: true, errors: [], warnings: [], report: { pieces: 1, joints: 1, motors: 1, mass_kg: 1, settled_height_m: 1, tags: [] } }));
    const stale = await buildRobot(env as never, ctx as never, { sha256: sha, timeoutMs: 50, sleep: async () => new Promise((r) => setTimeout(r, 20)) });
    assert.match(stale.text, /^Written, but not checked: the creature page did not report on this body within 20 s/, "a report for another body is not this body's");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the templates the tool writes are what 04-walks-home/body holds (robot-templates.ts is generated: run scripts/gen-robot-templates.mjs)", async () => {
  // @ts-expect-error: a plain .mjs script, without types
  const { generated } = await import("../scripts/gen-robot-templates.mjs");
  assert.equal(readFileSync(new URL("../robot-templates.ts", import.meta.url), "utf8"), generated);
});

test("once a body exists as code, the agent is no longer offered the tools that change a preset body: they leave its tool list from the first robot call, and come back for a robot with no code body", async () => {
  const names = async (r: Awaited<ReturnType<typeof rig>>) => (await r.agent()).tools.map((t) => t.name);
  const code = await rig([{ call: { name: "set_color", arguments: { part: "plates", color: "orange" } } }, { text: "Done." }], withBody);
  const before = await names(code);
  for (const t of ["resize", "scale", "set_legs", "morph"]) assert.ok(before.includes(t), `${t} is offered before`);
  await code.ask("paint the plates orange");
  const after = await names(code);
  for (const t of ["resize", "scale", "set_legs", "morph"]) assert.ok(!after.includes(t), `${t} is gone once the body is code`);
  for (const t of ["set_color", "set_shape", "set_face", "rename", "reset", "do", "build_robot", "update_robot"]) assert.ok(after.includes(t), `${t} stays`);
  await code.close();
  const preset = await rig([{ call: { name: "set_color", arguments: { part: "legs", color: "red" } } }, { text: "Done." }]);
  await preset.ask("legs red");
  const kept = await names(preset);
  for (const t of ["resize", "scale", "set_legs", "morph"]) assert.ok(kept.includes(t), `${t} stays for a preset body`);
  await preset.close();
});

test("build_robot hides them too, so the first thing the agent does in code mode is enough", async () => {
  const r = await rig([{ call: { name: "build_robot", arguments: {} } }, { text: "Done." }], withBody);
  await r.ask("check the robot");
  const names = (await r.agent()).tools.map((t) => t.name);
  assert.ok(!names.includes("morph") && names.includes("build_robot"));
  await r.close();
});
