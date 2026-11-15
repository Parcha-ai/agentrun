// What the model on a desktop or a phone run is offered to drive the computer, on every harness: the computer's step
// tools (computer_observe, computer_act, computer_screenshot) and the hand-over, and the host's codemode, whose scripts
// call those tools as tools.<name> and drive `computer` (its shell, files, apps and input through computer_op), each
// call a nested call (gated and recorded as the model's own). computer_op is bound for scripts alone: never listed.
// There is no computer_script anywhere: not as a tool, and not as tools.computer_script inside codemode (a script's
// `tools` are the run's own). Under the agent's surface "code" the step tools are not listed either: a script reaches
// them, as nested calls. Codex runs scripts in its own code mode, which reaches only the tools it is handed, so there
// they stay listed, computer_op among them.
// The kernel registry and runTools for both kinds; each CLI harness end to end through the API on the faux harness
// (fixtures/faux-table.mjs), --faux's desktop, and the faux model: no key, no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const { localWorkspace, runTools } = await import("../dist/workspace/index.js");
const { COMPUTER_TOOLS, computerToolsFor } = await import("../../run-adapters/dist/kernel/registry/index.js");

const STEPS = ["computer_observe", "computer_act", "computer_screenshot"];
const HANDOFF = "computer_request_handoff";
const OP = "computer_op";
const SCRIPT_TOOL = "computer_script";
const GROUPS = { desktop: ["ui", "screen", "input.pointer", "input.keys", "apps", "files", "exec", "processes"], phone: ["ui", "screen", "input.touch", "input.keys", "apps"] };
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "computer-tools-harnesses-"));
  dirs.push(dir);
  return dir;
};
const helloOf = (kind) => ({ protocol: "0.2", version: "0", os: kind === "phone" ? "android" : "linux", kind, arch: "amd64", groups: GROUPS[kind] });

test("the kernel registry has no computer_script: a computer's tools are its step tools, computer_op and the hand-over, for any groups", () => {
  assert.ok(!COMPUTER_TOOLS.includes(SCRIPT_TOOL), JSON.stringify(COMPUTER_TOOLS));
  for (const groups of Object.values(GROUPS)) assert.deepEqual([...computerToolsFor(groups)], [...STEPS, OP, HANDOFF], JSON.stringify(groups));
  // A computer with a screen alone has no op past the step tools: no computer_op.
  assert.deepEqual([...computerToolsFor(["screen"])], ["computer_observe", "computer_screenshot", HANDOFF]);
});

test("a desktop's and a phone's run binds the step tools, computer_op and the hand-over, never computer_script, under every surface; computer_op is bound for scripts alone (not listed), and under surface code the step tools too", async () => {
  for (const kind of ["desktop", "phone"]) {
    for (const surface of [undefined, "tools", "code"]) {
      const dir = fresh();
      const run = await runTools(localWorkspace(dir), { kind, computer: { client: fakeComputer(dir).client }, hello: helloOf(kind), ...(surface ? { surface } : {}) }, { mode: 1, context: ctx });
      const label = `${kind}, surface ${surface}`;
      assert.ok(!run.registry.list().some((def) => def.name === SCRIPT_TOOL), `${label}: the registry lists no computer_script`);
      assert.deepEqual([...run.kindTools], [...STEPS, OP, HANDOFF], `${label}: the tools the computer brings`);
      const bound = run.hostTools(run.kindTools);
      const listed = bound.filter((tool) => !tool.deferred).map((tool) => tool.name);
      const scriptsOnly = bound.filter((tool) => tool.deferred).map((tool) => tool.name);
      assert.deepEqual([listed, scriptsOnly], surface === "code" ? [[HANDOFF], [...STEPS, OP]] : [[...STEPS, HANDOFF], [OP]], `${label}: listed, and for scripts alone`);
      assert.deepEqual(run.computer?.card.groups, GROUPS[kind], `${label}: a script's computer is bound to the computer's card`);
      await run.end();
    }
  }
});

/** The tools each harness's session was handed for a desktop agent's run (`surface`, when given), end to end through the
 *  API on the faux harness: by harness, the names handed and the ones handed for scripts alone (deferred). */
async function handed(t, surface) {
  const harness = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
  const { fauxTable } = await import("./fixtures/faux-table.mjs");
  const opened = join(await scratch(t), "opened.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_OPENED: opened }, []);
  const { api } = await serve(t, { harnessTable: fauxTable(harness) });
  const seen = {};
  for (const id of ["claude-agent", "codex", "opencode"]) {
    const computer = { kind: "desktop", provider: "faux-desktop", ...(surface ? { surface } : {}) };
    const made = await api("POST", "/agents", agent(`desk-${id}`, { harness: id, tools: ["read"], computer }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const before = readOpened(opened).length;
    const started = await api("POST", `/agents/desk-${id}/runs`, { input: { content: "Look at the desktop." } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
    const record = readOpened(opened).slice(before).find((entry) => Array.isArray(entry.tools));
    assert.ok(record, `${id}: its session's tools were filed`);
    seen[id] = { tools: record.tools, deferred: record.deferred ?? [] };
  }
  return seen;
}
const readOpened = (file) => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

test("every CLI harness's desktop run is handed the step tools, the hand-over and codemode (Codex: its own code mode), never computer_script", { timeout: 240_000 }, async (t) => {
  const seen = await handed(t);
  for (const [id, { tools, deferred }] of Object.entries(seen)) {
    assert.ok(!tools.includes(SCRIPT_TOOL), `${id}: no computer_script: ${JSON.stringify(tools)}`);
    for (const name of [...STEPS.filter((name) => name !== "computer_observe" || tools.includes(name)), HANDOFF]) assert.ok(tools.includes(name) && !deferred.includes(name), `${id}: ${name} is listed: ${JSON.stringify({ tools, deferred })}`);
    assert.equal(tools.includes("codemode"), id !== "codex", `${id}: the host's codemode${id === "codex" ? " is not offered beside Codex's own" : " is offered"}: ${JSON.stringify(tools)}`);
    if (tools.includes(OP)) assert.equal(deferred.includes(OP), id !== "codex", `${id}: computer_op ${id === "codex" ? "listed, for Codex's own code mode" : "for scripts alone"}: ${JSON.stringify({ tools, deferred })}`);
  }
});

test("under surface code every CLI harness's desktop run reaches the step tools from a script alone: listed nowhere but on Codex, whose own code mode reaches only what it is handed; never computer_script", { timeout: 240_000 }, async (t) => {
  const seen = await handed(t, "code");
  for (const [id, { tools, deferred }] of Object.entries(seen)) {
    assert.ok(!tools.includes(SCRIPT_TOOL), `${id}: no computer_script: ${JSON.stringify(tools)}`);
    const steps = STEPS.filter((name) => tools.includes(name));
    assert.ok(steps.includes("computer_act") && steps.includes("computer_screenshot"), `${id}: the step tools are bound: ${JSON.stringify(tools)}`);
    assert.deepEqual(steps.filter((name) => deferred.includes(name)), id === "codex" ? [] : steps, `${id}: ${id === "codex" ? "listed, for its own code mode" : "for scripts alone"}: ${JSON.stringify({ tools, deferred })}`);
    assert.ok(tools.includes(HANDOFF) && !deferred.includes(HANDOFF), `${id}: the hand-over is listed`);
    assert.equal(tools.includes("codemode"), id !== "codex", `${id}: codemode: ${JSON.stringify(tools)}`);
  }
});
