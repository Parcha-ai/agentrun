import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentHome, checkSha, homeDir, type HomeAccess, ID_PATTERN, inClaimedHome, isSkillPath, localAccess, readState, RUN_STORE_FILE,
  runStoreIn, sha256, uuidv7,
} from "./home.js";
import { type BrowserProfile, LeasesDoc, type ProfileLease, ProfilesDoc, put, type RunRecord, RunsDoc } from "./kinds.js";
import { AgentHomeError, openStore, readFamily, type Store } from "./store.js";

export { RUN_STORE_FILE };
const DEFAULT_LEASE_MS = 6 * 60 * 60 * 1000;

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

const layout = (dir: string): RunPaths => ({ dir, storePath: runStoreIn(dir), workspace: path.join(dir, "work") });

/** The paths of run `runId` in `home`. */
export function runPaths(home: AgentHome, runId: string): RunPaths {
  if (typeof runId !== "string" || !ID_PATTERN.test(runId)) throw invalid(`the run id ${JSON.stringify(runId)} is not letters, digits, ".", "_" or "-" (at most 128)`);
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
  /** The repo commit of the skills the workspace got (the home's `agent.source`); absent for a home not tied to a repo. */
  sha?: string;
};

/** The home-side half of a run's start, as plain data for the run-side half (`seedRun`) to write: the profiles (each
 *  one this run leases with its `ref`, every other one `held` without), the skill files, the root agent, the sha the
 *  skills come from and the profiles it may save back. */
export type RunSeed = {
  runId: string;
  agent: { instructions: string; tools: string[] };
  leases: string[];
  profiles: Record<string, BrowserProfile>;
  skills: Record<string, string>;
  sha?: string;
  /** What `undoPrepare` puts back, not for the run: the start time of the record `prepareRun` wrote, and each lease it
   *  took as it was before (null where there was none). */
  prior: { startedAt: string; leases: Record<string, ProfileLease | null> };
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

/** A start's host, lease and sha, checked before the home is touched. */
function checkStart(options: { host: string; sha?: string; leaseMs?: number }): { leaseMs: number; wanted: string | undefined } {
  if (typeof options.host !== "string" || options.host === "") throw invalid("the host is not a non-empty string");
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw invalid("leaseMs is not a positive integer");
  return { leaseMs, wanted: options.sha === undefined ? undefined : checkSha(options.sha) };
}

/** The home-side half of a run's start, in one commit under the home's claim: with `sha`, a home whose cache is at
 *  another commit, or at none, is refused (`stale`); each skill is checked against its SHA-256; the save lease is taken
 *  for every profile no live run holds; the run is recorded in `agent.runs` (`runs/<runId>`) with the home's
 *  `agent.source` sha. It touches nothing under `runs/`: `seedRun` writes the run's directory from the seed. */
export async function prepareRun(home: AgentHome, options: { runId?: string; host: string; sha?: string; now?: number; leaseMs?: number; access?: HomeAccess }): Promise<RunSeed> {
  const now = options.now ?? Date.now();
  const runId = options.runId ?? uuidv7(now);
  if (typeof runId !== "string" || !ID_PATTERN.test(runId)) throw invalid(`the run id ${JSON.stringify(runId)} is not letters, digits, ".", "_" or "-" (at most 128)`);
  const { leaseMs, wanted } = checkStart(options);
  return inClaimedHome(home, options.access, (store) => prepareIn(store, { runId, now, host: options.host, leaseMs, wanted }));
}

/** `prepareRun`'s commit, on an agent store already held. */
async function prepareIn(store: Store, { runId, now, host, leaseMs, wanted }: { runId: string; now: number; host: string; leaseMs: number; wanted: string | undefined }): Promise<RunSeed> {
  const state = await readState(store);
  if (own(state.runs, runId)) throw new AgentHomeError("exists", `the run ${runId} already exists`);
  const sha = state.source?.sha;
  if (wanted !== undefined && wanted !== sha) {
    throw new AgentHomeError("stale", `the agent home's cache is at ${sha ?? "no commit"} and must be refreshed to ${wanted} before a run starts there`);
  }
  const skills = Object.fromEntries(Object.entries(state.skills).map(([file, skill]) => {
    if (!isSkillPath(file) || sha256(skill.content) !== skill.sha256) throw new AgentHomeError("format", `the skill ${file} does not match its sha256`);
    return [file, skill.content];
  }));
  const leases = Object.keys(state.profiles).filter((key) => isFree(own(state.leases, key), state.runs, now));
  const profiles = Object.fromEntries(Object.entries(state.profiles).map(([key, profile]) => [key, leases.includes(key) ? profile : withoutRef(profile, own(state.leases, key)!.runId)]));
  const record: RunRecord = { path: `runs/${runId}`, host, startedAt: iso(now), ...(sha !== undefined ? { sha } : {}) };
  const lease: ProfileLease = { runId, expiresAt: iso(now + leaseMs) };
  const prior = { startedAt: record.startedAt, leases: Object.fromEntries(leases.map((key) => [key, own(state.leases, key) ?? null])) };
  await store.session.commit(async (tx) => {
    put(await tx.doc(RunsDoc, runId, null), record);
    for (const key of leases) put(await tx.doc(LeasesDoc, key, null), lease);
  }, BACKGROUND_CONTEXT);
  return { runId, agent: { instructions: state.definition.instructions, tools: [...state.definition.tools] }, leases, profiles, skills, ...(sha !== undefined ? { sha } : {}), prior };
}

/** The run-side half: the run's pi-durable store with the seed's profiles, and its skill files under
 *  `.agents/skills/` in `workDir`. Safe to run again on a half-written directory: the skills are written again and the
 *  store is replaced, written beside its place and renamed in last, so a store that is there is a whole one. A seed
 *  that hands a profile's `ref` to a run that does not lease it is refused, and nothing is written. */
export async function seedRun(dir: { storePath: string; workDir: string }, seed: RunSeed): Promise<void> {
  for (const [key, profile] of Object.entries(seed.profiles)) {
    if (profile.ref && !seed.leases.includes(key)) throw invalid(`the seed gives the run ${seed.runId} the sign-in of ${key}, which it does not lease`);
  }
  for (const file of Object.keys(seed.skills)) if (!isSkillPath(file)) throw invalid(`the skill path ${JSON.stringify(file)} is not a relative path inside .agents/skills/`);
  await mkdir(dir.workDir, { recursive: true });
  const skills = path.join(dir.workDir, ".agents", "skills");
  await rm(skills, { recursive: true, force: true });
  for (const [file, content] of Object.entries(seed.skills)) {
    const target = path.join(skills, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(path.dirname(dir.storePath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(`${dir.storePath}${suffix}`, { force: true });
  const next = `${dir.storePath}.seed-${randomBytes(4).toString("hex")}`;
  try {
    const run = await openStore(next);
    try {
      await run.session.commit(async (tx) => {
        for (const [key, profile] of Object.entries(seed.profiles)) put(await tx.doc(ProfilesDoc, key, null), profile);
      }, BACKGROUND_CONTEXT);
    } finally {
      await run.close();
    }
    await rename(next, dir.storePath);
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(`${next}${suffix}`, { force: true });
  }
}

/** Start a run of the agent on this machine: `prepareRun`, then `seedRun` into `runs/<runId>/` (`store/run.sqlite`
 *  and `work/`), under one hold of the home, so a start that fails is undone under the same hold: no run directory, and
 *  its record and leases as they were. When undoing fails too, the error carries both failures. Seeding is this host
 *  step, never a tool. */
export async function startRun(home: AgentHome, options: { runId?: string; host: string; sha?: string; now?: number; leaseMs?: number }): Promise<RunStart> {
  const now = options.now ?? Date.now();
  const runId = options.runId ?? uuidv7(now);
  const paths = runPaths(home, runId);
  const { leaseMs, wanted } = checkStart(options);
  homeDir(home.dir);
  if (existsSync(paths.dir)) throw new AgentHomeError("exists", `the run ${runId} already exists`);
  return inClaimedHome(home, undefined, async (store) => {
    const seed = await prepareIn(store, { runId, now, host: options.host, leaseMs, wanted });
    try {
      await seedRun({ storePath: paths.storePath, workDir: paths.workspace }, seed);
    } catch (error) {
      const failed: unknown[] = [];
      await undoIn(store, seed).catch((undo) => failed.push(undo));
      await rm(paths.dir, { recursive: true, force: true }).catch((undo) => failed.push(undo));
      if (failed.length) throw undoFailed(seed, error, failed);
      throw error;
    }
    return { runId, ...paths, agent: seed.agent, leases: seed.leases, ...(seed.sha !== undefined ? { sha: seed.sha } : {}) };
  });
}

/** Undo a `prepareRun` whose seed never landed, inside the home's claim: each lease it took that is still this run's
 *  goes back to what it was before (or away, where there was none), and the run's record goes away if it is still the
 *  one `prepareRun` wrote. A lease another run has taken since, and a record that moved on, are left as they are. */
export async function undoPrepare(home: AgentHome, seed: RunSeed, options: { access?: HomeAccess } = {}): Promise<void> {
  await inClaimedHome(home, options.access, (store) => undoIn(store, seed));
}

async function undoIn(store: Store, seed: RunSeed): Promise<void> {
  const state = await readState(store);
  await store.session.commit(async (tx) => {
    for (const key of seed.leases) {
      if (own(state.leases, key)?.runId !== seed.runId) continue;
      const before = own(seed.prior.leases, key) ?? null;
      if (before) put(await tx.doc(LeasesDoc, key, null), before);
      else await tx.retireDoc(LeasesDoc, key);
    }
    const record = own(state.runs, seed.runId);
    if (record && record.endedAt === undefined && record.startedAt === seed.prior.startedAt) await tx.retireDoc(RunsDoc, seed.runId);
  }, BACKGROUND_CONTEXT);
}

/** The error of a start that failed and whose undo failed too: both, so neither is lost. */
function undoFailed(seed: RunSeed, error: unknown, failed: unknown[]): AggregateError {
  const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
  return new AggregateError([error, ...failed], `the run ${seed.runId} failed to start (${said(error)}), and undoing the start failed too (${failed.map(said).join("; ")}): its record or leases may still be in the home`);
}

/** The `browser.profiles` of a run's store, read from a private copy, so the file is only read. */
async function readRunProfiles(file: string): Promise<Record<string, BrowserProfile>> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-agent-run-"));
  try {
    const copy = path.join(dir, RUN_STORE_FILE);
    await copyFile(file, copy);
    if (existsSync(`${file}-wal`)) await copyFile(`${file}-wal`, `${copy}-wal`);
    for (const target of [copy, `${copy}-wal`]) if (existsSync(target)) await chmod(target, 0o600);
    const store = await openStore(copy);
    try { return await readFamily(store, ProfilesDoc); } finally { await store.close(); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Carry a finished run back into its agent home, in one commit inside the home's claim: each profile the run holds
 *  the save lease for (and each new profile no other run owns) is copied from the run store, the run's leases are
 *  released, and its `agent.runs` entry is completed. A second call for the same run changes nothing. The run store
 *  (`access.runStore`, by default the run's own file) is only read, from a copy, so the files pi-durable-disk adds do not
 *  matter; call it after the run's Harness has closed (pi-durable-disk: after `release()`). */
export async function carryBack(home: AgentHome, run: Pick<RunStart, "runId">, options: { outcome: string; finalAnswer?: JsonValue; cost?: number; now?: number; access?: HomeAccess }): Promise<CarryBack> {
  if (typeof options?.outcome !== "string" || options.outcome === "") throw invalid("the outcome is not a non-empty string");
  if (options.cost !== undefined && !(typeof options.cost === "number" && Number.isFinite(options.cost) && options.cost >= 0)) throw invalid("the cost is not a non-negative number");
  const now = options.now ?? Date.now();
  const access = options.access ?? localAccess(home);
  return inClaimedHome(home, access, async (store) => {
    const state = await readState(store);
    const record = own(state.runs, run.runId);
    if (!record) throw new AgentHomeError("missing", `${String(run.runId)} is not a run of this agent`);
    if (record.endedAt !== undefined) return { changed: false, profiles: [], released: [] };
    const storePath = await access.runStore({ runId: run.runId, path: record.path });
    if (!existsSync(storePath)) throw new AgentHomeError("missing", `the run ${run.runId} has no store at ${record.path}/store/${RUN_STORE_FILE}`);
    const profiles = await readRunProfiles(storePath);
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
