import assert from "node:assert/strict";
import { test } from "node:test";
import { SKILLS, parseSkillJson, parseSkillProgress } from "../skills.ts";
import { ScenarioThreads } from "../threads-scenario.ts";

// The rehearsal of the cluster beat: the agent splits into 8 threads on 8 GPUs, each box writes D2's per-skill files (served here from the script's clock, as the disk would), and the run comes
// home. Its numbers follow D2's typical timing and are SCRIPTED: the stage says so (a scripted feed never claims a measurement).
const text = (sc: ScenarioThreads, key: string) => {
  const b = sc.file(key);
  return b ? new TextDecoder().decode(b) : undefined;
};

test("nothing on the disk before the threads start; then each skill's files grow as its checkpoints land, and end with status done", () => {
  const sc = new ScenarioThreads({ origin: 0 });
  sc.begin();
  assert.equal(text(sc, "skills/walk/skill.json"), undefined);
  sc.advance(40_000);
  const walk = parseSkillJson(text(sc, "skills/walk/skill.json")!)!;
  assert.equal(walk.skill, "walk");
  const lines = parseSkillProgress(text(sc, "skills/walk/skill-progress.jsonl")!).points;
  assert.ok(lines.length >= 1);
  assert.equal(lines[0]!.metric?.name, "speed");
  assert.equal(lines[0]!.metric?.unit, "m/s");
  assert.equal(lines[0]!.passes, true, "D2: walk passes at checkpoint 1");
  const wave40 = parseSkillProgress(text(sc, "skills/wave/skill-progress.jsonl") ?? "").points;
  assert.ok(wave40.every((p) => p.passes === false), "wave needs 9 checkpoints, not yet");
  sc.advance(200_000);
  for (const dir of SKILLS) {
    const j = parseSkillJson(text(sc, `skills/${dir}/skill.json`)!)!;
    assert.equal(j.status, "done", dir);
    const pts = parseSkillProgress(text(sc, `skills/${dir}/skill-progress.jsonl`)!).points;
    assert.deepEqual(pts.map((p) => p.checkpoint), pts.map((_, i) => i + 1), `${dir}: checkpoints in order`);
    assert.equal(pts.filter((p) => p.passes).length, 3, `${dir}: every trainer stops 2 checkpoints after its first pass`);
  }
  assert.equal(parseSkillProgress(text(sc, "skills/wave/skill-progress.jsonl")!).points.findIndex((p) => p.passes) + 1, 9);
  assert.equal(parseSkillProgress(text(sc, "skills/spin/skill-progress.jsonl")!).points.findIndex((p) => p.passes) + 1, 5);
  assert.equal(parseSkillProgress(text(sc, "skills/turn-left/skill-progress.jsonl")!).points.findIndex((p) => p.passes) + 1, 3);
});

test("the directions: backwards and turn-right pass below their target, get-up has no value until it succeeds", () => {
  const sc = new ScenarioThreads({ origin: 0 });
  sc.begin();
  sc.advance(200_000);
  const back = parseSkillProgress(text(sc, "skills/backwards/skill-progress.jsonl")!).points;
  assert.ok(back.at(-1)!.metric!.value! <= -0.25 && back.at(-1)!.passes === true);
  assert.ok(back[0]!.metric!.value! > -0.25 && back[0]!.passes === false);
  const tr = parseSkillProgress(text(sc, "skills/turn-right/skill-progress.jsonl")!).points;
  assert.ok(tr.at(-1)!.metric!.value! <= -0.6);
  const up = parseSkillProgress(text(sc, "skills/get-up/skill-progress.jsonl")!).points;
  assert.equal(up[0]!.metric!.value, null);
  assert.equal(up.at(-1)!.metric!.unit, "s");
  assert.ok(up.at(-1)!.metric!.value! > 0);
});

test("the script says where it runs: eight threads each with its GPU and a measured-looking acquire time (scripted), the run on the GPU while they learn, and home at the end", () => {
  const sc = new ScenarioThreads({ origin: 0 });
  sc.begin();
  sc.advance(200_000);
  const st = sc.state;
  assert.equal(st.source, "scripted");
  assert.deepEqual(st.threads.map((t) => t.id), [...SKILLS]);
  assert.deepEqual(st.threads.map((t) => t.host), SKILLS.map((_, i) => `H100 #${i + 1}`));
  assert.ok(st.threads.every((t) => t.acquireMs !== null && t.acquireMs > 1000 && t.acquireMs < 4000));
  const places = sc.events.filter((e) => e.t === "place").map((e) => (e.t === "place" ? e.place.where : ""));
  assert.deepEqual(places, ["tab", "moving", "cloud", "moving", "home"]);
  assert.equal(st.place.where, "home");
});

test("the relearn rehearsal: the skills are for a new body (spider) and the robot's home body is another; each skill.json carries D2's fields (body, started_at, passed_at, wall_s, a CPU estimate)", () => {
  const sc = new ScenarioThreads({ origin: 0, relearn: true });
  sc.begin();
  sc.advance(200_000);
  const home = JSON.parse(text(sc, "home/skills.json")!);
  const walk = JSON.parse(text(sc, "skills/walk/skill.json")!);
  assert.notEqual(home.body_mjcf_sha256, walk.mjcf_sha256, "a relearn: the skills are not for the robot's home body");
  assert.equal(walk.body_name, "spider");
  assert.equal(walk.status, "done");
  assert.ok(typeof walk.started_at === "number" && walk.passed_at.passes === true && walk.wall_s > walk.passed_at.t);
  assert.ok(walk.cpu_estimate_s > 0 && /Xeon/.test(walk.cpu_estimate.cores));
  const plain = new ScenarioThreads({ origin: 0 });
  plain.begin();
  plain.advance(200_000);
  assert.equal(JSON.parse(text(plain, "home/skills.json")!).body_mjcf_sha256, JSON.parse(text(plain, "skills/walk/skill.json")!).mjcf_sha256, "without the option the skills are for the robot's own body");
  assert.equal(text(new ScenarioThreads({ origin: 0 }), "home/skills.json"), undefined, "nothing on the disk before the run starts");
});
