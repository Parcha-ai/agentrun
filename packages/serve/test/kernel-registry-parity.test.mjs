// The kernel's tool registry holds main's tools as main shows them today: the same names in the same order, the same
// words, schemas and replay, the same limits, the same shell-family gate mapping, and the same background tools' answers.
// The one ruled change, named below: with no computer, bash runs in the run's folder (asked first) and the background
// tools are refused.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as kernel from "@parcha/agentrun-kernel/kernel";
import * as background from "../dist/background.js";
import { BASH_DEFAULT_TIMEOUT_S, BASH_MAX_TIMEOUT_S, codingSource, READ_IMAGE_MAX_BYTES } from "../dist/coding-tools.js";
import { permissionFrom, SHELL_FAMILY, SHELL_WATCHERS } from "../dist/tool-gate.js";

const json = (value) => JSON.stringify(value);
/** main's tools for a box run and for a runner run, as the model sees them. */
const mainBox = () => codingSource({ mode: "sandbox", box: "docker" }, { env: async () => ({}) }).tools;
const mainRunner = () => codingSource({ mode: "runner" }).tools;
const replayOf = (tool) => tool.replay === "safe";

for (const [mode, shell, main] of [["box", "computer", mainBox], ["runner", "none", mainRunner]]) {
  test(`main's ${mode} tools: the registry's are the same names in the same order, words, schemas and replay`, () => {
    const ours = kernel.hostToolDefs({ maxExecS: BASH_MAX_TIMEOUT_S, shell });
    const theirs = main();
    assert.deepEqual(ours.map((tool) => tool.name), theirs.map((tool) => tool.name));
    for (const [index, tool] of theirs.entries()) {
      const mine = ours[index];
      assert.equal(mine.description, tool.description, `${tool.name}'s description`);
      assert.equal(json(mine.parameters), json(tool.parameters), `${tool.name}'s schema`);
      assert.equal(mine.replaySafe, replayOf(tool), `${tool.name}'s replay`);
    }
  });
}

test("the limits are main's", () => {
  assert.equal(kernel.BASH_DEFAULT_TIMEOUT_S, BASH_DEFAULT_TIMEOUT_S);
  assert.equal(kernel.BASH_MAX_TIMEOUT_S, BASH_MAX_TIMEOUT_S);
  assert.equal(kernel.READ_IMAGE_MAX_BYTES, READ_IMAGE_MAX_BYTES);
  for (const name of ["BACKGROUND_MAX", "BACKGROUND_LOG_BYTES", "BACKGROUND_PAGE_BYTES", "BACKGROUND_INPUT_BYTES", "BACKGROUND_LIST_MAX", "BACKGROUND_DIR"]) assert.equal(kernel[name], background[name], name);
  assert.deepEqual([...kernel.BACKGROUND_SIGNALS], [...background.BACKGROUND_SIGNALS]);
  assert.deepEqual([...kernel.BACKGROUND_TOOLS], [...background.BACKGROUND_TOOLS]);
  assert.deepEqual([...kernel.SHELL_TOOLS], [...background.SHELL_TOOLS]);
});

test("the gate's shell family is main's: the same keys, the same watchers, the same permission under each setting of bash", () => {
  assert.deepEqual({ ...kernel.SHELL_FAMILY }, { ...SHELL_FAMILY });
  assert.deepEqual([...kernel.SHELL_WATCHERS].sort(), [...SHELL_WATCHERS].sort());
  for (const name of kernel.SHELL_TOOLS) {
    for (const bash of ["allow", "ask", "deny"]) {
      assert.equal(kernel.shellPermission(name, bash), permissionFrom(name, { bash: { permission: bash } }).permission, `${name} under bash: ${bash}`);
    }
  }
});

test("ruled change, named: main has no bash with no computer; the registry's local mode offers it, asked first", () => {
  assert.deepEqual(mainRunner().map((tool) => tool.name), ["read", "write", "edit"]);
  assert.deepEqual(kernel.hostToolDefs({ maxExecS: BASH_MAX_TIMEOUT_S, shell: "local" }).map((tool) => tool.name), ["read", "write", "edit", "bash"]);
  assert.equal(kernel.defaultPermissionOf("bash", { computer: false }), "ask");
});

/** A command runner on a local folder, for both sides: main's background tools get it as an ExecutionEnv, the registry's
 *  as hands. Each side has its own folder and TMPDIR, so their processes never meet. */
function local() {
  const root = mkdtempSync(join(tmpdir(), "registry-parity-"));
  const tmp = join(root, ".tmp");
  mkdirSync(tmp);
  const run = (argv, timeoutS, onOutput) => new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root, env: { ...process.env, TMPDIR: tmp }, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutS * 1000);
    child.stdout.on("data", (data) => onOutput("stdout", data.toString("utf8")));
    child.stderr.on("data", (data) => onOutput("stderr", data.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code ?? 137);
    });
  });
  const env = { cwd: root, exec: async (argv, options) => ({ ok: true, value: { exitCode: await run(argv, options.timeout ?? 30, (stream, text) => options.onOutput?.(text, undefined, { stream })) } }) };
  const hands = { maxExecS: 600, exec: async (command, options) => ({ exitCode: await run(["bash", "-c", command], options.timeoutS, (stream, data) => options.onOutput?.({ stream, data })), signal: null, timedOut: false }) };
  return { env, hands };
}

const textOf = (result) => (result.output ?? []).map((block) => block.text ?? "").join("");
const normal = (text) => text.replace(/process group \d+/g, "process group N").replace(/started \d{4}-\d\d-\d\dT[\d:]+Z/g, "started T");

test("the background tools answer as main's do, call for call, on the same commands", async () => {
  const main = local();
  const ours = local();
  const theirs = Object.fromEntries(background.backgroundTools().map((tool) => [tool.name, tool]));
  const registry = kernel.createRegistry({ maxExecS: 600, shell: "computer", executors: { read: async () => ({ text: "" }), write: async () => ({ text: "" }), edit: async () => ({ text: "" }), bash: async () => ({ text: "" }) } });
  const both = async (name, args) => {
    const a = await theirs[name].execute(args, { env: main.env }, {}).then(textOf, (error) => `error: ${error.message}`);
    const b = await registry.invoke(name, args, { hands: ours.hands }).then((answer) => answer.text, (error) => `error: ${error.message}`);
    assert.equal(normal(b), normal(a), `${name} ${JSON.stringify(args)}`);
  };
  await both("bash_background", { command: "printf 'one\\ntwo\\n'" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  await both("bash_output", { id: "1" });
  await both("bash_output", { id: "1", offset: 4, max_bytes: 2 });
  await both("bash_list", {});
  await both("bash_input", { id: "1", text: "x" });
  await both("bash_signal", { id: "1", signal: "TERM" });
  await both("bash_output", { id: "7" });
  await both("bash_signal", { id: "x", signal: "TERM" });
  await both("bash_background", { command: "  " });
});
