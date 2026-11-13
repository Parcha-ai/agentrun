// The kernel's one tool registry: every model-visible host tool's definition, words and limits; the tool gate's shell
// family and its defaults; bash bounded to the hands' ceiling; the five background tools on the computer's processes
// (the computer module's reference behaviour), refused in words with none; and a registry that lacks an executor for a
// tool the model sees is refused when it is built.
import assert from "node:assert/strict";
import { readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BACKGROUND_MAX,
  BASH_DEFAULT_TIMEOUT_S,
  createRegistry,
  defaultPermissionOf,
  endBackground,
  exitCodeOf,
  hostToolDefs,
  NO_SHELL,
  SHELL_FAMILY,
  SHELL_WATCHERS,
  shellPermission,
} from "@parcha/agentrun-kernel/kernel";
import { localHands, until } from "./registry-support.mjs";

const BACKGROUND = ["bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"];
const COMPUTER = ["read", "write", "edit", "bash", ...BACKGROUND];
const NONE = ["read", "write", "edit"];
const LOCAL = ["read", "write", "edit", "bash"];
const answer = (text) => async () => ({ text });
/** The ruled refusal of every background tool with no computer, in Mode 1 or Mode 2. */
const NEEDS_A_COMPUTER = "Background programs need a computer: run this agent with a sandbox computer (Settings → Computers; place sandbox in the v2 API).";
/** A call's failure, in its words: an executor answers a failure, and only an abort throws. */
const errorOf = async (call) => (await call).error;
const injected = { read: answer("read"), write: answer("write"), edit: answer("edit"), bash: answer("bash") };

test("the model-visible tools, by name and in order: main's box list on a computer, its runner list with no shell", () => {
  assert.deepEqual(hostToolDefs({ maxExecS: 600, shell: "computer" }).map((tool) => tool.name), COMPUTER);
  assert.deepEqual(hostToolDefs({ maxExecS: 600, shell: "none" }).map((tool) => tool.name), NONE);
  assert.deepEqual(createRegistry({ maxExecS: 600, shell: "computer", executors: injected }).list().map((tool) => tool.name), COMPUTER);
});

test("ruled change: with no computer, bash runs in the run's folder (asked first), and the background tools are not offered", () => {
  assert.deepEqual(hostToolDefs({ maxExecS: 600, shell: "local" }).map((tool) => tool.name), LOCAL);
  assert.equal(defaultPermissionOf("bash", { computer: false }), "ask");
  for (const name of BACKGROUND) assert.equal(defaultPermissionOf(name, { computer: false }), "deny", name);
  assert.equal(defaultPermissionOf("bash", { computer: true }), "allow");
  for (const name of BACKGROUND) assert.equal(defaultPermissionOf(name, { computer: true }), "allow", name);
  assert.equal(defaultPermissionOf("read", { computer: false }), "allow");
});

test("ruled change: a background tool called with no computer is refused in words, never run on the host", async () => {
  const { hands } = localHands();
  const registry = createRegistry({ maxExecS: 600, shell: "local", executors: injected });
  const refused = await registry.invoke("bash_background", { command: "sleep 1" }, { hands });
  assert.equal(refused.error, NEEDS_A_COMPUTER);
});

test("a registry missing an executor for a tool the model sees is refused when it is built, naming the tool", () => {
  assert.throws(() => createRegistry({ maxExecS: 600, shell: "computer", executors: { read: answer("r"), write: answer("w"), edit: answer("e") } }), /bash/);
  assert.throws(() => createRegistry({ maxExecS: 600, shell: "none", executors: { read: answer("r"), write: answer("w") } }), /edit/);
  // With no shell the model never sees bash, so its run is not needed.
  assert.doesNotThrow(() => createRegistry({ maxExecS: 600, shell: "none", executors: { read: answer("r"), write: answer("w"), edit: answer("e") } }));
});

test("the shell family: bash and the five background tools are held to bash's setting, and the watchers run unasked under ask", () => {
  assert.deepEqual(Object.keys(SHELL_FAMILY), ["bash", ...BACKGROUND]);
  assert.ok(Object.values(SHELL_FAMILY).every((key) => key === "bash"));
  assert.deepEqual([...SHELL_WATCHERS].sort(), ["bash_list", "bash_output", "bash_signal"]);
  assert.equal(shellPermission("bash_output", "ask"), "allow");
  assert.equal(shellPermission("bash_background", "ask"), "ask");
  assert.equal(shellPermission("bash_output", "deny"), "deny");
});

test("bash is bounded: no timeout runs at the default, more than the hands' ceiling runs at the ceiling and says so", async () => {
  const seen = [];
  const base = async (args) => {
    seen.push(args.timeout);
    if (args.command === "slow") return { text: "", error: "Command timed out after 295 seconds" };
    return { text: "ok" };
  };
  const { hands } = localHands({ maxExecS: 295 });
  const registry = createRegistry({ maxExecS: 295, shell: "computer", executors: { ...injected, bash: base } });
  await registry.invoke("bash", { command: "true" }, { hands });
  assert.equal(seen[0], BASH_DEFAULT_TIMEOUT_S);
  const capped = await registry.invoke("bash", { command: "true", timeout: 900 }, { hands });
  assert.equal(seen[1], 295);
  assert.match(capped.diagnostics.at(-1).message, /at most 295 s: this one ran with 295 s, not the 900 s asked/);
  assert.match((await registry.invoke("bash", { command: "slow", timeout: 900 }, { hands })).error, /^Command timed out after 295 seconds\. bash runs a command for at most 295 s/);
  const words = hostToolDefs({ maxExecS: 295, shell: "computer" }).find((tool) => tool.name === "bash");
  assert.match(words.description, /at most 295 s; for longer work use bash_background\.$/);
});

test("a failure is an answer, its words apart from the output: a timed-out bash keeps what it printed first, then the timeout and the cap's words", async () => {
  // bash's own run over the hands, as a host gives it: the output as text, a timeout as the answer's error.
  const run = async (args, call) => {
    let out = "";
    const ended = await call.hands.exec(args.command, { timeoutS: args.timeout, onOutput: ({ data }) => void (out += data) });
    return ended.timedOut ? { text: out, error: `Command timed out after ${args.timeout} seconds` } : { text: out };
  };
  const { hands } = localHands({ maxExecS: 1 });
  const r = createRegistry({ maxExecS: 1, shell: "computer", executors: { ...injected, bash: run } });
  const said = await r.invoke("bash", { command: "echo before; sleep 30", timeout: 5 }, { hands });
  assert.equal(said.text, "before\n");
  assert.equal(said.error, "Command timed out after 1 seconds. bash runs a command for at most 1 s: this one ran with 1 s, not the 5 s asked. For longer work use bash_background.");
  assert.equal([said.text, said.error].join("\n\n"), "before\n\n\nCommand timed out after 1 seconds. bash runs a command for at most 1 s: this one ran with 1 s, not the 5 s asked. For longer work use bash_background.");
});

test("only an abort throws: a call whose signal has aborted rejects instead of answering", async () => {
  const { hands } = localHands({ processes: true });
  const aborted = AbortSignal.abort();
  await assert.rejects(registry().invoke("bash_list", {}, { hands, signal: aborted }), (error) => error.name === "AbortError");
});

test("an exec ended by a signal reads as 128 + n; one with a code reads as its code", () => {
  assert.equal(exitCodeOf({ exitCode: null, signal: "SIGKILL", timedOut: false }), 137);
  assert.equal(exitCodeOf({ exitCode: null, signal: "TERM", timedOut: true }), 143);
  assert.equal(exitCodeOf({ exitCode: 3, signal: null, timedOut: false }), 3);
  // Every signal the system names, not only the common eight: SIGSEGV is 11, SIGUSR1 10 (Linux).
  assert.equal(exitCodeOf({ exitCode: null, signal: "SIGSEGV", timedOut: false }), 139);
  assert.equal(exitCodeOf({ exitCode: null, signal: "USR1", timedOut: false }), 138);
  assert.equal(exitCodeOf({ exitCode: null, signal: "NOSUCHSIGNAL", timedOut: false }), undefined);
});

const registry = () => createRegistry({ maxExecS: 600, shell: "computer", executors: injected });

test("the background tools run on the computer's processes: start, read, write stdin, list, signal, and the run's end ends them", async (t) => {
  const { root, hands } = localHands({ processes: true });
  t.after(() => hands.processes.reap());
  const call = (name, args) => registry().invoke(name, args, { hands });
  const started = await call("bash_background", { command: "echo hello; read line; echo got $line" });
  assert.match(started.text, /^Started background process 1 \(process group \d+\)\. Its output goes to background\/1\/output\.log in work\/: read it with bash_output \{"id": "1"\}, write its stdin with bash_input, end it with bash_signal\.$/);
  assert.equal(started.details.id, "1");
  await until(async () => (await call("bash_output", { id: "1" })).text.includes("hello"), "the first line");
  const sent = await call("bash_input", { id: "1", text: "there\n" });
  assert.equal(sent.text, "Wrote 6 bytes to background process 1's stdin. Read what it answers with bash_output.");
  await until(async () => /exited with code 0/.test((await call("bash_output", { id: "1" })).text), "the exit");
  const read = await call("bash_output", { id: "1" });
  assert.equal(read.text, "Background process 1 exited with code 0. Output bytes 0 to 16 of 16, the end.\n\nhello\ngot there\n");
  const past = await call("bash_output", { id: "1", offset: 40 });
  assert.equal(past.text, "Background process 1 exited with code 0. No output past byte 40 (the log has 16 bytes).");
  assert.equal(readFileSync(join(root, "background", "1", "output.log"), "utf8"), "hello\ngot there\n");
  assert.equal(await errorOf(call("bash_input", { id: "1", text: "more" })), "background process 1 exited with code 0, so it takes no input");
  const sleeper = await call("bash_background", { command: "sleep 30" });
  assert.equal(sleeper.details.id, "2");
  const listed = await call("bash_list", {});
  assert.match(listed.text, new RegExp(`^1 of at most ${BACKGROUND_MAX} running\\.\\n2: is running; 0 bytes of output; started \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ; "sleep 30"\\n1: exited with code 0; 16 bytes of output;`));
  const signalled = await call("bash_signal", { id: "2", signal: "TERM" });
  assert.equal(signalled.text, "Sent TERM to background process 2: it ended by signal TERM (exit code 143).");
  // A process that ignores TERM: the run's end KILLs it 3 s later. It is ready once it has said so.
  await call("bash_background", { command: "trap '' TERM; echo ready; sleep 30" });
  await until(async () => (await call("bash_output", { id: "3" })).text.includes("ready"), "the TERM-ignoring process to be ready");
  assert.equal(await endBackground(hands), 1);
  await until(async () => (await hands.processes.list()).every((p) => !p.running), "the run's end to end them all");
  assert.equal(await errorOf(call("bash_output", { id: "9" })), "there is no background process 9 in this run: bash_list shows them");
  assert.match(await errorOf(call("bash_signal", { id: "../1", signal: "TERM" })), /^"\.\.\/1" is no background process id/);
});

test("nine starts at once start eight: the cap's count, the id and the start are one step", async (t) => {
  const { hands } = localHands({ processes: true });
  t.after(() => hands.processes.reap());
  const r = registry();
  const all = await Promise.all(Array.from({ length: 9 }, (_, i) => r.invoke("bash_background", { command: `echo q${i}; sleep 30` }, { hands })));
  assert.equal(all.filter((one) => one.error === undefined).length, 8);
  const refused = all.filter((one) => one.error !== undefined);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].error, "8 background processes already run in this run's box, the most at once (8): end one with bash_signal (bash_list shows them), or wait for one to exit, then start this again.");
  assert.equal(hands.processes.starts, 8);
  assert.match((await r.invoke("bash_list", {}, { hands })).text, /^8 of at most 8 running\./);
  assert.equal(await endBackground(hands), 8);
});

test("a call reaches only a process bash_background started: anything else on the computer is no background process", async (t) => {
  const { hands } = localHands({ processes: true });
  t.after(() => hands.processes.reap());
  await hands.processes.start({ argv: ["bash", "-c", "sleep 30", "agentrun-bash", "1", "sleep 30"], cwd: ".", log: "other/1/output.log", waitGroup: true, orphans: "keep" });
  const r = registry();
  assert.equal(await errorOf(r.invoke("bash_signal", { id: "1", signal: "KILL" }, { hands })), "there is no background process 1 in this run: bash_list shows them");
  assert.equal((await r.invoke("bash_list", {}, { hands })).text, "No background processes in this run's box: bash_background starts one.");
  assert.equal(await endBackground(hands), 0);
});

test("a link at work/background starts nothing, and a closed stdin says so", async (t) => {
  const { root, hands } = localHands({ processes: true });
  t.after(() => hands.processes.reap());
  const r = registry();
  symlinkSync(tmpdir(), join(root, "background"));
  assert.equal(await errorOf(r.invoke("bash_background", { command: "true" }, { hands })), "work/background is a link, so no background process starts: remove it, and its logs go in a directory of their own again");
  unlinkSync(join(root, "background"));
  await r.invoke("bash_background", { command: "cat" }, { hands });
  await r.invoke("bash_input", { id: "1", text: "", close: true }, { hands });
  await until(async () => /exited/.test((await r.invoke("bash_output", { id: "1" }, { hands })).text), "cat to end");
  await r.invoke("bash_background", { command: "sleep 30" }, { hands });
  await r.invoke("bash_input", { id: "2", text: "", close: true }, { hands });
  assert.equal(await errorOf(r.invoke("bash_input", { id: "2", text: "x" }, { hands })), "background process 2's stdin is closed: an earlier bash_input closed it");
});

test("a start cancelled while it waits its turn never starts, and answers as aborted", async (t) => {
  const { hands } = localHands({ processes: true });
  t.after(() => hands.processes.reap());
  let release;
  const held = new Promise((done) => (release = done));
  hands.processes.beforeStart = () => held;
  const r = registry();
  const first = r.invoke("bash_background", { command: "sleep 30" }, { hands });
  const cancel = new AbortController();
  const second = r.invoke("bash_background", { command: "sleep 30" }, { hands, signal: cancel.signal });
  await new Promise((done) => setTimeout(done, 50));
  cancel.abort();
  hands.processes.beforeStart = async () => {};
  release();
  assert.match((await first).text, /^Started background process 1 /);
  await assert.rejects(second, (error) => error.name === "AbortError");
  assert.equal(hands.processes.starts, 1);
  assert.match((await r.invoke("bash_list", {}, { hands })).text, /^1 of at most 8 running\.\n1: is running;/);
});

test("closing a terminal's input after an earlier partial line ends the input: its line is sent, then the end", async (t) => {
  const { hands } = localHands({ processes: true });
  t.after(() => hands.processes.reap());
  const r = registry();
  await r.invoke("bash_background", { command: "cat", tty: true }, { hands });
  await r.invoke("bash_input", { id: "1", text: "hello" }, { hands });
  const closed = await r.invoke("bash_input", { id: "1", text: "", close: true }, { hands });
  assert.equal(closed.text, "Wrote 0 bytes to background process 1's stdin, then closed it. Read what it answers with bash_output.");
  await until(async () => /exited with code 0/.test((await r.invoke("bash_output", { id: "1" }, { hands })).text), "cat to end on the end of its input");
  assert.match((await r.invoke("bash_output", { id: "1" }, { hands })).text, /\n\nhello$/);
});

test("with no shell, bash is not listed, and a call of it anyway is refused in words that say how to get one, its executor never run", async () => {
  const ran = [];
  const r = createRegistry({ maxExecS: 600, shell: "none", executors: { ...injected, bash: async () => (ran.push("bash"), { text: "ran" }) } });
  assert.deepEqual(r.list().map((tool) => tool.name), NONE);
  const { hands } = localHands();
  assert.equal(await errorOf(r.invoke("bash", { command: "true" }, { hands })), NO_SHELL);
  assert.match(NO_SHELL, /^bash is not available in this run: .*sandbox computer/);
  assert.deepEqual(ran, []);
});

test("with no computer's processes, each background tool refuses in words, and the run's end ends none", async () => {
  const { hands } = localHands();
  const r = registry();
  for (const name of BACKGROUND) {
    assert.equal(await errorOf(r.invoke(name, { id: "1", command: "true", signal: "TERM", text: "x" }, { hands })), NEEDS_A_COMPUTER, name);
  }
  assert.equal(await endBackground(hands), 0);
});
