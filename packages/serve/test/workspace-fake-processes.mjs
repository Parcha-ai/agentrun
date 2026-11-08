// Real processes behind a fake computer's process calls (workspace-fake-computer.mjs), as computerd answers them: a
// program started in its own process group, with /workspace/<path> mapped onto the bound host folder; stdout and stderr
// kept whole and read by offset, a read waiting up to waitMs for bytes or the end; a signal to the program's group;
// and, as computerd's guard does, every process the program left killed once it ends, so nothing it started outlives
// it. Only what the attached Workspace's exec calls: start, read, signal, wait.
import { spawn } from "node:child_process";
import { join } from "node:path";

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

  computer.overrides["process.start"] = ({ argv, cwd = "/workspace", env = {} }) => new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: host(cwd), env: { ...BASE_ENV, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
