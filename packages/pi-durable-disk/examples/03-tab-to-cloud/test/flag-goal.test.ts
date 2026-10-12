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
import { agentRegistry, rootAgent } from "../agent.ts";
import { ATTEMPT_FILE, FLAG_WAIT, NO_REPORT, SCENE_FILE } from "../flag-goal.ts";
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

async function rig(script: ScriptedTurn[], o: { scene?: boolean; skills?: string[]; provider?: string; outcome?: (learned: boolean) => Outcome | undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flag-goal-"));
  mkdirSync(join(dir, "creature"), { recursive: true });
  if (o.scene !== false) writeFileSync(join(dir, SCENE_FILE), JSON.stringify({ version: 1, flag: { x: 3, y: 0, radius: 0.4 } }));
  if (o.skills) {
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home/skills.json"), JSON.stringify({ version: 1, default: o.skills[0], skills: Object.fromEntries(o.skills.map((s) => [s, { label: s, policy: `skills/${s}.json` }])) }));
  }
  const env = new NodeExecutionEnv({ cwd: dir, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" } });
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
  const robot = () => JSON.parse(readFileSync(join(dir, ROBOT_FILE), "utf8")) as { skill?: string; attempt?: { id: string; skill: string; learned: boolean } };
  return { ask, results, robot, page, close: async () => { page.stop(); await harness.close(ctx); rmSync(dir, { recursive: true, force: true }); } };
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
