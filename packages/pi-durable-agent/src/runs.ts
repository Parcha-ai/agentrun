import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AgentHome, homeDir, inHome, isSkillPath, readState, sha256, uuidv7 } from "./home.js";
import { type BrowserProfile, LeasesDoc, type ProfileLease, ProfilesDoc, put, type RunRecord, RunsDoc } from "./kinds.js";
import { AgentHomeError, openStore, readFamily } from "./store.js";

export const RUN_STORE_FILE = "run.sqlite";
const DEFAULT_LEASE_MS = 6 * 60 * 60 * 1000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Where a run lives, in pi-durable-disk's run layout, so the run directory is one `pi-durable-disk run --dir` takes.
 *  pi-durable-disk adds `run.json`, `owner.lock` and `tmp/` (and `commands/` on a local directory) beside these. */
export type RunPaths = {
  /** `<home>/runs/<runId>`. */
  dir: string;
  /** `store/run.sqlite`: the run's pi-durable store, on which the host opens its Harness. */
  storePath: string;
  /** `work/`: the run's working directory, with the agent's skills under `.agents/skills/`. */
  workspace: string;
};

const layout = (dir: string): RunPaths => ({ dir, storePath: path.join(dir, "store", RUN_STORE_FILE), workspace: path.join(dir, "work") });

/** The paths of run `runId` in `home`. */
export function runPaths(home: AgentHome, runId: string): RunPaths {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw invalid(`the run id ${JSON.stringify(runId)} is not letters, digits, ".", "_" or "-" (at most 128)`);
  return layout(path.join(path.resolve(home.dir), "runs", runId));
}

/** A started run, as the host needs it. */
export type RunStart = RunPaths & {
  runId: string;
  /** The root conversation's agent: the definition's instructions and tool names, which the host binds to its tools. */
  agent: { instructions: string; tools: string[] };
  /** The profiles this run holds the save lease for: the only ones seeded with their `ref`, so the only ones it can
   *  write to and the only ones it saves back. Every other profile reaches it `held`, with no `ref`. */
  leases: string[];
};

/** What one carry back did. `changed` is false when the run had already been carried back. */
export type CarryBack = { changed: boolean; profiles: string[]; released: string[] };

const invalid = (message: string) => new AgentHomeError("invalid", message);
const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
const iso = (ms: number) => new Date(ms).toISOString();
/** A profile for a run without its save lease: no `ref`, so the run cannot write to the saved sign-in (pi-browser's
 *  Browserbase provider opens every saved context it is handed with saving on). */
const withoutRef = (profile: BrowserProfile, holder: string): BrowserProfile => ({
  provider: profile.provider, ref: "", state: "held", heldBy: holder,
  ...(profile.startUrl !== undefined ? { startUrl: profile.startUrl } : {}),
  ...(profile.allowedOrigins !== undefined ? { allowedOrigins: profile.allowedOrigins } : {}),
});
/** A lease is free when absent, past its expiry, or held by a run that has ended. */
const isFree = (lease: ProfileLease | undefined, runs: Record<string, RunRecord>, now: number) =>
  !lease || Date.parse(lease.expiresAt) <= now || own(runs, lease.runId)?.endedAt !== undefined;

/** Start a run of the agent: `runs/<runId>/` with `store/run.sqlite` and `work/`, the skills written into `work/`, the
 *  save lease taken for every profile no live run holds, the agent's `browser.profiles` copied into the run store (a
 *  profile another run holds without its `ref`), and the run recorded in `agent.runs`. Seeding is this host step, never
 *  a tool. */
export async function startRun(home: AgentHome, options: { runId?: string; host: string; now?: number; leaseMs?: number }): Promise<RunStart> {
  const now = options.now ?? Date.now();
  const runId = options.runId ?? uuidv7(now);
  const paths = runPaths(home, runId);
  if (typeof options.host !== "string" || options.host === "") throw invalid("the host is not a non-empty string");
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw invalid("leaseMs is not a positive integer");
  const dir = homeDir(home.dir);
  const { dir: runDir, storePath, workspace } = paths;
  return inHome(dir, async (store) => {
    const state = await readState(store);
    if (own(state.runs, runId) || existsSync(runDir)) throw new AgentHomeError("exists", `the run ${runId} already exists`);
    const leases = Object.keys(state.profiles).filter((key) => isFree(own(state.leases, key), state.runs, now));
    await mkdir(path.dirname(runDir), { recursive: true });
    await mkdir(runDir);
    try {
      await mkdir(path.dirname(storePath));
      await mkdir(workspace);
      for (const [file, skill] of Object.entries(state.skills)) {
        if (!isSkillPath(file) || sha256(skill.content) !== skill.sha256) throw new AgentHomeError("format", `the skill ${file} does not match its sha256`);
        const target = path.join(workspace, ".agents", "skills", ...file.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, skill.content);
      }
      const run = await openStore(storePath);
      try {
        await run.session.commit(async (tx) => {
          for (const [key, profile] of Object.entries(state.profiles)) {
            put(await tx.doc(ProfilesDoc, key, null), leases.includes(key) ? profile : withoutRef(profile, own(state.leases, key)!.runId));
          }
        }, BACKGROUND_CONTEXT);
      } finally {
        await run.close();
      }
      const record: RunRecord = { path: `runs/${runId}`, host: options.host, startedAt: iso(now) };
      const lease: ProfileLease = { runId, expiresAt: iso(now + leaseMs) };
      await store.session.commit(async (tx) => {
        put(await tx.doc(RunsDoc, runId, null), record);
        for (const key of leases) put(await tx.doc(LeasesDoc, key, null), lease);
      }, BACKGROUND_CONTEXT);
    } catch (error) {
      await rm(runDir, { recursive: true, force: true });
      throw error;
    }
    return { runId, ...paths, agent: { instructions: state.definition.instructions, tools: [...state.definition.tools] }, leases };
  });
}

/** Carry a finished run back into its agent home, in one commit under the home's lock: each profile the run holds the
 *  save lease for (and each new profile no other run owns) is copied from the run store, the run's leases are released,
 *  and its `agent.runs` entry is completed. A second call for the same run changes nothing. It reads only the run's
 *  store, so the files pi-durable-disk adds do not matter; call it after the run's Harness has closed (pi-durable-disk:
 *  after `release()`). */
export async function carryBack(home: AgentHome, run: Pick<RunStart, "runId">, options: { outcome: string; finalAnswer?: JsonValue; cost?: number; now?: number }): Promise<CarryBack> {
  if (typeof options?.outcome !== "string" || options.outcome === "") throw invalid("the outcome is not a non-empty string");
  if (options.cost !== undefined && !(typeof options.cost === "number" && Number.isFinite(options.cost) && options.cost >= 0)) throw invalid("the cost is not a non-negative number");
  const now = options.now ?? Date.now();
  const dir = homeDir(home.dir);
  return inHome(dir, async (store) => {
    const state = await readState(store);
    const record = own(state.runs, run.runId);
    if (!record) throw new AgentHomeError("missing", `${String(run.runId)} is not a run of this agent`);
    if (record.endedAt !== undefined) return { changed: false, profiles: [], released: [] };
    const { storePath } = layout(path.join(dir, record.path));
    if (!existsSync(storePath)) throw new AgentHomeError("missing", `the run ${run.runId} has no store at ${path.relative(dir, storePath)}`);
    const runStore = await openStore(storePath);
    let profiles: Record<string, BrowserProfile>;
    try { profiles = await readFamily(runStore, ProfilesDoc); } finally { await runStore.close(); }
    const holds = (key: string) => own(state.leases, key)?.runId === run.runId;
    const unowned = (key: string) => !own(state.profiles, key) && isFree(own(state.leases, key), state.runs, now);
    const copied = Object.keys(profiles).filter((key) => holds(key) || unowned(key));
    const released = Object.keys(state.leases).filter(holds);
    const ended: RunRecord = {
      ...record, endedAt: iso(now), outcome: options.outcome,
      ...(options.finalAnswer !== undefined ? { finalAnswer: options.finalAnswer } : {}),
      ...(options.cost !== undefined ? { cost: options.cost } : {}),
    };
    await store.session.commit(async (tx) => {
      for (const key of copied) put(await tx.doc(ProfilesDoc, key, null), profiles[key]!);
      for (const key of released) await tx.retireDoc(LeasesDoc, key);
      put(await tx.doc(RunsDoc, run.runId, null), ended);
    }, BACKGROUND_CONTEXT);
    return { changed: true, profiles: copied, released };
  });
}
