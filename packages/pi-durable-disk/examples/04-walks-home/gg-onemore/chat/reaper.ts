// The kept GPU box's fail-safe (`stop-gg.sh --keep-box`): a detached process that terminates the kept sandbox unless a
// `live-gg.mjs --reuse-box` start claims it (box-state/claimed names it) within its minutes, so a box nobody comes back to
// does not idle until its TTL. Its pid is <home>/reaper.pid; the claim, a plain stop and a new start end it by that exact
// pid. startReaper runs this file:
//   node chat/reaper.ts <home> <sandbox> <minutes> -- <the command that terminates the sandbox...>
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const claimFile = (home: string) => join(home, "box-state", "claimed");
const pidFile = (home: string) => join(home, "reaper.pid");

/** A --reuse-box start takes the kept box: the reaper watching it stands down. */
export function claimBox(home: string, sandbox: string): void {
  writeFileSync(claimFile(home), sandbox, { mode: 0o600 });
}

const claimed = (home: string, sandbox: string) => {
  try {
    return readFileSync(claimFile(home), "utf8").trim() === sandbox;
  } catch {
    return false;
  }
};

export async function reapUnlessClaimed(o: {
  home: string;
  sandbox: string;
  minutes: number;
  terminate: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<"claimed" | "reaped"> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + o.minutes * 60_000;
  while (now() < deadline) {
    await sleep(Math.min(5_000, Math.max(50, deadline - now())));
    if (claimed(o.home, o.sandbox)) return "claimed";
  }
  o.terminate();
  return "reaped";
}

/** Starts the reaper detached (its own session, past the launcher's exit), its output in <home>/reaper.log; its pid. */
export function startReaper(o: { home: string; sandbox: string; minutes: number; command: readonly string[] }): number {
  // a claim left from an earlier keep is not a claim of this one; cleared here, before the reaper runs, so a start that
  // claims the box before the reaper's process is up still counts
  rmSync(claimFile(o.home), { force: true });
  const log = openSync(join(o.home, "reaper.log"), "a", 0o600);
  const child = spawn(process.execPath, [HERE, o.home, o.sandbox, String(o.minutes), "--", ...o.command], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  writeFileSync(pidFile(o.home), String(child.pid), { mode: 0o600 });
  return child.pid!;
}

const isReaper = (pid: number, home: string) => {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return cmd.includes(HERE) && cmd.includes(home);
  } catch {
    return false;
  }
};

/** Ends this home's reaper by its exact pid (checked against /proc: a pid file naming another process kills nothing). */
export function stopReaper(home: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile(home), "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !isReaper(pid, home)) {
    if (!existsSync(`/proc/${pid}`)) rmSync(pidFile(home), { force: true });
    return false;
  }
  process.kill(pid, "SIGTERM");
  rmSync(pidFile(home), { force: true });
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  const [home, sandbox, minutes, sep, ...command] = process.argv.slice(2);
  if (!home || !sandbox || !(Number(minutes) > 0) || sep !== "--" || command.length === 0) {
    console.error("usage: node chat/reaper.ts <home> <sandbox> <minutes> -- <terminate command...>");
    process.exit(2);
  }
  const say = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, sandbox, ...data }));
  say("reaper.start", { minutes: Number(minutes) });
  const out = await reapUnlessClaimed({
    home,
    sandbox,
    minutes: Number(minutes),
    terminate: () => {
      const r = spawnSync(command[0]!, command.slice(1), { encoding: "utf8" });
      say("reaper.terminate", { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").at(-1) });
    },
  });
  say(`reaper.${out}`);
  try {
    if (readFileSync(pidFile(home), "utf8").trim() === String(process.pid)) rmSync(pidFile(home), { force: true });
  } catch {
    // already gone
  }
}
