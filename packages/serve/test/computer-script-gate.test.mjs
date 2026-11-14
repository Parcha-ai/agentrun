// A script's computer calls (computer_script, pi's code mode) run on the run's computer, so the gate decides them as on a
// computer: a desktop that mounts no run folder (a vendor's) still has a computer to run a command or a program on.
// shell.run and processes.start then follow bash's one setting alike, as the run's own tools on a computer do; the run's
// own host tools keep the no-computer defaults (bash asks first, the background tools are refused), where its bash runs
// on Archil's exec or not at all.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stores } from "./runner-support.mjs";

const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const root = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-script-gate-"));

test("on a desktop that mounts no folder (shell none or local), a script's shell.run and processes.start follow bash's one setting: nothing set, both run", async () => {
  const { runners } = await stores({ runners: 1 });
  for (const shell of ["none", "local"]) {
    for (const approvals of ["ask", "never"]) {
      const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals } }, root(), shell);
      assert.equal(await gate.script("bash", { command: "id" }), "allow", `${shell}, approvals ${approvals}: shell.run`);
      assert.equal(await gate.script("bash_background", { command: "sleep 2" }), "allow", `${shell}, approvals ${approvals}: processes.start`);
      // The run's own tools: no computer's shell, the kernel's ruled defaults.
      assert.equal(gate.permissions.policy("bash_background"), "deny", `${shell}: the host's background tools are not the script's`);
    }
  }
});

test("a script on a desktop that mounts no folder: bash's setting holds both, in words that name bash", async () => {
  const { runners } = await stores({ runners: 1 });
  const denied = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "never", toolSettings: { bash: { permission: "deny" } } } }, root(), "none");
  for (const tool of ["bash", "bash_background"]) {
    const decision = await denied.script(tool, { command: "id" });
    assert.equal(typeof decision, "object", `${tool}: refused`);
    assert.match(decision.deny, /bash/, `${tool}: the words name bash's setting`);
    assert.doesNotMatch(decision.deny, /by default/, `${tool}: refused by the agent's setting, not a default`);
  }
  const asks = await adapterRunGate(runners[0], { runId: "run-2" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { bash: { permission: "ask" } } } }, root(), "none");
  assert.deepEqual([await asks.script("bash", { command: "id" }), await asks.script("bash_background", { command: "sleep 2" })], ["ask", "ask"]);
});
