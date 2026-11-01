// The commands a run's environment starts, recorded where the next open of the same claim finds them. pi makes each
// command the leader of a process group of its own, so killing an instance does not reach its commands: a host's unit
// cgroup or a container ends them with it, and a run on a local directory has neither. While commands run, the instance
// walks its own process tree (`/proc/<pid>/task/<tid>/children` on Linux, one ps listing on macOS: process-table.ts) and
// records each of its commands' group leader and every descendant it has seen, each by pid, start and boot. Its commands
// are the children that lead their own group and carry its mark (COMMANDS_MARK=<its token>) in their environment:
// another environment's commands in the same process, or the app's own helpers, are not its to record. The next open,
// which holds the owner lock, kills whatever a previous incarnation recorded that is still the same process (pid, start
// and boot all match), waits until it is gone, and clears the records, before the Harness opens. A recorded leader's
// whole process group is ended and waited for, a member no walk recorded included; a descendant that left the group
// (setsid or setpgid: a session or group of its own) is ended if a walk recorded it or it still carries the mark. The
// group is listed just before its SIGKILL: a process forked in between gets the SIGKILL but is not waited for (it ends
// at once unless it is in an uninterruptible wait). A walk runs only after a command has started, so before its first
// command starts the recorder also writes its mark (`mark-<token>.json`), synchronously: the next open ends every live
// process that carries a mark it finds, as a whole group when it leads one, so a command killed with its instance before
// any walk recorded it is ended too. A process that cleared its environment carries no mark, and the mark goes once
// nothing of the instance is running or recorded: a descendant no walk recorded that outlives its command and its
// group's leader is out of reach from then on, as before marks. Only the instance writes
// records: a command never does. Nothing stops a command from writing one too, and none needs stopping: a run's commands
// run as the instance's user (or, with `runAs`, as another one that cannot write the instance's 0700 directory), so a
// record a command forged names only what that command could already kill itself. A record grants nothing.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HeldError } from "./errors.ts";
import { processTable, procTable, type ProcessOrigin, type ProcessSnapshot, type ProcessTable } from "./process-table.ts";

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
  /** The writer's pid namespace and the write's time in clock ticks since boot (Linux; see `whose`). */
  readonly pidns?: string;
  readonly ticks?: number;
}

/** What a reap did: how many processes it signalled, and those still alive at its deadline (kept for the next open). */
export interface Reaped {
  readonly signalled: number;
  readonly survivors: readonly ProcessMark[];
  /** Record files written in another pid namespace whose processes are not proved gone: kept, and nothing they name was
   *  signalled. Present only when there are any. */
  readonly foreign?: readonly string[];
}

/** Where a record was written, for a reader at `origin`: "here" (this reader's pid namespace, judged as ever by pid and
 *  start), "gone" (another namespace, every process of which has provably ended), or "unknown" (kept, refused by name,
 *  nothing signalled). A record from another namespace is gone when it was written on another boot (a reboot ends every
 *  namespace), or on this boot BEFORE this reader's PID 1 started: the writer's namespace is a previous incarnation of
 *  this one (a container restarted on the same data root). A missing or unparsable namespace, boot or time is unknown.
 *
 *  That second case holds only under three preconditions, each pinned where it is kept:
 *  (1) Serve's data root, where these records live, is never shown to a box (run-adapters' checkBoxArgv, its `hidden`
 *      paths: "serve's data root is never shown to a box ..."). A box is a child namespace whose PID 1 also started after
 *      the host's records were written, and would otherwise forget live host commands.
 *  (2) Two servers never hold one data root at once (serve's server.lock: "a second server on the same data root ...").
 *  (3) Serve is the child of its namespace's PID 1 (tini), which the image's ENTRYPOINT makes by the launcher's exec into
 *      tini: when serve exits, tini exits, and the namespace ends with it. A server started without that chain (node
 *      dist/cli.js directly, or under a supervisor that restarts it in place) is outside this rule.
 *  The PR that boxes pi's commands re-opens this rule by name.
 *
 *  A record with no namespace (written before namespaces were recorded) is read as before, in the reader's own. */
function whose(record: { readonly boot?: unknown; readonly pidns?: unknown; readonly ticks?: unknown }, origin: ProcessOrigin, boot: string | undefined): "here" | "gone" | "unknown" {
  if (record.pidns === undefined) return "here";
  if (typeof record.pidns !== "string" || origin.pidns === undefined) return "unknown";
  if (record.pidns === origin.pidns) return "here";
  if (typeof record.boot !== "string" || record.boot === "" || boot === undefined) return "unknown";
  if (record.boot !== boot) return "gone";
  if (typeof record.ticks !== "number" || !Number.isFinite(record.ticks) || origin.pid1Start === undefined) return "unknown";
  return record.ticks < origin.pid1Start ? "gone" : "unknown";
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
const MARK = /^mark-([0-9a-f-]{36})\.json$/;

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
  /** Whether this recorder's mark is on disk: written before a command starts, removed once nothing of it is left. */
  #marked = false;
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

  /** A command is about to start. Returns whether this recorder's mark is on disk, so the next open can name the
   *  command even if no walk records it; false when it is not (no boot id, or a mark that cannot be written). */
  started(): boolean {
    if (this.#boot === undefined) return false; // nothing could verify a record on the next open
    // Before the command exists: an instance killed before the first walk still leaves what names its commands.
    if (!this.#marked) {
      try {
        this.#writeFile(`mark-${this.token}.json`, { boot: this.#boot, token: this.token, ...this.#stamp() });
        this.#marked = true;
      } catch (error) {
        if (!this.#reported) {
          this.#reported = true;
          this.#onError?.(error);
        }
      }
    }
    if (this.#active++ === 0) {
      this.#timer = setInterval(() => this.scan(), this.#everyMs);
      this.#timer.unref();
    }
    setTimeout(() => this.scan(), 20).unref();
    return this.#marked;
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
    // Nothing of this environment is running or recorded: its mark has nothing left to name.
    if (this.#active === 0 && this.#records.size === 0 && this.#marked) {
      rmSync(join(this.#dir, `mark-${this.token}.json`), { force: true });
      this.#marked = false;
    }
  }

  #write(key: string, record: CommandRecord): void {
    this.#writeFile(`${key}.json`, { ...record, ...this.#stamp() });
    this.#written.add(key);
  }

  /** This writer's pid namespace and the time of the write, in clock ticks since boot, for a reader in another namespace
   *  (see `whose`); nothing where the table has no namespaces. */
  #stamp(): { pidns?: string; ticks?: number } {
    const origin = this.#table.origin?.();
    if (origin?.pidns === undefined) return {};
    return { pidns: origin.pidns, ...(origin.nowTicks === undefined ? {} : { ticks: origin.nowTicks }) };
  }

  #writeFile(name: string, data: unknown): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const file = join(this.#dir, name);
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  }
}

/**
 * Ends what a previous incarnation's commands left running: for each record of this boot, the leader's whole group when
 * the leader is still the recorded process, and each recorded descendant that still is. Waits up to `timeoutMs` until
 * none of them is alive: every process of a killed group, one the instance never recorded included. A record whose processes are all gone is removed; one that still names a live process (it did
 * not die at the deadline: a process in an uninterruptible wait) is rewritten with just those, so the next open tries
 * again, and they are returned. Run only while holding the run (after its owner lock), before the Harness opens.
 */
export async function reapCommands(dir: string, options: CommandsOptions & { readonly timeoutMs?: number } = {}): Promise<Reaped> {
  const table = tableOf(options);
  const signal = options.kill ?? ((target: number, name: NodeJS.Signals) => process.kill(target, name));
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => RECORD.test(name) || MARK.test(name));
  } catch {
    return { signalled: 0, survivors: [] };
  }
  if (files.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    return { signalled: 0, survivors: [] };
  }
  const boot = table.bootId();
  // Where this reader stands, for a record from another pid namespace (`whose`): such a record is never signalled, and
  // one not proved gone is kept and refuses the open.
  const origin = table.origin?.() ?? {};
  const foreign: string[] = [];
  const before = table.snapshot();
  const own = before.info(process.pid);
  let signalled = 0;
  /** The groups and the pids this reap has sent SIGKILL to: a record and a mark may name the same command. */
  const killedGroups = new Set<number>();
  const killedPids = new Set<number>();
  /**
   * False for what is never a target: this process, its group, and a pid of 1 or below, since `kill(0)` is the caller's
   * group and `kill(-1)` every process the user may signal. A target this reap already signalled (the same group, or the
   * same pid) is still a target but gets no second SIGKILL. A member is still signalled after its group: it may have left
   * the group since the listing.
   */
  const kill = (target: number, mark: ProcessMark): boolean => {
    if (!(mark.pid > 1) || mark.pid === process.pid || (target < 0 && -target === own?.pgrp)) return false;
    if (target < 0 ? killedGroups.has(-target) : killedPids.has(target)) return true;
    if (target < 0) killedGroups.add(-target);
    else killedPids.add(target);
    try {
      signal(target, "SIGKILL");
      signalled++;
    } catch {
      // gone between the check and the kill, or not ours to signal: still a target, a survivor if it is alive
    }
    return true;
  };
  const pending: { file: string; boot: string; leader: ProcessMark | null; members: ProcessMark[]; mark?: true }[] = [];
  for (const name of files) {
    const file = join(dir, name);
    if (MARK.test(name)) {
      let mark: { boot?: string; token?: string; pidns?: unknown; ticks?: unknown };
      try {
        mark = JSON.parse(readFileSync(file, "utf8")) as { boot?: string; token?: string; pidns?: unknown; ticks?: unknown };
      } catch {
        rmSync(file, { force: true }); // a torn write names nothing
        continue;
      }
      const where = whose(mark, origin, boot);
      if (where === "gone") {
        rmSync(file, { force: true });
        continue;
      }
      if (where === "unknown") {
        foreign.push(file);
        continue;
      }
      if (boot === undefined || mark.boot !== boot || typeof mark.token !== "string" || `mark-${mark.token}.json` !== name) {
        rmSync(file, { force: true });
        continue;
      }
      // Every live process carrying the mark, whatever a walk saw: a leader with its whole group (its group's id is its
      // pid, which no other process holds while it lives), any other one alone.
      const members: ProcessMark[] = [];
      const add = (pid: number) => {
        const info = before.info(pid);
        if (info && !members.some((m) => m.pid === pid)) members.push({ pid, start: info.start });
      };
      for (const pid of before.withMark(COMMANDS_MARK, mark.token)) {
        const info = before.info(pid);
        if (info === undefined) continue;
        const self = { pid, start: info.start };
        if (info.pgrp === pid) {
          const group = before.group(pid);
          if (same(before, self) && kill(-pid, self)) for (const member of group) add(member);
        } else if (kill(pid, self)) add(pid);
      }
      pending.push({ file, boot, leader: null, members, mark: true });
      continue;
    }
    let record: CommandRecord;
    try {
      record = JSON.parse(readFileSync(file, "utf8")) as CommandRecord;
    } catch {
      rmSync(file, { force: true }); // a torn write of a record names nothing
      continue;
    }
    const where = whose(record, origin, boot);
    if (where === "gone") {
      rmSync(file, { force: true });
      continue;
    }
    if (where === "unknown") {
      foreign.push(file);
      continue;
    }
    if (boot === undefined || record.boot !== boot) {
      rmSync(file, { force: true }); // another boot's pids mean nothing on this one
      continue;
    }
    // The group as it is before the kill, while its leader is still the recorded process: a group's id is its leader's
    // pid, which no other process holds while the leader lives. The group is killed, and what was listed kept, only if
    // the leader is still that process once the listing is read, so each process kept was this group's, never another's.
    // SIGKILL to the group reaches all of them, a child no walk recorded yet included, but each dies when it next runs,
    // and one can outlive its leader for a moment, or for long in an uninterruptible wait: so each is waited for by pid
    // and start, and kept for the next open if it outlives the deadline.
    const listed: ProcessMark[] =
      record.leader !== null && same(before, record.leader)
        ? before.group(record.leader.pid).flatMap((pid) => {
            const info = pid === record.leader!.pid ? undefined : before.info(pid);
            return info ? [{ pid, start: info.start }] : [];
          })
        : [];
    const leader = record.leader !== null && same(before, record.leader) && kill(-record.leader.pid, record.leader) ? record.leader : null;
    // A member that is the leader went with its group.
    const members = (record.members ?? []).filter((member) => member.pid !== record.leader?.pid && same(before, member) && kill(member.pid, member));
    if (leader !== null) for (const mark of listed) if (!members.some((member) => member.pid === mark.pid)) members.push(mark);
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
  // Every record file this reap writes goes through `keep`, which unions what this reap writes to one file (members by
  // pid and start, a leader kept): a mark's survivors may land in the file of a record this reap rewrites, and in
  // whatever order the two come, neither drops what the other named. Every record file in the directory is one of
  // this reap's, so a rewrite holds just what survived, plus anything another of its writes named there.
  const kept = new Map<string, CommandRecord>();
  const gone = new Set<string>();
  const keep = (file: string, boot: string, leader: ProcessMark | null, members: readonly ProcessMark[]) => {
    const known = kept.get(file);
    const all = [...(known?.members ?? [])];
    for (const m of members) if (!all.some((k) => k.pid === m.pid && k.start === m.start)) all.push(m);
    kept.set(file, { boot, leader: leader ?? known?.leader ?? null, members: all });
  };
  for (const record of pending) {
    const leader = record.leader !== null && same(after, record.leader) ? record.leader : null;
    const members = record.members.filter((member) => same(after, member));
    if (leader === null && members.length === 0) {
      gone.add(record.file);
      continue;
    }
    survivors.push(...(leader ? [leader] : []), ...members);
    // A mark is kept as it is, so the next open looks for its token again. Its survivors are also recorded by pid and
    // start: one that cleared its environment carries no mark, so once the marked leader is gone nothing else names it.
    if (record.mark) keep(join(dir, `${members[0]!.pid}-${members[0]!.start}.json`), record.boot, null, members);
    else keep(record.file, record.boot, leader, members);
  }
  for (const file of gone) if (!kept.has(file)) rmSync(file, { force: true });
  // What this reap rewrites it wrote in its own namespace, now.
  const now = table.origin?.();
  const stamp = now?.pidns === undefined ? {} : { pidns: now.pidns, ...(now.nowTicks === undefined ? {} : { ticks: now.nowTicks }) };
  for (const [file, record] of kept) {
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...record, ...stamp }));
    renameSync(`${file}.tmp`, file);
  }
  if (survivors.length === 0 && foreign.length === 0) rmSync(dir, { recursive: true, force: true });
  return { signalled, survivors, ...(foreign.length === 0 ? {} : { foreign }) };
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
  if (reaped.foreign !== undefined) {
    throw new HeldError(
      "commands",
      `${reaped.foreign.length} record(s) of the run's commands were written in another pid namespace, which may still be running them: ` +
        `${reaped.foreign.join(", ")}. Nothing they name was signalled, and the run does not resume beside them. ` +
        `If every process of that namespace has ended (the container or the machine that wrote them is gone), remove these files and open the run again.`,
    );
  }
  return reaped;
}
