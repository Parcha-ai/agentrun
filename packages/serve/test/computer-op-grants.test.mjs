// A script's computer op that reads or writes a file needs its tool among the agent's tools, as the run's own file tools
// do: files.read, files.list and files.stat need read, files.write needs write. None given, none. The run's gate refuses
// such an op for an agent not given its tool before that tool's setting is read, on every computer, a desktop that mounts
// the run's folder or one that mounts none; an agent given it has the op decided by the tool's setting, as before. What
// the model is offered agrees: computer_op's op list and a script's `computer` declarations leave out every op the gate
// would refuse for want of a tool, and both say that input ops can drive a terminal app, so leaving bash out is no shell
// boundary on a computer that has one. shell.run and processes.start are held to bash's setting alone here.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { COMPUTER_OP_TOOL, COMPUTER_OPS } from "@parcha/agentrun-kernel/kernel";
import { localWorkspace, runTools } from "../dist/workspace/index.js";
import { stores } from "./runner-support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { metaTools } = await import("../dist/runner/meta-tools.js");
const root = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-op-grants-"));
const op = (name, args) => ({ callId: `c-${name}`, tool: COMPUTER_OP_TOOL, args: { op: name, args } });
const READS = ["files.read", "files.list", "files.stat"];
const PATH = { path: "/workspace/notes.txt" };
/** The words every offer of a computer's ops carries: input ops reach a terminal app, whatever bash's setting. */
const TERMINAL = "Input ops on a computer with a terminal app can do what a shell does, whatever bash's setting.";

/** The run's gate for an agent on a desktop; `tools` null: the agent names no tools list at all. */
const gateOf = async ({ tools = ["read", "write"], toolSettings = {}, shell = "none", approvals = "ask" } = {}) => {
  const { runners } = await stores({ runners: 1 });
  return adapterRunGate(runners[0], { runId: "run-1" }, { kind: "agentic", body: { approvals, computer: { kind: "desktop", provider: "faux-desktop" }, ...(tools === null ? {} : { tools }), toolSettings } }, root(), shell, { facts: undefined });
};

test("files.read, files.list and files.stat are refused to an agent not given read or naming no tools, on a desktop that mounts the run's folder and one that mounts none, whatever read's setting, in words that name read", async () => {
  for (const tools of [["write"], [], null]) {
    for (const shell of ["computer", "none"]) {
      for (const [approvals, toolSettings] of [["ask", {}], ["ask", { read: { permission: "allow" } }], ["never", { read: { permission: "ask" } }]]) {
        const gate = await gateOf({ tools, shell, approvals, toolSettings });
        for (const name of READS) {
          const decision = await gate(op(name, PATH));
          const what = `${name}, tools ${JSON.stringify(tools)}, shell ${shell}, ${approvals}, ${JSON.stringify(toolSettings)}`;
          assert.equal(typeof decision, "object", `refused: ${what}`);
          assert.match(decision.deny, /^Permission denied: /, `${what}: ${decision.deny}`);
          assert.ok(decision.deny.includes(`computer_op ${name}`), `${what}: names the op: ${decision.deny}`);
          assert.match(decision.deny, /not given read/, `${what}: ${decision.deny}`);
          assert.match(decision.deny, /It was not run/, decision.deny);
        }
      }
    }
  }
});

test("an agent given read has files.read, files.list and files.stat decided by read's setting: allowed by default, asked, or refused in read's deny words", async () => {
  for (const shell of ["computer", "none"]) {
    for (const tools of [["read"], ["read", "write"]]) {
      const allowed = await gateOf({ tools, shell });
      const asked = await gateOf({ tools, shell, toolSettings: { read: { permission: "ask" } } });
      const denied = await gateOf({ tools, shell, toolSettings: { read: { permission: "deny" } } });
      for (const name of READS) {
        const what = `${name}, tools ${JSON.stringify(tools)}, shell ${shell}`;
        assert.equal(await allowed(op(name, PATH)), "allow", `${what}: read's default`);
        assert.equal(await asked(op(name, PATH)), "ask", `${what}: read's ask`);
        const refusal = await denied(op(name, PATH));
        assert.match(refusal.deny, /read is set to deny/, `${what}: ${refusal.deny}`);
        assert.doesNotMatch(refusal.deny, /not given/, `${what}: the setting holds a granted tool: ${refusal.deny}`);
      }
    }
  }
});

test("each grant holds its own ops alone: an agent given read but not write keeps the reads and is refused files.write; one given write but not read the reverse", async () => {
  const readOnly = await gateOf({ tools: ["read"] });
  for (const name of READS) assert.equal(await readOnly(op(name, PATH)), "allow", `${name} with read`);
  assert.match((await readOnly(op("files.write", { ...PATH, data: "x" }))).deny, /not given write/);
  const writeOnly = await gateOf({ tools: ["write"] });
  assert.equal(await writeOnly(op("files.write", { ...PATH, data: "x" })), "allow", "files.write with write");
  for (const name of READS) assert.match((await writeOnly(op(name, PATH))).deny, /not given read/, name);
});

test("the desktop set to deny refuses a read op in the kind's words first, not given read or not, and turns the computer off", async () => {
  for (const tools of [["read"], []]) {
    const gate = await gateOf({ tools, toolSettings: { desktop: { permission: "deny" } } });
    const decision = await gate(op("files.read", PATH));
    assert.match(decision.deny, /desktop is set to deny/, `${JSON.stringify(tools)}: ${decision.deny}`);
    assert.doesNotMatch(decision.deny, /not given/, decision.deny);
  }
});

test("shell.run and processes.start stay on bash's setting alone: no tools list, or one without bash, still runs them on a desktop", async () => {
  for (const tools of [["read"], [], null]) {
    const gate = await gateOf({ tools });
    assert.equal(await gate(op("shell.run", { command: "id" })), "allow", `shell.run, tools ${JSON.stringify(tools)}`);
    assert.equal(await gate(op("processes.start", { command: "sleep 1" })), "allow", `processes.start, tools ${JSON.stringify(tools)}`);
  }
});

/** A desktop with every op's group, its tools bound as a run's spec binds them for an agent whose gate is `gate`. */
async function boundFor(gate) {
  const dir = root();
  const computer = fakeComputer(dir);
  const groups = ["screen", "input.pointer", "input.keys", "apps", "exec", "processes", "files"];
  const run = await runTools(localWorkspace(dir), { kind: "desktop", computer: { client: computer.client }, hello: { protocol: "0.2", version: "0", os: "linux", kind: "desktop", arch: "amd64", groups } }, { mode: 1, context: ctx });
  return { run, tools: run.hostTools(run.kindTools, { writes: gate.writes(), opsNotGiven: gate.opsNotGiven() }) };
}

test("computer_op offers exactly the ops the gate would not refuse for want of a tool: its op list and its words leave the others out, for every grant", async () => {
  for (const tools of [["read", "write"], ["read"], ["write"], [], null]) {
    const gate = await gateOf({ tools });
    const { tools: bound } = await boundFor(gate);
    const opTool = bound.find((tool) => tool.name === COMPUTER_OP_TOOL);
    assert.ok(opTool, `computer_op is bound: ${JSON.stringify(bound.map((tool) => tool.name))}`);
    const offered = opTool.inputSchema.properties.op.enum;
    for (const name of Object.keys(COMPUTER_OPS)) {
      const decision = await gate(op(name, name.startsWith("files.") ? { ...PATH, data: "x" } : { command: "id", actions: [], id: "x" }));
      const notGiven = typeof decision === "object" && /not given/.test(decision.deny);
      const what = `${name}, tools ${JSON.stringify(tools)}`;
      assert.equal(offered.includes(name), !notGiven, `${what}: offered exactly when the gate would not refuse it for want of a tool (${JSON.stringify(decision)})`);
      assert.equal(opTool.description.includes(`${name} `) || opTool.description.includes(`${name},`) || opTool.description.includes(`${name}.`), !notGiven, `${what}: its words name it exactly when offered: ${opTool.description}`);
    }
    assert.ok(opTool.description.includes(TERMINAL), `computer_op says what input ops reach: ${opTool.description}`);
  }
});

test("a script's `computer` declares only the file ops the agent is given: files.read, list and stat with read, files.write with write, no files member with neither; and says what input ops reach", () => {
  const declared = (opsNotGiven) => {
    const [, , codemode] = metaTools({ tools: () => [], granted: async () => true, codemode: true, discovery: { search: true, call: true }, computer: { card: { groups: ["screen", "input.pointer", "input.keys", "exec", "files"] }, ...(opsNotGiven ? { opsNotGiven } : {}) } });
    return codemode.description;
  };
  const files = (text) => text.match(/readonly files: \{[^\n]*?\}; \}?/)?.[0] ?? "";
  const all = declared(undefined);
  for (const method of ["read(", "write(", "list(", "stat("]) assert.ok(files(all).includes(method), `every file op with nothing left out: ${method} in ${files(all)}`);
  const noRead = declared(READS);
  assert.ok(files(noRead).includes("write("), files(noRead));
  for (const method of ["read(", "list(", "stat("]) assert.ok(!files(noRead).includes(method), `not given read: no ${method} in ${files(noRead)}`);
  assert.ok(noRead.includes("readonly shell:"), "the shell stays: bash's setting holds it");
  const noWrite = declared(["files.write"]);
  assert.ok(!files(noWrite).includes("write("), files(noWrite));
  for (const method of ["read(", "list(", "stat("]) assert.ok(files(noWrite).includes(method), `${method} in ${files(noWrite)}`);
  const neither = declared([...READS, "files.write"]);
  assert.ok(!neither.includes("readonly files:"), `no files member at all: ${neither}`);
  assert.ok(!neither.includes("type FileInfo"), "nor the types only file ops name");
  for (const text of [all, noRead, neither]) assert.ok(text.includes(TERMINAL), `codemode says what input ops reach: ${text}`);
  assert.match(all, /a file it reads, lists or stats needs read among this agent's tools/, "codemode says the grant the reads need");
});
