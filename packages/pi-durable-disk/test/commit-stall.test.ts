// The live run suite's commit-stall note (test/live/_commit-stall.ts), on archil client lines recorded from a live run in
// which T14 self-fence's instance exited before it opened (the disk id replaced). The note only names what stalled; it
// never decides a verdict, and with no journald it says nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitStall, parseJournal, stallNote, type JournalLine } from "./live/_commit-stall.ts";

const MP = "/mnt/pda/p4/a/runs/p4-mvqornfb-selffence";
const CMD = `/usr/bin/archil mount dsk-0000000000000000:/runs/p4-mvqornfb-selffence ${MP} --region aws-us-east-1`;
const retry = (n: number, ms: number) =>
  `event=client.operation_retrying fsid=dsk-0000000000000000 operation=conditional_create first_operation_id=Some(1) operation_count=1 retry_attempt=${n} retry_elapsed_ms=${ms} reason=server_timeout request_id=NetworkRequestId(4)`;
// Recorded, in order: the mount, a short sync, four retries of one operation, a 9.5 s interval sync, a short sync.
const RECORDED: JournalLine[] = [
  { at: 1793105830777.004, cmdline: CMD, message: "[dsk-0000000000000000] Mounted disk in 153ms." },
  { at: 1793105831134.417, cmdline: CMD, message: "[dsk-0000000000000000] long sync user-requested: execute_time=170.61507ms, queue_time=Some(170.645323ms) for None with data_only=false to flush 2 transactions, 0.00 MiB pushed" },
  { at: 1793105831247.447, cmdline: CMD, message: retry(1, 2) },
  { at: 1793105831271.73, cmdline: CMD, message: retry(2, 27) },
  { at: 1793105831401.035, cmdline: CMD, message: retry(4, 156) },
  { at: 1793105833817.309, cmdline: CMD, message: retry(8, 2572) },
  { at: 1793105841704.809, cmdline: CMD, message: "[dsk-0000000000000000] long sync interval: execute_time=9.468796357s, queue_time=None for None with data_only=false to flush 1 transactions, 0.00 MiB pushed" },
  { at: 1793105842071.043, cmdline: CMD, message: "[dsk-0000000000000000] long sync user-requested: execute_time=60.985707ms, queue_time=Some(61.012735ms) for None with data_only=false to flush 1 transactions, 0.11 MiB pushed" },
];
const START = 1793105830500;
const EXIT = 1793105836000;

test("the recorded self-fence red: four server_timeout retries and a 9.5 s commit that began before the instance exited", () => {
  const stall = commitStall(RECORDED, MP, START, EXIT);
  assert.deepEqual([stall.retries, Math.round(stall.longestSyncMs)], [4, 9469]);
  assert.equal(stallNote(stall, "the instance exited (last event: none)"), "environment: on this test's own mount a commit took 9469 ms, 4 server_timeout retries before the instance exited (last event: none); ");
});

test("another mount's lines do not count, also one whose path only starts the same", () => {
  const other = RECORDED.map((l) => ({ ...l, cmdline: l.cmdline.replaceAll(MP, `${MP}2`) }));
  assert.deepEqual(commitStall(other, MP, START, EXIT), { retries: 0, longestSyncMs: 0 });
  assert.equal(stallNote(commitStall(other, MP, START, EXIT), "x"), "");
});

test("a window: retries count inside it, a sync counts when its run overlaps it", () => {
  // Before the 9.5 s sync began (it ran from about 1793105832236): the retries only.
  assert.deepEqual(commitStall(RECORDED, MP, START, 1793105832000), { retries: 3, longestSyncMs: 170.61507 });
  // After every line: nothing.
  assert.deepEqual(commitStall(RECORDED, MP, 1793105843000, 1793105850000), { retries: 0, longestSyncMs: 0 });
});

test("no stall, or no journald on this host: no note, so the message is the one it always was", () => {
  const quiet = RECORDED.filter((l) => !l.message.includes("retrying") && !l.message.includes("9.468796357s"));
  assert.equal(stallNote(commitStall(quiet, MP, START, EXIT), "x"), "");
  assert.equal(stallNote(null, "x"), "");
});

test("journalctl's JSON: entries with a text message are read, binary messages and broken lines skipped", () => {
  const text = [
    JSON.stringify({ __REALTIME_TIMESTAMP: "1793105831247447", _CMDLINE: CMD, MESSAGE: retry(1, 2) }),
    JSON.stringify({ __REALTIME_TIMESTAMP: "1793105831247448", _CMDLINE: CMD, MESSAGE: [104, 105] }),
    "{not json",
    "-- No entries --",
    JSON.stringify({ __REALTIME_TIMESTAMP: "1793105831247449", MESSAGE: "no command line" }),
  ].join("\n");
  assert.deepEqual(parseJournal(text), [
    { at: 1793105831247.447, cmdline: CMD, message: retry(1, 2) },
    { at: 1793105831247.449, cmdline: "", message: "no command line" },
  ]);
});
