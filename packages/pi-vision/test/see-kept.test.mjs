// A paid answer belongs to the conversation, not to the tool call that paid for it. On a code-mode host whose tool is
// not replay-safe (pi never runs a cut call again), a kill held at the second filing, after the eyes answered both
// windows, is followed by a new call with the same script: it asks the eyes nothing, reads both answers back, tells the
// window whose filing was cut once and the other again as kept, so each window is paid once and every payment is told.
// An answer kept on the call's task, where memos lived before, is read back the same way by a cut call pi runs again.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pngBytes } from "@parcha/pi-vision/testing";
import { tmp } from "./durable/rig.mjs";

const CHILD = path.join(import.meta.dirname, "durable", "kept-child.mjs");
const DEADLINE_MS = 60_000;
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const within = (promise, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} within ${DEADLINE_MS} ms`)), DEADLINE_MS); })]).finally(() => clearTimeout(timer));
};

/** The first process killed at the second filing, then the second run to the end; every child is killed when the test
 *  ends, however it ends. */
async function cutThenRerun(t, env) {
  const dir = tmp("vision-kept-");
  const paths = { DB: path.join(dir, "run.sqlite"), CWD: path.join(dir, "work"), OUT: path.join(dir, "out"), LEDGER: path.join(dir, "eyes.jsonl") };
  fs.mkdirSync(paths.CWD); fs.mkdirSync(paths.OUT);
  fs.writeFileSync(path.join(paths.CWD, "w1.png"), pngBytes(40, 30));
  fs.writeFileSync(path.join(paths.CWD, "w2.png"), pngBytes(50, 30));
  const child = (mode) => {
    const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, ...paths, ...env, MODE: mode }, stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); });
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    const exit = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, line: stdout.split("\n").find((l) => l.startsWith("RESULT ")) })));
    return { proc, exit };
  };
  const first = child("first");
  for (let waited = 0; !fs.existsSync(path.join(paths.CWD, ".cut")); waited += 20) {
    assert.ok(waited < DEADLINE_MS, "the first process never reached the second filing");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(lines(paths.LEDGER).length, 2, "the eyes answered both windows before the cut");
  first.proc.kill("SIGKILL");
  assert.deepEqual(await within(first.exit, "the first process exits"), { code: null, signal: "SIGKILL", line: undefined });
  const { line } = await within(child("second").exit, "the second process prints its result");
  assert.ok(line, "the second process printed its result");
  return { second: JSON.parse(line.slice("RESULT ".length)), asked: lines(paths.LEDGER).length, told: lines(path.join(paths.OUT, "looks.jsonl")) };
}

test("killed at the second filing on a host that never reruns a cut call, the next call pays nothing and every payment is told once", async (t) => {
  const { second, asked, told } = await cutThenRerun(t, { REPLAY: "unsafe" });
  assert.equal(second.settled, "done");
  const calls = second.results.filter((r) => r.tool === "code");
  assert.equal(calls.length, 2, "the cut call stays cut, and the lead called the tool again");
  const answer = JSON.parse(calls.at(-1).content[0].text);
  assert.deepEqual([answer.ok, answer.value.kept], [true, true], "the new call read every answer back");
  assert.equal(asked, 2, "the eyes were asked once per window in all");
  assert.deepEqual(told.map((r) => [r.by, r.source, r.kept]), [["first", "talk.mp4#t=0,30", false], ["second", "talk.mp4#t=0,30", true], ["second", "talk.mp4#t=30,60", false]],
    "the first window told paid, then again as kept; the second, whose filing was cut, told paid once");
  const paid = told.filter((r) => !r.kept);
  assert.deepEqual([paid.length, told.length - paid.length, new Set(paid.map((r) => r.key)).size], [2, 1, 2], "paid 2, kept 1, no window paid twice");
});

test("answers kept on the cut call's task are read back when pi runs that call again, never paid twice", async (t) => {
  const { second, asked, told } = await cutThenRerun(t, { REPLAY: "safe", TASK_MEMOS: "first" });
  assert.equal(second.settled, "done");
  assert.equal(asked, 2, "the eyes were asked once per window in all");
  const paid = told.filter((r) => !r.kept);
  assert.deepEqual(paid.map((r) => [r.by, r.source]), [["first", "talk.mp4#t=0,30"], ["second", "talk.mp4#t=30,60"]], "each window told paid once: the first before the cut, the second, whose filing was cut, after it");
});
