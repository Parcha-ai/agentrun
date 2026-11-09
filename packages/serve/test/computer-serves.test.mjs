// The one check of a started computer's hello against the kind registry (serve/src/workspace/computer-serves.ts
// servedGroups): the groups when it serves the kind, else a refusal in the registry's words. A hello that declares no
// groups (absent, or not a list) declares none: the registry refuses it in words, never a TypeError.
import assert from "node:assert/strict";
import { test } from "node:test";
import { servingRefusals } from "@parcha/agentrun-computer";
import { servedGroups } from "../dist/workspace/computer-serves.js";

test("a hello that serves the kind gives its groups", () => {
  assert.deepEqual(servedGroups({ kind: "linux", groups: ["exec", "files", "processes"] }, "sandbox", servingRefusals), ["exec", "files", "processes"]);
});

test("a hello that does not serve the kind is refused in the registry's words", () => {
  assert.throws(() => servedGroups({ kind: "linux", groups: ["exec", "files"] }, "sandbox", servingRefusals), /the run's computer can't serve a sandbox: kind sandbox needs groups processes/);
});

test("a hello with no groups (absent or not a list) declares none: refused in words, never a TypeError", () => {
  for (const said of [{ kind: "linux" }, { kind: "linux", groups: null }, { kind: "linux", groups: "exec" }, {}]) {
    // A hello with no machine kind is refused for that too, in the same words, before its groups.
    assert.throws(() => servedGroups(said, "sandbox", servingRefusals), (error) => !(error instanceof TypeError) && /^the run's computer can't serve a sandbox: /.test(error.message) && /kind sandbox needs groups exec, files, processes/.test(error.message), JSON.stringify(said));
  }
});
