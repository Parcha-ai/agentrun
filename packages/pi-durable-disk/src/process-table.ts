// The process table a run reads to know its commands and its holder. On Linux it is /proc, read live. macOS has no /proc:
// there it is one ps(1) listing per look, ps for a process's environment, and sysctl(8) for the boot. A process's start
// tells it from a later process with the same pid: on Linux its start time in clock ticks after boot (field 22 of
// /proc/<pid>/stat), on macOS the second it started (ps's `lstart`, read in UTC). A start is only ever compared with
// another read on the same machine and boot. On macOS a pid freed and handed out again within the same second would pass
// for the old process; pids there are handed out in order up to 99999 before one is reused.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A live process (a zombie is not one): its parent, its group, and its start. */
export interface ProcessInfo {
  readonly ppid: number;
  readonly pgrp: number;
  readonly start: number;
}

/** One look at the processes. Through ps, every `info` and `children` of one snapshot sees the same listing; /proc is read live. */
export interface ProcessSnapshot {
  info(pid: number): ProcessInfo | undefined;
  /** The direct children of `pid`. */
  children(pid: number): number[];
  /** Whether `pid` was started with `name=value` in its environment (false when it cannot be read). */
  marked(pid: number, name: string, value: string): boolean;
  /** Its command line, for a message; `?` when it cannot be read. */
  commandLine(pid: number): string;
}

export interface ProcessTable {
  /** A new look. Through ps it throws when the listing cannot be had or read: no process is ever taken for gone on a failed read. */
  snapshot(): ProcessSnapshot;
  /** This boot's id; undefined when it cannot be read. */
  bootId(): string | undefined;
  /** How often a recorder's walk is worth repeating: a /proc read is cheap, a ps listing is not. */
  readonly walkMs: number;
}

/** The table on Linux: `/proc` (or another directory laid out like it, for tests). */
export function procTable(proc = "/proc"): ProcessTable {
  const read = (...parts: string[]) => readFileSync(join(proc, ...parts), "utf8");
  const snapshot: ProcessSnapshot = {
    // `stat`'s fields after the last `)`, since the command name may hold spaces and parentheses.
    info(pid) {
      try {
        const text = read(String(pid), "stat");
        const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
        if (fields[0] === "Z" || fields[0] === "X") return undefined;
        return { ppid: Number(fields[1]), pgrp: Number(fields[2]), start: Number(fields[19]) };
      } catch {
        return undefined;
      }
    },
    // From each of its threads' `children` list.
    children(pid) {
      let tasks: string[];
      try {
        tasks = readdirSync(join(proc, String(pid), "task"));
      } catch {
        return [];
      }
      return tasks.flatMap((tid) => {
        try {
          return read(String(pid), "task", tid, "children").split(" ").filter(Boolean).map(Number);
        } catch {
          return [];
        }
      });
    },
    marked(pid, name, value) {
      try {
        return read(String(pid), "environ").split("\0").includes(`${name}=${value}`);
      } catch {
        return false;
      }
    },
    commandLine(pid) {
      try {
        return read(String(pid), "cmdline").split("\0").filter(Boolean).join(" ") || "?";
      } catch {
        return "?";
      }
    },
  };
  return {
    snapshot: () => snapshot,
    bootId() {
      try {
        return read("sys/kernel/random/boot_id").trim() || undefined;
      } catch {
        return undefined;
      }
    },
    walkMs: 100,
  };
}

/** Runs a program with arguments and returns what it printed; throws when it fails. */
export type CommandRunner = (file: string, args: readonly string[]) => string;

const PS = "/bin/ps";
const SYSCTL = "/usr/sbin/sysctl";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** In the C locale and UTC, so `lstart` reads the same whatever the user's settings. */
const runCommand: CommandRunner = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 64 << 20 });

/**
 * One line of `ps -A -o pid=,ppid=,pgid=,stat=,lstart=` in UTC: `pid ppid pgid stat Www Mmm dd hh:mm:ss yyyy`. Null
 * for a zombie; throws on a line it does not read.
 */
function psLine(line: string): [number, ProcessInfo] | null {
  const f = line.trim().split(/\s+/);
  const [pid, ppid, pgrp] = f.slice(0, 3).map(Number);
  const month = MONTHS.indexOf(f[5] ?? "");
  const [h, m, s] = (f[7] ?? "").split(":").map(Number);
  const start = Date.UTC(Number(f[8]), month, Number(f[6]), h!, m!, s!) / 1000;
  if (f.length !== 9 || ![pid, ppid, pgrp, start].every(Number.isSafeInteger) || month < 0) throw new Error(`ps printed a line this does not read: ${JSON.stringify(line)}`);
  return f[3]!.startsWith("Z") ? null : [pid!, { ppid: ppid!, pgrp: pgrp!, start }];
}

/** The table on macOS: `ps` and `sysctl`, through `run` (for tests). */
export function psTable(run: CommandRunner = runCommand): ProcessTable {
  let boot: string | undefined;
  return {
    snapshot() {
      const rows = new Map<number, ProcessInfo>();
      for (const line of run(PS, ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="]).split("\n")) {
        if (line.trim() === "") continue;
        const row = psLine(line);
        if (row !== null) rows.set(...row);
      }
      return {
        info: (pid) => rows.get(pid),
        children: (pid) => [...rows].filter(([, info]) => info.ppid === pid).map(([child]) => child),
        // `-E` prints the environment the process was started with after its arguments, separated by spaces; a mark is
        // a name and a UUID, which hold none.
        marked(pid, name, value) {
          try {
            return run(PS, ["-ww", "-E", "-p", String(pid), "-o", "command="]).split(/\s+/).includes(`${name}=${value}`);
          } catch {
            return false;
          }
        },
        commandLine(pid) {
          try {
            return run(PS, ["-ww", "-p", String(pid), "-o", "command="]).trim() || "?";
          } catch {
            return "?";
          }
        },
      };
    },
    // Read once it can be: a boot's id does not change.
    bootId() {
      try {
        boot ??= run(SYSCTL, ["-n", "kern.bootsessionuuid"]).trim() || undefined;
      } catch {
        // not now; the next call asks again
      }
      return boot;
    },
    walkMs: 500,
  };
}

/** Test seam: a table that stands in for this machine's everywhere `processTable()` is read. */
export const processTableHooks: { table?: ProcessTable } = {};

let platformTable: { readonly platform: NodeJS.Platform; readonly table: ProcessTable } | undefined;

/** This machine's table: ps on macOS, /proc elsewhere. */
export function processTable(): ProcessTable {
  if (processTableHooks.table !== undefined) return processTableHooks.table;
  if (platformTable?.platform !== process.platform) {
    platformTable = { platform: process.platform, table: process.platform === "darwin" ? psTable() : procTable() };
  }
  return platformTable.table;
}

/** This boot's id on this machine, null when it cannot be read. */
export function thisBoot(): string | null {
  return processTable().bootId() ?? null;
}
