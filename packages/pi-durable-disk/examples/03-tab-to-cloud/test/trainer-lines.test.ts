import assert from "node:assert/strict";
import { test } from "node:test";
import { humanizeOutput, trainerLine } from "../tab/trainer-lines.ts";

// The trainer (04-walks-home/train/train_skill.py, pi-run) prints one JSON object per line, each with an `event`. The known ones read as quiet lines; anything else stays as it was. Shapes are the trainer's own
// (the lines below are what it printed in D4's code4 run and what skill-progress.jsonl holds).
const START = { event: "skill.start", skill: "walk", label: "walk", command: 0.5, skill_dir: "/workspace/skills/walk", skill_sha256: "ed7b1ba3", mjcf_sha256: "fbd67cbc414e175fccb7a21706a499a0a1a7f87aac392eef0e1d0e444744f374", joints: 8, status: "training", init_from: "", started_at: 1791798913.1288712, host: "modal", body_name: null };
const CKPT = { event: "skill.checkpoint", skill: "wave", checkpoint: 5, steps: 3932160, t: 38.6, passes: false, metric: { name: "paw up", value: 0.0, unit: "share of time", target: ">= 0.6" }, along_mps: 0.002, fell_at: null };

test("each known trainer event is one quiet line, from its typed fields", () => {
  assert.equal(trainerLine(START), "start · walk · 8 joints");
  assert.equal(trainerLine({ event: "skill.waiting-for-compile", cache: "/root/.cache/pda-skill/body-fbd.tar.gz" }), "compiling the body…");
  assert.equal(trainerLine({ event: "skill.compile-ready", waited_s: 28.8, finished: true }), "compiled · ready in 28.8 s");
  assert.equal(trainerLine({ event: "skill.compile-ready", waited_s: 30, finished: false }), "compile not finished after 30 s");
  assert.equal(trainerLine({ event: "train.start", universe: "walk", generation: 1, impl: "warp", device: "cuda:0", remaining: 12288000, restore: null, compile_cache: "run" }), "training 12M steps on cuda:0");
  assert.equal(trainerLine({ event: "train.start", device: "cuda:0", remaining: 3000000, restore: "ckpt-4" }), "training 3M steps on cuda:0 · resuming from ckpt-4");
  assert.equal(trainerLine(CKPT), "checkpoint 5 · paw up 0 share of time (target ≥ 0.6) · not yet · 38.6 s");
  assert.equal(trainerLine({ ...CKPT, passes: true, metric: { name: "speed", value: 0.62, unit: "m/s", target: ">= 0.4" } }), "checkpoint 5 · speed 0.62 m/s (target ≥ 0.4) · ✓ passes · 38.6 s");
  assert.equal(trainerLine({ ...CKPT, passes: false, fell_at: 3.2 }), "checkpoint 5 · fell in its test · 38.6 s");
  assert.equal(trainerLine({ event: "skill.test-error", checkpoint: 6, error: "ValueError: bad reward\nmore" }), "checkpoint 6 · its test raised: ValueError: bad reward");
  assert.equal(trainerLine({ event: "train.diverged", steps: 900000, error: "nan loss" }), "diverged at 900000 steps: nan loss");
  assert.equal(trainerLine({ event: "skill.done", status: "done", passed_at: { checkpoint: 3, steps: 1, t: 40 }, wall_s: 90.7 }), "done · passed at checkpoint 3 · 90.7 s");
  assert.equal(trainerLine({ event: "skill.done", status: "failed", passed_at: null, wall_s: 120, diagnosis: "the robot falls over before it can turn" }), "failed · never passed · 120 s · the robot falls over before it can turn");
  assert.equal(trainerLine({ event: "skill.refused", why: "the body has no legs" }), "refused: the body has no legs");
  // `train-skill --check <policy>`: the skill's own test run once on a finished policy (train_skill.py)
  assert.equal(trainerLine({ event: "skill.check", policy: "/workspace/runs/walk/policy.json", passes: true, metric: { name: "speed", value: 0.481, unit: "m/s", target: ">= 0.4" } }), "check · speed 0.48 m/s (target ≥ 0.4) · ✓ passes");
  assert.equal(trainerLine({ event: "skill.check", policy: "p", passes: false, metric: { name: "speed", value: 0.1, unit: "m/s", target: ">= 0.4" } }), "check · speed 0.1 m/s (target ≥ 0.4) · not yet");
  assert.equal(trainerLine({ event: "skill.check", policy: "p", passes: false, error: "the policy was trained for another body" }), "check · did not pass · the policy was trained for another body");
  assert.equal(trainerLine({ event: "skill.check", policy: "p" }), null, "no verdict and no error: nothing to say");
});

test("an event it does not know, or a known one with the wrong field types, is not guessed at", () => {
  assert.equal(trainerLine({ event: "box.warm", skill: "walk", ok: true }), null);
  assert.equal(trainerLine({ event: "skill.checkpoint", skill: "walk" }), null, "no checkpoint number: nothing to say");
  assert.equal(trainerLine({ event: "train.start", device: 5, remaining: "lots" }), null);
  assert.equal(trainerLine({ event: "skill.compile-ready", waited_s: 30, finished: "false" }), null, "finished must be a boolean: a string is not success");
  assert.equal(trainerLine({ event: "skill.compile-ready", waited_s: 30 }), null, "no finished at all: nothing to say");
  assert.equal(trainerLine({ nothing: 1 }), null);
  assert.equal(trainerLine(null), null);
});

test("an output is read line by line: trainer events become quiet lines, other lines stay as they were, and it says how many it understood", () => {
  const out = [
    "cp: cannot create directory '/workspace/skills/walk': No such file or directory",
    JSON.stringify(START),
    JSON.stringify({ event: "skill.waiting-for-compile", cache: "/root/x" }),
    "this line is not json",
    JSON.stringify({ event: "skill.compile-ready", waited_s: 28.8, finished: true }),
    JSON.stringify({ event: "box.warm", ok: true }),
    JSON.stringify(CKPT),
  ].join("\n");
  const h = humanizeOutput(out);
  assert.equal(h.recognized, 4);
  assert.deepEqual(h.lines.map((l) => [l.kind, l.text]), [
    ["plain", "cp: cannot create directory '/workspace/skills/walk': No such file or directory"],
    ["event", "start · walk · 8 joints"],
    ["event", "compiling the body…"],
    ["plain", "this line is not json"],
    ["event", "compiled · ready in 28.8 s"],
    ["plain", JSON.stringify({ event: "box.warm", ok: true })],
    ["event", "checkpoint 5 · paw up 0 share of time (target ≥ 0.6) · not yet · 38.6 s"],
  ]);
  assert.equal(humanizeOutput("ls -la\ntotal 4").recognized, 0, "an ordinary command's output has nothing to humanize");
  const check = humanizeOutput(JSON.stringify({ event: "skill.check", policy: "p", passes: true, metric: { name: "speed", value: 0.5, unit: "m/s", target: ">= 0.4" } })).lines[0]!;
  assert.equal(check.kind, "pass", "a passing check is green like a passing checkpoint");
  const pass = humanizeOutput(JSON.stringify({ ...CKPT, passes: true, metric: { name: "speed", value: 0.62, unit: "m/s", target: ">= 0.4" } })).lines[0]!;
  assert.equal(pass.kind, "pass", "a passing checkpoint is marked so the page can colour it");
});
