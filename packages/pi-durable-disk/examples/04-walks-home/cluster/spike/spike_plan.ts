// Code mode end to end: the session plans three skills with briefs, and each thread writes a reward and trains with its
// coding tools (write, bash) on its own box. The first host is SIGKILLed while the threads train and a second one
// resumes; with --deadline-ms the run goes in one process and slow threads must fold as timed out.
//
//   node spike_plan.ts [--tick 200] [--deadline-ms N] [--dir DIR]
// Prints a JSON verdict (also DIR/verdict.json); exits 1 if a check fails.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { tick: { type: "string", default: "200" }, "deadline-ms": { type: "string" }, dir: { type: "string" }, kill: { type: "boolean", default: false }, "status-throws": { type: "boolean", default: false }, "new-skill": { type: "boolean", default: false }, unmeasured: { type: "boolean", default: false } } });
const dir = a.dir ?? mkdtempSync(join(tmpdir(), "teach-plan-"));
const host = join(dirname(fileURLToPath(import.meta.url)), "host.ts");
const deadline = a["deadline-ms"];
// With --deadline-ms the run goes in one process, unless --kill: then the host dies before the deadline and the second one
// starts after it has passed, so the deadline must come from the store, not a fresh clock.
const kill = !deadline || a.kill;
const run = (mode: string) =>
  spawn(process.execPath, [host, "--dir", dir, "--mode", mode, "--tick", a.tick!, "--plan", ...(deadline ? ["--deadline-ms", deadline] : []), ...(a["status-throws"] ? ["--status-throws"] : []), ...(a["new-skill"] ? ["--new-skill"] : []), ...(a.unmeasured ? ["--unmeasured"] : [])], { stdio: ["ignore", "inherit", "inherit"] });
const exit = (p: ReturnType<typeof run>) => new Promise<number>((r) => p.once("exit", (c) => r(c ?? 1)));

let killed = false;
const t0 = Date.now();
if (kill && !a["status-throws"]) {
  const first = run("first");
  while (!existsSync(join(dir, "mid.json"))) {
    if (first.exitCode !== null) throw new Error(`the first host exited early (${first.exitCode})`);
    await new Promise((r) => setTimeout(r, 25));
  }
  first.kill("SIGKILL");
  await new Promise((r) => first.once("exit", r));
  killed = true;
  if (deadline) await new Promise((r) => setTimeout(r, Math.max(0, t0 + Number(deadline) + 400 - Date.now()))); // resume after it passed
}
const code = await exit(run("resume"));
if (code !== 0) throw new Error(`the host failed (${code})`);
const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
const before = existsSync(join(dir, "before-resume.json")) ? JSON.parse(readFileSync(join(dir, "before-resume.json"), "utf8")) : [];
const pool = readFileSync(join(dir, "pool", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const threads: { skill: string; status: string; checkpoint?: number; summary: string; reason?: string }[] = report.teachResult?.details?.threads ?? [];
const by = (s: string) => threads.find((t) => t.skill === s);
const teachBefore = before.find((t: { kind: string }) => t.kind === "robot.teach-skills");
const children: { id: number; tools: string[]; box: { skill: string; gpu: number }; parent?: unknown; owner?: unknown }[] = report.children;
// threadsOf, as a viewer reads it: mid-run (the first host, at the kill point) and after the run.
type Listed = { conversation: number; name: string; gpu: number; of: number; boxId: string | null; status: string; settled: boolean };
const mid: Listed[] | undefined = existsSync(join(dir, "mid.json")) ? JSON.parse(readFileSync(join(dir, "mid.json"), "utf8")).threads : undefined;
const after: Listed[] = report.threads_of ?? [];
// --new-skill: the third skill is one the library does not have (bow), made from its closest library skill (wave).
const NEW_SKILL = a["new-skill"] ? "bow" : undefined;
// --unmeasured: the third is get-up, which the trainer finds never happened on this body (no retry, a report).
const third = NEW_SKILL ?? (a.unmeasured ? "get-up" : "wave");
const planned = ["walk", "spin", third];
// What each thread ran on its box, as TRAIN_SOP's steps (a command rerun after the restart counts once).
const ladder: Record<string, string[]> = {};
for (const b of existsSync(join(dir, "boxes")) ? readdirSync(join(dir, "boxes")) : []) {
  const log = join(dir, "boxes", b, "exec.log");
  if (!existsSync(log)) continue;
  for (const line of readFileSync(log, "utf8").trim().split("\n")) {
    const command = JSON.parse(line) as unknown;
    const wrote = (command as { write?: string } | null)?.write;
    if (typeof wrote === "string") {
      // A file the thread's coding tools wrote or edited: skills/<skill>/<file>.
      const m = /^skills\/([\w-]+)\/(.+)$/.exec(wrote);
      if (m) (ladder[m[1]!] ??= []).push(`edit:${m[2]}`);
      continue;
    }
    if (typeof command !== "string") continue;
    const copied = /(?:^|&& )cp -r \/opt\/pda\/train\/skills\/[\w-]+ skills\/([\w-]+)/.exec(command)?.[1];
    const skill = copied ?? /^pi-run ([\w-]+) -- train-skill/.exec(command)?.[1];
    const step = copied ? "copy" : /--compile-only/.test(command) ? "compile" : /--check /.test(command) ? "check" : /--steps (\d+M)/.exec(command)?.[1];
    if (!skill || !step) continue;
    const steps = (ladder[skill] ??= []);
    if (steps[steps.length - 1] !== step) steps.push(step);
  }
}
const sameThreads = (l: Listed[]) =>
  l.map((t) => t.name).join() === planned.join() &&
  l.every((t, i) => t.gpu === i + 1 && t.of === 3) &&
  l.map((t) => t.conversation).join() === [...children].sort((x, y) => x.box.gpu - y.box.gpu).map((c) => c.id).join();

const checks: Record<string, boolean> = {
  the_plan_forked_three_threads: threads.length === 3 && children.length === 3,
  // Every thread's own tool calls are in its transcript: walk, spin and wave are library skills, so each copied the
  // library's files and trained through bash and wrote no file; only wave, after a try that never moved, may edit one
  // weight (the ladder check below requires that edit when the run is not cut short).
  each_thread_copied_its_library_skill_and_wrote_nothing: children.filter((c) => c.box.skill !== NEW_SKILL).every((c) => c.tools[0]?.startsWith("bash") && !c.tools.some((t) => t.startsWith("write")) && c.tools.filter((t) => t.startsWith("edit")).length <= (c.box.skill === "wave" ? 1 : 0)),
  each_child_links_to_parent_and_owner: children.every((c) => c.parent !== undefined && c.owner !== undefined),
  no_thread_gets_a_second_box: (() => {
    const creates = pool.filter((p) => p.event === "pool.create").map((p) => p.threadId);
    return creates.length === 3 && new Set(creates).size === 3;
  })(),
  // Every thread's box was given back (a release retried after the kill may be logged twice).
  every_box_released: new Set(pool.filter((p) => p.event === "pool.release").map((p) => p.threadId)).size === 3 && readdirSync(join(dir, "pool")).every((f) => !f.endsWith(".box")),
  no_live_tasks_left: report.tasks_after.length === 0,
  // After the run every listed thread is settled, with its fold's status.
  threads_of_after_the_run: sameThreads(after) && after.every((t, i) => t.settled && t.boxId !== null && t.status === threads[i]?.status),
};
if (kill && !a["status-throws"]) {
  // Mid-run the same threads are listed, in plan order with their conversations, and not all of them are done yet.
  checks.threads_of_mid_run = mid !== undefined && sameThreads(mid) && mid.some((t) => !t.settled && (t.status === "queued" || t.status === "running"));
}
if (!deadline) {
  // TRAIN_SOP's ladder for a library skill: copy, 12M at once (no compile-only), then ONE retry by the trainer's diagnosis:
  // spin was still changing, so 40M with the same files, then --check its pass; wave never moved, so one weight edited in
  // skill.json and 12M again, and it reports after that.
  checks.the_threads_follow_the_sop_ladder =
    ladder.walk?.join() === "copy,12M,check" && ladder.spin?.join() === "copy,12M,40M,check" &&
    (a["new-skill"]
      ? // A skill the library lacks starts from the closest one: copied, its skill.json and test.py edited, one reward
        // term added, compiled (its reward changed), trained, checked. Never a fresh file tree.
        ladder.bow?.join() === "copy,edit:skill.json,edit:test.py,edit:reward.py,compile,12M,check"
      : a.unmeasured
        ? // Was never measured: the body cannot do it, so the thread reports after its one try, with no 40M and no edit.
          ladder["get-up"]?.join() === "copy,12M"
        : ladder.wave?.join() === "copy,12M,edit:skill.json,12M");
}
// A skill the library lacks, whatever the outcome: its thread starts with the copy and writes at most one file (reward.py).
// Run to its end, it made exactly the SOP's change, and the files on its box are that change on the library's real wave.
if (NEW_SKILL) {
  const t = children.find((c) => c.box.skill === NEW_SKILL);
  checks.new_skill_starts_from_the_copy = t !== undefined && t.tools[0] === "bash" && ladder[NEW_SKILL]?.[0] === "copy" && t.tools.filter((x) => x === "write").length <= 1;
  if (!deadline) {
    checks.new_skill_is_copied_then_edited = t !== undefined && t.tools.filter((x) => x === "edit").length === 2 && t.tools.filter((x) => x === "write").length === 1;
    const box = readdirSync(join(dir, "boxes")).find((b) => b.startsWith(`sb-${NEW_SKILL}-`));
    const file = (name: string) => (box ? readFileSync(join(dir, "boxes", box, "workspace", "skills", NEW_SKILL, name), "utf8") : "");
    const config = box ? (JSON.parse(file("skill.json")) as { name?: string; reward_scales?: Record<string, number>; env?: Record<string, unknown> }) : {};
    checks.new_skill_files_are_the_skill =
      config.name === NEW_SKILL && config.reward_scales?.feet_height === 0 && config.reward_scales?.pose === 0 && config.reward_scales?.bow_pitch === 3 &&
      config.reward_scales?.tracking_lin_vel === 0.5 && (config.env as { command_zero_prob?: number } | undefined)?.command_zero_prob === 1 && // wave's own settings kept
      /down = r\.share\(r\.pitch < -0\.25, after_s=2\)/.test(file("test.py")) && /r\.fell_at is None/.test(file("test.py")) && !/paw up/.test(file("test.py")) &&
      /def terms\(s\):[\s\S]*"bow_pitch": jp\.exp/.test(file("reward.py"));
  }
}
// The outcomes, chosen by the flags first.
if (a["status-throws"]) {
  // The outcome hook failed for every thread: the result says so (it is not silently "reported"), and every box came back.
  checks.outcome_errors_are_reported = threads.every((t) => (t as { outcomeError?: string }).outcomeError === "skill.json is unreadable") && /could not be read: skill\.json is unreadable/.test(report.teachResult?.text ?? "");
} else if (deadline) {
  // spin needs a 12M try and 6 checkpoints at 40M: past the deadline it folds as timed out (on a resume after the kill the
  // stored deadline has already passed, so it is stopped at once). wave never passes; bow (4 checkpoints after its copy,
  // edits and compile) may pass before the deadline or be stopped by it.
  // get-up (--unmeasured) reports after its one short try, so it may be done before the deadline.
  const thirdMay = NEW_SKILL ? ["passed", "timed-out"] : a.unmeasured ? ["never-passed", "timed-out"] : ["timed-out"];
  const slowFolded = by("spin")?.status === "timed-out" && thirdMay.includes(by(third)?.status ?? "");
  if (kill) checks.deadline_survives_the_restart = killed && slowFolded;
  else {
    checks.fast_thread_passed_before_the_deadline = by("walk")?.status === "passed";
    checks.slow_threads_folded_as_timed_out = slowFolded;
  }
} else {
  checks.parent_waiting_allSettled_on_3_when_killed = killed && teachBefore?.status === "waiting" && teachBefore.on === 3 && teachBefore.policy === "allSettled";
  // The status is the trainer's skill.json, not the thread's words (which only say it trained and read the file).
  checks.status_from_skill_json_not_words = by("walk")?.status === "passed" && by("walk")?.checkpoint === 3 && by("spin")?.status === "passed" && by("spin")?.checkpoint === 6 &&
    (NEW_SKILL ? by(NEW_SKILL)?.status === "passed" && by(NEW_SKILL)?.checkpoint === 4 : by(third)?.status === "never-passed");
  // A run that never passed carries the trainer's diagnosis from skill.json into its result and the fold's text.
  if (!NEW_SKILL) {
    const said = a.unmeasured ? "self-righting was never measured" : "never moved";
    checks.never_passed_carries_the_diagnosis = ((by(third) as { reason?: string } | undefined)?.reason ?? "").startsWith(said) && new RegExp(`${third}: never passed\\..*Trainer: ${said}`).test(report.teachResult?.text ?? "");
  }
  checks.read_thread_answers_from_gpu_3 = typeof report.readThread === "string" && new RegExp(`GPU 3 \\(${third}\\)`).test(report.readThread) && /bash/.test(report.readThread);
}
const ok = Object.values(checks).every(Boolean);
const verdict = { ok, dir, checks, ladder, threads_of: { mid: mid?.map((t) => `${t.gpu} ${t.name} ${t.status}`), after: after.map((t) => `${t.gpu} ${t.name} ${t.status}`) }, threads: threads.map((t) => ({ skill: t.skill, status: t.status, checkpoint: t.checkpoint, ...(t.reason ? { reason: t.reason } : {}) })), tools: children.map((c) => ({ skill: c.box.skill, tools: c.tools })), answer: report.answer };
writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 1));
console.log(JSON.stringify(verdict, null, 1));
process.exit(ok ? 0 : 1);
