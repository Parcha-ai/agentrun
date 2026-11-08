// The kernel's tool registry holds main's tools as main shows them today: the same names in the same order, the same
// words, schemas and replay, the same limits, and the same shell-family gate mapping. The one ruled change, named below:
// with no computer, bash runs in the run's folder (asked first) and the background tools are refused. (The background
// tools' answers follow the computer module's reference on the computer's processes; the kernel's own tests hold them.)
import assert from "node:assert/strict";
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
