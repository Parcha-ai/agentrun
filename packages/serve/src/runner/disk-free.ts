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
import { loadArchilSettings } from "../archil-settings.js";
import type { KeyEnv } from "../key-meta.js";
import type { Settings } from "../store/store.js";

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

/** Why a runner on `dataDir` can't serve the runs its store holds now, or undefined while it can: on Postgres, while the
 *  server keeps runs' folders on its own disk (Mode 1: no Archil settings, from the store or `env`) and `dataDir` is not that
 *  disk. On SQLite always undefined: the store is in the data directory, so the runner's is the server's. */
export async function diskFreeRefusal(store: { settings: Pick<Settings, "get"> }, dataDir: string, env: KeyEnv, storeKind: string): Promise<string | undefined> {
  if (storeKind === "sqlite") return undefined;
  if ((await loadArchilSettings(store, env)) !== undefined) return undefined;
  if ((await sharesServerDisk(store, dataDir)) !== false) return undefined;
  return DISK_FREE_MODE_1;
}

/** A disk-free runner's words while the server is in Mode 1: what the runner can't do, why, and the two ways out. */
export const DISK_FREE_MODE_1 =
  "this runner's data directory is not the server's, and the server keeps each run's folder on its own disk (Mode 1: no Archil settings are saved), which this runner can't reach. Save the Archil settings so runs' folders are on Archil (Mode 2), or start the runner on the server's data directory.";

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
