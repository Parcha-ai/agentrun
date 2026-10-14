// The commands a run's environment starts, recorded where the next open of the same claim finds them. pi makes each
// command the leader of a process group of its own, so killing an instance does not reach its commands: a host's unit
// cgroup or a container ends them with it, and a run on a local directory has neither. While commands run, the instance
// walks its own process tree (`/proc/<pid>/task/<tid>/children`) and records each command's group leader and every
// descendant it has seen, each by pid, start ticks and boot. The next open, which holds the owner lock, kills whatever a
// previous incarnation recorded that is still the same process (pid, start ticks and boot all match), waits until it is
// gone, and clears the records, before the Harness opens. Only the instance writes records: a command never does.
// Nothing stops a command from writing one too, and none needs stopping: a run's commands run as the instance's user (or,
// with `runAs`, as another one that cannot write the instance's 0700 directory), so a record a command forged names only
// what that command could already kill itself. A record grants nothing.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One process, as recorded: a pid alone could be reused, a pid with its start ticks on one boot cannot. */
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
  /** How a reap signals; default `process.kill`. For tests. */
  readonly kill?: (target: number, signal: NodeJS.Signals) => void;
}

interface Stat {
  readonly ppid: number;
  readonly pgrp: number;
  readonly start: number;
}

/** `/proc/<pid>/stat`: fields after the last `)` (the command name may hold spaces and parentheses); a zombie is gone. */
function stat(proc: string, pid: number): Stat | undefined {
  try {
    const text = readFileSync(join(proc, String(pid), "stat"), "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    return { ppid: Number(fields[1]), pgrp: Number(fields[2]), start: Number(fields[19]) };
  } catch {
    return undefined;
  }
}

function bootId(proc: string): string | undefined {
  try {
    return readFileSync(join(proc, "sys/kernel/random/boot_id"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The direct children of `pid`, from each of its threads' `children` list. */
function children(proc: string, pid: number): number[] {
  let tasks: string[];
  try {
    tasks = readdirSync(join(proc, String(pid), "task"));
  } catch {
    return [];
  }
  return tasks.flatMap((tid) => {
    try {
      return readFileSync(join(proc, String(pid), "task", tid, "children"), "utf8").split(" ").filter(Boolean).map(Number);
    } catch {
      return [];
    }
  });
}

/** Whether `mark` is still the process it was: same pid, same start ticks, not a zombie. */
function same(proc: string, mark: ProcessMark): boolean {
  return mark.pid > 0 && stat(proc, mark.pid)?.start === mark.start;
}

const RECORD = /^(\d+)-(\d+)\.json$/;

/**
 * Records the command groups under this process while commands run. `started()` and `finished()` bracket each command;
 * while any runs, the tree is walked soon after a start and then every `everyMs`. A record is written when its group
 * gains a process and removed once nothing in it is alive.
 */
export class CommandRecorder {
  readonly #dir: string;
  readonly #proc: string;
  readonly #instance: number;
  readonly #everyMs: number;
  readonly #boot: string | undefined;
  readonly #records = new Map<string, { leader: ProcessMark; members: Map<number, ProcessMark> }>();
  /** The records on disk, by key; a group's first walk writes its record even before it has members. */
  readonly #written = new Set<string>();
  #active = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(dir: string, options: CommandsOptions & { readonly instance?: number; readonly everyMs?: number } = {}) {
    this.#dir = dir;
    this.#proc = options.proc ?? "/proc";
    this.#instance = options.instance ?? process.pid;
    this.#everyMs = options.everyMs ?? 100;
    this.#boot = bootId(this.#proc);
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

  /** One walk: record what is new under each command group, and drop the records of groups that are gone. */
  scan(): void {
    const boot = this.#boot;
    if (boot === undefined) return;
    const own = stat(this.#proc, this.#instance);
    if (own === undefined) return;
    const seen = new Set<string>();
    for (const pid of children(this.#proc, this.#instance)) {
      const leader = stat(this.#proc, pid);
      // A command is a child that leads its own group (pi spawns each one so); anything else is not one.
      if (leader === undefined || leader.pgrp !== pid || leader.pgrp === own.pgrp) continue;
      const key = `${pid}-${leader.start}`;
      seen.add(key);
      let record = this.#records.get(key);
      if (record === undefined) {
        record = { leader: { pid, start: leader.start }, members: new Map() };
        this.#records.set(key, record);
      }
      let grew = !this.#written.has(key);
      const walk = (parent: number) => {
        for (const child of children(this.#proc, parent)) {
          const s = stat(this.#proc, child);
          if (s === undefined) continue;
          if (record!.members.get(child)?.start !== s.start) {
            record!.members.set(child, { pid: child, start: s.start });
            grew = true;
          }
          walk(child);
        }
      };
      walk(pid);
      if (grew) this.#write(key, { boot, leader: record.leader, members: [...record.members.values()] });
    }
    // A group whose leader has left the instance's children: keep it while any process recorded in it is alive.
    for (const [key, record] of this.#records) {
      if (seen.has(key)) continue;
      if (same(this.#proc, record.leader) || [...record.members.values()].some((m) => same(this.#proc, m))) continue;
      this.#records.delete(key);
      this.#written.delete(key);
      rmSync(join(this.#dir, `${key}.json`), { force: true });
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
  const proc = options.proc ?? "/proc";
  const signal = options.kill ?? ((target: number, name: NodeJS.Signals) => process.kill(target, name));
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => RECORD.test(name));
  } catch {
    return { signalled: 0, survivors: [] };
  }
  const boot = bootId(proc);
  const own = stat(proc, process.pid);
  let signalled = 0;
  /** False for what is never a target: this process, its group, a pid of 0 or below (`kill(0)` is the caller's group). */
  const kill = (target: number, mark: ProcessMark): boolean => {
    if (!(mark.pid > 0) || mark.pid === process.pid || (target < 0 && -target === own?.pgrp)) return false;
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
    const leader = record.leader !== null && same(proc, record.leader) && kill(-record.leader.pid, record.leader) ? record.leader : null;
    // A member that is the leader went with its group.
    const members = (record.members ?? []).filter((member) => member.pid !== record.leader?.pid && same(proc, member) && kill(member.pid, member));
    pending.push({ file, boot, leader, members });
  }
  const alive = () => pending.flatMap((p) => [...(p.leader ? [p.leader] : []), ...p.members]).filter((mark) => same(proc, mark));
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (alive().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const survivors: ProcessMark[] = [];
  for (const record of pending) {
    const leader = record.leader !== null && same(proc, record.leader) ? record.leader : null;
    const members = record.members.filter((member) => same(proc, member));
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
