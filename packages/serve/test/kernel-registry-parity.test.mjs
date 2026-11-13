// The kernel's tool registry agrees with serve on the tools' limits and the shell family's gate mapping: the background
// tools' bounds, read's image bound (the runner's pi environment's), and the same permission under each setting of bash.
// (The background tools' answers follow the computer module's reference on the computer's processes; the kernel's own
// tests hold them.)
import assert from "node:assert/strict";
import { test } from "node:test";
import * as kernel from "@parcha/agentrun-kernel/kernel";
import * as background from "../dist/background.js";
import { READ_IMAGE_MAX_BYTES } from "../dist/workspace/pi-env.js";
import { permissionFrom, SHELL_FAMILY, SHELL_WATCHERS } from "../dist/tool-gate.js";

test("the limits are serve's", () => {
  assert.equal(kernel.READ_IMAGE_MAX_BYTES, READ_IMAGE_MAX_BYTES);
  for (const name of ["BACKGROUND_MAX", "BACKGROUND_LOG_BYTES", "BACKGROUND_PAGE_BYTES", "BACKGROUND_INPUT_BYTES", "BACKGROUND_LIST_MAX", "BACKGROUND_DIR"]) assert.equal(kernel[name], background[name], name);
  assert.deepEqual([...kernel.BACKGROUND_SIGNALS], [...background.BACKGROUND_SIGNALS]);
  assert.deepEqual([...kernel.BACKGROUND_TOOLS], [...background.BACKGROUND_TOOLS]);
  assert.deepEqual([...kernel.SHELL_TOOLS], [...background.SHELL_TOOLS]);
});

test("the gate's shell family is serve's: the same keys, the same watchers, the same permission under each setting of bash", () => {
  assert.deepEqual({ ...kernel.SHELL_FAMILY }, { ...SHELL_FAMILY });
  assert.deepEqual([...kernel.SHELL_WATCHERS].sort(), [...SHELL_WATCHERS].sort());
  for (const name of kernel.SHELL_TOOLS) {
    for (const bash of ["allow", "ask", "deny"]) {
      assert.equal(kernel.shellPermission(name, bash), permissionFrom(name, { bash: { permission: bash } }).permission, `${name} under bash: ${bash}`);
    }
  }
});
