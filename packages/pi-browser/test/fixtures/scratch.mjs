import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
export const CHROME_SINGLETON = /^\.?(org\.chromium\.Chromium|com\.google\.Chrome)\.[A-Za-z0-9]{6}$/;

/** Every directory scratch made in this process; the preload removes any that a teardown outliving its test made again. */
export const made = new Set();

// A hook added while hooks run goes last, so the directory outlives every other cleanup of its test (a Chrome's release);
// whatever still runs in it by then (a Chrome a capped teardown left up) is killed first, and said.
const removeLast = (t, dir) => t.after(() => t.after(async () => {
  for (let round = 0, found; round < 20 && (found = killNaming(dir, [process.pid])).length > 0; round += 1) {
    if (round === 0) t.diagnostic(`killed ${found.length} process(es) still running in ${path.basename(dir)} after its test's cleanups`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await rm(dir, RM);
}));

export async function scratch(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  made.add(dir);
  removeLast(t, dir);
  return dir;
}

export function scratchSync(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  removeLast(t, dir);
  return dir;
}

// The environment too: a child host names the directory only through the TMPDIR it inherited.
export function processesNaming(dir) {
  if (!fs.existsSync("/proc/self/stat")) {
    const ps = spawnSync("ps", ["-A", "-ww", "-E", "-o", "pid=", "-o", "pgid=", "-o", "command="], { encoding: "utf8" });
    return ps.stdout.split("\n").flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m && m[3].includes(dir) ? [{ pid: Number(m[1]), pgid: Number(m[2]), cmd: m[3] }] : [];
    });
  }
  return fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try {
      const read = (file) => fs.readFileSync(`/proc/${name}/${file}`, "latin1");
      const cmd = read("cmdline");
      let env = "";
      try { env = read("environ"); } catch {}
      if (!cmd.includes(dir) && !env.includes(dir)) return [];
      const stat = read("stat");
      return [{ pid: Number(name), pgid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]), cmd: cmd.replaceAll("\0", " ").trim() }];
    } catch { return []; }
  });
}

// Only a group whose leader names `dir` is killed whole, so the runner's group is never signalled.
export function killNaming(dir, except = []) {
  const found = processesNaming(dir).filter((p) => !except.includes(p.pid));
  const pids = new Set(found.map((p) => p.pid));
  for (const { pgid } of found) if (pids.has(pgid)) try { process.kill(-pgid, "SIGKILL"); } catch {}
  for (const { pid } of found) try { process.kill(pid, "SIGKILL"); } catch {}
  return found;
}
