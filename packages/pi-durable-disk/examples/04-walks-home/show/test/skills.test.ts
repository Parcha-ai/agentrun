import assert from "node:assert/strict";
import { test } from "node:test";
import { SKILLS, parseSkillJson, parseSkillProgress, skillEvents } from "../skills.ts";
import { SkillsPoller } from "../page/skills-poller.ts";
import { emptyState, fold } from "../reduce.ts";
import type { ShowEvent } from "../types.ts";

// D2's per-skill files (image v7+): each GPU box writes /workspace/skills/<skill>/, mirrored to work/skills/<skill>/ on the run's disk: skill-progress.jsonl (a line per checkpoint, appended as each
// lands) and skill.json (written at the start, rewritten at the end: status training | done | failed). Every number is a physical one a viewer can follow; there is no reward or loss.
const SPIN5 = { checkpoint: 5, steps: 3932160, t: 44.2, passes: true, metric: { name: "spin rate", value: 1.344, unit: "rad/s", target: ">= 1.0" }, along_mps: 0.005, total_mps: 0.005, yaw_rate: 1.344, pitch_mean: -1.5, min_up: 1.0, fell_at: null, paw_up_share: 0.0 };
const SPIN4 = { ...SPIN5, checkpoint: 4, steps: 3145728, t: 36.1, passes: false, metric: { ...SPIN5.metric, value: 0.7 } };
const lines = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("the skills are D2's eight, in the order of her table", () => {
  assert.deepEqual(SKILLS, ["walk", "sprint", "backwards", "turn-left", "turn-right", "spin", "wave", "get-up"]);
});

test("progress lines: the checkpoint, its metric with unit and target, whether it passes, and when it fell; a line that is not understood is counted and skipped", () => {
  const { points, skipped } = parseSkillProgress(lines(SPIN4, SPIN5) + "not json\n{\"checkpoint\":\"x\"}\n\n");
  assert.equal(skipped, 2);
  assert.deepEqual(points.map((p) => [p.checkpoint, p.passes, p.metric?.name, p.metric?.value, p.metric?.unit, p.metric?.target, p.seconds]), [[4, false, "spin rate", 0.7, "rad/s", ">= 1.0", 36.1], [5, true, "spin rate", 1.344, "rad/s", ">= 1.0", 44.2]]);
  assert.equal(points[0]!.fell, false);
  // A checkpoint that fell in its 10 s test never passes; get-up's value is null until all three recoveries succeed.
  const fell = parseSkillProgress(lines({ checkpoint: 1, t: 12, passes: false, metric: { name: "slowest get-up", value: null, unit: "s", target: "rights itself from left, right and back" }, fell_at: 6.5 })).points[0]!;
  assert.deepEqual([fell.fell, fell.metric?.value, fell.passes], [true, null, false]);
  assert.equal(parseSkillProgress("").points.length, 0);
});

test("skill.json: the label, the status, and the first passing checkpoint; anything else is nothing", () => {
  const j = parseSkillJson(JSON.stringify({ skill: "spin", label: "spin in place", command: [0, 0, 1], mjcf_sha256: "ab", joints: 12, status: "done", passed_at: SPIN5, wall_s: 61.3 }))!;
  assert.deepEqual([j.skill, j.label, j.status, j.wallS, j.passedAt?.checkpoint], ["spin", "spin in place", "done", 61.3, 5]);
  assert.equal(parseSkillJson(JSON.stringify({ skill: "spin", status: "training" }))!.label, null);
  assert.equal(parseSkillJson(JSON.stringify({ skill: "spin", status: "exploded" })), null);
  assert.equal(parseSkillJson("not json"), null);
  assert.equal(parseSkillJson(JSON.stringify([])), null);
});

test("events from a skill's files: a thread patch for what changed, then only the checkpoints after the last one said", () => {
  const first = skillEvents("spin", parseSkillJson(JSON.stringify({ skill: "spin", label: "spin in place", status: "training" })), parseSkillProgress(lines(SPIN4)).points, 100, 0);
  assert.deepEqual(first.map((e) => e.t), ["thread", "thread.point"]);
  assert.deepEqual((first[0] as Extract<ShowEvent, { t: "thread" }>).patch, { skill: "spin in place", status: "learning", metric: "spin rate", unit: "rad/s", target: ">= 1.0" });
  const p = first[1] as Extract<ShowEvent, { t: "thread.point" }>;
  assert.deepEqual([p.id, p.n, p.value, p.unit, p.passes, p.fell, p.seconds], ["spin", 4, 0.7, "rad/s", false, false, 36.1]);
  // Later: checkpoint 5 only, and the skill is done.
  const next = skillEvents("spin", parseSkillJson(JSON.stringify({ skill: "spin", label: "spin in place", status: "done", wall_s: 61.3 })), parseSkillProgress(lines(SPIN4, SPIN5)).points, 200, 4);
  assert.deepEqual(next.map((e) => e.t), ["thread", "thread.point"]);
  assert.equal((next[0] as Extract<ShowEvent, { t: "thread" }>).patch.status, "done");
  assert.equal((next[1] as Extract<ShowEvent, { t: "thread.point" }>).n, 5);
  // Nothing new says nothing.
  assert.deepEqual(skillEvents("spin", null, [], 300, 0), []);
  // The dir name stands in for a label the file did not give; progress alone (no skill.json yet) is a skill that is learning.
  const bare = skillEvents("walk", null, parseSkillProgress(lines({ ...SPIN4, metric: { name: "speed", value: 0.5, unit: "m/s", target: ">= 0.4" } })).points, 1, 0);
  assert.deepEqual((bare[0] as Extract<ShowEvent, { t: "thread" }>).patch, { skill: "walk", status: "learning", metric: "speed", unit: "m/s", target: ">= 0.4" });
});

test("the poller reads each skill's two files once per tick, says what is new, and says it once; a missing file (204) is nothing", async () => {
  const files = new Map<string, string>();
  const asked: string[] = [];
  const emitted: ShowEvent[] = [];
  const poller = new SkillsPoller({
    read: async (path) => {
      asked.push(path);
      return files.get(path);
    },
    emit: (e) => emitted.push(e),
    now: () => 500,
    skills: ["spin", "walk"],
  });
  await poller.tick();
  assert.deepEqual(asked, ["skills/spin/skill.json", "skills/spin/skill-progress.jsonl", "skills/walk/skill.json", "skills/walk/skill-progress.jsonl"]);
  assert.equal(emitted.length, 0);
  files.set("skills/spin/skill.json", JSON.stringify({ skill: "spin", label: "spin", status: "training" }));
  files.set("skills/spin/skill-progress.jsonl", lines(SPIN4));
  await poller.tick();
  assert.deepEqual(emitted.map((e) => e.t), ["thread", "thread.point"]);
  await poller.tick();
  assert.equal(emitted.length, 2, "nothing changed: nothing said again");
  files.set("skills/spin/skill-progress.jsonl", lines(SPIN4, SPIN5));
  files.set("skills/spin/skill.json", JSON.stringify({ skill: "spin", label: "spin", status: "done" }));
  await poller.tick();
  assert.deepEqual(emitted.slice(2).map((e) => e.t), ["thread", "thread.point"]);
  const s = fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [] }, ...emitted]);
  assert.deepEqual(s.threads.map((t) => [t.id, t.status, t.points.length]), [["spin", "done", 2]]);
  // A new run (the feed started over): everything is said again.
  poller.reset();
  await poller.tick();
  assert.ok(emitted.length > 4);
  assert.equal(emptyState().threads.length, 0);
});
