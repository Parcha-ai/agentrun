// A sandbox computer for a runner test whose run needs a shell (a run with no mounting computer gets none, #2088): the
// attach tests' fake computer (workspace-fake-computer.mjs), bound to the run's folder, whose processes run for real on
// this machine in that folder and stream their output as computerd's do (process.start, process.read from each stream's
// offset with a wait, process.wait, process.signal), so a running bash's output reaches the run's live view as it comes.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readBackOf } from "@parcha/agentrun-computer";
import { fakeComputer } from "../workspace-fake-computer.mjs";

/** The computer at `folder` (the run's folder, which /workspace binds), as a claim's computerForClaim answers it. */
export function streamingSandbox(folder) {
  const computer = fakeComputer(folder);
  const host = (path) => join(folder, String(path ?? "/workspace").replace(/^\/workspace\/?/, ""));
  const procs = new Map();
  let next = 0;
  computer.overrides["process.start"] = ({ argv, cwd, env }) => {
    const id = `p${(next += 1)}`;
    const child = spawn(argv[0], argv.slice(1), { cwd: host(cwd), env: { PATH: process.env.PATH, ...env } });
    const proc = { child, out: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, exit: undefined, waiters: new Set() };
    const wake = () => { for (const resolve of proc.waiters) resolve(); proc.waiters.clear(); };
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", (chunk) => { proc.out[stream] = Buffer.concat([proc.out[stream], chunk]); wake(); });
    child.on("close", (code, signal) => { proc.exit = { exitCode: code, signal: signal ? signal.replace(/^SIG/, "") : null }; wake(); });
    procs.set(id, proc);
    return { id, pid: child.pid };
  };
  computer.overrides["process.read"] = async ({ id, stream, offset, waitMs = 0 }) => {
    const proc = procs.get(id);
    if (proc.out[stream].length <= offset && proc.exit === undefined && waitMs > 0) {
      await new Promise((resolve) => { proc.waiters.add(resolve); setTimeout(resolve, waitMs); });
    }
    const data = proc.out[stream].subarray(offset);
    return { data: data.toString("base64"), nextOffset: offset + data.length, dropped: 0, exited: proc.exit !== undefined && data.length === 0 };
  };
  computer.overrides["process.wait"] = async ({ id }) => {
    const proc = procs.get(id);
    if (proc.exit === undefined) await new Promise((resolve) => proc.waiters.add(resolve));
    while (proc.exit === undefined) await new Promise((resolve) => proc.waiters.add(resolve));
    return { running: false, exitCode: proc.exit.exitCode, signal: proc.exit.signal };
  };
  computer.overrides["process.signal"] = ({ id, signal }) => {
    procs.get(id)?.child.kill(`SIG${String(signal).replace(/^SIG/, "")}`);
    return {};
  };
  return {
    computer: { kind: "sandbox", computer, check: { readBackOf } },
    release: async () => { for (const proc of procs.values()) if (proc.exit === undefined) proc.child.kill("SIGKILL"); },
  };
}
