// A runner on a disk of its own (a disk-free runner): `agentrun-serve runner --data D` where D is the runner's own local
// directory, not the server's, on the Postgres store AGENTRUN_STORE_URL names. Its data directory then holds only what
// is the runner's: its heartbeat, its runs' uid slots and their scratch, and the harnesses it installs at a claim. It never
// reads the server's: a run's folder is on Archil (Mode 2), which every machine reaches; Mode 1 keeps it on the server's
// own disk, which this runner can't see, so a disk-free runner claims nothing while the server is in Mode 1.
//
// Which disk is the server's: the server keeps an id of its data root in a file there (DATA_ROOT_FILE, made once) and
// says it in the store at each start (DATA_ROOT_KEY). A runner whose data directory holds the same id shares the server's
// disk (the image's server-and-runner, compose's runners on one /data volume); any other runner is disk-free. A store
// whose server has not said its data root yet (one older than this) is taken as shared, as every runner was before.
// SQLite is in the data directory, so a runner on it always shares the server's.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHIL_SETTINGS_ENV, loadArchilSettings } from "../archil-settings.js";
import type { KeyEnv } from "../key-meta.js";
import type { Settings } from "../store/store.js";
import { serverRunEnv } from "./runner-check.js";

/** The file in the server's data root that holds its id (made once, kept across starts). */
export const DATA_ROOT_FILE = "data-root.id";
/** The store.settings key a server keeps its data root's id under at each start: `{ v: 1, id }`. */
export const DATA_ROOT_KEY = "server.data_root";
const ID = /^[0-9a-f]{32}$/;

/** The id in `dataDir`'s DATA_ROOT_FILE, or undefined when there is none (or it does not read as one). Never made here. */
export function dataRootIdIn(dataDir: string): string | undefined {
  try {
    const id = readFileSync(join(dataDir, DATA_ROOT_FILE), "utf8").trim();
    return ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The server's start: its data root's id (the file's, else a new one written there, 0600), said in the store, replacing
 *  the last start's. Called once the server holds its data root (server-lock.ts), so no other server writes the file. */
export async function recordDataRoot(store: { settings: Pick<Settings, "put"> }, dataDir: string): Promise<string> {
  let id = dataRootIdIn(dataDir);
  if (id === undefined) {
    id = randomBytes(16).toString("hex");
    writeFileSync(join(dataDir, DATA_ROOT_FILE), `${id}\n`, { mode: 0o600 });
  }
  await store.settings.put(DATA_ROOT_KEY, { v: 1, id });
  return id;
}

/** Whether a runner on `dataDir` shares its server's disk: true when its data directory holds the id the server said at its
 *  last start, false when it holds none or another, and undefined when the store holds none (a server older than this, or
 *  none started yet), which a caller takes as shared. */
export async function sharesServerDisk(store: { settings: Pick<Settings, "get"> }, dataDir: string): Promise<boolean | undefined> {
  const said = await store.settings.get(DATA_ROOT_KEY);
  const id = typeof said === "object" && said !== null ? (said as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !ID.test(id)) return undefined;
  return dataRootIdIn(dataDir) === id;
}

/** Whether the server is in Mode 2, by what the server holds, never by this runner's environment: the Archil settings
 *  saved in the store, or set in the server's own environment, whose names (never values) it says at each start
 *  (runner-check.ts RUN_ENV_KEY). */
export async function serverInArchilMode(store: { settings: Pick<Settings, "get"> }): Promise<boolean> {
  if ((await loadArchilSettings(store)) !== undefined) return true;
  const names = await serverRunEnv(store);
  return names !== undefined && [ARCHIL_SETTINGS_ENV.region, ARCHIL_SETTINGS_ENV.s3Url].every((name) => names.includes(name));
}

/** Why a runner on `dataDir` can't serve the runs its store holds now, or undefined while it can. On Postgres, a runner
 *  whose `dataDir` is not the server's disk can't while the server keeps runs' folders on that disk (Mode 1: the server
 *  holds no Archil settings, saved or in its environment), whatever this runner's environment holds; nor while the server
 *  is in Mode 2 by its own environment and this runner holds no Archil settings, so its claim would keep the run's folder
 *  on its own disk. On SQLite always undefined: the store is in the data directory, so the runner's is the server's. */
export async function diskFreeRefusal(store: { settings: Pick<Settings, "get"> }, dataDir: string, env: KeyEnv, storeKind: string): Promise<string | undefined> {
  if (storeKind === "sqlite") return undefined;
  if ((await sharesServerDisk(store, dataDir)) !== false) return undefined;
  if (!(await serverInArchilMode(store))) return DISK_FREE_MODE_1;
  if ((await loadArchilSettings(store, env)) === undefined) return DISK_FREE_NO_ARCHIL;
  return undefined;
}

/** A disk-free runner's words while the server is in Mode 1: what the runner can't do, why, and the two ways out. */
export const DISK_FREE_MODE_1 =
  "this runner's data directory is not the server's, and the server keeps each run's folder on its own disk (Mode 1: the server holds no Archil settings, saved or in its environment), which this runner can't reach. Save the Archil settings so runs' folders are on Archil (Mode 2), or start the runner on the server's data directory.";

/** A disk-free runner's words while the server is in Mode 2 by its own environment and this runner holds no Archil settings. */
export const DISK_FREE_NO_ARCHIL =
  `this runner's data directory is not the server's, and the server keeps each run's folder on Archil (Mode 2) by the Archil settings in its environment, which this runner does not hold. Hand this runner the server's ${ARCHIL_SETTINGS_ENV.region} and ${ARCHIL_SETTINGS_ENV.s3Url} (and ${ARCHIL_SETTINGS_ENV.image} when the server has it), or save the Archil settings in the store.`;

/** How long a gate's answer is kept between polls (diskFreeGate): a change of mode reaches a runner within this. */
export const DISK_FREE_GATE_MS = 5_000;

/** The runner's claim gate (runner.ts claimGate) for a runner on `dataDir`: diskFreeRefusal, its answer kept for
 *  DISK_FREE_GATE_MS between polls and read again when asked fresh. */
export function diskFreeGate(store: { settings: Pick<Settings, "get"> }, dataDir: string, env: KeyEnv, storeKind: string, now: () => number = Date.now): (fresh: boolean) => Promise<string | undefined> {
  let kept: { at: number; words: string | undefined } | undefined;
  return async (fresh) => {
    const at = now();
    if (!fresh && kept && at - kept.at < DISK_FREE_GATE_MS) return kept.words;
    const words = await diskFreeRefusal(store, dataDir, env, storeKind);
    kept = { at, words };
    return words;
  };
}
