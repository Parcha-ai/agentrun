// A script's computer op that reads or writes a file needs its tool among the agent's tools, as the run's own file tools
// do: files.read, files.list and files.stat need read, files.write needs write. None given, none. The run's gate refuses
// such an op for an agent not given its tool before that tool's setting is read, on every computer, a desktop that mounts
// the run's folder or one that mounts none; an agent given it has the op decided by the tool's setting, as before. What
// the model is offered agrees: computer_op's op list and a script's `computer` declarations leave out every op held to a
// tool that the gate would refuse whatever its arguments (its tool not given, the tool it is held to set to deny, or set
// to ask where no one can approve), and both say that input ops can drive a terminal app or a file manager and apps.open
// a URL or a path, so
// leaving bash, read or write out is no boundary on a computer that has them. shell.run and processes.start need no
// grant: bash's setting alone holds them.
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
/** The words every offer of a computer's ops carries: a terminal app, a file manager and an app opened on a URL or a
 *  path reach what the shell and the file ops do, whatever their settings. */
const GUI_REACH = "Input ops on a computer with a terminal app or a GUI file manager, and apps.open with a URL or a path, can do what a shell or the file ops do, whatever bash's, read's or write's setting.";

/** The run's gate for an agent on a desktop; `tools` null: the agent names no tools list at all; `approvers` false: no
 *  one can approve an ask on this server. */
const gateOf = async ({ tools = ["read", "write"], toolSettings = {}, shell = "none", approvals = "ask", approvers } = {}) => {
  const { server, runners } = await stores({ runners: 1 });
  if (approvers !== undefined) await server.settings.put("approvers", { approvers });
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
  return { run, tools: run.hostTools(run.kindTools, { writes: gate.writes(), opsRefused: gate.opsRefused() }) };
}

/** Each agent the offer is checked for: its grant, its tool settings and whether anyone can approve an ask. The desktop
 *  itself is allowed where no one can approve, so the ops held to its own setting stay in reach. */
const OFFERS = [
  ...[["read", "write"], ["read"], ["write"], [], null].map((tools) => ({ tools })),
  { toolSettings: { read: { permission: "deny" } } },
  { toolSettings: { write: { permission: "deny" } } },
  { toolSettings: { bash: { permission: "deny" } } },
  { toolSettings: { desktop: { permission: "allow" }, read: { permission: "ask" } }, approvers: false },
  { toolSettings: { desktop: { permission: "allow" }, write: { permission: "ask" } }, approvers: false },
  { toolSettings: { desktop: { permission: "allow" }, bash: { permission: "ask" } }, approvers: false },
  { toolSettings: { read: { permission: "ask" }, write: { permission: "ask" } }, approvers: true },
  { toolSettings: { desktop: { permission: "allow" }, read: { permission: "ask" } }, approvers: false, approvals: "never" },
  { toolSettings: { bash: { policy: "read-only" } } },
  { toolSettings: { bash: { policy: "not-a-policy" } } },
];

test("computer_op offers exactly the ops the gate would not refuse whatever their arguments: not given, held to a tool set to deny, or to one set to ask where no one can approve; its op list and its words leave the others out", async () => {
  const refusedSome = new Set();
  for (const agent of OFFERS) {
    const gate = await gateOf(agent);
    const { tools: bound } = await boundFor(gate);
    const opTool = bound.find((tool) => tool.name === COMPUTER_OP_TOOL);
    assert.ok(opTool, `computer_op is bound: ${JSON.stringify(bound.map((tool) => tool.name))}`);
    const offered = opTool.inputSchema.properties.op.enum;
    const refused = [];
    for (const name of Object.keys(COMPUTER_OPS)) {
      // A command bash's read-only policy runs (ls), so a refusal here is one whatever the command.
      const decision = await gate(op(name, name.startsWith("files.") ? { ...PATH, data: "x" } : { command: "ls", actions: [], id: "x" }));
      const denied = typeof decision === "object";
      if (denied) refused.push(name);
      const what = `${name}, ${JSON.stringify(agent)}`;
      assert.equal(offered.includes(name), !denied, `${what}: offered exactly when the gate would not refuse it (${JSON.stringify(decision)})`);
      assert.equal(opTool.description.includes(`${name} `) || opTool.description.includes(`${name},`) || opTool.description.includes(`${name}.`), !denied, `${what}: its words name it exactly when offered: ${opTool.description}`);
    }
    assert.deepEqual([...gate.opsRefused()].sort(), refused.sort(), `${JSON.stringify(agent)}: the gate's own list of the ops it refuses`);
    for (const name of refused) refusedSome.add(name);
    assert.ok(opTool.description.includes(GUI_REACH), `computer_op says what input ops reach: ${opTool.description}`);
  }
  for (const name of [...READS, "files.write", "shell.run", "processes.start"]) assert.ok(refusedSome.has(name), `some agent above is refused ${name}`);
});

test("bash's read-only policy refuses processes.start whatever its command, so the offer leaves it out, while shell.run stays, its command read at each call; a policy the server does not know leaves out both", async () => {
  const offeredBy = async (gate) => (await boundFor(gate)).tools.find((tool) => tool.name === COMPUTER_OP_TOOL).inputSchema.properties.op.enum;
  const readOnly = await gateOf({ toolSettings: { bash: { policy: "read-only" } } });
  for (const command of ["id", "sleep 1", "ls"]) assert.match((await readOnly(op("processes.start", { command }))).deny ?? "", /read-only|not offered/, `processes.start ${command}`);
  assert.deepEqual([...readOnly.opsRefused()], ["processes.start"], "only the op the policy refuses whatever its arguments");
  const offered = await offeredBy(readOnly);
  assert.ok(!offered.includes("processes.start"), `processes.start left out: ${JSON.stringify(offered)}`);
  assert.ok(offered.includes("shell.run"), `shell.run stays, decided per command: ${JSON.stringify(offered)}`);
  assert.equal(await readOnly(op("shell.run", { command: "ls" })), "allow", "a read-only command still runs");
  const unknown = await gateOf({ toolSettings: { bash: { policy: "not-a-policy" } } });
  assert.deepEqual([...unknown.opsRefused()].sort(), ["processes.start", "shell.run"], "a policy this server does not know refuses every shell call");
});

test("every op the kernel puts in the files group needs a grant: an agent naming no tools is refused each before any setting is read, and the gate leaves each out of its offer", async () => {
  const fileOps = Object.keys(COMPUTER_OPS).filter((name) => COMPUTER_OPS[name].includes("files"));
  assert.ok(fileOps.length >= 4, JSON.stringify(fileOps));
  for (const tools of [[], null]) {
    const gate = await gateOf({ tools, toolSettings: { read: { permission: "allow" }, write: { permission: "allow" } } });
    for (const name of fileOps) {
      const decision = await gate(op(name, { ...PATH, data: "x" }));
      assert.match(decision?.deny ?? "", /not given (read|write)/, `${name}, tools ${JSON.stringify(tools)}: ${JSON.stringify(decision)}`);
      assert.ok(gate.opsRefused().includes(name), `${name} is left out of the offer: ${JSON.stringify(gate.opsRefused())}`);
    }
  }
});

test("a script's `computer` declares only the file ops the agent is given: files.read, list and stat with read, files.write with write, no files member with neither; and says what input ops reach", () => {
  const declared = (opsRefused) => {
    const [, , codemode] = metaTools({ tools: () => [], granted: async () => true, codemode: true, discovery: { search: true, call: true }, computer: { card: { groups: ["screen", "input.pointer", "input.keys", "exec", "files"] }, ...(opsRefused ? { opsRefused } : {}) } });
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
  for (const text of [all, noRead, neither]) assert.ok(text.includes(GUI_REACH), `codemode says what input ops reach: ${text}`);
  assert.match(all, /a file it reads, lists or stats needs read among this agent's tools/, "codemode says the grant the reads need");
  const noShell = declared(["shell.run"]);
  assert.ok(!noShell.includes("readonly shell:"), `bash refused: no shell member: ${noShell}`);
});
