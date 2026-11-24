// A command a test starts that cannot outlive it, and a bounded wait on it: serve's eval-template CLI test and the
// agentrun CLI's template eval tests start their commands through these. The command runs in a process group of its own, and on every
// path (a pass, a failed assertion, the test's timeout) that group (the command and what it started) is sent a SIGKILL and
// the test lets go of its pipes, which a process it started may still hold, so no case keeps its file's process alive past
// its end. A signal a case sends goes to the command alone.
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** `script` run by this Node with `args`: `seen` gathers its output; `exited` and `closed` resolve to its exit code (or
 *  signal) at its exit and once its output has closed too. */
export function started(t, script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const seen = { out: "", err: "", child };
  child.stdout.on("data", (chunk) => (seen.out += chunk));
  child.stderr.on("data", (chunk) => (seen.err += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(code ?? signal)));
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve(code ?? signal)));
  t.after(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group has ended: nothing is left to stop.
    }
    child.stdout.destroy();
    child.stderr.destroy();
  });
  return { child, seen, exited, closed };
}

/** `script` run to its end: its exit code (or signal) and its output once its output has closed, failing past `ms` as
 *  `within` does. */
export async function ran(t, script, args, env, ms) {
  const { seen, closed } = started(t, script, args, env);
  const status = await within(closed, ms, args.join(" "), seen);
  return { status, out: seen.out, err: seen.err };
}

/** `promise`, or a failure once `ms` pass naming `what`, with the command's stderr so far and, on Linux, what is still
 *  alive in its group and every process that holds its stderr open (a command's output closes only once the last one
 *  lets go). */
export function within(promise, ms, what, seen) {
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: not within ${ms / 1000} s. Its stderr so far:\n${seen.err}${seen.child ? holders(seen.child) : ""}`)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Each thread of `pid`, one line each: its id, name, state, the kernel function it sleeps in (wchan) and the system
 *  call it is in, by number and first arguments ("running" when in none). A command that printed its last line and
 *  never exited shows here where it waits: Node's MainThread in a write, a futex (a lock, or a thread it joins at exit)
 *  or a poll, and what each libuv-worker and V8Worker is doing meanwhile. The test's process is the command's
 *  ancestor, so ptrace scope 1 lets it read a thread's system call; a field it can't read shows why. */
function threadsOf(pid) {
  const field = (path) => {
    try {
      return readFileSync(path, "utf8").trim() || "-";
    } catch (error) {
      return `(${error.code})`;
    }
  };
  try {
    return readdirSync(`/proc/${pid}/task`).map((tid) => {
      const at = `/proc/${pid}/task/${tid}`;
      const stat = field(`${at}/stat`);
      const syscall = field(`${at}/syscall`).split(" ");
      return `  thread ${tid} ${field(`${at}/comm`)} ${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]} wchan ${field(`${at}/wchan`)} syscall ${syscall.slice(0, 3).join(" ")}`;
    });
  } catch {
    return [];
  }
}

/** The processes left in `child`'s group, each with its threads (threadsOf), and those holding its stderr's other end,
 *  on Linux: "" elsewhere. Node's stdio "pipe" is a socket pair, whose other end `ss` names by this end's inode (its
 *  peer). */
function holders(child) {
  try {
    readdirSync("/proc/self/fd");
  } catch {
    return "";
  }
  // The holders, apart: without them (no ss, or it fails), the group is still listed.
  const holding = new Set();
  let holdersUnknown = "";
  try {
    const own = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${child.stderr._handle.fd}`))?.[1];
    if (own === undefined) throw new Error("its stderr is no socket");
    for (const line of execFileSync("ss", ["-xpnH"], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024 }).split("\n")) {
      if (line.trim().split(/\s+/)[7] === own) for (const [, pid] of line.matchAll(/pid=(\d+)/g)) holding.add(pid);
    }
  } catch (error) {
    holdersUnknown = ` (not known: ${error.message.split("\n")[0]})`;
  }
  try {
    const group = [];
    const held = [];
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const [state, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const inGroup = Number(pgrp) === child.pid;
        // A cmdline read can block on its process's memory lock: read only the ones listed.
        if (!inGroup && !holding.has(pid)) continue;
        const line = `${pid} ppid ${ppid} pgrp ${pgrp} ${state} ${readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim().slice(0, 200)}`;
        if (inGroup) group.push(line, ...threadsOf(pid));
        if (holding.has(pid)) held.push(line);
      } catch {
        // Gone, or not ours to read.
      }
    }
    return `\nIn its group (${child.pid}):\n${group.join("\n") || "(none)"}\nHolding its stderr open${holdersUnknown}:\n${held.join("\n") || "(none)"}`;
  } catch {
    return "";
  }
}
