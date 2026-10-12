#!/usr/bin/env node
// Mutation check for spec/receipts: each mutant breaks one guard a recovery driver relies on, and the
// properties of the config it names (Receipts.cfg unless it says otherwise) must catch it, with the
// property named here. A property that no mutant can fail is vacuous; a mutant that no property
// catches is a guard the spec does not state. The receipts-spec CI job runs it after
// check-receipts.sh when a change touches spec/receipts/ or scripts/spec/, and nightly; every
// mutant must be caught, by its named property, within TLC_TIMEOUT_S (default 300 s) of TLC time.
//
//   TLA2TOOLS=<path of tla2tools.jar> node scripts/spec/receipts-mutants.mjs
//     (TLC_WORKERS, TLC_TIMEOUT_S as in check-receipts.sh; with TLC_OUT set, each mutant's log is
//      TLC_OUT/mutant-<name>/tlc.log)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const spec = fs.readFileSync(path.join(root, "spec/receipts/Receipts.tla"), "utf8");
// Each mutant runs TLC in its own directory, so a relative jar path is resolved from the caller's first.
const jar = process.env.TLA2TOOLS && path.resolve(process.env.TLA2TOOLS);
if (!jar || !fs.existsSync(jar)) { console.error(`tla2tools.jar not found${jar ? ` at ${jar}` : ""}: set TLA2TOOLS to its path`); process.exit(2); }
const workers = process.env.TLC_WORKERS || "auto";
const limitS = Number(process.env.TLC_TIMEOUT_S || 300);
const out = process.env.TLC_OUT;

const MUTANTS = [
  { name: "DispatchUnknownOnResume", code: "a resumed driver dispatches only an effect its own admit answered new; RecoveryJournal.admit returns an earlier admission as it stands",
    caughtBy: "I3_OneDispatchPerKey",
    edits: [["  /\\ Working /\\ fresh = at /\\ at <= N /\\ memo[at] = \"unknown\"", "  /\\ Working /\\ fresh \\in {0, at} /\\ at <= N /\\ memo[at] = \"unknown\""]] },
  { name: "DispatchBeforeAdmit", code: "an effect is dispatched only after RecoveryJournal.admit resolved, so the admission is durable first",
    caughtBy: "I1_AdmitBeforeDispatch",
    edits: [["  /\\ Working /\\ fresh = at /\\ at <= N /\\ memo[at] = \"unknown\"", "  /\\ Working /\\ flight = 0 /\\ at <= N /\\ memo[at] \\in {\"none\", \"unknown\"}"]] },
  { name: "ResendCompletedOnResume", code: "a resumed driver answers a completed effect from its receipt (recovery.call returns the recorded result) and never sends it again",
    caughtBy: "I3_OneDispatchPerKey",
    edits: [["  /\\ at' = at + 1\n  /\\ UNCHANGED <<memo, sent, fresh, flight, run, afterFault, up, crashes>>", "  /\\ at' = at + 1 /\\ sent' = [sent EXCEPT ![at] = @ + 1]\n  /\\ UNCHANGED <<memo, fresh, flight, run, afterFault, up, crashes>>"]] },
  { name: "AnswerUnknownReceipt", code:"a resumed driver answers only a completed effect from the journal and refuses an unknown one",
    caughtBy: "I3_CallRefused",
    edits: [["  /\\ Working /\\ flight = 0 /\\ fresh = 0 /\\ at <= N /\\ memo[at] = \"completed\"", "  /\\ Working /\\ flight = 0 /\\ fresh = 0 /\\ at <= N /\\ memo[at] \\in {\"completed\", \"unknown\"}"]] },
  { name: "CompleteWithoutDispatch", code: "RecoveryJournal.complete records the value the effect's own dispatch returned, never one it did not make",
    caughtBy: "I7_CompletedDispatchedOnce",
    edits: [["  /\\ Working /\\ flight = at /\\ at <= N", "  /\\ Working /\\ flight \\in {0, at} /\\ at <= N"]] },
  { name: "AdmitAfterFault", code: "a failed commit is the run's failure, and every later commit through that open is refused",
    caughtBy: "I6_NoAdmissionAfterFault",
    edits: [["  /\\ afterFault' = (afterFault \\/ run = \"faulted\")\n  /\\ run = \"running\"\n", "  /\\ afterFault' = (afterFault \\/ run = \"faulted\")\n"]] },
  { name: "RetryUnderRecovery", code: "packages/dsl/src/workflow.ts runs no call retry under recovery, so an admitted effect goes out once",
    caughtBy: "I3_OneDispatchPerKey",
    edits: [["  /\\ sent' = [sent EXCEPT ![at] = @ + 1] /\\ flight' = at /\\ fresh' = 0", "  /\\ sent' = [sent EXCEPT ![at] = @ + 1] /\\ flight' = at /\\ fresh' = fresh"]] },
  { name: "CrashErasesReceipt", code: "RecoveryJournal.complete commits the effect's result with the state, and a completed effect is never rewritten",
    // The erased state already shows a dispatch with no admission, so TLC's first report may be I1.
    caughtBy: ["I7_ReceiptsNeverErased", "I1_AdmitBeforeDispatch"],
    edits: [["  /\\ UNCHANGED <<memo, sent, at, run, afterFault>>", "  /\\ memo' = [i \\in Steps |-> IF memo[i] = \"completed\" THEN \"none\" ELSE memo[i]]\n  /\\ UNCHANGED <<sent, at, run, afterFault>>"]] },
  { name: "FinishBeforeEveryStep", code: "the interpreter ends a run only after its last step committed",
    caughtBy: "I7_DoneSettledEveryCall",
    edits: [["  /\\ Working /\\ at = N + 1 /\\ run' = \"done\"", "  /\\ Working /\\ at >= 1 /\\ run' = \"done\""]] },
];

let failed = 0;
for (const mutant of MUTANTS) {
  let text = spec;
  for (const [from, to] of mutant.edits) {
    if (text.split(from).length !== 2) { console.error(`FAIL ${mutant.name}: its edit no longer matches Receipts.tla exactly once; update the mutant`); failed++; text = null; break; }
    text = text.replace(from, to);
  }
  if (text === null) continue;
  const dir = out ? path.join(out, `mutant-${mutant.name}`) : fs.mkdtempSync(path.join(os.tmpdir(), `receipts-mutant-${mutant.name}-`));
  if (out) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
  const module = `M_${mutant.name}`;
  fs.writeFileSync(path.join(dir, `${module}.tla`), text.replace("MODULE Receipts", `MODULE ${module}`));
  const cfg = mutant.cfg ?? "Receipts.cfg";
  fs.copyFileSync(path.join(root, "spec/receipts", cfg), path.join(dir, cfg));
  // A private java.io.tmpdir, as in check-receipts.sh; a mutant whose TLC outlives the limit is
  // killed and fails as a stall, never hangs the job.
  fs.mkdirSync(path.join(dir, "tmp"), { recursive: true });
  let log, stalled = false;
  const began = Date.now();
  try { log = execFileSync("java", ["-XX:+UseParallelGC", `-Djava.io.tmpdir=${path.join(dir, "tmp")}`, "-cp", jar, "tlc2.TLC", "-workers", workers, "-config", cfg, "-metadir", path.join(dir, "states"), `${module}.tla`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: limitS * 1000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024 }); }
  catch (error) { log = `${error.stdout ?? ""}${error.stderr ?? ""}`; stalled = error.code === "ETIMEDOUT"; }
  fs.writeFileSync(path.join(dir, "tlc.log"), log);
  const seconds = Math.round((Date.now() - began) / 1000);
  if (stalled) { console.error(`FAIL ${mutant.name}: TLC did not finish within ${limitS}s and was stopped (log in ${dir}/tlc.log)`); failed++; continue; }
  const violation = /^Error: (?:Invariant|Action property) (\S+) is violated/m.exec(log)?.[1] ?? (/^Error: Temporal properties were violated/m.test(log) ? "Termination" : null);
  if ([mutant.caughtBy].flat().includes(violation)) console.log(`ok   ${mutant.name}: caught by ${violation} on ${cfg} in ${seconds}s (${mutant.code})`);
  else { console.error(`FAIL ${mutant.name}: expected ${[mutant.caughtBy].flat().join(" or ")}, TLC reported ${violation ?? "no violation"} (log in ${dir}/tlc.log)`); failed++; continue; }
  if (!out) fs.rmSync(dir, { recursive: true, force: true });
  else fs.rmSync(path.join(dir, "states"), { recursive: true, force: true });
}
console.log(`${MUTANTS.length - failed} of ${MUTANTS.length} mutants caught by their named property`);
process.exit(failed ? 1 : 0);
