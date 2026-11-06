// Background processes in a sandbox run's box (background.ts): bash_background starts a command and answers its id at
// once; bash_output pages its log by byte offset with its state and exit code; bash_input writes its stdin; bash_signal
// sends its group TERM, INT or KILL; bash_list lists them; the per-run cap refuses in words; the run's end ends every one
// of them; the log stays in the run's files. Each test is a run through the API on the faux probe model (one tool call
// a turn, fixtures/faux-probe.mjs), in the faux box (fixtures/faux-box.mjs: pi-transport's local box standing in for
// Docker, so no docker command runs).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_LOG_BYTES, BACKGROUND_MAX } from "../dist/background.js";
import { fauxRoot } from "./fixtures/faux-box.mjs";
import { follow, serve } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_BOX = new URL("./fixtures/faux-box.mjs", import.meta.url).pathname;
const SANDBOX = { mode: "sandbox", box: "docker" };
const TOOLS = ["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"];

/** Each tool call of run `runId` and its answer, in order, from its store. */
function answers(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
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
/** Whether process group `group` has a process left. */
const groupAlive = (group) => {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
};

async function boxedRun(t, plan) {
  const logged = [];
  const server = await serve(t, { faux: PROBE, fauxBox: FAUX_BOX, log: (line) => void logged.push(line) });
  const { api } = server;
  const made = await api("POST", "/agents", { definition: { id: "bg", name: "bg", instructions: "Probe.", place: SANDBOX, tools: TOOLS } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", "/agents/bg/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 90_000 });
  const work = join(server.data, "runs", run.body.run_id, "work");
  return { ...server, runId: run.body.run_id, said: answers(server.data, run.body.run_id), work, logged };
}

const wait = (seconds) => ({ tool: "bash", args: { command: `sleep ${seconds}` } });

test("demo: the agent starts `sleep 30; echo done` in the background, lists it, signals it and sees it gone; its log is in the run's files", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "echo started; sleep 30; echo done" } },
    { tool: "bash_list", args: {} },
    { tool: "bash_signal", args: { id: "1", signal: "TERM" } },
    { tool: "bash_list", args: {} },
    { tool: "bash_output", args: { id: "1" } },
  ];
  const started = Date.now();
  const { api, said, runId, work, data } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.match(said[0].text, /^Started background process 1 \(process group \d+\)\. Its output goes to background\/1\/output\.log in work\//);
  assert.match(said[1].text, /^1 of at most 8 running\.\n1: is running; \d+ bytes of output; started \d{4}-\d\d-\d\dT[\d:]+Z; "echo started; sleep 30; echo done"$/);
  assert.equal(said[2].text, "Sent TERM to background process 1: it ended by signal TERM (exit code 143).");
  // bash may say how its child ended ("Terminated"), as it does in a terminal.
  assert.match(said[3].text, /^0 of at most 8 running\.\n1: ended by signal TERM \(exit code 143\); (8|19) bytes of output;/);
  assert.match(said[4].text, /^Background process 1 ended by signal TERM \(exit code 143\)\. Output bytes 0 to (8|19) of (8|19), the end\.\n\nstarted\n(Terminated\n)?$/);
  assert.ok(Date.now() - started < 30_000, "the run did not wait out the sleep");
  // The log and its state are in the run's files, through the API.
  const files = (await api("GET", `/runs/${runId}/files`)).body.files.map((f) => f.path);
  for (const name of ["output.log", "command", "exit", "pid", "started"]) assert.ok(files.includes(`background/1/${name}`), `${name} in ${JSON.stringify(files)}`);
  assert.match((await api("GET", `/runs/${runId}/files/background/1/output.log`)).body, /^started\n(Terminated\n)?$/);
  assert.equal(readFileSync(join(work, "background", "1", "exit"), "utf8"), "143\n");
  assert.equal(readFileSync(join(work, "background", "1", "command"), "utf8"), plan[0].args.command);
  // No fifo, socket or other non-regular file is left in work/ (a remote box's pull refuses one).
  assert.deepEqual(readdirSync(join(work, "background", "1")).sort(), ["command", "exit", "output.log", "pid", "started"]);
  assert.equal(groupAlive(Number(readFileSync(join(work, "background", "1", "pid"), "utf8"))), false, "its group is gone");
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
});

test("start, then page by byte offset, then the exit code; a page never splits a character; an unknown id is refused in words", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "printf 'one\\n'; sleep 0.2; printf 'two\\n'; printf '\\342\\202\\254!'; exit 3" } },
    wait(1.5),
    { tool: "bash_output", args: { id: "1", max_bytes: 4 } },
    { tool: "bash_output", args: { id: "1", offset: 4, max_bytes: 5 } },
    { tool: "bash_output", args: { id: "1", offset: 8 } },
    { tool: "bash_output", args: { id: "1", offset: 12 } },
    { tool: "bash_output", args: { id: "99" } },
    { tool: "bash_signal", args: { id: "1", signal: "KILL" } },
    { tool: "bash_input", args: { id: "1", text: "late\n" } },
    // A page smaller than the one character it starts with reads nothing, and says what to ask.
    { tool: "bash_output", args: { id: "1", offset: 8, max_bytes: 2 } },
  ];
  const { said } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step, i) => [step.tool, i >= 6]), JSON.stringify(said));
  assert.match(said[9].text, /the character at byte 8 of background process 1's output is longer than max_bytes 2: ask again with max_bytes 4 or more/);
  assert.equal(said[2].text, "Background process 1 exited with code 3. Output bytes 0 to 4 of 12; call again with offset 4 for the next part.\n\none\n");
  // Five bytes asked from 4: "two\n" and the first byte of the euro sign, which is left for the next page.
  assert.equal(said[3].text, "Background process 1 exited with code 3. Output bytes 4 to 8 of 12; call again with offset 8 for the next part.\n\ntwo\n");
  assert.equal(said[4].text, "Background process 1 exited with code 3. Output bytes 8 to 12 of 12, the end.\n\n€!");
  assert.equal(said[5].text, "Background process 1 exited with code 3. No output past byte 12 (the log has 12 bytes).");
  assert.match(said[6].text, /there is no background process 99 in this run: bash_list shows them/);
  assert.match(said[7].text, /background process 1 exited with code 3, so no signal was sent/);
  assert.match(said[8].text, /background process 1 exited with code 3, so it takes no input/);
});

test("a child the command leaves running keeps the process running until its group is empty: listed, counted, and ended by a signal to the group", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "sleep 60 >/dev/null 2>&1 & echo parent done" } },
    wait(1),
    { tool: "bash_output", args: { id: "1" } },
    { tool: "bash_list", args: {} },
    { tool: "bash_signal", args: { id: "1", signal: "TERM" } },
  ];
  const { said, work } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.equal(said[2].text, "Background process 1 is running. Output bytes 0 to 12 of 12, all of it so far; call again with offset 12 for what comes next.\n\nparent done\n");
  assert.match(said[3].text, /^1 of at most 8 running\.\n1: is running;/);
  // The shell itself exited 0; its child ended with the TERM, and only then is the process done.
  assert.equal(said[4].text, "Sent TERM to background process 1: it exited with code 0.");
  assert.equal(groupAlive(Number(readFileSync(join(work, "background", "1", "pid"), "utf8"))), false, "its group is gone");
});

test("stdin reaches a `read` loop, line by line; close: true ends its input", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "while read -r line; do echo \"got $line\"; [ \"$line\" = stop ] && exit 0; done; echo eof" } },
    { tool: "bash_input", args: { id: "1", text: "hello\n" } },
    wait(0.5),
    { tool: "bash_output", args: { id: "1" } },
    { tool: "bash_input", args: { id: "1", text: "stop\n" } },
    wait(0.5),
    { tool: "bash_output", args: { id: "1", offset: 10 } },
    { tool: "bash_background", args: { command: "cat; echo \" (end of input)\"" } },
    { tool: "bash_input", args: { id: "2", text: "abc", close: true } },
    wait(0.5),
    { tool: "bash_output", args: { id: "2" } },
  ];
  const { said } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.equal(said[1].text, "Wrote 6 bytes to background process 1's stdin. Read what it answers with bash_output.");
  assert.equal(said[3].text, "Background process 1 is running. Output bytes 0 to 10 of 10, all of it so far; call again with offset 10 for what comes next.\n\ngot hello\n");
  assert.equal(said[6].text, "Background process 1 exited with code 0. Output bytes 10 to 19 of 19, the end.\n\ngot stop\n");
  assert.equal(said[8].text, "Wrote 3 bytes to background process 2's stdin, then closed it. Read what it answers with bash_output.");
  assert.equal(said[10].text, "Background process 2 exited with code 0. Output bytes 0 to 19 of 19, the end.\n\nabc (end of input)\n");
});

test("a signal ends it: INT as Ctrl-C, and KILL where TERM is ignored", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "sleep 30; echo done" } },
    { tool: "bash_signal", args: { id: "1", signal: "INT" } },
    { tool: "bash_background", args: { command: "trap '' TERM; echo stubborn; sleep 30" } },
    wait(0.3),
    { tool: "bash_signal", args: { id: "2", signal: "TERM" } },
    { tool: "bash_signal", args: { id: "2", signal: "KILL" } },
    { tool: "bash_signal", args: { id: "2", signal: "HUP" } },
  ];
  const { said, work } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step, i) => [step.tool, i === 6]), JSON.stringify(said));
  assert.equal(said[1].text, "Sent INT to background process 1: it ended by signal INT (exit code 130).");
  assert.equal(said[4].text, "Sent TERM to background process 2: it is running. Send KILL to end it at once.");
  assert.equal(said[5].text, "Sent KILL to background process 2: it ended by signal KILL (exit code 137).");
  assert.match(said[6].text, /signal: must be equal to one of the allowed values/);
  for (const id of ["1", "2"]) assert.equal(groupAlive(Number(readFileSync(join(work, "background", id, "pid"), "utf8"))), false, `${id}'s group is gone`);
});

test(`the per-run cap (${BACKGROUND_MAX} at once) refuses in plain words, and the run's end ends every process, each log kept`, { timeout: 150_000 }, async (t) => {
  const plan = [
    ...Array.from({ length: BACKGROUND_MAX }, (_, i) => ({ tool: "bash_background", args: { command: `echo p${i + 1}; sleep 60` } })),
    { tool: "bash_background", args: { command: "echo one too many" } },
    { tool: "bash_list", args: {} },
  ];
  const { said, work, data, runId, api, logged } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step, i) => [step.tool, i === BACKGROUND_MAX]), JSON.stringify(said));
  assert.match(said[BACKGROUND_MAX].text, new RegExp(`${BACKGROUND_MAX} background processes already run in this run's box, the most at once \\(${BACKGROUND_MAX}\\): end one with bash_signal \\(bash_list shows them\\), or wait for one to exit, then start this again\\.`));
  assert.match(said[BACKGROUND_MAX + 1].text, new RegExp(`^${BACKGROUND_MAX} of at most ${BACKGROUND_MAX} running\\.`));
  assert.equal(existsSync(join(work, "background", String(BACKGROUND_MAX + 1))), false, "the refused one made nothing");
  // The run's end: each one's group got TERM, its runner wrote its exit code, and it is marked as ended at the run's end.
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  for (let i = 1; i <= BACKGROUND_MAX; i++) {
    const dir = join(work, "background", String(i));
    assert.equal(readFileSync(join(dir, "exit"), "utf8"), "143\n", `${i} ended by TERM`);
    assert.ok(existsSync(join(dir, "ended")), `${i} is marked as ended at the run's end`);
    assert.match(readFileSync(join(dir, "output.log"), "utf8"), new RegExp(`^p${i}\n(Terminated\n)?$`));
    assert.equal(groupAlive(Number(readFileSync(join(dir, "pid"), "utf8"))), false, `${i}'s group is gone`);
  }
  const files = (await api("GET", `/runs/${runId}/files`)).body.files.map((f) => f.path);
  assert.ok(files.includes(`background/${BACKGROUND_MAX}/output.log`), JSON.stringify(files));
  // The server's log says it.
  const line = logged.find((l) => l.includes("background_ended"));
  assert.ok(line?.includes(runId) && line.includes(String(BACKGROUND_MAX)), JSON.stringify(logged.filter((l) => l.includes("box") || l.includes("background"))));
});

test(`a log keeps its first ${BACKGROUND_LOG_BYTES / (1024 * 1024)} MiB, and the process runs on past the cap`, { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: `head -c ${BACKGROUND_LOG_BYTES + 4096} /dev/zero | tr '\\0' x; echo; echo after the cap >&2; exit 4` } },
    wait(3),
    { tool: "bash_output", args: { id: "1", offset: BACKGROUND_LOG_BYTES - 3 } },
  ];
  const { said, work } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.equal(said[2].text, `Background process 1 exited with code 4. Output bytes ${(BACKGROUND_LOG_BYTES - 3).toLocaleString("en-US")} to ${BACKGROUND_LOG_BYTES.toLocaleString("en-US")} of ${BACKGROUND_LOG_BYTES.toLocaleString("en-US")}, the end. Its log reached the 16 MiB cap, so later output was dropped.\n\nxxx`);
  assert.ok(existsSync(join(work, "background", "1", "capped")));
});

// tty: true runs the command on a terminal in the box (`script -qfec`), so a program that needs one works; paging, input
// and signals are the same calls.
test("tty: a tty process sits on a /dev/pts terminal, a plain one has none; a prompt answers over bash_input; INT reaches the terminal's process", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "tty", tty: true } },
    { tool: "bash_background", args: { command: "tty" } },
    { tool: "bash_background", args: { command: "read -r -p 'name? ' n; echo \"hello $n\"", tty: true } },
    wait(1),
    { tool: "bash_output", args: { id: "1" } },
    { tool: "bash_output", args: { id: "2" } },
    { tool: "bash_output", args: { id: "3" } },
    { tool: "bash_input", args: { id: "3", text: "bob\n" } },
    { tool: "bash_background", args: { command: "trap 'echo caught INT' INT; echo ready; while :; do sleep 0.1; done", tty: true } },
    wait(1),
    { tool: "bash_signal", args: { id: "4", signal: "INT" } },
    { tool: "bash_output", args: { id: "3" } },
    { tool: "bash_output", args: { id: "4" } },
    { tool: "bash_signal", args: { id: "4", signal: "KILL" } },
    { tool: "bash_list", args: {} },
    // Left running on its terminal: the run's end ends it too.
    { tool: "bash_background", args: { command: "sleep 60", tty: true } },
  ];
  const { said, work, data } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.match(said[15].text, /^Started background process 5 \(process group \d+\) on a terminal\./);
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
  assert.equal(readFileSync(join(work, "background", "5", "exit"), "utf8"), "143\n", "TERM at the run's end reached the terminal's command");
  assert.ok(existsSync(join(work, "background", "5", "ended")));
  assert.match(said[4].text, /^Background process 1 exited with code 0\. .*\n\n\/dev\/pts\/\d+\r?\n$/s);
  assert.match(said[5].text, /^Background process 2 exited with code 1\. .*\n\nnot a tty\n$/s);
  // bash prints read's prompt only to a terminal; the answer is echoed by the terminal, then the reply follows.
  assert.match(said[6].text, /^Background process 3 is running\. .*\n\nname\? $/s);
  assert.equal(said[7].text, "Wrote 4 bytes to background process 3's stdin. Read what it answers with bash_output.");
  assert.match(said[10].text, /^Sent INT to background process 4: it is running\./);
  assert.match(said[11].text, /^Background process 3 exited with code 0\. .*\n\nname\? bob\r?\nhello bob\r?\n$/s);
  assert.match(said[12].text, /\n\nready\r?\n(.*\r?\n)*caught INT\r?\n/);
  assert.match(said[13].text, /^Sent KILL to background process 4: it ended by signal KILL \(exit code 137\)\./);
  assert.match(said[14].text, /^0 of at most 8 running\.\n4: ended by signal KILL[^\n]*\(tty\)/);
  for (const id of ["1", "3", "4"]) assert.ok(existsSync(join(work, "background", id, "tty")), `${id} is marked tty`);
  assert.equal(existsSync(join(work, "background", "2", "tty")), false);
});

test("tty: INT is Ctrl-C to the terminal's foreground job, so an interactive shell's command stops and the shell runs on", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "bash --norc --noprofile -i", tty: true } },
    wait(1),
    { tool: "bash_input", args: { id: "1", text: "sleep 60\n" } },
    wait(1),
    { tool: "bash_signal", args: { id: "1", signal: "INT" } },
    { tool: "bash_input", args: { id: "1", text: "echo back $?\n" } },
    wait(1),
    { tool: "bash_output", args: { id: "1" } },
    { tool: "bash_input", args: { id: "1", text: "exit\n" } },
  ];
  const started = Date.now();
  const { said } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.match(said[4].text, /^Sent INT to background process 1: it is running\./);
  // The shell got its prompt back: sleep ended by Ctrl-C (130), well before its 60 s.
  assert.match(said[7].text, /back 130/);
  assert.ok(Date.now() - started < 50_000, "sleep 60 did not run out");
});

test("tty: a child the terminal command leaves running keeps the process running, and a signal reaches it after its shell is gone", { timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: "bash_background", args: { command: "trap '' HUP; sleep 60 </dev/null >/dev/null 2>&1 & echo $! > child.pid; echo done", tty: true } },
    wait(1.5),
    { tool: "bash_output", args: { id: "1" } },
    { tool: "bash_list", args: {} },
    { tool: "bash_signal", args: { id: "1", signal: "TERM" } },
  ];
  const { said, work } = await boxedRun(t, plan);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  const child = Number(readFileSync(join(work, "child.pid"), "utf8"));
  assert.match(said[2].text, /^Background process 1 is running\./);
  assert.match(said[3].text, /^1 of at most 8 running\.\n1: is running;/);
  assert.equal(said[4].text, "Sent TERM to background process 1: it exited with code 0.");
  let alive = true;
  try { process.kill(child, 0); } catch { alive = false; }
  assert.equal(alive, false, "the child left on the terminal is gone");
});
