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

  private save(): Promise<void> {
    return writeDurable(this.file, `${JSON.stringify(this.list())}\n`);
  }
}

export type Settled = "none" | "owned" | "reaped" | "cleared" | "quarantined";

/** The quarantine key of a cgroup no record named. */
const leftoverKey = (path: string) => `cgroup:${path}`;

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
    await quarantine.add(runId, record, `its reap failed: ${(error as Error).message}`);
    return "quarantined";
  }
  if (verdict.by === "none") {
    // Nothing named the box to count, and its writer is gone: --die-with-parent ended whatever had started.
    await writeDurable(path, `${JSON.stringify({ ...record, reaped: { at: new Date().toISOString(), by: "none" } })}\n`);
    await quarantine.clear(runId);
    return "cleared";
  }
  if (!verdict.empty) {
    await quarantine.add(runId, record, `its reap left ${verdict.left} process${verdict.left === 1 ? "" : "es"} (counted by ${verdict.by})`);
    return "quarantined";
  }
  if (record.cgroup && host.cgroups) await host.cgroups.remove(record.cgroup);
  await writeDurable(path, `${JSON.stringify({ ...record, reaped: { at: new Date().toISOString(), by: verdict.by } })}\n`);
  await quarantine.clear(runId);
  return "reaped";
}

/** At start, before any run opens a box: every run's box let go that nothing owns, then every run cgroup no record
 *  names, reaped by the cgroup and removed when empty. */
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
      await host.cgroups.remove(cgroup);
      await quarantine.clear(leftoverKey(cgroup));
    } else await quarantine.add(leftoverKey(cgroup), record, `its reap left ${verdict.left} process${verdict.left === 1 ? "" : "es"} (counted by ${verdict.by})`);
  }
  return settled;
}
