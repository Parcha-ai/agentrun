// Code mode end to end: the session plans three skills with briefs, and each thread writes a reward and trains with its
// coding tools (write, bash) on its own box. The first host is SIGKILLed while the threads train and a second one
// resumes; with --deadline-ms the run goes in one process and slow threads must fold as timed out.
//
//   node spike_plan.ts [--tick 200] [--deadline-ms N] [--dir DIR]
// Prints a JSON verdict (also DIR/verdict.json); exits 1 if a check fails.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { tick: { type: "string", default: "200" }, "deadline-ms": { type: "string" }, dir: { type: "string" }, kill: { type: "boolean", default: false }, "status-throws": { type: "boolean", default: false } } });
const dir = a.dir ?? mkdtempSync(join(tmpdir(), "teach-plan-"));
const host = join(dirname(fileURLToPath(import.meta.url)), "host.ts");
const deadline = a["deadline-ms"];
// With --deadline-ms the run goes in one process, unless --kill: then the host dies before the deadline and the second one
// starts after it has passed, so the deadline must come from the store, not a fresh clock.
const kill = !deadline || a.kill;
const run = (mode: string) =>
  spawn(process.execPath, [host, "--dir", dir, "--mode", mode, "--tick", a.tick!, "--plan", ...(deadline ? ["--deadline-ms", deadline] : []), ...(a["status-throws"] ? ["--status-throws"] : [])], { stdio: ["ignore", "inherit", "inherit"] });
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
const planned = ["walk", "spin", "wave"];
const sameThreads = (l: Listed[]) =>
  l.map((t) => t.name).join() === planned.join() &&
  l.every((t, i) => t.gpu === i + 1 && t.of === 3) &&
  l.map((t) => t.conversation).join() === [...children].sort((x, y) => x.box.gpu - y.box.gpu).map((c) => c.id).join();

const checks: Record<string, boolean> = {
  the_plan_forked_three_threads: threads.length === 3 && children.length === 3,
  // Every thread's own tool calls are in its transcript: it wrote its reward, then ran training through bash.
  each_thread_wrote_and_ran_its_own_code: children.every((c) => c.tools[0] === "write" && c.tools.some((t) => t.startsWith("bash"))),
  each_child_links_to_parent_and_owner: children.every((c) => c.parent !== undefined && c.owner !== undefined),
  no_thread_gets_a_second_box: (() => {
    const creates = pool.filter((p) => p.event === "pool.create").map((p) => p.threadId);
    return creates.length === 3 && new Set(creates).size === 3;
  })(),
  every_box_released: pool.filter((p) => p.event === "pool.release").length === 3,
  no_live_tasks_left: report.tasks_after.length === 0,
  // After the run every listed thread is settled, with its fold's status.
  threads_of_after_the_run: sameThreads(after) && after.every((t, i) => t.settled && t.boxId !== null && t.status === threads[i]?.status),
};
if (kill && !a["status-throws"]) {
  // Mid-run the same threads are listed, in plan order with their conversations, and not all of them are done yet.
  checks.threads_of_mid_run = mid !== undefined && sameThreads(mid) && mid.some((t) => !t.settled && (t.status === "queued" || t.status === "running"));
}
if (a["status-throws"]) {
  // The outcome hook failed for every thread: the result says so (it is not silently "reported"), and every box came back.
  checks.outcome_errors_are_reported = threads.every((t) => (t as { outcomeError?: string }).outcomeError === "skill.json is unreadable") && /could not be read: skill\.json is unreadable/.test(report.teachResult?.text ?? "");
} else if (deadline && kill) {
  // spin was mid-training at the kill; with the stored deadline already past on resume it is stopped at once. A fresh
  // deadline would let it retrain (6 checkpoints, about 1.2 s) and pass.
  checks.deadline_survives_the_restart = killed && by("spin")?.status === "timed-out" && by("wave")?.status === "timed-out";
} else if (deadline) {
  // walk passes in 3 checkpoints; spin needs 6 and wave never passes: past the deadline they fold as timed out.
  checks.fast_thread_passed_before_the_deadline = by("walk")?.status === "passed";
  checks.slow_threads_folded_as_timed_out = by("spin")?.status === "timed-out" && by("wave")?.status === "timed-out";
} else {
  checks.parent_waiting_allSettled_on_3_when_killed = killed && teachBefore?.status === "waiting" && teachBefore.on === 3 && teachBefore.policy === "allSettled";
  // The status is the trainer's skill.json, not the thread's words (which only say it trained and read the file).
  checks.status_from_skill_json_not_words = by("walk")?.status === "passed" && by("walk")?.checkpoint === 3 && by("spin")?.status === "passed" && by("spin")?.checkpoint === 6 && by("wave")?.status === "never-passed";
  // A run that never passed carries the trainer's diagnosis from skill.json into its result and the fold's text.
  checks.never_passed_carries_the_diagnosis = /^plateaued/.test((by("wave") as { reason?: string } | undefined)?.reason ?? "") && /wave: never passed\..*Trainer: plateaued/.test(report.teachResult?.text ?? "");
  checks.read_thread_answers_from_gpu_3 = typeof report.readThread === "string" && /GPU 3 \(wave\)/.test(report.readThread) && /bash/.test(report.readThread);
}
const ok = Object.values(checks).every(Boolean);
const verdict = { ok, dir, checks, threads_of: { mid: mid?.map((t) => `${t.gpu} ${t.name} ${t.status}`), after: after.map((t) => `${t.gpu} ${t.name} ${t.status}`) }, threads: threads.map((t) => ({ skill: t.skill, status: t.status, checkpoint: t.checkpoint })), tools: children.map((c) => ({ skill: c.box.skill, tools: c.tools })), answer: report.answer };
writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 1));
console.log(JSON.stringify(verdict, null, 1));
process.exit(ok ? 0 : 1);
