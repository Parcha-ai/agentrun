// The kernel's one tool registry: every model-visible host tool's definition, words and limits; the tool gate's shell
// family and its defaults; bash bounded to the hands' ceiling; the five background tools run on the run's hands; and a
// registry that lacks an executor for a tool the model sees is refused when it is built.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BACKGROUND_MAX,
  BASH_DEFAULT_TIMEOUT_S,
  createRegistry,
  defaultPermissionOf,
  endBackground,
  hostToolDefs,
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
  await assert.rejects(registry.invoke("bash_background", { command: "sleep 1" }, { hands }), /bash_background needs a computer: with no computer, bash runs in the run's folder and background processes are not offered/);
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
    if (args.command === "slow") throw new Error("Command timed out after 295 seconds");
    return { text: "ok" };
  };
  const { hands } = localHands({ maxExecS: 295 });
  const registry = createRegistry({ maxExecS: 295, shell: "computer", executors: { ...injected, bash: base } });
  await registry.invoke("bash", { command: "true" }, { hands });
  assert.equal(seen[0], BASH_DEFAULT_TIMEOUT_S);
  const capped = await registry.invoke("bash", { command: "true", timeout: 900 }, { hands });
  assert.equal(seen[1], 295);
  assert.match(capped.diagnostics.at(-1).message, /at most 295 s: this one ran with 295 s, not the 900 s asked/);
  await assert.rejects(registry.invoke("bash", { command: "slow", timeout: 900 }, { hands }), /timed out after 295 seconds\. bash runs a command for at most 295 s/);
  const words = hostToolDefs({ maxExecS: 295, shell: "computer" }).find((tool) => tool.name === "bash");
  assert.match(words.description, /at most 295 s; for longer work use bash_background\.$/);
});

test("an exec ended by a signal reads as 128 + n, and one cut by its timeout says so", async () => {
  const ended = (result) => ({ maxExecS: 600, exec: async () => result });
  const registry = createRegistry({ maxExecS: 600, shell: "computer", executors: injected });
  await assert.rejects(registry.invoke("bash_list", {}, { hands: ended({ exitCode: null, signal: "SIGKILL", timedOut: false }) }), /^Error: the run's box answered with exit code 137$/);
  await assert.rejects(registry.invoke("bash_list", {}, { hands: ended({ exitCode: null, signal: "KILL", timedOut: true }) }), /^Error: the run's box did not answer: timed out after 30 s$/);
  await assert.rejects(registry.invoke("bash_list", {}, { hands: { maxExecS: 600, exec: async () => { throw new Error("aborted"); } } }), /^Error: the run's box did not answer: aborted$/);
});

test("the background tools run on the run's hands: start, read, write stdin, list, signal, and the run's end ends them", async () => {
  const { root, tmp, hands } = localHands();
  const registry = createRegistry({ maxExecS: 600, shell: "computer", executors: injected });
  const call = (name, args) => registry.invoke(name, args, { hands });
  const started = await call("bash_background", { command: "echo hello; read line; echo got $line" });
  assert.match(started.text, /^Started background process 1 \(process group \d+\)\. Its output goes to background\/1\/output\.log in work\//);
  assert.equal(started.details.id, "1");
  await until(async () => (await call("bash_output", { id: "1" })).text.includes("hello"), "the first line");
  const sent = await call("bash_input", { id: "1", text: "there\n" });
  assert.equal(sent.text, "Wrote 6 bytes to background process 1's stdin. Read what it answers with bash_output.");
  await until(async () => /exited with code 0/.test((await call("bash_output", { id: "1" })).text), "the exit");
  const read = await call("bash_output", { id: "1" });
  assert.match(read.text, /^Background process 1 exited with code 0\. Output bytes 0 to 16 of 16, the end\.\n\nhello\ngot there\n$/);
  assert.equal(readFileSync(join(root, "background", "1", "output.log"), "utf8"), "hello\ngot there\n");
  const sleeper = await call("bash_background", { command: "sleep 30" });
  assert.equal(sleeper.details.id, "2");
  const listed = await call("bash_list", {});
  assert.match(listed.text, new RegExp(`^1 of at most ${BACKGROUND_MAX} running\\.\\n2: is running;`));
  const signalled = await call("bash_signal", { id: "2", signal: "TERM" });
  assert.match(signalled.text, /^Sent TERM to background process 2: it ended by signal TERM \(exit code 143\)\.$/);
  await call("bash_background", { command: "sleep 30" });
  assert.equal(await endBackground(hands), 1);
  assert.ok(existsSync(join(tmp, ".agentrun-background", "3", "ended")));
  await assert.rejects(call("bash_output", { id: "9" }), /there is no background process 9 in this run: bash_list shows them/);
  await assert.rejects(call("bash_signal", { id: "../1", signal: "TERM" }), /is no background process id/);
});
