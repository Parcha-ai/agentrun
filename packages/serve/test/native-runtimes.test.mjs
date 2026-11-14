import assert from "node:assert/strict";
import { test } from "node:test";
import { isNativeRuntime, NATIVE_MINIMUM_VERSION, NATIVE_RUNTIME_FACTS, NATIVE_RUNTIMES } from "../dist/native/runtimes.js";

test("native CLI facts keep the public connection identities and supported selectors separate from managed harnesses", () => {
  assert.deepEqual(NATIVE_RUNTIMES, ["claude-code", "codex"]);
  assert.deepEqual(NATIVE_MINIMUM_VERSION, { "claude-code": "2.1.322", codex: "0.167.2" });
  assert.deepEqual(NATIVE_RUNTIMES.map(id => [NATIVE_RUNTIME_FACTS[id].binary, NATIVE_RUNTIME_FACTS[id].namedSelector]),
    [["claude", "agent"], ["codex", "profile"]]);
  for (const id of NATIVE_RUNTIMES) {
    assert.equal(isNativeRuntime(id), true);
    assert.equal(Object.isFrozen(NATIVE_RUNTIME_FACTS[id]), true);
    assert.equal(Object.isFrozen(NATIVE_RUNTIME_FACTS[id].authStatus), true);
  }
  for (const id of ["claude-agent", "pi", "opencode", "toString", "__proto__", null, 0]) assert.equal(isNativeRuntime(id), false);
  assert.equal(Object.isFrozen(NATIVE_RUNTIMES), true);
  assert.equal(Object.isFrozen(NATIVE_RUNTIME_FACTS), true);
});
