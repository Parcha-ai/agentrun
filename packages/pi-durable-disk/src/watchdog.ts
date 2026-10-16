// The lease watchdog on a thread of its own. A store commit is synchronous, so a FUSE daemon that stops
// answering blocks the instance's main thread inside the kernel, and with it every timer the main thread owns. This
// thread never touches the mount: it reads a clock reading the main thread shares, /proc and the cgroup (on macOS, one
// ps listing), and sends signals. Once the lease has lapsed it kills the instance's commands on every look, until the main thread runs again,
// sees the flag and takes the normal fence path (exit 75).
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

/** Slots of the shared BigInt64Array. Clock readings are `process.hrtime.bigint()`, monotonic and the same on every thread. */
export const SLOT_BEAT = 0; // when the last successful heartbeat write started
export const SLOT_LIMIT = 1; // expiry minus margin, in ns
export const SLOT_LAPSED = 2; // 0 while the lease holds; else how old the last beat was when this thread found it lapsed
export const SLOT_KILLED = 3; // signals sent so far
const SLOTS = 4;

// The watchdog's code is plain CommonJS JavaScript in strings this module carries, and the worker is started from that
// source (`eval: true`), never from this module's URL: bundled into an app, this module's URL is the app's bundle, and a
// worker loaded from it would run the whole app again. A bundler leaves string contents alone, so the worker runs the
// same text whatever bundles the module. It must stay free of ESM syntax (`import`, `export`, `import.meta`): Node then
// runs it as CommonJS, with `require`. The main thread compiles the same LIB text for `lapsed` and `sweep`, so the tests
// exercise exactly the code the worker runs.
const LIB = String.raw`
const SLOT_BEAT = 0, SLOT_LIMIT = 1, SLOT_LAPSED = 2, SLOT_KILLED = 3;

function lapsed(shared, now) {
  if (Atomics.load(shared, SLOT_LAPSED) !== 0n) return true;
  const age = now - Atomics.load(shared, SLOT_BEAT);
  if (age <= Atomics.load(shared, SLOT_LIMIT)) return false;
  Atomics.compareExchange(shared, SLOT_LAPSED, 0n, age);
  return true;
}

function stat(proc, pid) {
  try {
    const text = fs.readFileSync(path.join(proc, String(pid), "stat"), "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(fields[1]), pgrp: Number(fields[2]) };
  } catch {
    return undefined;
  }
}

function cgroupPids(instance, proc, sys) {
  try {
    const line = fs.readFileSync(path.join(proc, String(instance), "cgroup"), "utf8").split("\n").find((l) => l.startsWith("0::"));
    if (line === undefined) return [];
    return fs.readFileSync(path.join(sys, line.slice(3), "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** The instance's group and its direct children, from /proc. */
function procTree(instance, proc) {
  const own = stat(proc, instance);
  if (own === undefined) return undefined;
  const children = [];
  for (const entry of fs.readdirSync(proc)) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === instance) continue;
    const child = stat(proc, pid);
    if (child !== undefined && child.ppid === instance) children.push({ pid, pgrp: child.pgrp });
  }
  return { pgrp: own.pgrp, children };
}

/** The same from one ps listing, where there is no /proc (macOS). */
function psTree(instance, ps) {
  let text;
  try {
    text = ps("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid="]);
  } catch {
    return undefined;
  }
  const rows = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/).map(Number);
    if (f.length === 3 && f.every(Number.isInteger)) rows.push({ pid: f[0], ppid: f[1], pgrp: f[2] });
  }
  const own = rows.find((row) => row.pid === instance);
  if (own === undefined) return undefined;
  return { pgrp: own.pgrp, children: rows.filter((row) => row.ppid === instance && row.pid > 0 && row.pid !== instance) };
}

const runPs = (file, args) => child_process.execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });

function sweep(instance, options = {}) {
  const proc = options.proc ?? "/proc";
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const ps = options.ps ?? (options.proc === undefined && process.platform === "darwin" ? runPs : undefined);
  const tree = ps === undefined ? procTree(instance, proc) : psTree(instance, ps);
  if (tree === undefined) return 0;
  const targets = new Set();
  for (const child of tree.children) targets.add(child.pgrp === tree.pgrp || child.pgrp <= 1 ? child.pid : -child.pgrp);
  if (options.ownCgroup && ps === undefined) {
    for (const pid of cgroupPids(instance, proc, options.sys ?? "/sys/fs/cgroup")) if (pid !== instance && pid > 0) targets.add(pid);
  }
  let sent = 0;
  for (const target of targets) {
    try {
      kill(target, "SIGKILL");
      sent++;
    } catch {
      // gone already, or not ours to signal
    }
  }
  return sent;
}
`;

const WORKER_SOURCE = `"use strict";
const child_process = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { workerData } = require("node:worker_threads");
${LIB}
const shared = new BigInt64Array(workerData.buffer);
setInterval(() => {
  if (!lapsed(shared, process.hrtime.bigint())) return;
  Atomics.add(shared, SLOT_KILLED, BigInt(sweep(workerData.instance, { ownCgroup: workerData.ownCgroup })));
}, workerData.checkMs);
`;

export interface SweepOptions {
  /** The instance runs in a cgroup of its own (a systemd unit, a container): every other process in it is killed too. */
  readonly ownCgroup?: boolean;
  readonly proc?: string;
  readonly sys?: string;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Lists processes with this ps(1) instead of reading `proc`: the default on macOS, which has no /proc, unless `proc` is given. */
  readonly ps?: (file: string, args: readonly string[]) => string;
}

const compiled = new Function("child_process", "fs", "path", `"use strict";${LIB}\nreturn { lapsed, sweep };`)(child_process, fs, path) as {
  lapsed(shared: BigInt64Array, now: bigint): boolean;
  sweep(instance: number, options?: SweepOptions): number;
};

/** One look at the shared state at `now`. True once the lease has lapsed, for good; the first look records the age. */
export const lapsed: (shared: BigInt64Array, now: bigint) => boolean = compiled.lapsed;

/**
 * SIGKILL the instance's commands: the process group of each direct child (pi starts each command as its own group's
 * leader), or the child alone when it shares the instance's group; with `ownCgroup`, every other process of the cgroup.
 * Never the instance or its group. A process this user may not signal (sudo's archil helpers) is skipped. Returns the
 * number of signals sent. Where there is no /proc (macOS) the processes come from one ps listing, and there is no cgroup. `stat` lines are `pid (comm) state ppid pgrp ...`, read after the last `)` since comm may hold
 * spaces and parentheses.
 */
export const sweep: (instance: number, options?: SweepOptions) => number = compiled.sweep;

type WatchdogData = { buffer: SharedArrayBuffer; checkMs: number; instance: number; ownCgroup: boolean };

/** The main thread's handle on the watchdog thread. */
export class LeaseWatchdog {
  readonly #shared: BigInt64Array;
  readonly #worker: Worker;

  /** Starts the thread; `beatNs` is when the last successful heartbeat write started. */
  constructor(options: { limitMs: number; checkMs: number; beatNs: bigint; ownCgroup?: boolean }) {
    const buffer = new SharedArrayBuffer(SLOTS * 8);
    this.#shared = new BigInt64Array(buffer);
    Atomics.store(this.#shared, SLOT_BEAT, options.beatNs);
    Atomics.store(this.#shared, SLOT_LIMIT, BigInt(Math.round(options.limitMs * 1e6)));
    const data: WatchdogData = { buffer, checkMs: options.checkMs, instance: process.pid, ownCgroup: options.ownCgroup === true };
    // No inherited Node flags: the source is self-contained CommonJS and needs none of the host's, and some would make Node
    // read it as ESM (`--input-type=module`, a host running inline ESM through -e or stdin), where `require` is undefined.
    this.#worker = new Worker(WORKER_SOURCE, { eval: true, workerData: data, execArgv: [] });
    this.#worker.unref();
  }

  /** A heartbeat write that started at `startNs` succeeded. */
  beat(startNs: bigint): void {
    for (;;) {
      const current = Atomics.load(this.#shared, SLOT_BEAT);
      if (startNs <= current || Atomics.compareExchange(this.#shared, SLOT_BEAT, current, startNs) === current) return;
    }
  }

  /** Once the watchdog found the lease lapsed: how long before that the last successful heartbeat started, in ms. */
  get lapsedAfterMs(): number | undefined {
    const age = Atomics.load(this.#shared, SLOT_LAPSED);
    return age === 0n ? undefined : Number(age) / 1e6;
  }

  get killed(): number {
    return Number(Atomics.load(this.#shared, SLOT_KILLED));
  }

  stop(): void {
    void this.#worker.terminate();
  }
}
