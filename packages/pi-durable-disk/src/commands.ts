// The commands a run's environment starts, recorded where the next open of the same claim finds them. pi makes each
// command the leader of a process group of its own, so killing an instance does not reach its commands: a host's unit
// cgroup or a container ends them with it, and a run on a local directory has neither. While commands run, the instance
// walks its own process tree (`/proc/<pid>/task/<tid>/children` on Linux, one ps listing on macOS: process-table.ts) and
// records each of its commands' group leader and every descendant it has seen, each by pid, start and boot. Its commands
// are the children that lead their own group and carry its mark (COMMANDS_MARK=<its token>) in their environment:
// another environment's commands in the same process, or the app's own helpers, are not its to record. The next open,
// which holds the owner lock, kills whatever a previous incarnation recorded that is still the same process (pid, start
// and boot all match), waits until it is gone, and clears the records, before the Harness opens. Only the instance writes
// records: a command never does. Nothing stops a command from writing one too, and none needs stopping: a run's commands
// run as the instance's user (or, with `runAs`, as another one that cannot write the instance's 0700 directory), so a
// record a command forged names only what that command could already kill itself. A record grants nothing.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HeldError } from "./errors.ts";
import { processTable, procTable, type ProcessSnapshot, type ProcessTable } from "./process-table.ts";

/** The environment variable that marks a command as one environment's: its value is that recorder's token. */
export const COMMANDS_MARK = "PI_DURABLE_DISK_COMMANDS";

/** One process, as recorded: a pid alone could be reused, a pid with its start on one boot cannot (process-table.ts). */
export interface ProcessMark {
  readonly pid: number;
  readonly start: number;
}

/** What a record holds: a command's group leader (null once only members of it outlived a reap) and the descendants seen. */
export interface CommandRecord {
  readonly boot: string;
  readonly leader: ProcessMark | null;
  readonly members: readonly ProcessMark[];
}

/** What a reap did: how many processes it signalled, and those still alive at its deadline (kept for the next open). */
export interface Reaped {
  readonly signalled: number;
  readonly survivors: readonly ProcessMark[];
}

export interface CommandsOptions {
  /** The `/proc` to read; for tests. */
  readonly proc?: string;
  /** The process table to read; default this machine's (`/proc`, or `proc` when given; ps on macOS). For tests. */
  readonly table?: ProcessTable;
  /** How a reap signals; default `process.kill`. For tests. */
  readonly kill?: (target: number, signal: NodeJS.Signals) => void;
}

const tableOf = (options: CommandsOptions): ProcessTable => options.table ?? (options.proc === undefined ? processTable() : procTable(options.proc));

/** Whether `mark` is still the process it was: same pid, same start, not a zombie. Never pid 1 or below. */
function same(look: ProcessSnapshot, mark: ProcessMark): boolean {
  return mark.pid > 1 && look.info(mark.pid)?.start === mark.start;
}

const RECORD = /^(\d+)-(\d+)\.json$/;

/**
 * Records this environment's command groups under this process while commands run. `started()` and `finished()` bracket
 * each command, which carries `COMMANDS_MARK=<token>` in its environment; while any runs, the tree is walked soon after a
 * start and then every `everyMs`. A record is written when its group gains a process and removed once nothing in it is
 * alive. A walk that fails (a record cannot be written: a full disk) goes to `onError` the first time, never out of a
 * timer, and the next walk tries again.
 */
export class CommandRecorder {
  /** The value of `COMMANDS_MARK` in this environment's commands. */
  readonly token = randomUUID();
  readonly #dir: string;
  readonly #table: ProcessTable;
  readonly #instance: number;
  readonly #everyMs: number;
  readonly #boot: string | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  #reported = false;
  readonly #records = new Map<string, { leader: ProcessMark; members: Map<number, ProcessMark> }>();
  /** The records on disk, by key; a group's first walk writes its record even before it has members. */
  readonly #written = new Set<string>();
  #active = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    dir: string,
    options: CommandsOptions & { readonly instance?: number; readonly everyMs?: number; readonly onError?: (error: unknown) => void } = {},
  ) {
    this.#dir = dir;
    this.#table = tableOf(options);
    this.#instance = options.instance ?? process.pid;
    this.#everyMs = options.everyMs ?? this.#table.walkMs;
    this.#boot = this.#table.bootId();
    this.#onError = options.onError;
  }

  /** A command is about to start. */
  started(): void {
    if (this.#boot === undefined) return; // nothing could verify a record on the next open
    if (this.#active++ === 0) {
      this.#timer = setInterval(() => this.scan(), this.#everyMs);
      this.#timer.unref();
    }
    setTimeout(() => this.scan(), 20).unref();
  }

  /** A command ended (its result is in). The last one stops the walks after a final one. */
  finished(): void {
    if (this.#boot === undefined || this.#active === 0) return;
    if (--this.#active === 0) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.scan();
    }
  }

  /** Stops recording (the environment closed); the records stay for the next open. */
  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#active = 0;
  }

  /** One walk. It is called from timers, so it never throws: a failure goes to `onError` once, and the next walk retries. */
  scan(): void {
    try {
      this.#scan();
    } catch (error) {
      if (this.#reported) return;
      this.#reported = true;
      this.#onError?.(error);
    }
  }

  /** Record what is new under each of this environment's command groups, and drop the records of groups that are gone. */
  #scan(): void {
    const boot = this.#boot;
    if (boot === undefined) return;
    const look = this.#table.snapshot();
    const own = look.info(this.#instance);
    if (own === undefined) return;
    // New commands: children of this process that lead their own group (pi spawns each one so) and carry this
    // environment's mark. Once recorded, a leader stays its environment's whatever it execs next (same pid and start).
    for (const pid of look.children(this.#instance)) {
      const leader = look.info(pid);
      if (leader === undefined || leader.pgrp !== pid || leader.pgrp === own.pgrp) continue;
      const key = `${pid}-${leader.start}`;
      if (this.#records.has(key) || !look.marked(pid, COMMANDS_MARK, this.token)) continue;
      this.#records.set(key, { leader: { pid, start: leader.start }, members: new Map() });
    }
    // Every record: walk from each of its processes still alive, the leader and every member, so a background worker whose
    // leader (or parent) exited and was reparented away is still followed, and so are the children it starts later.
    for (const [key, record] of this.#records) {
      const live = [record.leader, ...record.members.values()].filter((mark) => same(look, mark));
      if (live.length === 0) {
        this.#records.delete(key);
        this.#written.delete(key);
        rmSync(join(this.#dir, `${key}.json`), { force: true });
        continue;
      }
      let grew = !this.#written.has(key);
      const walk = (parent: number) => {
        for (const child of look.children(parent)) {
          const s = look.info(child);
          if (s === undefined || child === record.leader.pid) continue;
          const known = record.members.get(child)?.start === s.start;
          if (!known) {
            record.members.set(child, { pid: child, start: s.start });
            grew = true;
          }
          if (!known || !live.some((mark) => mark.pid === child)) walk(child);
        }
      };
      for (const mark of live) walk(mark.pid);
      if (grew) this.#write(key, { boot, leader: record.leader, members: [...record.members.values()] });
    }
  }

  #write(key: string, record: CommandRecord): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const file = join(this.#dir, `${key}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(record));
    renameSync(`${file}.tmp`, file);
    this.#written.add(key);
  }
}

/**
 * Ends what a previous incarnation's commands left running: for each record of this boot, the leader's whole group when
 * the leader is still the recorded process, and each recorded descendant that still is. Waits up to `timeoutMs` until
 * none of them is alive. A record whose processes are all gone is removed; one that still names a live process (it did
 * not die at the deadline: a process in an uninterruptible wait) is rewritten with just those, so the next open tries
 * again, and they are returned. Run only while holding the run (after its owner lock), before the Harness opens.
 */
export async function reapCommands(dir: string, options: CommandsOptions & { readonly timeoutMs?: number } = {}): Promise<Reaped> {
  const table = tableOf(options);
  const signal = options.kill ?? ((target: number, name: NodeJS.Signals) => process.kill(target, name));
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => RECORD.test(name));
  } catch {
    return { signalled: 0, survivors: [] };
  }
  if (files.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    return { signalled: 0, survivors: [] };
  }
  const boot = table.bootId();
  const before = table.snapshot();
  const own = before.info(process.pid);
  let signalled = 0;
  /**
   * False for what is never a target: this process, its group, and a pid of 1 or below, since `kill(0)` is the caller's
   * group and `kill(-1)` every process the user may signal.
   */
  const kill = (target: number, mark: ProcessMark): boolean => {
    if (!(mark.pid > 1) || mark.pid === process.pid || (target < 0 && -target === own?.pgrp)) return false;
    try {
      signal(target, "SIGKILL");
      signalled++;
    } catch {
      // gone between the check and the kill, or not ours to signal: still a target, a survivor if it is alive
    }
    return true;
  };
  const pending: { file: string; boot: string; leader: ProcessMark | null; members: ProcessMark[] }[] = [];
  for (const name of files) {
    const file = join(dir, name);
    let record: CommandRecord;
    try {
      record = JSON.parse(readFileSync(file, "utf8")) as CommandRecord;
    } catch {
      rmSync(file, { force: true }); // a torn write of a record names nothing
      continue;
    }
    if (boot === undefined || record.boot !== boot) {
      rmSync(file, { force: true }); // another boot's pids mean nothing on this one
      continue;
    }
    const leader = record.leader !== null && same(before, record.leader) && kill(-record.leader.pid, record.leader) ? record.leader : null;
    // A member that is the leader went with its group.
    const members = (record.members ?? []).filter((member) => member.pid !== record.leader?.pid && same(before, member) && kill(member.pid, member));
    pending.push({ file, boot, leader, members });
  }
  const alive = () => {
    const marks = pending.flatMap((p) => [...(p.leader ? [p.leader] : []), ...p.members]);
    if (marks.length === 0) return marks;
    const look = table.snapshot();
    return marks.filter((mark) => same(look, mark));
  };
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (alive().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const survivors: ProcessMark[] = [];
  const after = pending.length === 0 ? before : table.snapshot();
  for (const record of pending) {
    const leader = record.leader !== null && same(after, record.leader) ? record.leader : null;
    const members = record.members.filter((member) => same(after, member));
    if (leader === null && members.length === 0) {
      rmSync(record.file, { force: true });
      continue;
    }
    survivors.push(...(leader ? [leader] : []), ...members);
    writeFileSync(`${record.file}.tmp`, JSON.stringify({ boot: record.boot, leader, members } satisfies CommandRecord));
    renameSync(`${record.file}.tmp`, record.file);
  }
  if (survivors.length === 0) rmSync(dir, { recursive: true, force: true });
  return { signalled, survivors };
}

/**
 * `reapCommands` at an open: refuses the run (`HeldError("commands")`, exit 76) when a process a killed incarnation's
 * commands left is still alive after it, since the run must not resume beside it. Its record stays, and the next open
 * tries again.
 */
export async function reapOrRefuse(dir: string, options: CommandsOptions & { readonly timeoutMs?: number } = {}): Promise<Reaped> {
  const reaped = await reapCommands(dir, options);
  if (reaped.survivors.length > 0) {
    const look = tableOf(options).snapshot();
    const pids = reaped.survivors.map((s) => s.pid);
    throw new HeldError(
      "commands",
      `${pids.length} process(es) a killed incarnation's commands started are still alive after SIGKILL: ` +
        `${reaped.survivors.map((s) => `pid ${s.pid} (${look.commandLine(s.pid)})`).join(", ")}. ` +
        `The run does not resume beside them. End them (kill -9 ${pids.join(" ")}, as their owner, or wait for them) and open the run again; ` +
        `they stay recorded in ${dir} until then.`,
    );
  }
  return reaped;
}
