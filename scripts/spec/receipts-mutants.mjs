#!/usr/bin/env node
// Mutation check for spec/receipts: each mutant breaks one guard a recovery driver (Receipts.tla) or the
// serve door (Door.tla, `module: "Door"`) relies on, and the properties of the config it names (its
// module's own .cfg unless it says otherwise) must catch it, with the property named here. A property
// that no mutant can fail is vacuous; a mutant that no property catches is a guard the spec does not
// state. The receipts-spec CI job runs it after check-receipts.sh when a change touches spec/receipts/
// or scripts/spec/, and nightly; every mutant must be caught, by its named property, within
// TLC_TIMEOUT_S (default 300 s) of TLC time.
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
const specs = Object.fromEntries(["Receipts", "Door"].map((m) => [m, fs.readFileSync(path.join(root, `spec/receipts/${m}.tla`), "utf8")]));
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
    // Admitting after the guard is dropped violates both "no admission after a fault" and, when the run is also
    // stopped, "no admission after a stop"; TLC reports whichever it reaches first, so accept either.
    caughtBy: ["I6_NoAdmissionAfterFault", "I9_NoAdmissionAfterStop"],
    edits: [["  /\\ afterFault' = (afterFault \\/ run = \"faulted\")\n  /\\ run = \"running\"\n", "  /\\ afterFault' = (afterFault \\/ run = \"faulted\")\n"]] },
  { name: "DispatchAfterStop", code: "the driver's guard throws a stop before an admitted effect is dispatched, not only before admission",
    // Dispatch drops the run = running guard (Working -> up), so an admitted effect goes out in a process that has
    // applied a stop. Dispatch still records that it ran after a stop, so "no admission after a stop" catches it.
    caughtBy: "I9_NoAdmissionAfterStop",
    edits: [["  /\\ Working /\\ fresh = at /\\ at <= N /\\ memo[at] = \"unknown\"\n  /\\ afterStop'",
             "  /\\ up /\\ fresh = at /\\ at <= N /\\ memo[at] = \"unknown\"\n  /\\ afterStop'"]] },
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
  { name: "SwallowRefusedStop", code: "close throws a stop's commit the store refused, so a host never takes as stopped a run whose stop is not on the journal",
    caughtBy: "I8_StopOnJournalOrHeard",
    edits: [["  /\\ closed' = TRUE /\\ heard' = (stop = \"refused\")", "  /\\ closed' = TRUE /\\ heard' = FALSE"]] },
  { name: "CloseBeforeStopCommit", code: "close waits for every commit the driver started, the stop's own included",
    caughtBy: "I8_StopOnJournalOrHeard",
    edits: [["  /\\ up /\\ stop \\in {\"landed\", \"refused\"} /\\ ~closed", "  /\\ up /\\ stop # \"none\" /\\ ~closed"]] },
  { name: "AdmitAfterStop", code: "a stop blocks every admission: the driver's guard throws the stop",
    caughtBy: "I9_NoAdmissionAfterStop",
    edits: [["  /\\ afterFault' = (afterFault \\/ run = \"faulted\")\n  /\\ run = \"running\"\n", "  /\\ afterFault' = (afterFault \\/ run = \"faulted\")\n  /\\ run \\in {\"running\", \"stopped\"}\n"]] },
  { name: "RestartResumesCancelled", code: "an open refuses a run whose journal holds its cancel, so a cancelled run never resumes",
    caughtBy: "I10_CancelledNeverResumes",
    edits: [["  /\\ run' = IF run = \"stopped\" /\\ ~stopped THEN \"running\" ELSE run", "  /\\ run' = IF run = \"stopped\" THEN \"running\" ELSE run"]] },
  { module: "Door", name: "DoorResubmitOnResume", code: "a later incarnation answers an ADMITTED or UNKNOWN record as it stands and never calls hook.submit for it (src/door.ts)",
    // An ADMITTED record goes out a second time (I1); an UNKNOWN one goes out while it is not ADMITTED (I4).
    caughtBy: ["I1_OneDispatchPerRequest", "I4_DispatchOnlyAdmittedUnderLease"],
    edits: [["       ELSE UNCHANGED <<rec, by, call>> \\* the commit refused, or the record answered",
             "       ELSE IF holds[i] /\\ rec[r] \\in {\"ADMITTED\", \"UNKNOWN\"} /\\ by[r] # i THEN by' = [by EXCEPT ![r] = i] /\\ call' = [call EXCEPT ![i][r] = \"own\"] /\\ UNCHANGED rec ELSE UNCHANGED <<rec, by, call>>"]] },
  { module: "Door", name: "DoorLateAnswerWithoutFence", code: "a late answer settles the record through the run's fenced commit, refused once the lease is lost",
    caughtBy: "I3_UnknownSettledByItsLateAnswer",
    edits: [["  /\\ \\E o \\in Settled : rec' = IF holds[i] THEN [rec EXCEPT ![r] = o] ELSE rec \\* fenced", "  /\\ \\E o \\in Settled : rec' = [rec EXCEPT ![r] = o]"]] },
  { module: "Door", name: "DoorDedupeAfterDispatch", code: "the door looks the requestId up and admits it in one commit before hook.submit, never after",
    caughtBy: ["I1_OneDispatchPerRequest", "I4_DispatchOnlyAdmittedUnderLease"],
    edits: [["  /\\ alive[i] /\\ holds[i] /\\ call[i][r] = \"own\"\n", "  /\\ alive[i] /\\ holds[i] /\\ (call[i][r] = \"own\" \\/ checking[i][r] > 0)\n"]] },
];

let failed = 0;
for (const mutant of MUTANTS) {
  const of = mutant.module ?? "Receipts";
  let text = specs[of];
  for (const [from, to] of mutant.edits) {
    if (text.split(from).length !== 2) { console.error(`FAIL ${mutant.name}: its edit no longer matches ${of}.tla exactly once; update the mutant`); failed++; text = null; break; }
    text = text.replace(from, to);
  }
  if (text === null) continue;
  const dir = out ? path.join(out, `mutant-${mutant.name}`) : fs.mkdtempSync(path.join(os.tmpdir(), `receipts-mutant-${mutant.name}-`));
  if (out) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
  const module = `M_${mutant.name}`;
  fs.writeFileSync(path.join(dir, `${module}.tla`), text.replace(`MODULE ${of}`, `MODULE ${module}`));
  const cfg = mutant.cfg ?? `${of}.cfg`;
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
