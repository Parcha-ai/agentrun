// Real processes behind a fake computer's process calls (workspace-fake-computer.mjs), as computerd answers them: a
// program started in its own process group, with /workspace/<path> mapped onto the bound host folder; stdout and stderr
// kept whole and read by offset, a read waiting up to waitMs for bytes or the end; a signal to the program's group;
// and, as computerd's guard does, every process the program left killed once it ends, so nothing it started outlives
// it. Only what the attached Workspace's exec calls: start, write (stdin, for a process started with `stdin`), read,
// signal, wait.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readBackOf } from "@parcha/agentrun-computer";
import { fakeComputer } from "./workspace-fake-computer.mjs";

/** The minimal environment computerd adds the call's over. */
const BASE_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin" };
const fail = (code, message) => Object.assign(new Error(message), { code });

/** `computer`'s process calls answered by real processes on this machine, its /workspace being `root`. */
export function realProcesses(computer, root) {
  const table = new Map();
  let next = 1;
  const host = (path) => join(root, path.slice("/workspace".length));
  const waiters = new Set();
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const until = (ready, ms) => new Promise((resolve) => {
    if (ready() || ms <= 0) return resolve();
    const done = () => { if (!ready()) return; clearTimeout(timer); waiters.delete(done); resolve(); };
    const timer = setTimeout(() => { waiters.delete(done); resolve(); }, ms);
    waiters.add(done);
  });

  computer.overrides["process.start"] = ({ argv, cwd = "/workspace", env = {}, stdin = false }) => new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: host(cwd), env: { ...BASE_ENV, ...env }, detached: true, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    child.stdin?.on("error", () => {});
    const id = `p${next++}`;
    const entry = { child, out: { stdout: [], stderr: [] }, size: { stdout: 0, stderr: 0 }, exit: undefined, closed: false };
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", (chunk) => { entry.out[stream].push(chunk); entry.size[stream] += chunk.length; wake(); });
    child.on("error", (error) => reject(error.code === "ENOENT" ? fail("ENOENT", `${argv[0]}: not found`) : error));
    child.on("spawn", () => { table.set(id, entry); resolve({ id, pid: child.pid }); });
    child.on("exit", (code, signal) => {
      entry.exit = { exitCode: code, signal: signal ? signal.replace(/^SIG/, "") : null };
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ }
      wake();
    });
    child.on("close", () => { entry.closed = true; wake(); });
  });

  computer.overrides["process.read"] = async ({ id, stream, offset, maxBytes = 512 * 1024, waitMs = 0 }) => {
    const entry = table.get(id);
    if (!entry) throw fail("ENOENT", `no process ${id}`);
    await until(() => entry.size[stream] > offset || entry.closed, waitMs);
    const all = Buffer.concat(entry.out[stream]);
    const data = all.subarray(offset, offset + maxBytes);
    const nextOffset = offset + data.length;
    return { data: data.toString("base64"), nextOffset, dropped: 0, exited: entry.closed && nextOffset >= all.length, size: all.length };
  };

  // As computerd's: a process started without stdin is refused; `close` closes its stdin after the data.
  computer.overrides["process.write"] = async ({ id, data = "", close = false }) => {
    const entry = table.get(id);
    if (!entry) throw fail("ENOENT", `no process ${id}`);
    const input = entry.child.stdin;
    if (!input) throw fail("invalid", `process ${id} was started without stdin`);
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > 0) await new Promise((resolve) => input.write(bytes, () => resolve()));
    if (close) input.end();
    return {};
  };

  computer.overrides["process.signal"] = ({ id, signal }) => {
    const entry = table.get(id);
    if (!entry) throw fail("ENOENT", `no process ${id}`);
    if (entry.exit === undefined) try { process.kill(-entry.child.pid, `SIG${signal}`); } catch { /* ended */ }
    return {};
  };

  computer.overrides["process.wait"] = async ({ id, timeoutMs }) => {
    const entry = table.get(id);
    if (!entry) throw fail("ENOENT", `no process ${id}`);
    await until(() => entry.exit !== undefined, timeoutMs);
    return entry.exit === undefined ? { running: true, exitCode: null, signal: null } : { running: false, ...entry.exit };
  };

  return computer;
}

/** A runner's computerForClaim(launch, store, deps) stand-in that gives the run a sandbox: the fake computer over the
 *  run's own folder (Mode 1, a bind of it, as Docker's mount is), its process calls run for real (realProcesses), its
 *  mount checked with the computer module's readBackOf. `made` gets each computer, `released` counts the releases. */
export function sandboxForClaim() {
  const made = [];
  let released = 0;
  return {
    made,
    released: () => released,
    forClaim: async (_launch, _store, deps) => {
      const spec = await deps.workspace.mountSpec();
      if (spec?.kind !== "bind") throw new Error(`the fake sandbox binds a folder of this machine (Mode 1), not ${JSON.stringify(spec)}`);
      const computer = realProcesses(fakeComputer(spec.path), spec.path);
      made.push(computer);
      return { computer: { kind: "sandbox", computer, check: { readBackOf } }, release: async () => void (released += 1) };
    },
  };
}
