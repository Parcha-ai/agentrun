// A run's tools on the kernel's registry (serve/src/workspace/run-tools.ts runTools): the registry's definitions over
// the run's hands and executors. With no computer the run sees read, write, edit and bash, and its hands have no
// processes; a computer gives the five background tools too, on the attached Workspace's processes (hands.ts
// processesOf, the kernel's narrow port over computerd's calls). bash's bound is the registry's, by the hands' ceiling;
// a timeout keeps what the command printed; the run's end ends background processes, then sweeps.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { NEEDS_A_COMPUTER } from "@parcha/agentrun-kernel/kernel";
import { localWorkspace, processesOf, runTools } from "../dist/workspace/index.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { realProcesses } from "./workspace-fake-processes.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-registry-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}
const call = (tools, name, args, attempt) => tools.find((tool) => tool.name === name).call(args, { callId: `c-${name}-${Math.random()}`, signal: new AbortController().signal, ...(attempt ? { attempt } : {}) });

test("no computer: the registry's runner list (read, write, edit, bash), no processes on the hands, a background call refused in words; the end sweeps", async () => {
  const root = scratch();
  const run = await runTools(localWorkspace(root), undefined, { mode: 1, context: ctx });
  assert.deepEqual(run.registry.list().map((def) => def.name), ["read", "write", "edit", "bash"]);
  assert.equal(run.hands.processes, undefined);
  const tools = run.hostTools(["read", "write", "bash", "bash_background", "web_fetch"]);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.replay]), [["read", "safe"], ["write", "never"], ["bash", "never"]]);
  assert.equal((await call(tools, "write", { path: "a.txt", content: "hi" })).text, "Successfully wrote to a.txt");
  assert.deepEqual(await call(tools, "bash", { command: "cat a.txt" }), { text: "hi", isError: false });
  const refused = await run.registry.invoke("bash_background", { command: "sleep 9" }, { hands: run.hands });
  assert.equal(refused.error, NEEDS_A_COMPUTER, "the registry's own words for it");
  await run.end();
  assert.ok(!existsSync(join(root, ".agentrun", "tmp")), "the end swept TMPDIR");
});

// The 120 s default with no timeout given is the kernel registry's own (run-adapters/test/kernel-registry.test.mjs).
test("bash's bound is the registry's, by the hands' ceiling: Archil's 295 s in bash's words; one past it runs at it and says so; a timeout is said as pi says it, its output kept", async () => {
  const run = await runTools(localWorkspace(scratch()), undefined, { mode: 2, context: ctx });
  const [bash] = run.hostTools(["bash"]);
  assert.match(bash.description, /at most 295 s/, "Archil's ceiling, in bash's words");
  const capped = await call([bash], "bash", { command: "echo hi", timeout: 900 });
  assert.equal(capped.text, "hi\n\n\nbash runs a command for at most 295 s: this one ran with 295 s, not the 900 s asked.");
  const timed = await call([bash], "bash", { command: "echo before; sleep 30", timeout: 0.5 });
  assert.deepEqual(timed, { text: "before\n\n\nCommand timed out after 0.5 seconds", isError: true });
});

test("a computer: the registry's computer list, with the five background tools on the attached Workspace's processes", async () => {
  const root = scratch();
  const computer = realProcesses(fakeComputer(root), root);
  const run = await runTools(localWorkspace(root), { kind: "sandbox", computer, check: { readBackOf } }, { mode: 1, context: ctx });
  assert.deepEqual(run.registry.list().map((def) => def.name), ["read", "write", "edit", "bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]);
  assert.ok(run.hands.processes, "the hands carry the computer's processes");
  computer.overrides["process.list"] = () => ({ processes: [], truncated: false, next: 0 });
  const [list] = run.hostTools(["bash_list"]);
  const listed = await call([list], "bash_list", {});
  assert.equal(listed.isError, false, listed.text);
  assert.ok(computer.calls.some(([method]) => method === "process.list"), "bash_list read the computer's processes");
  await run.end();
});

test("processesOf: the kernel's port over the attached Workspace's process calls, only the fields the tools use; a refusal throws its code and words", async () => {
  const calls = [];
  const answer = (method, value) => async (params) => (calls.push([method, params]), { ok: true, value });
  const process = {
    start: answer("start", { id: "p7", pid: 70 }),
    read: answer("read", { data: Buffer.from("héllo").toString("base64"), nextOffset: 6, dropped: 0, exited: false, size: 6, capped: true }),
    write: answer("write", {}),
    signal: answer("signal", { note: "no foreground job" }),
    wait: answer("wait", {}),
    list: async (params) => {
      calls.push(["list", params]);
      const one = (id) => ({ id, pid: 1, argv: ["bash", "-c", "x", "agentrun-background", id], argvClipped: false, pty: false, running: true, exitCode: null, signal: null, startedAt: 5, endedAt: null });
      return params.from === 0 ? { ok: true, value: { processes: [one("p1")], truncated: true, next: 1 } } : { ok: true, value: { processes: [one("p2")], truncated: false, next: 2 } };
    },
  };
  const port = processesOf(process);
  assert.deepEqual(await port.start({ argv: ["bash", "-c", "s"], cwd: ".", log: "background/1/output.log", waitGroup: true, orphans: "keep", pty: { cols: 80, rows: 24 } }), { handle: "p7", pid: 70 });
  assert.deepEqual(calls.at(-1), ["start", { argv: ["bash", "-c", "s"], cwd: ".", log: "background/1/output.log", waitGroup: true, orphans: "keep", pty: { cols: 80, rows: 24 } }]);
  const read = await port.read("p7", { offset: 0, maxBytes: 100 });
  assert.deepEqual([Buffer.from(read.data).toString(), read.size, read.capped], ["héllo", 6, true]);
  assert.deepEqual(calls.at(-1), ["read", { id: "p7", stream: "log", offset: 0, maxBytes: 100 }]);
  await port.write("p7", { data: Buffer.from("y\n"), close: true });
  assert.deepEqual(calls.at(-1), ["write", { id: "p7", data: Buffer.from("y\n").toString("base64"), close: true }]);
  assert.deepEqual(await port.signal("p7", "INT"), { note: "no foreground job" });
  assert.deepEqual(calls.at(-1), ["signal", { id: "p7", signal: "INT" }]);
  assert.deepEqual((await port.list()).map((info) => [info.handle, info.running, info.startedAt, info.argv[3]]), [["p1", true, 5, "agentrun-background"], ["p2", true, 5, "agentrun-background"]], "every page");
  const refusing = processesOf({ ...process, signal: async () => ({ ok: false, error: { code: "not_found", message: "no process p9" } }) });
  await assert.rejects(refusing.signal("p9", "TERM"), (error) => error.code === "not_found" && error.message === "no process p9");
});
