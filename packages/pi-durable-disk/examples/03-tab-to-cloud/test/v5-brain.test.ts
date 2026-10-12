// The shared v5 brain (tab/v5-brain.ts): what the phone and the laptop's "Take it offline" both run. D1's V5T serving (v5's weights on the 16-tag prompt), the
// narrowed lock on a body written as code, the state line for each kind of body, and the prefix the warm state is made from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { agentRegistry } from "../agent.ts";
import { FilesEnv, memoryFs } from "../tab/files-env.ts";
import { lockGrammar, renderNative } from "../tab/native-tools.ts";
import { narrowEnum, robotLock, signatureTools, signatureView, toNativeTools } from "../tab/native-turn.ts";
import { PhoneModel } from "../tab/phone-model.ts";
import { robotStateLine } from "../tab/v5-brain.ts";
import { SKILL_NAMES, applyRobotTool, initialRobot, type Design } from "../robot-model.ts";
import { codeStateLine, stateLine } from "../robot-state-line.ts";
import { ROBOT_FILE } from "../robot-tools.ts";
import type { Llm, ToolChatTool } from "../../04-walks-home/tab/src/modelhost.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const tagsServing = JSON.parse(readFileSync(fixture("robot-v5-tags-serving.json"), "utf8")) as { system: string; tools?: ToolChatTool[] };
const template = (JSON.parse(readFileSync(fixture("qwen35-robot-v3.template.json"), "utf8")) as { template: string }).template;
const TAGS = ["torso", "head", "neck", "tail", "legs", "front_legs", "back_legs", "arms", "wings", "eyes", "jaw", "belly", "plates", "horns", "spikes", "decoration"];

/** The registry's own tools as the model is shown them: the ten the V5T system text lists, in its order. */
function shownTools(): ToolChatTool[] {
  const registry = agentRegistry(async () => undefined, { switchTool: false, environments: [] });
  const offered = toNativeTools(registry.snapshot().tools().map((r) => ({ name: r.tool.name, description: r.tool.description, parameters: r.tool.parameters })));
  return signatureView(offered, signatureTools(tagsServing.system));
}
const enumOf = (tools: ToolChatTool[], tool: string, prop: string) => ((tools.find((t) => t.function.name === tool)!.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties[prop]!.enum);

test("V5T: the system text lists the same ten tools in the same order, over the 16 tags", () => {
  assert.equal(tagsServing.tools, undefined, "a signature prefix: no tools block");
  assert.deepEqual(signatureTools(tagsServing.system), ["set_color", "set_shape", "set_face", "rename", "resize", "scale", "set_legs", "morph", "reset", "do"]);
  assert.deepEqual(shownTools().map((t) => t.function.name), signatureTools(tagsServing.system), "the conversation offers them all, nothing else");
  for (const tag of TAGS) assert.ok(tagsServing.system.includes(tag), tag);
});

test("the lock on a body written as code: set_color is all and the body's tags, set_shape the body's tags with no all, do the skills home or gone", () => {
  const tags = ["torso", "head", "legs", "plates"];
  const locked = robotLock(shownTools(), { system: tagsServing.system, home: ["walk", "spin"], tags });
  assert.deepEqual(enumOf(locked, "set_color", "part"), TAGS.filter((t) => tags.includes(t)).concat("all").sort((a, b) => (enumOf(shownTools(), "set_color", "part")!.indexOf(a) - enumOf(shownTools(), "set_color", "part")!.indexOf(b))), "all and the body's tags, in the schema's order");
  assert.deepEqual(enumOf(locked, "set_shape", "part"), tags.slice().sort((a, b) => TAGS.indexOf(a) - TAGS.indexOf(b)), "the body's tags, no all");
  assert.deepEqual(enumOf(locked, "do", "skill"), ["walk", "spin"]);
  assert.deepEqual(locked.filter((t) => ["resize", "scale", "set_legs", "morph"].includes(t.function.name)).length, 4, "the body tools stay: on a code body they answer with the refusal");
  const none = robotLock(shownTools(), { system: tagsServing.system, home: [], tags });
  assert.ok(!none.some((t) => t.function.name === "do"), "no do at all when no skill is home");
});

test("the lock on a preset body, all eight skills home, is D1's v5-tags-lock.gbnf byte for byte", () => {
  const locked = robotLock(shownTools(), { system: tagsServing.system, home: SKILL_NAMES });
  assert.equal(lockGrammar(locked), (JSON.parse(readFileSync(fixture("robot-v5-tags-lock.json"), "utf8")) as { grammar: string }).grammar, "D1's V5T lock, byte for byte");
});

test("the warm-up's prefix is the V5T system turn as the model's template renders it with no tools block; byte for byte the serving file's text", async () => {
  const llm: Llm = { async load() {}, async chat() { return { text: "", tokens: 0 }; }, async loadUrl() {}, chatTemplate: () => template, async complete() { return { text: "", stoppedBy: "length", promptTokens: 1, outputTokens: 0, ms: 1 }; }, async exit() {} };
  const model = new PhoneModel(llm, { url: "https://p.example/m/robot-v5-00001-of-00007.gguf", threads: 2, nCtx: 2048, batch: 128, maxTokens: 300 });
  model.toolsInPrompt = false;
  await model.warm(tagsServing.system, shownTools());
  assert.equal(model.warmPrompt, `<|im_start|>system\n${tagsServing.system}<|im_end|>\n`, "the system turn is the serving file's text, nothing added");
  const withTools = renderNative(template, [{ role: "system", content: tagsServing.system }, { role: "user", content: "X" }], shownTools(), { enable_thinking: false });
  assert.notEqual(withTools.slice(0, withTools.indexOf("<|im_start|>user\n")), model.warmPrompt, "a tools block would be another prefix: a state made for this one would be skipped");
});

const drawn: Design = { version: 1, name: "quadruped", legDof: 3, torso: { length: 0.5, width: 0.22, height: 0.1 }, legs: [{ x: 0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }, { x: -0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }], original: undefined } as never;

async function robotEnv(files: Record<string, string>): Promise<FilesEnv> {
  const env = new FilesEnv(memoryFs("/workspace"));
  for (const [path, text] of Object.entries(files)) assert.ok((await env.writeFile(path, text, ctx)).ok, path);
  return env;
}
const skills = (names: string[]) => ({ "home/skills.json": JSON.stringify({ version: 1, body_mjcf_sha256: "0".repeat(64), skills: Object.fromEntries(names.map((n) => [n, { policy: `skills/${n}.json`, command: 0 }])) }) });

test("the state line on a preset body is D1's, with the skills home; no tags: every part stays", async () => {
  const robot = initialRobot(drawn);
  const env = await robotEnv({ [ROBOT_FILE]: JSON.stringify(robot), ...skills(["walk", "spin"]) });
  const read = await robotStateLine(env);
  assert.equal(read.line, stateLine(robot, ["walk", "spin"], "walk"));
  assert.deepEqual(read.skills, ["walk", "spin"]);
  assert.equal(read.tags, undefined);
});

test("the state line on a body written as code is codeStateLine: its tags with their colours (a set_color wins), the legs, and the tags the lock narrows to", async () => {
  const body = { name: "dino", tag_list: ["torso", "head", "legs", "plates"], legs: 4, tags: { body: ["torso"], face: ["head"], l1: ["legs"], p1: ["plates"] }, colors: { body: "green", face: "green", l1: "green", p1: "orange" } };
  const base = initialRobot(drawn);
  const painted = applyRobotTool(base, "set_color", { part: "plates", color: "purple" }, { skills: {}, body: { name: "dino", tags: body.tag_list, legs: 4 } }).state;
  const env = await robotEnv({ [ROBOT_FILE]: JSON.stringify(painted), "robot/body.json": JSON.stringify(body), ...skills(["walk"]) });
  const read = await robotStateLine(env);
  assert.deepEqual(read.tags, ["torso", "head", "legs", "plates"]);
  assert.equal(read.line, codeStateLine({ name: painted.name, face: painted.look.face }, { body: "dino", tags: body.tag_list, pieceTags: body.tags, pieceColors: body.colors, legs: 4 }, painted.look.tags ?? {}, ["walk"], "walk"));
  assert.match(read.line!, /built from code; 4 legs; colors torso green, head green, legs green, plates purple;/);
});

test("narrowing a free skill name or a tag list never widens: a tag the schema does not have is not added", () => {
  const locked = robotLock(shownTools(), { system: tagsServing.system, home: ["walk"], tags: ["torso", "unicorn"] });
  assert.deepEqual(enumOf(locked, "set_color", "part"), ["torso", "all"].sort((a, b) => enumOf(shownTools(), "set_color", "part")!.indexOf(a) - enumOf(shownTools(), "set_color", "part")!.indexOf(b)));
  assert.deepEqual(enumOf(narrowEnum(shownTools(), "skill", ["walk"]), "do", "skill"), ["walk"]);
});
