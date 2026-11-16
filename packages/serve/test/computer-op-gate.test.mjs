// A codemode script's `computer` reaches the computer's shell, files, apps and input through computer_op, one nested call
// per call of `computer`, and the run's one gate holds each: shell.run to bash's setting, processes.start to
// bash_background's (bash's one setting), files.write to write's, files.read, list and stat to read's, and the rest
// (apps, input) to the computer kind's. Those calls run on the run's computer, so the gate decides them as on a
// computer: a desktop that mounts no run folder (a vendor's) still has a computer to run a command or a program on, so
// shell.run and processes.start follow bash's one setting alike, as the run's own tools on a computer do; the run's own
// host tools keep the no-computer defaults (bash asks first, the background tools are refused), where its bash runs on
// Archil's exec or not at all.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { localWorkspace, runTools } from "../dist/workspace/index.js";
import { stores } from "./runner-support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const root = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-op-gate-"));
const op = (name, args) => ({ callId: `c-${name}`, tool: "computer_op", args: { op: name, args } });

test("on a desktop that mounts no folder (shell none or local), a script's shell.run and processes.start follow bash's one setting: nothing set, both run", async () => {
  const { runners } = await stores({ runners: 1 });
  for (const shell of ["none", "local"]) {
    for (const approvals of ["ask", "never"]) {
      const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals } }, root(), shell);
      assert.equal(await gate(op("shell.run", { command: "id" })), "allow", `${shell}, approvals ${approvals}: shell.run`);
      assert.equal(await gate(op("processes.start", { command: "sleep 2" })), "allow", `${shell}, approvals ${approvals}: processes.start`);
      // The run's own tools: no computer's shell, the kernel's ruled defaults.
      assert.equal(gate.permissions.policy("bash_background"), "deny", `${shell}: the host's background tools are not the script's`);
    }
  }
});

test("a script on a desktop that mounts no folder: bash's setting holds shell.run and processes.start, in words that name bash, and an ask is asked about as bash", async () => {
  const { runners } = await stores({ runners: 1 });
  const denied = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "never", toolSettings: { bash: { permission: "deny" } } } }, root(), "none");
  for (const name of ["shell.run", "processes.start"]) {
    const decision = await denied(op(name, { command: "id" }));
    assert.equal(typeof decision, "object", `${name}: refused`);
    assert.match(decision.deny, /bash/, `${name}: the words name bash's setting`);
    assert.doesNotMatch(decision.deny, /by default/, `${name}: refused by the agent's setting, not a default`);
  }
  const asks = await adapterRunGate(runners[0], { runId: "run-2" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { bash: { permission: "ask" } } } }, root(), "none");
  assert.deepEqual([await asks(op("shell.run", { command: "id" })), await asks(op("processes.start", { command: "sleep 2" }))], ["ask", "ask"]);
  assert.equal(asks.askedAs("computer_op", { op: "shell.run", args: { command: "id" } }), "bash", "the person is asked about a shell command as bash");
  assert.equal(asks.askedAs("computer_op", { op: "processes.start", args: { command: "sleep 2" } }), "bash_background");
});

test("a script's files.write is held to write's setting and files.read, list and stat to read's; apps and input to the computer kind's, whose deny refuses every op first", async () => {
  const { runners } = await stores({ runners: 1 });
  const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { write: { permission: "deny" }, read: { permission: "ask" } } } }, root(), "none");
  const wrote = await gate(op("files.write", { path: "/tmp/a", data: "x" }));
  assert.equal(typeof wrote, "object", "files.write: refused by write's deny");
  assert.match(wrote.deny, /write is set to deny/, wrote.deny);
  for (const name of ["files.read", "files.list", "files.stat"]) assert.equal(await gate(op(name, { path: "/tmp/a" })), "ask", `${name}: read's ask`);
  assert.equal(gate.askedAs("computer_op", { op: "files.read", args: { path: "/tmp/a" } }), "read");
  // The desktop set to deny: apps and input are the kind's, and the kind's deny comes before any op's own tool.
  const kindDenied = await adapterRunGate(runners[0], { runId: "run-2" }, { kind: "agentic", body: { approvals: "ask", toolSettings: { write: { permission: "allow" }, desktop: { permission: "deny" } } } }, root(), "none");
  for (const name of ["apps.list", "apps.open", "input.act", "files.write"]) {
    const decision = await kindDenied(op(name, { path: "/tmp/a", data: "x" }));
    assert.equal(typeof decision, "object", `${name}: held to desktop's deny`);
    assert.match(decision.deny, /desktop is set to deny/, decision.deny);
  }
});

test("computer_op runs only the computer's ops that no step tool runs: observe, act and screenshot are their own tools, so each is held and recorded as that tool", async () => {
  const folder = root();
  const computer = fakeComputer(folder);
  const hello = { protocol: "0.2", version: "0", os: "linux", kind: "desktop", arch: "amd64", groups: ["exec", "files", "screen", "input.pointer", "input.keys"] };
  const run = await runTools(localWorkspace(folder), { kind: "desktop", computer, hello }, { mode: 1, context: ctx });
  const tool = run.hostTools(run.kindTools).find((one) => one.name === "computer_op");
  assert.ok(tool, `computer_op is bound: ${JSON.stringify(run.kindTools)}`);
  for (const name of ["observe", "act", "screenshot"]) {
    const refused = await tool.call({ op: name, args: {} }, { callId: `c-${name}`, signal: new AbortController().signal });
    assert.equal(refused.isError, true, name);
    assert.match(refused.text, new RegExp(`computer_${name}`), `${name}: sent to its own tool: ${refused.text}`);
  }
  assert.deepEqual(computer.calls.filter(([method]) => method !== "hello"), [], "nothing reached the computer");
  await run.end();
});

test("a desktop whose agent has exec off (no exec group: a bench exec-deny agent) refuses computer_op's shell.run and processes.start though the gate allows both, and nothing reaches the computer's exec", async () => {
  const { runners } = await stores({ runners: 1 });
  const gate = await adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals: "never" } }, root(), "none");
  assert.deepEqual([await gate(op("shell.run", { command: "id" })), await gate(op("processes.start", { command: "xterm" }))], ["allow", "allow"], "the gate alone would let both run");
  const folder = root();
  const computer = fakeComputer(folder);
  const hello = { protocol: "0.2", version: "0", os: "linux", kind: "desktop", arch: "amd64", groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"] };
  const run = await runTools(localWorkspace(folder), { kind: "desktop", computer, hello, exec: false }, { mode: 1, context: ctx });
  const tool = run.hostTools(run.kindTools).find((one) => one.name === "computer_op");
  for (const [name, args] of [["shell.run", { command: "id" }], ["processes.start", { command: "xterm" }]]) {
    const refused = await tool.call({ op: name, args }, { callId: `c-${name}`, signal: new AbortController().signal });
    assert.equal(refused.isError, true, name);
    assert.match(refused.text, /this agent's computer runs no programs: its exec setting is off/, `${name}: ${refused.text}`);
  }
  assert.deepEqual(computer.calls.filter(([method]) => method === "exec.run" || method.startsWith("process.")), [], "nothing ran on the computer");
  assert.deepEqual(run.computer?.card.groups.filter((group) => group === "exec" || group === "processes"), [], "the card a script's computer is bound to has no exec or processes group");
  await run.end();
});
