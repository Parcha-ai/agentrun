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

/** A started run, as the host needs it. */
export type RunStart = {
  runId: string;
  /** The run's pi-durable store; the host opens its own Harness on it. */
  storePath: string;
  /** The run's working directory, with the agent's skills under `.agents/skills/`. */
  workspace: string;
  /** The root conversation's agent: the definition's instructions and tool names, which the host binds to its tools. */
  agent: { instructions: string; tools: string[] };
  /** The profile keys this run may save back; every other profile is read-only for it. */
  leases: string[];
};

/** What one carry back did. `changed` is false when the run had already been carried back. */
export type CarryBack = { changed: boolean; profiles: string[]; released: string[] };

const invalid = (message: string) => new AgentHomeError("invalid", message);
const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
const iso = (ms: number) => new Date(ms).toISOString();
/** A lease is free when absent, past its expiry, or held by a run that has ended. */
const isFree = (lease: ProfileLease | undefined, runs: Record<string, RunRecord>, now: number) =>
  !lease || Date.parse(lease.expiresAt) <= now || own(runs, lease.runId)?.endedAt !== undefined;

/** Start a run of the agent: `runs/<runId>/` with `run.sqlite` and `workspace/`, the skills written into the workspace,
 *  the agent's `browser.profiles` copied into the run store, the save lease taken for every profile no live run holds,
 *  and the run recorded in `agent.runs`. Seeding is this host step, never a tool. */
export async function startRun(home: AgentHome, options: { runId?: string; host: string; now?: number; leaseMs?: number }): Promise<RunStart> {
  const now = options.now ?? Date.now();
  const runId = options.runId ?? uuidv7(now);
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw invalid(`the run id ${JSON.stringify(runId)} is not letters, digits, ".", "_" or "-" (at most 128)`);
  if (typeof options.host !== "string" || options.host === "") throw invalid("the host is not a non-empty string");
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw invalid("leaseMs is not a positive integer");
  const dir = homeDir(home.dir);
  const runDir = path.join(dir, "runs", runId);
  const storePath = path.join(runDir, RUN_STORE_FILE);
  const workspace = path.join(runDir, "workspace");
  return inHome(dir, async (store) => {
    const state = await readState(store);
    if (own(state.runs, runId) || existsSync(runDir)) throw new AgentHomeError("exists", `the run ${runId} already exists`);
    const leases = Object.keys(state.profiles).filter((key) => isFree(own(state.leases, key), state.runs, now));
    await mkdir(path.dirname(runDir), { recursive: true });
    await mkdir(runDir);
    try {
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
          for (const [key, profile] of Object.entries(state.profiles)) put(await tx.doc(ProfilesDoc, key, null), profile);
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
    return { runId, storePath, workspace, agent: { instructions: state.definition.instructions, tools: [...state.definition.tools] }, leases };
  });
}

/** Carry a finished run back into its agent home, in one commit under the home's lock: each profile the run holds the
 *  save lease for (and each new profile no other run owns) is copied from the run store, the run's leases are released,
 *  and its `agent.runs` entry is completed. A second call for the same run changes nothing. Call it after the host's
 *  Harness on the run store has closed. */
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
    const storePath = path.join(dir, record.path, RUN_STORE_FILE);
    if (!existsSync(storePath)) throw new AgentHomeError("missing", `the run ${run.runId} has no store at ${record.path}/${RUN_STORE_FILE}`);
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
