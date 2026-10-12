// The robot's place and goal (D0's flag beat): "walk to the flag" is `do walk` before and after training. Before, the
// robot tries with the page's untrained brain and fails where everyone can see it; after, it walks and the answer says
// whether it reached the flag. Over a real pi-durable Harness with the cloud agent scripted, and a fake page that answers
// each request id in creature/robot.json with creature/attempt.json in D0's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { agentRegistry, rootAgent, setExtraInstructions } from "../agent.ts";
import { ROBOT_CODE_INSTRUCTIONS } from "../robot-sop.ts";
import { ATTEMPT_FILE, FLAG_WAIT, NO_REPORT, requestId, runText, SCENE_FILE, tryText, waitForAttempt, type SceneFiles } from "../flag-goal.ts";
import { BRAIN_PROVIDER } from "../providers.ts";
import { ROBOT_FILE } from "../robot-tools.ts";
import { scriptedCloud, type ScriptedTurn } from "../tab/scripted-cloud.ts";

FLAG_WAIT.tryMs = 1_500;
FLAG_WAIT.runMs = 1_500;

type Outcome = { fell: boolean; distance_m: number; to_flag_m: number; reached_flag: boolean; seconds: number };

/** The page, faked: each new attempt id in robot.json gets one report, after a moment, by whether the skill had come home. */
function fakePage(dir: string, outcome: (learned: boolean) => Outcome | undefined) {
  const seen = new Set<string>();
  const timer = setInterval(() => {
    const file = join(dir, ROBOT_FILE);
    if (!existsSync(file)) return;
    const robot = JSON.parse(readFileSync(file, "utf8")) as { attempt?: { id: string; skill: string; learned: boolean } };
    const a = robot.attempt;
    if (!a || seen.has(a.id)) return;
    seen.add(a.id);
    const o = outcome(a.learned);
    if (o) setTimeout(() => writeFileSync(join(dir, ATTEMPT_FILE), JSON.stringify({ version: 1, id: a.id, skill: a.skill, learned: a.learned, ...o })), 100);
  }, 50);
  return { seen, stop: () => clearInterval(timer) };
}

/** The computer, with each write of the robot's file held back a moment: two edits that read the file before either writes lose one. */
function slowRobotWrites(env: NodeExecutionEnv): NodeExecutionEnv {
  return new Proxy(env, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === "writeFile") return async (path: string, ...rest: unknown[]) => {
        if (path === ROBOT_FILE) await new Promise((r) => setTimeout(r, 300));
        return (v as (...a: unknown[]) => unknown).call(target, path, ...rest);
      };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function rig(script: ScriptedTurn[], o: { scene?: boolean; skills?: string[]; provider?: string; slowWrites?: boolean; outcome?: (learned: boolean) => Outcome | undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flag-goal-"));
  mkdirSync(join(dir, "creature"), { recursive: true });
  if (o.scene !== false) writeFileSync(join(dir, SCENE_FILE), JSON.stringify({ version: 1, flag: { x: 3, y: 0, radius: 0.4 } }));
  if (o.skills) {
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home/skills.json"), JSON.stringify({ version: 1, default: o.skills[0], skills: Object.fromEntries(o.skills.map((s) => [s, { label: s, policy: `skills/${s}.json` }])) }));
  }
  const node = new NodeExecutionEnv({ cwd: dir, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" } });
  const env = o.slowWrites ? slowRobotWrites(node) : node;
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  const models = createModels();
  models.setProvider(scriptedCloud("m", script, [], o.provider));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
  const root = await harness.root(ctx, { agent: { ...rootAgent("m"), ...(o.provider ? { model: { provider: o.provider, modelId: "m" } } : {}) } });
  const page = fakePage(dir, o.outcome ?? (() => undefined));
  const ask = async (t: string) => void (await (await root.submit({ type: "input", content: t }, ctx)).wait(ctx));
  const results = async () =>
    ((await root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { toolName?: string; isError?: boolean; content?: { text?: string }[] }[]; data?: unknown }[])
      .filter((e) => e.kind === "pi.tool-result").reverse().map((e) => ({ error: e.model![0]!.isError === true, text: e.model![0]!.content?.map((c) => c.text ?? "").join("") ?? "" }));
  const lastSaid = async () =>
    ((await root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { role?: string; content?: { type: string; text?: string }[] }[] }[])
      .flatMap((e) => (e.model ?? []).filter((m) => m.role === "assistant").map((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")))
      .find((t) => t.length > 0);
  const robot = () => JSON.parse(readFileSync(join(dir, ROBOT_FILE), "utf8")) as { skill?: string; look: { torso: string | null }; attempt?: { id: string; skill: string; learned: boolean } };
  let closed = false;
  const shut = async () => { if (!closed) { closed = true; await harness.close(ctx); } };
  return { dir, ask, results, robot, lastSaid, page, shut, close: async () => { page.stop(); await shut(); rmSync(dir, { recursive: true, force: true }); } };
}

const walkToFlag: ScriptedTurn[] = [{ call: { name: "do", arguments: { skill: "walk" } } }, { text: "ok" }];

test("before training: \"walk to the flag\" makes the robot try with the untrained brain (not refused), and the answer is the page's measure", async () => {
  const r = await rig(walkToFlag, { outcome: (learned) => (learned ? undefined : { fell: true, distance_m: 0.12, to_flag_m: 2.9, reached_flag: false, seconds: 4 }) });
  try {
    await r.ask("walk to the flag");
    const [res] = await r.results();
    assert.equal(res!.error, false, "the try is not a refusal");
    assert.equal(res!.text, "Not learned yet: the robot tried to walk and fell after 4 s, 0.1 m from where it stood; the flag is still 2.9 m away. teach_skills can teach it to walk.");
    const robot = r.robot();
    assert.equal(robot.attempt?.skill, "walk");
    assert.equal(robot.attempt?.learned, false);
    assert.equal(robot.skill, undefined, "the skill it is doing is left as it was");
  } finally {
    await r.close();
  }
});

test("after training: \"walk to the flag\" walks it and the answer says it reached the flag; asking again is a new request", async () => {
  const r = await rig([...walkToFlag, ...walkToFlag], { skills: ["walk", "spin"], outcome: (learned) => (learned ? { fell: false, distance_m: 2.8, to_flag_m: 0.2, reached_flag: true, seconds: 6.2 } : undefined) });
  try {
    await r.ask("walk to the flag");
    const first = r.robot().attempt!;
    assert.deepEqual([r.robot().skill, first.skill, first.learned], ["walk", "walk", true]);
    await r.ask("walk to the flag again");
    const second = r.robot().attempt!;
    assert.notEqual(second.id, first.id, "a second ask with walk already playing is a new request");
    const res = await r.results();
    for (const x of res) assert.match(x.text, /^The robot is now doing walk\..* It reached the flag in 6\.2 s\.$/);
    assert.equal(r.page.seen.size, 2);
  } finally {
    await r.close();
  }
});

test("the try and then the learned walk, from calls with the same id (the browser's brain names every turn's first call call-0): two requests, each answered from its own report", async () => {
  const walk: ScriptedTurn = { call: { name: "do", arguments: { skill: "walk" }, id: "call-0" } };
  const r = await rig([walk, { text: "ok" }, walk, { text: "ok" }], { outcome: (learned) => (learned ? { fell: false, distance_m: 2.8, to_flag_m: 0.2, reached_flag: true, seconds: 5.4 } : { fell: true, distance_m: 0.6, to_flag_m: 2.6, reached_flag: false, seconds: 4 }) });
  try {
    await r.ask("walk to the flag");
    const tried = r.robot().attempt!;
    // walk comes home
    mkdirSync(join(r.dir, "home"), { recursive: true });
    writeFileSync(join(r.dir, "home/skills.json"), JSON.stringify({ version: 1, default: "walk", skills: { walk: { label: "walk", policy: "skills/walk.json" } } }));
    await r.ask("walk to the flag");
    const walked = r.robot().attempt!;
    assert.notEqual(walked.id, tried.id, "a new request has a new id, whatever the call was named");
    assert.equal(r.page.seen.size, 2, "the page took up both");
    const [first, second] = await r.results();
    assert.match(first!.text, /^Not learned yet: the robot tried to walk and fell after 4 s/);
    assert.match(second!.text, /^The robot is now doing walk\..* It reached the flag in 5\.4 s\.$/, "answered from the walk's own report, not the try's");
  } finally {
    await r.close();
  }
});

test("a page that does not report: the answer says so and claims nothing either way", async () => {
  const r = await rig(walkToFlag, { skills: ["walk"] });
  try {
    await r.ask("walk to the flag");
    const [res] = await r.results();
    assert.ok(res!.text.endsWith(NO_REPORT), res!.text);
    assert.doesNotMatch(res!.text, /reached the flag in/);
  } finally {
    await r.close();
  }
});

test("without a flag, or with the browser's own model driving, do is what it was: a skill not home is refused and nothing is tried", async () => {
  for (const o of [{ scene: false }, { provider: BRAIN_PROVIDER }]) {
    const r = await rig(walkToFlag, { ...o, skills: ["spin"], outcome: () => ({ fell: true, distance_m: 0, to_flag_m: 3, reached_flag: false, seconds: 4 }) });
    try {
      await r.ask("walk to the flag");
      const [res] = await r.results();
      assert.equal(res!.error, true);
      assert.match(res!.text, /^Not done: the robot has not learned walk; it can do spin\./);
      assert.equal(r.page.seen.size, 0, "no request was written");
    } finally {
      await r.close();
    }
  }
});

test("the browser's own model asking for a walk that came home starts the same measured run, and its turn does not wait for the report", async () => {
  const runMs = FLAG_WAIT.runMs;
  FLAG_WAIT.runMs = 30_000;
  const r = await rig(walkToFlag, { provider: BRAIN_PROVIDER, skills: ["walk"] });
  try {
    const t0 = Date.now();
    await r.ask("walk to the flag");
    assert.ok(Date.now() - t0 < 5_000, "no wait for the page");
    const robot = r.robot();
    assert.deepEqual([robot.skill, robot.attempt?.skill, robot.attempt?.learned], ["walk", "walk", true], "the page is asked for the run as the cloud agent asks for it");
    const [res] = await r.results();
    assert.equal(res!.error, false);
    assert.doesNotMatch(res!.text, /flag/);
  } finally {
    FLAG_WAIT.runMs = runMs;
    await r.close();
  }
});

test("other skills with a flag on the floor: one that came home plays where the robot stands, unmeasured; one that did not is refused, not tried", async () => {
  const spin: ScriptedTurn[] = [{ call: { name: "do", arguments: { skill: "spin" } } }, { text: "ok" }, { call: { name: "do", arguments: { skill: "wave" } } }, { text: "ok" }];
  const r = await rig(spin, { skills: ["walk", "spin"], outcome: () => ({ fell: false, distance_m: 0, to_flag_m: 3, reached_flag: false, seconds: 1 }) });
  try {
    await r.ask("make it spin");
    assert.deepEqual([r.robot().skill, r.robot().attempt], ["spin", undefined]);
    await r.ask("make it wave");
    const [spun, waved] = await r.results();
    assert.match(spun!.text, /^The robot is now doing spin\./);
    assert.doesNotMatch(spun!.text, /flag|did not report/);
    assert.equal(waved!.error, true);
    assert.match(waved!.text, /^Not done: the robot has not learned wave/);
    assert.equal(r.page.seen.size, 0, "no request was written");
  } finally {
    await r.close();
  }
});

test("two calls in one turn, \"paint it red and walk to the flag\": the try's request and the colour both land (the try waits its turn to write)", async () => {
  const both: ScriptedTurn[] = [{ calls: [{ name: "set_color", arguments: { part: "torso", color: "red" } }, { name: "do", arguments: { skill: "walk" } }] }, { text: "ok" }];
  const r = await rig(both, { slowWrites: true, outcome: () => ({ fell: true, distance_m: 0.1, to_flag_m: 2.9, reached_flag: false, seconds: 4 }) });
  try {
    await r.ask("paint it red and walk to the flag");
    const robot = r.robot();
    assert.equal(robot.look.torso, "red", "the colour was not lost");
    assert.equal(robot.attempt?.skill, "walk", "the request was not lost");
    assert.equal(r.page.seen.size, 1);
  } finally {
    await r.close();
  }
});

test("a call cancelled while it waits for the page stops waiting: closing the harness does not sit out the wait", async () => {
  const runMs = FLAG_WAIT.runMs;
  FLAG_WAIT.runMs = 30_000;
  const r = await rig(walkToFlag, { skills: ["walk"] });
  try {
    const pending = r.ask("walk to the flag").catch(() => undefined);
    for (let i = 0; i < 100 && !existsSync(join(r.dir, ROBOT_FILE)); i++) await new Promise((res) => setTimeout(res, 20));
    const t0 = Date.now();
    await r.shut();
    await pending;
    assert.ok(Date.now() - t0 < 5_000, `closed in ${Date.now() - t0} ms, not after the 30 s wait`);
  } finally {
    FLAG_WAIT.runMs = runMs;
    await r.close();
  }
});

/** The computer as the wait sees it: reads that find no report, each one cut short when the signal aborts. */
function noReport(signal: AbortSignal): SceneFiles & { reads: number } {
  const files = {
    reads: 0,
    async readTextFile() {
      files.reads++;
      if (signal.aborted) return { ok: false as const, error: { code: "aborted", message: "aborted" } };
      return { ok: false as const, error: { code: "not_found", message: "no report" } };
    },
  };
  return files;
}

test("waitForAttempt: a cancel stops the wait at once and says cancelled, not 'no report'; one already cancelled does not read", async () => {
  const ac = new AbortController();
  const files = noReport(ac.signal);
  setTimeout(() => ac.abort(), 100);
  const t0 = Date.now();
  assert.equal(await waitForAttempt(files, undefined as never, "x", { timeoutMs: 10_000, signal: ac.signal }), "cancelled");
  assert.ok(Date.now() - t0 < 1_000, `stopped after ${Date.now() - t0} ms`);
  const reads = files.reads;
  assert.equal(await waitForAttempt(files, undefined as never, "x", { timeoutMs: 10_000, signal: ac.signal }), "cancelled");
  assert.equal(files.reads, reads, "no read after the cancel");
});

test("a run or a try that starts at the flag says so, and never that it reached it", () => {
  const at = { version: 1 as const, id: "x", skill: "walk", learned: true, fell: false, distance_m: 0.3, to_flag_m: 0.1, reached_flag: false, started_at_flag: true, seconds: 15 };
  assert.equal(runText(at), "It was already at the flag when it started, so it did not reach it: it stopped after 15 s, 0.3 m from where it started.");
  assert.equal(tryText({ ...at, learned: false, fell: true, seconds: 4 }), "Not learned yet: the robot tried to walk and fell after 4 s, 0.3 m from where it stood; it was already at the flag. teach_skills can teach it to walk.");
  assert.equal(runText({ ...at, started_at_flag: false, to_flag_m: 2.7 }), "It stopped after 15 s, 0.3 m from where it started and 2.7 m short of the flag.");
});

test("requestId: the same call id twice gives two ids, each naming the call", () => {
  const [a, b] = [requestId("call-0"), requestId("call-0")];
  assert.notEqual(a, b);
  for (const id of [a, b]) assert.match(id, /^call-0-.{8,}$/);
});

test("the flag reply says what happened to the robot and nothing about files: the session's instructions ask for files only when some changed", async () => {
  // gpt-6-sol in code12, told to say "which files changed" after every request, ended each flag reply with "No files changed."
  // The scripted model does the same unless its instructions, as the request carries them, say not to.
  const seen: string[] = [];
  const reply = (instructions: string) => {
    seen.push(instructions);
    return `Your dinosaur reached the flag in 5.4 seconds!${/never add that no files changed/.test(instructions.replace(/\s+/g, " ")) ? "" : " No files changed."}`;
  };
  setExtraInstructions(ROBOT_CODE_INSTRUCTIONS);
  const r = await rig([{ call: { name: "do", arguments: { skill: "walk" } } }, { reply }], { skills: ["walk"], outcome: () => ({ fell: false, distance_m: 2.8, to_flag_m: 0.2, reached_flag: true, seconds: 5.4 }) });
  try {
    await r.ask("walk to the flag");
    const flat = seen[0]!.replace(/\s+/g, " ");
    assert.match(flat, /Mention files only when you changed some or the user asked about them; never add that no files changed\./, "the base rule is in the flag turn's instructions");
    assert.match(flat, /The look tools and `do` keep the robot's own file: using them is not a file change to mention\./, "and robot.md's line on the robot's own file");
    assert.equal(await r.lastSaid(), "Your dinosaur reached the flag in 5.4 seconds!");
  } finally {
    setExtraInstructions("");
    await r.close();
  }
});
