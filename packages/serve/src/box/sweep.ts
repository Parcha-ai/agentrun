// What serve does with the boxes runs leave: the box a run's process recorded (its box.json), reaped once nothing owns
// it, and the cgroups no record names. A box is let go only on the reap's own count: empty, its record is marked reaped
// and its cgroup removed; anything else (left processes, a reap that throws) quarantines it, its record kept, and every
// later sweep tries again. A record nothing could count (no pid and no cgroup: a crash before the box's first process
// was known) is cleared only once the run process that wrote it is gone, by its pid and start time, so a box still
// starting is never written off.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoxRecord, Reaped } from "@parcha/agentrun-adapters/host";
import { readJson, writeDurable } from "../files.js";
import { BOX_RECORD } from "./record.js";

/** The data directory's file of quarantined boxes. */
export const BOX_QUARANTINE = "box-quarantine.json";

/** What serve needs of the box: its reap, and on a shared server the run cgroups under its delegated subtree. */
export interface BoxHost {
  reap(record: BoxRecord): Promise<Reaped>;
  cgroups?: {
    /** Every run cgroup under the subtree, by path. */
    list(): Promise<string[]>;
    /** Removes an empty cgroup. */
    remove(path: string): Promise<void>;
  };
}

/** A run cgroup removed, or already gone: a reap that empties a cgroup may remove it itself (bwrapBox's does), so a
 *  missing one is the removal done. Any other failure is the caller's. */
async function removeCgroup(cgroups: NonNullable<BoxHost["cgroups"]>, path: string): Promise<void> {
  try {
    await cgroups.remove(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

/** A process's start time as /proc/<pid>/stat gives it (clock ticks since boot), or undefined when it is not running. */
export function startTimeOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** The record's writer is gone: no process has its pid, or the one that has it started at another time (a reused pid). */
export function writerGone(writer: BoxRecord["writer"] | undefined, startOf: (pid: number) => string | undefined = startTimeOf): boolean {
  if (!writer || !Number.isSafeInteger(writer.pid) || writer.pid <= 0) return true;
  return startOf(writer.pid) !== writer.startTime;
}

/** A box record on disk, and whether a reap already let it go. */
type Stored = BoxRecord & { reaped?: { at: string; by: Reaped["by"] } };

/** The boxes that a reap could not let go, kept across restarts: by run (or "" for a cgroup no record named). */
export class Quarantine {
  private constructor(
    private readonly file: string,
    private readonly entries: Map<string, { record: BoxRecord; why: string; at: string }>,
  ) {}

  static async open(file: string): Promise<Quarantine> {
    const kept = await readJson(file);
    const entries = new Map<string, { record: BoxRecord; why: string; at: string }>();
    if (Array.isArray(kept)) for (const e of kept as Array<{ key: string; record: BoxRecord; why: string; at: string }>) if (e && typeof e.key === "string") entries.set(e.key, { record: e.record, why: e.why, at: e.at });
    return new Quarantine(file, entries);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  list(): Array<{ key: string; record: BoxRecord; why: string; at: string }> {
    return [...this.entries].map(([key, e]) => ({ key, ...e }));
  }

  async add(key: string, record: BoxRecord, why: string): Promise<void> {
    this.entries.set(key, { record, why, at: new Date().toISOString() });
    await this.save();
  }

  async clear(key: string): Promise<void> {
    if (this.entries.delete(key)) await this.save();
  }

  // One save at a time, each writing the whole set as it is then: concurrent writes of the same file would share its
  // temporary file, and one could lose another's entries or fail its rename.
  private saving: Promise<void> = Promise.resolve();
  private save(): Promise<void> {
    const next = this.saving.catch(() => {}).then(() => writeDurable(this.file, `${JSON.stringify(this.list())}\n`));
    this.saving = next;
    return next;
  }
}

export type Settled = "none" | "owned" | "reaped" | "cleared" | "quarantined";

/** The quarantine key of a cgroup no record named. */
const leftoverKey = (path: string) => `cgroup:${path}`;
/** The quarantine key of a run's box: by the box, so a run whose box is quarantined and that opens a new one keeps the
 *  old one held, and the new one's reap never clears it. */
export const boxKey = (runId: string, record: Pick<BoxRecord, "id">) => `${runId}/${record.id}`;
/** Whether a cgroup is still named by a box other than `key`'s that is not yet let go: a quarantined one, or (`current`)
 *  the run's current box. A run's boxes share its cgroup, so one box's empty count never removes another's. */
function namedElsewhere(quarantine: Quarantine, cgroup: string, key: string, current?: Stored | null): boolean {
  if (current && !current.reaped && current.cgroup === cgroup && current.id !== key.slice(key.lastIndexOf("/") + 1)) return true;
  return quarantine.list().some((entry) => entry.key !== key && entry.record.cgroup === cgroup);
}
const left = (verdict: Reaped) => `its reap left ${verdict.left} process${verdict.left === 1 ? "" : "es"} (counted by ${verdict.by})`;

/**
 * The box the run in `runDir` recorded, let go if nothing owns it: none recorded, or already let go (`none`); its writer,
 * the run process, still alive, so the box is that process's (`owned`); else reaped. Empty: marked, its cgroup removed
 * (`reaped`). Nothing to count, with its writer gone: marked (`cleared`). Anything else: quarantined, its record kept.
 */
export async function settleBox(host: BoxHost, quarantine: Quarantine, runId: string, runDir: string, startOf?: (pid: number) => string | undefined): Promise<Settled> {
  const path = join(runDir, BOX_RECORD);
  const stored = (await readJson(path)) as Stored | null;
  if (!stored || typeof stored.id !== "string" || stored.reaped) return "none";
  if (!writerGone(stored.writer, startOf)) return "owned";
  const { reaped: _, ...record } = stored;
  let verdict: Reaped;
  try {
    verdict = await host.reap(record);
  } catch (error) {
    await quarantine.add(boxKey(runId, record), record, `its reap failed: ${(error as Error).message}`);
    return "quarantined";
  }
  if (verdict.by === "none") {
    // Nothing named the box to count, and its writer is gone: --die-with-parent ended whatever had started.
    await writeDurable(path, `${JSON.stringify({ ...record, reaped: { at: new Date().toISOString(), by: "none" } })}\n`);
    await quarantine.clear(boxKey(runId, record));
    return "cleared";
  }
  if (!verdict.empty) {
    await quarantine.add(boxKey(runId, record), record, left(verdict));
    return "quarantined";
  }
  if (record.cgroup && host.cgroups && !namedElsewhere(quarantine, record.cgroup, boxKey(runId, record))) await removeCgroup(host.cgroups, record.cgroup);
  await writeDurable(path, `${JSON.stringify({ ...record, reaped: { at: new Date().toISOString(), by: verdict.by } })}\n`);
  await quarantine.clear(boxKey(runId, record));
  return "reaped";
}

/** At start, before any run opens a box: every run's box let go that nothing owns; then every box the quarantine still
 *  holds that is no longer its run's current one (the run opened another since), tried again by its own record; then
 *  every run cgroup no record names, reaped by the cgroup and removed when empty. */
export async function sweepBoxes(host: BoxHost, quarantine: Quarantine, runs: ReadonlyArray<{ id: string; dir: string }>, startOf?: (pid: number) => string | undefined): Promise<Record<string, Settled>> {
  const settled: Record<string, Settled> = {};
  const named = new Set<string>();
  for (const run of runs) {
    settled[run.id] = await settleBox(host, quarantine, run.id, run.dir, startOf);
    if (settled[run.id] === "owned" || settled[run.id] === "quarantined") {
      const cgroup = ((await readJson(join(run.dir, BOX_RECORD))) as Stored | null)?.cgroup;
      if (cgroup) named.add(cgroup);
    }
  }
  // A run's earlier box, still held: only its own reap's count lets it go. Its cgroup stays named while it is held.
  const current = new Set(runs.map((run) => run.id));
  for (const entry of quarantine.list()) {
    if (entry.key.startsWith("cgroup:")) continue;
    const runId = entry.key.slice(0, entry.key.lastIndexOf("/"));
    const now = current.has(runId) ? ((await readJson(join(runs.find((r) => r.id === runId)!.dir, BOX_RECORD))) as Stored | null) : null;
    if (now?.id === entry.record.id) {
      if (entry.record.cgroup && quarantine.has(entry.key)) named.add(entry.record.cgroup);
      continue;
    }
    let verdict: Reaped | undefined;
    if (!writerGone(entry.record.writer, startOf)) verdict = undefined;
    else verdict = await host.reap(entry.record).catch(() => undefined);
    if (verdict && (verdict.empty || verdict.by === "none")) {
      const cgroup = entry.record.cgroup;
      if (verdict.empty && cgroup && host.cgroups && !namedElsewhere(quarantine, cgroup, entry.key, now)) await removeCgroup(host.cgroups, cgroup);
      await quarantine.clear(entry.key);
    } else if (entry.record.cgroup) named.add(entry.record.cgroup);
  }
  if (!host.cgroups) return settled;
  for (const cgroup of await host.cgroups.list()) {
    if (named.has(cgroup)) continue;
    const record: BoxRecord = { id: leftoverKey(cgroup), cgroup, writer: { pid: 0, startTime: "" } };
    let verdict: Reaped;
    try {
      verdict = await host.reap(record);
    } catch (error) {
      await quarantine.add(leftoverKey(cgroup), record, `its reap failed: ${(error as Error).message}`);
      continue;
    }
    if (verdict.empty) {
      await removeCgroup(host.cgroups, cgroup);
      await quarantine.clear(leftoverKey(cgroup));
    } else await quarantine.add(leftoverKey(cgroup), record, left(verdict));
  }
  return settled;
}
