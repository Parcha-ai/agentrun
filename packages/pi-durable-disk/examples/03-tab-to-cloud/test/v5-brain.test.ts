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
import { robotStateLine, startV5Brain, type V5Host } from "../tab/v5-brain.ts";
import type { TabRuntime } from "../tab/runtime.ts";
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

test("with a flag on the floor nothing plays by itself: the line says doing nothing until a skill is asked for, and a reported run toward the flag is over", async () => {
  const scene = { "creature/scene.json": JSON.stringify({ version: 1, flag: { x: 3, y: -0.1, radius: 0.25 } }) };
  const robot = initialRobot(drawn);
  const doing = async (files: Record<string, string>) => /doing ([^;]+);/.exec((await robotStateLine(await robotEnv({ ...scene, ...skills(["walk", "spin"]), ...files }))).line!)![1];
  assert.equal(await doing({ [ROBOT_FILE]: JSON.stringify(robot) }), "nothing", "home, nothing asked yet: it stands at the start");
  const walking = { ...robot, skill: "walk", attempt: { id: "c1", skill: "walk", learned: true } };
  assert.equal(await doing({ [ROBOT_FILE]: JSON.stringify(walking) }), "walk", "asked, not yet reported: walking");
  const report = (id: string) => ({ "creature/attempt.json": JSON.stringify({ version: 1, id, skill: "walk", learned: true, fell: false, distance_m: 2.8, to_flag_m: 0.2, reached_flag: true, seconds: 6.2 }) });
  assert.equal(await doing({ [ROBOT_FILE]: JSON.stringify(walking), ...report("c1") }), "nothing", "reported: it stands at the flag");
  assert.equal(await doing({ [ROBOT_FILE]: JSON.stringify(walking), ...report("c0") }), "walk", "a report on an earlier request does not end this one");
  assert.equal(await doing({ [ROBOT_FILE]: JSON.stringify({ ...robot, skill: "spin", attempt: walking.attempt }), ...report("c1") }), "spin", "a skill asked for after the run plays where it stands");
  // On a body written as code, the same.
  const body = { "robot/body.json": JSON.stringify({ name: "dino", tag_list: ["torso", "legs"], legs: 4, tags: { body: ["torso"], l1: ["legs"] }, colors: { body: "green", l1: "green" } }) };
  assert.equal(await doing({ [ROBOT_FILE]: JSON.stringify(robot), ...body }), "nothing");
  // Without a flag, the page plays the default as before.
  assert.equal(/doing ([^;]+);/.exec((await robotStateLine(await robotEnv({ [ROBOT_FILE]: JSON.stringify(robot), ...skills(["walk", "spin"]) }))).line!)![1], "walk");
});

test("narrowing a free skill name or a tag list never widens: a tag the schema does not have is not added", () => {
  const locked = robotLock(shownTools(), { system: tagsServing.system, home: ["walk"], tags: ["torso", "unicorn"] });
  assert.deepEqual(enumOf(locked, "set_color", "part"), ["torso", "all"].sort((a, b) => enumOf(shownTools(), "set_color", "part")!.indexOf(a) - enumOf(shownTools(), "set_color", "part")!.indexOf(b)));
  assert.deepEqual(enumOf(narrowEnum(shownTools(), "skill", ["walk"]), "do", "skill"), ["walk"]);
});

// ---- startV5Brain, end to end against stand-ins: the order things are set and called in, and the wasm globals ------------------------------------------------------------
const parts = [{ name: "robot-v5-00001-of-00001.gguf", bytes: 10, sha256: "a".repeat(64) }];
async function withPage<T>(run: () => Promise<T>): Promise<T> {
  const real = { fetch: globalThis.fetch, location: (globalThis as { location?: unknown }).location };
  const files: Record<string, string> = { "https://p.example/models/robot-v5-00001-of-00001.parts.json": JSON.stringify({ parts }), "https://p.example/models/v5t.serving.json": readFileSync(fixture("robot-v5-tags-serving.json"), "utf8") };
  globalThis.fetch = (async (u: string | URL) => { const body = files[String(u)]; return body === undefined ? new Response("missing", { status: 404 }) : new Response(body); }) as typeof fetch;
  (globalThis as { location?: unknown }).location = { href: "https://p.example/run/x", origin: "https://p.example" };
  try { return await run(); } finally { globalThis.fetch = real.fetch; (globalThis as { location?: unknown }).location = real.location; }
}
function standIn(order: string[]) {
  const llm: Llm = { async load() {}, async chat() { return { text: "", tokens: 0 }; }, async loadUrl() { order.push("load"); }, chatTemplate: () => template, async complete() { return { text: "", stoppedBy: "length", promptTokens: 595, outputTokens: 0, ms: 1 }; }, async exit() {} };
  const registry = agentRegistry(async () => undefined, { switchTool: false, environments: [] });
  const conversation = { async agent() { return {}; }, async configure() { order.push("configure"); } };
  const runtime = { models: { setProvider: () => order.push("provider") }, registry, harness: { resume: async () => { order.push("resume"); } }, env: new FilesEnv(memoryFs("/workspace")) } as unknown as TabRuntime;
  const host = (extra: Partial<V5Host> = {}): V5Host => ({ params: new URLSearchParams("build=asyncify&state=0&model=/models/robot-v5-00001-of-00001.gguf&serving=/models/v5t.serving.json"), marks: {}, say: () => undefined, log: () => undefined, report: () => undefined, conversation: () => conversation as never, makeLlm: () => llm, ...extra });
  return { runtime, host };
}

test("startV5Brain gives `ready` the brain, with the lock and the reports already set, and resumes a cut-short turn only after it", async () => {
  const order: string[] = [];
  const { runtime, host } = standIn(order);
  const reports: string[] = [];
  const brain = await withPage(() => startV5Brain(runtime, host({ report: (kind) => void reports.push(kind) }), (b) => {
    assert.ok(b.model && typeof b.model.lock === "function" && typeof b.model.onTurn === "function" && typeof b.model.onTurnStart === "function", "everything a turn uses is set when the page is told");
    assert.equal(b.agent.instructions, tagsServing.system);
    order.push("ready");
  }));
  assert.deepEqual(order, ["load", "provider", "configure", "ready", "resume"], "the provider is in before the conversation is configured, the page is told before a cut-short turn resumes");
  assert.ok(reports.includes("build") && reports.includes("ready"));
  assert.equal(brain.build, "asyncify");
  assert.equal(brain.model.toolsInPrompt, false, "a signature prefix: no tools block");
});

test("the laptop gets this page's wasm globals back after the model is loaded; the phone's are left as the build selection set them", async () => {
  const W = WebAssembly as unknown as { Memory: unknown; Suspending?: unknown };
  const real = { Memory: W.Memory, Suspending: W.Suspending };
  try {
    for (const restore of [true, false]) {
      const { runtime, host } = standIn([]);
      await withPage(() => startV5Brain(runtime, host({ restoreWasmGlobals: restore })));
      assert.equal(W.Memory === real.Memory, restore, restore ? "Memory is the page's own again" : "Memory is still the build selection's");
      assert.equal(W.Suspending, restore ? real.Suspending : undefined, restore ? "Suspending is back" : "Suspending is still hidden (the Asyncify build)");
      W.Memory = real.Memory; if (real.Suspending !== undefined) W.Suspending = real.Suspending; else Reflect.deleteProperty(WebAssembly, "Suspending");
    }
  } finally {
    W.Memory = real.Memory;
    if (real.Suspending !== undefined) W.Suspending = real.Suspending;
  }
});
