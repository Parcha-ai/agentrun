// examples/kill-9: a coding agent whose process is SIGKILLed in the middle of a long bash command. A second process opens the
// same run: the files are intact, the cut command comes back `interrupted` and is never run again, the file tools stay in
// work/, and the agent goes on to the end. The example checks all of that itself and ends with an `ok:` line.
import { it } from "node:test";
import assert from "node:assert/strict";
import { endSurvivors, judge, type Seen } from "../../examples/kill-9/survivors.ts";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("kill-9: the files are intact after kill -9, the cut command comes back interrupted and ran once, the agent finishes", { timeout: 120_000 }, async () => {
  const result = await runExample("kill-9");
  assertExampleOk(result, /^ok: after kill -9 the files were intact, the next open ended the cut command and it came back interrupted without a rerun, the agent finished in generation 2, and its file tools stayed in work\/$/m);
  assert.match(result.stdout, /^the long command is running: SIGKILL to the first process \(its command is not touched\)$/m);
  assert.match(result.stdout, /^the first process ended \(SIGKILL\); its command is still running: a bare kill -9 does not end it; a second process opens the same run$/m);
  assert.match(result.stdout, /^generation 2 opened the run in .*kill-9-run \(3 tool results before\)$/m);
  assert.match(result.stdout, /^ {2}bash \[error\]: .*Tool bash was interrupted and may have partially run$/m);
  assert.match(result.stdout, /^ {2}write \[error\]: .*outside the workspace/m);
});

// The example's check, over a made-up process table: its group is 4300 (the command's leader), and the next open began at
// tick 1000. A process group is named by a pid, which the kernel hands out again; only a start tells whose a process is.
const before = 1000;
const seen = (pid: number, group: number, start: number, state = "S", command = "sleep 120"): Seen => ({ pid, ppid: 1, group, state, start, command });

it("the example's check: a process holding the command's group number that started after the next open began took the number again, and is reported, never a survivor", () => {
  const stranger = seen(4300, 4300, 1500, "S", "node another-test.js");
  assert.deepEqual(judge([stranger], 4300, before), { survivors: [], reused: [stranger] });
  // What the check read before: any live process of the group number, so this one read as the cut command still running.
  assert.ok([stranger].some((p) => p.group === 4300 && !p.state.startsWith("Z")), "the old check's reading of this table");
});

it("the example's check: a process of the command's group that started before the next open is a survivor, and an equal start counts", () => {
  const leader = seen(4300, 4300, 500, "S", "bash -c ...");
  const atTheInstant = seen(4320, 4300, before);
  assert.deepEqual(judge([leader, atTheInstant], 4300, before), { survivors: [leader, atTheInstant], reused: [] });
});

it("the example's check: while a process of the command's group from before the next open lives, the group never ended, so a child it forked after that instant is the command's too, a survivor", () => {
  // A process of the group from before the instant lives, so the group never ended and its number was never free.
  const leader = seen(4300, 4300, 500, "S", "bash -c ...");
  const late = seen(4310, 4300, 1500, "S", "sleep 120");
  assert.deepEqual(judge([leader, late], 4300, before), { survivors: [leader, late], reused: [] });
});

it("the example's check: a zombie of the group, and a live process of another group, are neither survivors nor reused numbers", () => {
  assert.deepEqual(judge([seen(4310, 4300, 600, "Z"), seen(4400, 4400, 600), seen(4401, 4400, 1500)], 4300, before), { survivors: [], reused: [] });
});

it("the example's check: with the command's leader gone, a holder of its group number that started after the next open began is another group's, by the command's own order", () => {
  // The long job starts its sleep before it writes `started`, and the instant is taken only after that line: every
  // process of the command started before the instant. So once none of those lives, a holder that started after it took
  // the number again.
  const holder = seen(4300, 4300, 1500, "S", "node another-test.js");
  assert.deepEqual(judge([holder], 4300, before), { survivors: [], reused: [holder] });
});

// The example's cleanup ends what the check judged only while a fresh look still shows it so. The kill is a recorder here:
// no test of this sends a real signal.
it("the example's cleanup: a judged survivor that a fresh look shows in another group, or with another start, is reported and never signalled; one still as judged is", () => {
  const moved = seen(4310, 4300, 600);
  const reborn = seen(4320, 4300, 700);
  const kept = seen(4330, 4300, 800);
  const gone = seen(4340, 4300, 900);
  const fresh = new Map([
    [4310, seen(4310, 9900, 600, "S", "node another-lane.js")],
    [4320, seen(4320, 4300, 1500, "S", "node another-test.js")],
    [4330, kept],
  ]);
  const signalled: number[] = [];
  const { ended, skipped } = endSurvivors([moved, reborn, kept, gone], 4300, (pid) => fresh.get(pid), (pid) => signalled.push(pid));
  assert.deepEqual(signalled, [4330]);
  assert.deepEqual(ended, [4330]);
  assert.deepEqual(skipped, [
    "pid 4310: in group 9900, not the command's 4300",
    "pid 4320: started at 1500, not at 700 as judged (the pid was handed out again)",
    "pid 4340: gone",
  ]);
});
