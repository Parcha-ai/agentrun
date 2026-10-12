// The teach_skills spike, end to end: a host process starts teaching 8 skills, is SIGKILLed while the parent waits on
// its threads, and a new process reopens the same store, resumes, finishes, and answers "what happened on GPU 3?".
//
//   node spike.ts [--tick 700] [--capacity 8] [--dir DIR]
// Prints a JSON verdict; exits 1 if a check fails. Nothing runs but this machine's node and the fakes.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { tick: { type: "string", default: "700" }, capacity: { type: "string", default: "8" }, dir: { type: "string" }, "done-before": { type: "string", default: "" }, "assemble-fails": { type: "boolean", default: false } } });
const dir = a.dir ?? mkdtempSync(join(tmpdir(), "teach-skills-spike-"));
const host = join(dirname(fileURLToPath(import.meta.url)), "host.ts");
const run = (mode: string) =>
  spawn(process.execPath, [host, "--dir", dir, "--mode", mode, "--tick", a.tick!, "--capacity", a.capacity!, ...(a["done-before"] ? ["--done-before", a["done-before"]] : []), ...(a["assemble-fails"] ? ["--assemble-fails"] : [])], { stdio: ["ignore", "inherit", "inherit"] });

const t0 = Date.now();
const first = run("first");
while (!existsSync(join(dir, "mid.json"))) {
  if (first.exitCode !== null) throw new Error(`the first host exited early (${first.exitCode})`);
  await new Promise((r) => setTimeout(r, 25));
}
first.kill("SIGKILL");
await new Promise((r) => first.once("exit", r));
const killedAt = (Date.now() - t0) / 1000;
const mid = JSON.parse(readFileSync(join(dir, "mid.json"), "utf8"));
console.log(JSON.stringify({ event: "killed", s: killedAt, checkpoints: mid.checkpoints }));

const second = run("resume");
const code: number = await new Promise((r) => second.once("exit", (c) => r(c ?? 1)));
if (code !== 0) throw new Error(`the resumed host failed (${code})`);
const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
const before = JSON.parse(readFileSync(join(dir, "before-resume.json"), "utf8"));
const pool = readFileSync(join(dir, "pool", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const runs = (box: string) => (existsSync(join(dir, "boxes", box, "runs.jsonl")) ? readFileSync(join(dir, "boxes", box, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

function peakHeld(log: { event: string }[]): number {
  let held = 0;
  let peak = 0;
  for (const p of log) {
    held += p.event === "pool.create" ? 1 : p.event === "pool.release" ? -1 : 0;
    peak = Math.max(peak, held);
  }
  return peak;
}
const teachBefore = before.find((t: { kind: string }) => t.kind === "robot.teach-skills");
const threads = report.teachResult?.details?.threads ?? [];
const checks = {
  parent_waiting_allSettled_on_8_when_killed: teachBefore?.status === "waiting" && teachBefore.on === 8 && teachBefore.policy === "allSettled",
  eight_children_in_the_same_store: report.children.length === 8,
  each_child_links_to_parent_fork_and_owner_task: report.children.every((c: { parent?: { conversationId: string }; owner?: { conversationId: string; taskId: string } }) => c.parent !== undefined && c.owner !== undefined && c.parent.conversationId === c.owner.conversationId),
  each_child_has_its_own_transcript: report.children.every((c: { ownEntries: number }) => c.ownEntries >= 4),
  distinct_box_per_child: new Set(report.children.map((c: { box: { boxId: string } }) => c.box.boxId)).size === 8,
  eight_boxes_created_never_more: pool.filter((p) => p.event === "pool.create").length === 8,
  // A thread past its acquire phase resumes with its box ID from its checkpoint; one still acquiring gets the same box,
  // and one still queued for a small pool gets its first. No thread ever holds a second box.
  no_thread_gets_a_second_box: (() => {
    const creates = pool.filter((p) => p.event === "pool.create").map((p) => p.threadId);
    return creates.length === 8 && new Set(creates).size === 8;
  })(),
  // Every thread's box was given back (a release retried after the kill may be logged twice).
  every_box_released: new Set(pool.filter((p) => p.event === "pool.release").map((p) => p.threadId)).size === 8 && readdirSync(join(dir, "pool")).every((f) => !f.endsWith(".box")),
  boxes_out_never_above_capacity: peakHeld(pool) <= Number(a.capacity),
  allSettled_folded_all_8_with_one_failure: threads.length === 8 && threads.filter((t: { status: string }) => t.status === "passed").length === 7 && threads.some((t: { skill: string; status: string }) => t.skill === "wave" && t.status === "never-passed"),
  // wave's thread said only "wave ran out of steps": its status and facts come from the result it saved, not its words.
  failed_thread_keeps_its_saved_facts: threads.some((t: { skill: string; status: string; boxId: string | null; checkpoint?: number; seconds?: number }) =>
    t.skill === "wave" && t.status === "never-passed" && t.boxId !== null && t.checkpoint === 8 && t.seconds !== undefined),
  // "Teach it to move." names no skills: all eight are taught, and the passed ones come home before the tool answers.
  omitted_skills_teach_all_eight: threads.length === 8,
  // With a failing assemble, the failure is reported in the result and every thread's result is still there.
  ...(a["assemble-fails"] ? {
    home_failure_reported_with_thread_results_kept:
      report.teachResult?.details?.home?.error === "assemble-skills exited 1" && /Bringing the skills home failed: assemble-skills exited 1/.test(report.teachResult.text) &&
      threads.length === 8 && threads.filter((t: { status: string }) => t.status === "passed").length === 7 && /GPU 3 · backwards: passed/.test(report.teachResult.text),
  } : {
  passed_skills_are_home: (() => {
    const home = report.teachResult?.details?.home?.skills ?? [];
    const passed = threads.filter((t: { status: string }) => t.status === "passed").map((t: { skill: string }) => t.skill);
    const file = existsSync(join(dir, "home", "skills.json")) ? Object.keys(JSON.parse(readFileSync(join(dir, "home", "skills.json"), "utf8")).skills) : [];
    return home.length === passed.length && passed.every((s: string) => home.includes(s) && file.includes(s)) && new RegExp(`Home: ${passed.length} skills`).test(report.teachResult.text);
  })(),
  }),
  read_thread_answers_from_gpu_3: typeof report.readThread === "string" && /GPU 3 \(backwards\)/.test(report.readThread) && /train_skill/.test(report.readThread),
  no_live_tasks_left: report.tasks_after.length === 0,
};
// A skill whose box already held a finished run reports that run's checkpoint and seconds, not zero and the replay's time.
for (const spec of (a["done-before"] ?? "").split(",").filter(Boolean)) {
  const [skill, checkpoint, seconds] = spec.split(":");
  const t = threads.find((x: { skill: string }) => x.skill === skill);
  (checks as Record<string, boolean>)[`replayed_${skill}_reports_its_saved_run`] =
    t?.status === "passed" && t.checkpoint === Number(checkpoint) && t.seconds === Number(seconds) && /already passed/.test(t.summary);
}
const reruns = report.children.map((c: { box: { boxId: string; skill: string } }) => ({ skill: c.box.skill, runs: runs(c.box.boxId).map((r: { event: string }) => r.event) }));
const ok = Object.values(checks).every(Boolean);
const verdict = { ok, dir, capacity: Number(a.capacity), peak_boxes: peakHeld(pool), killed_at_s: killedAt, resume_to_settled_s: report.resume_to_settled_s, checks, reruns, answer: report.answer, ask: report.ask };
writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict, null, 1));
console.log(JSON.stringify(verdict, null, 1));
process.exit(ok ? 0 : 1);
