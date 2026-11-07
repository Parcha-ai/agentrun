// What the background tools trust (background.ts): every file under work/background/<id>/ can be written by the run's
// own file tools, so no call reads one as fact. The group a signal goes to, the exit code, the start time, the command
// and the run's-end mark come from the box-only directory alone; output.log is read only as a regular file reached
// through no link; and a display copy in work/ is renamed over its name, never written through a link planted there.
// Each test is a run through the API on the faux probe model in the faux box (pi-transport's local box, standing in for
// Docker: its processes are this machine's, so a decoy process group started here stands for another of the box's).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fauxRoot } from "./fixtures/faux-box.mjs";
import { follow, runDir, scratch, serve } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_BOX = new URL("./fixtures/faux-box.mjs", import.meta.url).pathname;
const SANDBOX = { mode: "sandbox", box: "docker" };
const TOOLS = ["bash", "write", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"];

function answers(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, error: message.isError, text: (message.content ?? []).map((c) => c.text ?? "").join("") }));
  } finally {
    db.close();
  }
}
const until = async (done, what, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const liveBoxes = (data) => (existsSync(fauxRoot(data)) ? readdirSync(fauxRoot(data)).filter((name) => name.startsWith("local-") && existsSync(join(fauxRoot(data), name, "box.json"))) : []);
const groupAlive = (group) => {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
};
/** A process group of its own, started here: another of the box's groups, which no call of process 1's may reach. */
function decoy(t) {
  const child = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  child.unref();
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  });
  return child.pid;
}

async function boxedRun(t, plan, { before } = {}) {
  const server = await serve(t, { faux: PROBE, fauxBox: FAUX_BOX });
  const { api } = server;
  await before?.(server.data);
  const made = await api("POST", "/agents", { definition: { id: "bg", name: "bg", instructions: "Probe.", place: SANDBOX, tools: TOOLS } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", "/agents/bg/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 90_000 });
  return { ...server, runId: run.body.run_id, said: answers(server.data, run.body.run_id), work: join(runDir(server.data, run.body.run_id), "work") };
}
/** A box whose display copy of `exit` lands slowly: an `mv` first on its PATH that waits 2 s before it renames over
 *  `./exit`, the display copy's own rename. The run's end must not destroy the box before that copy has landed. */
async function slowExitCopy(t, data) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "mv"), '#!/bin/sh\nfor a; do last=$a; done\ncase "$last" in ./exit) sleep 2;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
  await mkdir(fauxRoot(data), { recursive: true });
  await writeFile(join(fauxRoot(data), "path-prefix"), bin);
}
const groupOf = (started) => Number(/\(process group (\d+)\)/.exec(started)?.[1]);

test("a pid written into work/ is no group a signal goes to: bash_signal TERM ends process 1's own group, and the group named in its forged pid file lives on", { timeout: 120_000 }, async (t) => {
  const other = decoy(t);
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30" } },
    { tool: "write", args: { path: "background/1/pid", content: String(other) } },
    { tool: "bash_signal", args: { id: "1", signal: "TERM" } },
  ];
  const { said, data } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.equal(said[2].text, "Sent TERM to background process 1: it ended by signal TERM (exit code 143).");
  assert.equal(groupAlive(groupOf(said[0].text)), false, "process 1's own group is gone");
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  assert.equal(groupAlive(other), true, "the forged group was never signalled, by the call or by the run's end");
});

test("a link planted at output.log is refused in words: neither bash_output nor bash_list reads the file it names", { timeout: 120_000 }, async (t) => {
  const outside = await scratch(t);
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET-TEXT-OUTSIDE-WORK\n");
  const plan = [
    { tool: "bash_background", args: { command: "echo hi" } },
    { tool: "bash", args: { command: `sleep 0.5; ln -sf ${secret} background/1/output.log` } },
    { tool: "bash_output", args: { id: "1" } },
    { tool: "bash_list", args: {} },
  ];
  const { said } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step, i) => [step.tool, i === 2]), JSON.stringify(said));
  assert.match(said[2].text, /background process 1's log is not read: background\/1\/output\.log \(or a directory on its way\) is a link or not a regular file/);
  // The cause that applied, alone: this box has /proc, so no word of it.
  assert.ok(!said[2].text.includes("/proc"), said[2].text);
  for (const answer of said) assert.ok(!answer.text.includes("SECRET-TEXT"), `${answer.tool}: ${answer.text}`);
  assert.match(said[3].text, /\n1: exited with code 0; 0 bytes of output;/);
});

test("links planted at exit, command and started read nothing of what they name: bash_list shows the process running, with its own command", { timeout: 120_000 }, async (t) => {
  const outside = await scratch(t);
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET-TEXT-OUTSIDE-WORK\n");
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30" } },
    { tool: "bash", args: { command: `for f in exit command started; do ln -sf ${secret} background/1/$f; done` } },
    { tool: "bash_list", args: {} },
    { tool: "bash_output", args: { id: "1" } },
    { tool: "bash_signal", args: { id: "1", signal: "KILL" } },
  ];
  const { said } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  for (const answer of said) assert.ok(!answer.text.includes("SECRET-TEXT"), `${answer.tool}: ${answer.text}`);
  assert.match(said[2].text, /^1 of at most 8 running\.\n1: is running; 0 bytes of output; started \d{4}-\d\d-\d\dT[\d:]+Z; "sleep 30"$/);
  assert.match(said[3].text, /^Background process 1 is running\./);
  assert.match(said[4].text, /ended by signal KILL \(exit code 137\)/);
});

test("a link planted at ended truncates nothing at the run's end", { timeout: 120_000 }, async (t) => {
  const outside = await scratch(t);
  const victim = join(outside, "keep.txt");
  await writeFile(victim, "KEEP-THIS\n");
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30" } },
    { tool: "bash", args: { command: `ln -s ${victim} background/1/ended` } },
  ];
  // Its display copy of exit lands 2 s after the trusted one would have: the box must outlast it.
  const { said, data, work } = await boxedRun(t, plan, { before: (data) => slowExitCopy(t, data) });
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  assert.equal(readFileSync(victim, "utf8"), "KEEP-THIS\n", "the file the planted links name is as it was");
  assert.equal(groupAlive(groupOf(said[0].text)), false, "process 1 was ended at the run's end");
  // Its display copy replaced the link, written beside it and renamed over.
  assert.equal(lstatSync(join(work, "background", "1", "ended")).isFile(), true, "ended is a file of its own now");
  assert.equal(readFileSync(join(work, "background", "1", "exit"), "utf8"), "143\n");
});

test("a process directory made in work/ with a forged pid and no exit is lost: never running, never signalled, at a call or at the run's end", { timeout: 120_000 }, async (t) => {
  const other = decoy(t);
  const plan = [
    { tool: "write", args: { path: "background/99/pid", content: String(other) } },
    { tool: "bash_list", args: {} },
    { tool: "bash_signal", args: { id: "99", signal: "KILL" } },
    { tool: "bash_background", args: { command: "sleep 30" } },
  ];
  const { said, data } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step, i) => [step.tool, i === 2]), JSON.stringify(said));
  // Its own words: no process of this box's, only files in work/; never the words for a process whose box was replaced.
  assert.match(said[1].text, /^0 of at most 8 running\.\n99: was not started in this box \(only its files in work\/ remain\);/);
  assert.match(said[2].text, /background process 99 was not started in this box \(only its files in work\/ remain\), so no signal was sent/);
  assert.ok(!said[1].text.includes("box was replaced") && !said[2].text.includes("box was replaced"), `${said[1].text}\n${said[2].text}`);
  assert.equal(groupAlive(other), true, "a call never signals it");
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  assert.equal(groupAlive(other), true, "nor the run's end");
});

test("a link to a directory planted at a display name is replaced, never moved into: the directory it names gets nothing", { timeout: 120_000 }, async (t) => {
  const outside = await scratch(t);
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30" } },
    { tool: "bash", args: { command: `ln -s ${outside} background/1/ended; ln -s ${outside} background/1/exit` } },
  ];
  const { said, data, work } = await boxedRun(t, plan, { before: (data) => slowExitCopy(t, data) });
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  assert.deepEqual(readdirSync(outside), [], "nothing was moved into the directory the links name");
  for (const name of ["ended", "exit"]) assert.equal(lstatSync(join(work, "background", "1", name)).isFile(), true, `${name} is a file of its own now`);
  assert.deepEqual(readdirSync(join(work, "background", "1")).filter((name) => name.startsWith(".put.")), [], "no temporary file is left");
});

test("on a terminal too, a pid written into work/ is no group a signal goes to: TERM ends process 1's own terminal command, and the forged group lives on", { timeout: 120_000 }, async (t) => {
  const other = decoy(t);
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30", tty: true } },
    { tool: "write", args: { path: "background/1/pid", content: String(other) } },
    { tool: "write", args: { path: "background/1/tty", content: "" } },
    { tool: "bash_signal", args: { id: "1", signal: "TERM" } },
  ];
  const { said, data } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.equal(said[3].text, "Sent TERM to background process 1: it ended by signal TERM (exit code 143).");
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  assert.equal(groupAlive(other), true, "the forged group was never signalled, by the call or by the run's end");
});

test("a tty mark written into work/ makes no plain process a terminal one: its signal goes to its own group", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30" } },
    { tool: "write", args: { path: "background/1/tty", content: "" } },
    { tool: "bash_list", args: {} },
    { tool: "bash_signal", args: { id: "1", signal: "INT" } },
  ];
  const { said } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.ok(!said[2].text.includes("(tty)"), said[2].text);
  assert.equal(said[3].text, "Sent INT to background process 1: it ended by signal INT (exit code 130).");
});

test("a real directory planted at a display name gets no temporary file: the copy is skipped, never moved into it", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30" } },
    { tool: "bash", args: { command: "mkdir background/1/exit background/1/ended" } },
  ];
  const { said, data, work } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  for (const name of ["exit", "ended"]) assert.deepEqual(readdirSync(join(work, "background", "1", name)), [], `nothing was moved into the directory at ${name}`);
  assert.deepEqual(readdirSync(join(work, "background", "1")).filter((name) => name.startsWith(".put.")), [], "no temporary file is left");
  assert.equal(groupAlive(groupOf(said[0].text)), false, "process 1 was ended at the run's end all the same");
});

test("links planted at command and started after the start are replaced at the run's end by the process's own copies", { timeout: 120_000 }, async (t) => {
  const outside = await scratch(t);
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET-TEXT-OUTSIDE-WORK\n");
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30" } },
    { tool: "bash", args: { command: `ln -sf ${secret} background/1/command; ln -sf ${secret} background/1/started` } },
  ];
  const { said, data, work } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  for (const name of ["command", "started"]) assert.equal(lstatSync(join(work, "background", "1", name)).isFile(), true, `${name} is a file of its own again`);
  assert.equal(readFileSync(join(work, "background", "1", "command"), "utf8"), "sleep 30");
  assert.match(readFileSync(join(work, "background", "1", "started"), "utf8"), /^\d{4}-\d\d-\d\dT[\d:]+Z\n$/);
  assert.equal(readFileSync(secret, "utf8"), "SECRET-TEXT-OUTSIDE-WORK\n", "the file the links named is as it was");
});

test("links planted at pid and tty are replaced at the run's end by the process's own copies, as command and started are", { timeout: 120_000 }, async (t) => {
  const outside = await scratch(t);
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET-TEXT-OUTSIDE-WORK\n");
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30", tty: true } },
    { tool: "bash", args: { command: `ln -sf ${secret} background/1/pid; ln -sf ${secret} background/1/tty` } },
  ];
  const { said, data, work } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  for (const name of ["pid", "tty"]) assert.equal(lstatSync(join(work, "background", "1", name)).isFile(), true, `${name} is a file of its own again`);
  assert.equal(readFileSync(join(work, "background", "1", "pid"), "utf8"), `${groupOf(said[0].text)}\n`);
  assert.equal(readFileSync(join(work, "background", "1", "tty"), "utf8"), "");
  assert.equal(readFileSync(secret, "utf8"), "SECRET-TEXT-OUTSIDE-WORK\n");
});

test("links planted at tty and capped of a process that has neither are removed at the run's end", { timeout: 120_000 }, async (t) => {
  const outside = await scratch(t);
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET-TEXT-OUTSIDE-WORK\n");
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30" } },
    { tool: "bash", args: { command: `ln -sf ${secret} background/1/tty; ln -sf ${secret} background/1/capped` } },
  ];
  const { said, data, work } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  const names = readdirSync(join(work, "background", "1"));
  assert.ok(!names.includes("tty") && !names.includes("capped"), JSON.stringify(names));
  assert.equal(readFileSync(secret, "utf8"), "SECRET-TEXT-OUTSIDE-WORK\n", "the file the links named is as it was");
});
