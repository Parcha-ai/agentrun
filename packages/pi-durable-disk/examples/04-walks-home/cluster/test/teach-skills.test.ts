// teach_skills end to end over a real Harness on SQLite, with fake GPU boxes and a scripted model: each case runs
// spike/spike.ts, which SIGKILLs the first host while the parent waits on its threads and finishes in a second one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeBoxEnv } from "../spike/fake-cluster.ts";
import { foldText, SKILLS, skillsToTeach, type ThreadResult } from "../teach-skills.ts";

const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, "..", "spike", "spike.ts");
const host = join(here, "..", "spike", "host.ts");
const spikePlan = join(here, "..", "spike", "spike_plan.ts");

function runPlan(...extra: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "teach-plan-"));
  const r = spawnSync(process.execPath, [spikePlan, "--dir", dir, "--tick", "200", ...extra], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, verdict: JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")) };
}

function runSpike(capacity: number, ...extra: string[]) {
  const dir = mkdtempSync(join(tmpdir(), `teach-skills-${capacity}-`));
  const r = spawnSync(process.execPath, [spike, "--dir", dir, "--tick", "150", "--capacity", String(capacity), ...extra], { encoding: "utf8", timeout: 120_000 });
  const verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
  return { status: r.status, verdict };
}

test("eight threads survive a SIGKILL of the host while the parent waits allSettled, and GPU 3 reads back", () => {
  const { status, verdict } = runSpike(8);
  // The scripted session calls teach_skills({}) for "Teach it to move.": no skills named forks all eight threads.
  assert.equal(verdict.checks.omitted_skills_teach_all_eight, true);
  assert.equal(verdict.checks.passed_skills_are_home, true);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.equal(verdict.peak_boxes, 8);
  assert.match(verdict.ask, /GPU 3 \(backwards\)/);
  // Threads cut off by the kill reran through pi-run, which stopped the earlier run first; finished ones did not rerun.
  const reran = verdict.reruns.filter((r: { runs: string[] }) => r.runs.includes("pi-run.stopped-previous"));
  assert.ok(reran.length >= 1);
  for (const r of reran) assert.deepEqual(r.runs.slice(-2), ["pi-run.stopped-previous", "train.start"]);
});

test("a pool of two boxes queues the threads in acquire and still joins all eight", () => {
  const { status, verdict } = runSpike(2);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.equal(verdict.peak_boxes, 2);
});

test("a replay of a skill that already passed reports that run's checkpoint and seconds, not invented ones", () => {
  const { status, verdict } = runSpike(8, "--done-before", "get-up:4:30");
  assert.equal(verdict.checks["replayed_get-up_reports_its_saved_run"], true);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("finished skills lower the kill point instead of leaving the spike waiting for checkpoints that never come", () => {
  // These three finish before the run starts, leaving 24 checkpoints: more than half of them, but fewer than 30.
  const { status, verdict } = runSpike(8, "--done-before", "backwards:6:30,spin:6:30,get-up:6:30");
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("a spike where every skill is already done is refused at once, not left waiting", () => {
  const dir = mkdtempSync(join(tmpdir(), "teach-skills-none-"));
  const all = ["walk", "sprint", "backwards", "turn-left", "turn-right", "spin", "wave", "get-up"].map((s) => `${s}:3:20`).join(",");
  const r = spawnSync(process.execPath, [spike, "--dir", dir, "--tick", "150", "--done-before", all], { encoding: "utf8", timeout: 30_000 });
  assert.notEqual(r.status, 0);
  assert.equal(r.signal, null, "it exited by itself, not by the test's timeout");
  assert.match(r.stdout + r.stderr, /no thread trains/);
});

test("aborting the run mid-way stops every artifact mirror and gives every box back", () => {
  const dir = mkdtempSync(join(tmpdir(), "teach-skills-abort-"));
  const r = spawnSync(process.execPath, [host, "--dir", dir, "--mode", "abort", "--tick", "150"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(join(dir, "abort-report.json"), "utf8"));
  assert.ok(report.mirrorsBefore > 0, "mirrors were running when the run was aborted");
  assert.equal(report.mirrorsAfter, 0);
  assert.equal(report.teach, "aborted");
  assert.deepEqual(report.tasks_after, []);
  const pool = readFileSync(join(dir, "pool", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(pool.filter((p) => p.event === "pool.release").length, pool.filter((p) => p.event === "pool.create").length);
});

test("a failing assemble is reported in the tool's result and every thread's result is kept", () => {
  const { status, verdict } = runSpike(8, "--assemble-fails");
  assert.equal(verdict.checks.home_failure_reported_with_thread_results_kept, true);
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("a call teaches the skills named, else every skill offered, each once", () => {
  assert.deepEqual(skillsToTeach(undefined, undefined), [...SKILLS]);
  assert.deepEqual(skillsToTeach([], ["walk", "spin"]), ["walk", "spin"]);
  assert.deepEqual(skillsToTeach(undefined, ["walk", "walk", "spin", "walk"]), ["walk", "spin"]);
  assert.deepEqual(skillsToTeach(["spin", "spin"], ["walk"]), ["spin"]);
});

test("code mode: the session plans skills with briefs, each thread writes and runs its own training, survives a SIGKILL", () => {
  const { status, verdict } = runPlan();
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  assert.deepEqual(verdict.threads.map((t: { skill: string; status: string }) => [t.skill, t.status]), [["walk", "passed"], ["spin", "passed"], ["wave", "never-passed"]]);
});

test("code mode: threadsOf lists the run's threads in plan order with their conversations, mid-run and after", () => {
  const { verdict } = runPlan();
  assert.equal(verdict.checks.threads_of_mid_run, true);
  assert.equal(verdict.checks.threads_of_after_the_run, true);
  // Mid-run a fast thread may already have passed; the others are still running.
  assert.deepEqual(verdict.threads_of.mid.map((l: string) => l.split(" ").slice(0, 2).join(" ")), ["1 walk", "2 spin", "3 wave"]);
  for (const l of verdict.threads_of.mid) assert.match(l, / (running|passed)$/);
  assert.deepEqual(verdict.threads_of.after, ["1 walk passed", "2 spin passed", "3 wave never-passed"]);
});

test("code mode: a thread past its deadline is stopped and folds as timed out, the others are kept", () => {
  // walk passes under 1 s after its box (copy, then 3 checkpoints); spin cannot pass before about 2.2 s (a 12M try that is
  // still changing, then 6 checkpoints at 40M): 1.4 s keeps one fast pass and two time-outs.
  const { status, verdict } = runPlan("--deadline-ms", "1400");
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("code mode: a deadline is kept across a restart, so a resumed thread gets no fresh time limit", () => {
  const { status, verdict } = runPlan("--deadline-ms", "1500", "--kill");
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("code mode: an outcome hook that throws is reported in each thread's result, and every box still comes back", () => {
  const { status, verdict } = runPlan("--status-throws");
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
});

test("the fold says which skills came home, or why they could not", () => {
  const t: ThreadResult = { skill: "walk", gpu: 1, conversationId: 3, boxId: "sb-1", status: "passed", checkpoint: 3, seconds: 21, summary: "walk passed." };
  assert.match(foldText([t], { skills: ["walk"] }), /^Home: 1 skill \(walk\)\.$/m);
  assert.match(foldText([t], { error: "assemble-skills exited 1" }), /^Bringing the skills home failed: assemble-skills exited 1$/m);
  assert.doesNotMatch(foldText([t]), /Home:|home failed/);
});

test("the fold names every thread, passed or not, in its own words", () => {
  const threads: ThreadResult[] = [
    { skill: "walk", gpu: 1, conversationId: 3, boxId: "sb-1", status: "passed", checkpoint: 3, seconds: 21, summary: "walk passed at checkpoint 3." },
    { skill: "wave", gpu: 7, conversationId: 9, boxId: "sb-7", status: "never-passed", summary: "wave never passed its test." },
  ];
  assert.equal(
    foldText(threads),
    [
      "2 threads finished: 1 passed, 1 did not.",
      "- GPU 1 · walk: passed at checkpoint 3 in 21 s. walk passed at checkpoint 3.",
      "- GPU 7 · wave: never passed. wave never passed its test.",
      "Each thread's own conversation: read_thread with its skill or GPU number.",
    ].join("\n"),
  );
});

test("train-skill.md copies the library's worked skills from the directories the image really has", () => {
  // The image bakes 04-walks-home/train/skills/ into /opt/pda/train/skills/ (listed on D2's v13 image: getup has no hyphen).
  const sop = readFileSync(join(here, "..", "sop", "train-skill.md"), "utf8").replace(/\s+/g, " "); // as one line: a pair may wrap
  const dirs = readdirSync(join(here, "..", "..", "train", "skills"));
  const named = [...sop.matchAll(/\/opt\/pda\/train\/skills\/([\w-]+)/g)].map((m) => m[1]);
  assert.ok(named.length > 0);
  for (const d of named) assert.ok(dirs.includes(d!), `the SOP copies /opt/pda/train/skills/${d}, which the library does not have`);
  // A new box has no skills/ yet, and cp -r makes only the last directory: every copy command makes it first.
  const copies = [...sop.matchAll(/`([^`]*cp -r \/opt\/pda\/train\/skills\/[^`]*)`/g)].map((m) => m[1]!);
  assert.ok(copies.length > 0);
  for (const c of copies) assert.match(c, /^mkdir -p skills && cp -r /, `the SOP's copy command makes skills/ first: ${c}`);
  for (const dir of dirs) {
    const name = JSON.parse(readFileSync(join(here, "..", "..", "train", "skills", dir, "skill.json"), "utf8")).name as string;
    assert.ok(sop.includes(`${name} \`${dir}/\``), `the SOP gives ${name}'s directory as ${dir}/`);
  }
});

test("on a new box a bare cp into skills/ fails as cp does, and the SOP's own copy command succeeds", async () => {
  // The SOP's copy commands as written (with the placeholders filled), run on fresh fake boxes; nothing runs on this machine.
  const sop = readFileSync(join(here, "..", "sop", "train-skill.md"), "utf8").replace(/\s+/g, " ");
  const generic = [...sop.matchAll(/`(mkdir -p skills && cp -r \/opt\/pda\/train\/skills\/<its directory> skills\/<your skill>)`/g)].map((m) => m[1]!)[0];
  const getUp = [...sop.matchAll(/`(mkdir -p skills && cp -r \/opt\/pda\/train\/skills\/getup skills\/get-up)`/g)].map((m) => m[1]!)[0];
  assert.ok(generic && getUp, "the SOP has the generic and the get-up copy commands");
  const run = async (command: string) => {
    const dir = mkdtempSync(join(tmpdir(), "teach-box-"));
    const box = new FakeBoxEnv("sb-test", dir, 10);
    let out = "";
    const r = (await box.exec(command, { onOutput: (text: string) => (out += text) } as never, {} as never)) as { ok: boolean; value?: { exitCode: number } };
    return { exitCode: r.ok ? r.value!.exitCode : -1, out, skillJson: (skill: string) => JSON.parse(readFileSync(join(dir, "workspace", "skills", skill, "skill.json"), "utf8")) as { name: string } };
  };
  // The fumble code4 showed: skills/ does not exist yet, cp -r makes only the last directory.
  const bare = await run("cp -r /opt/pda/train/skills/walk skills/walk");
  assert.equal(bare.exitCode, 1);
  assert.match(bare.out, /cp: cannot create directory 'skills\/walk': No such file or directory/);
  // The SOP's command makes skills/ first and copies the worked skill under the thread's skill name.
  const walk = await run(generic.replace("<its directory>", "walk").replace("<your skill>", "walk"));
  assert.equal(walk.exitCode, 0, walk.out);
  assert.equal(walk.skillJson("walk").name, "walk");
  const getup = await run(getUp);
  assert.equal(getup.exitCode, 0, getup.out);
  assert.equal(getup.skillJson("get-up").name, "get-up", "getup/ holds get-up's skill");
});

test("code mode: a skill the library lacks is made from its closest library skill by copy and small edits, not a fresh file tree", () => {
  const { status, verdict } = runPlan("--new-skill");
  for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, name);
  assert.equal(status, 0);
  // bow: the library's real wave copied, its skill.json and test.py edited, one reward.py added, compiled, trained, checked.
  assert.deepEqual(verdict.ladder.bow, ["copy", "edit:skill.json", "edit:test.py", "edit:reward.py", "compile", "12M", "check"]);
  assert.equal(verdict.checks.new_skill_files_are_the_skill, true, "the files on the box are the SOP's change on wave's real files");
  const bow = verdict.tools.find((t: { skill: string }) => t.skill === "bow").tools as string[];
  assert.equal(bow[0], "bash", "the first step is the copy");
  assert.equal(bow.filter((t) => t === "write").length, 1, "one new file (reward.py); skill.json and test.py come from the copy");
});

test("code mode: the new-skill plan's outcomes follow the outcome flags (a throwing status hook, a deadline), its setup checks hold under each", () => {
  for (const flags of [["--new-skill", "--status-throws"], ["--new-skill", "--deadline-ms", "1400"]]) {
    const { status, verdict } = runPlan(...flags);
    for (const [name, passed] of Object.entries(verdict.checks)) assert.equal(passed, true, `${flags.join(" ")}: ${name}`);
    assert.equal(status, 0);
  }
});

test("the fake box copies the library's real files, and its trainer refuses a copy left unchanged or a reward term without a weight or with a built-in name", async () => {
  const { FakeBoxEnv } = await import("../spike/fake-cluster.ts");
  const run = async (commands: string[], files: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "teach-box-"));
    const box = new FakeBoxEnv("sb-test", dir, 10);
    let out = "";
    let code = 0;
    for (const c of commands) {
      if (c === "WRITE") {
        for (const [p, t] of Object.entries(files)) writeFileSync(join(dir, "workspace", p), t);
        continue;
      }
      const r = (await box.exec(c, { onOutput: (t: string) => (out += t) } as never, {} as never)) as { ok: boolean; value?: { exitCode: number } };
      code = r.ok ? r.value!.exitCode : -1;
      if (code !== 0) break;
    }
    return { code, out, file: (p: string) => readFileSync(join(dir, "workspace", p), "utf8") };
  };
  const compile = "pi-run bow -- train-skill --skill-dir /workspace/skills/bow --body /workspace/robot --out /workspace/runs/bow --init-from '' --compile-only";
  const copy = "mkdir -p skills && cp -r /opt/pda/train/skills/wave skills/bow";
  const real = await run([copy]);
  assert.equal(real.file("skills/bow/skill.json"), readFileSync(join(here, "..", "..", "train", "skills", "wave", "skill.json"), "utf8"), "the copy is the library's own wave");
  assert.equal((await run([copy, compile])).code, 2, "a copy still named wave is refused");
  const renamed = (scales: string) => real.file("skills/bow/skill.json").replace('"name": "wave"', '"name": "bow"').replace('"feet_height": -30.0,', scales);
  const unweighted = await run([copy, "WRITE", compile], { "skills/bow/skill.json": renamed('"feet_height": 0.0,'), "skills/bow/reward.py": 'def terms(s):\n    return {"bow_pitch": s.pitch}\n' });
  assert.equal(unweighted.code, 1);
  assert.match(unweighted.out, /bow_pitch has no weight in skill\.json's reward_scales/);
  const builtin = await run([copy, "WRITE", compile], { "skills/bow/skill.json": renamed('"feet_height": 0.0,'), "skills/bow/reward.py": 'def terms(s):\n    return {"pose": s.pitch}\n' });
  assert.match(builtin.out, /pose reuses a built-in name/);
  const right = await run([copy, "WRITE", compile], { "skills/bow/skill.json": renamed('"feet_height": 0.0,\n  "bow_pitch": 3.0,'), "skills/bow/reward.py": 'def terms(s):\n    return {"bow_pitch": s.pitch}\n' });
  assert.equal(right.code, 0, right.out);
});

test("train-skill.md starts a skill the library lacks from its closest library skill, with the edits it takes", () => {
  const sop = readFileSync(join(here, "..", "sop", "train-skill.md"), "utf8").replace(/\s+/g, " ");
  assert.match(sop, /Not in the library\? Start from the closest library skill, never from an empty directory\./);
  assert.match(sop, /`mkdir -p skills && cp -r \/opt\/pda\/train\/skills\/<closest> skills\/<your skill>`/);
  assert.match(sop, /The trainer names parts by MuJoCo name, never by tag/);
  // The body can only make the motions its joints' axes allow (tails and necks pitch): check first, never a stand-in.
  assert.match(sop, /A joint turns about its axis: `\[0, 1, 0\]` pitches \(up and down, a nod\), `\[0, 0, 1\]` yaws \(side to side\)/);
  assert.match(sop, /do not train a stand-in: report that this body cannot make it/);
  assert.match(sop, /down = r\.share\(r\.pitch < -0\.25, after_s=2\)/, "the example is a pitch posture (a bow)");
  assert.doesNotMatch(sop, /tail_wag|swings >= 8/, "no side-to-side wag template");
  assert.match(sop, /That is the whole change: one skill\.json edit, one test\.py edit and a small reward\.py\./);
  assert.doesNotMatch(sop, /write it from the closest example/, "the old from-scratch wording is gone");
});

test("teach.md plans walk and the turns for \"move\", and get-up only for a body with a motor that swings a leg sideways", async () => {
  const { copyFileSync, mkdirSync } = await import("node:fs");
  const teach = readFileSync(join(here, "..", "sop", "teach.md"), "utf8");
  const flat = teach.replace(/\s+/g, " ");
  assert.match(flat, /"Teach it to move" means: walk, turn-left and turn-right\. Add backwards or sprint if the body looks able to\./);
  assert.match(flat, /Plan get-up only if a motor can swing a leg sideways/);
  assert.doesNotMatch(flat, /and getting up after a fall/, "get-up is no longer in the default plan for move");
  // The check the planner runs, as teach.md writes it, on bodies built by D3's own lib and build script.
  const check = /`(node -e '[^`]*robot\/body\.json[^`]*')`/.exec(teach)?.[1];
  assert.ok(check, "teach.md gives the check");
  const body = join(here, "..", "..", "body");
  const built = (example: string, edit = (s: string) => s) => {
    const dir = mkdtempSync(join(tmpdir(), "teach-body-"));
    mkdirSync(join(dir, "robot"));
    for (const f of ["lib.mjs", "build.mjs"]) copyFileSync(join(body, f), join(dir, "robot", f));
    writeFileSync(join(dir, "robot", "body.mjs"), edit(readFileSync(join(body, example), "utf8")));
    const b = spawnSync(process.execPath, ["robot/build.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
    const r = spawnSync("bash", ["-c", check!], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  // The dinosaur (code5's skeleton): every motor on [0, 1, 0], so no get-up.
  assert.equal(built("dino.example.mjs"), "no sideways motors");
  // A dog whose hips swing sideways ([1, 0, 0]) can roll over: the check names those motors.
  // The dog's hip turned to swing sideways; the edit must take, whatever else its joint line carries (strength, a comment).
  const sidewaysHip = (s: string) => {
    const t = s.replace(/axis: \[0, 1, 0\], range: \[-1, 1\], stand: -0\.45/, "axis: [1, 0, 0], range: [-0.5, 0.5], stand: 0");
    assert.notEqual(t, s, "the dog's hip joint was found and turned sideways");
    return t;
  };
  const sideways = built("dog.example.mjs", sidewaysHip);
  assert.match(sideways, /^sideways motors: leg_front_j/);
});
