// The run-directory markers and the per-run door's files the server reads and writes (the runner cutover deletes these).
// The server-wide durable-file plumbing and the data-directory location moved to server-fs.ts; this module re-exports it
// so callers that still reach for it here keep working until they are pointed at server-fs.ts.
import { createHash } from "node:crypto";
import { join } from "node:path";

export { DATA_ENV, SERVER_FILE, TOKEN_FILE, agentFolderOf, defaultData, readJson, removeOwnRecord, serialBy, syncDir, tempOf, writeDurable, writeDurableSync, writeWhole } from "./server-fs.js";

/** The server's own file in each run's directory: the run's title, input and how it was asked to run. */
export const RUN_META = "serve.json";
/** A cancelled run's mark in its directory, written before its process is told: the run's process sends no model
 *  request once it is there, however the cancel and the process's start interleave. */
export const RUN_CANCELLED = "cancelled";

/** The server-wide door token, in the data directory: the door of a run an older server started takes it. */
export const DOOR_TOKEN_FILE = ".door-token";
/** A run's own door token, in its directory, made at its first launch and handed to its process alone (its
 *  `--serve-token-file`): the server's calls to that run's door carry it, and so do that run's calls to the box relay
 *  (box-relay.ts), which takes a call for a run only with that run's token. */
export const RUN_DOOR_TOKEN = "door-token";

/** Why a run fails whose launch mark a start finds (`error.details.reason`, openapi.ts). */
export const LAUNCH_LOST = "server_lost_at_launch";
/** Why a run fails that the store has running with no serve.json: its server went down before it set the run up. */
export const SETUP_LOST = "server_lost_at_setup";


export const HOMES_DIR = "homes";
/** Paths in an agent's home that only the host reads and writes (another component owns them): the home API reads and
 *  writes neither, and lists each by its name alone. `learning` (learning.ts, read through its own API) and `sign-ins`
 *  (sign-ins-store.ts: the agent's saved sign-ins, sealed pointers to its browser vendor's objects, shown without them on
 *  GET /agents/{id}). */
export const HOME_HOST_OWNED = ["learning", "sign-ins"];
/** An agent's home directory's name: its id in lower case, then 16 hex digits of the id's SHA-256. Ids that differ only
 *  in case get names that differ in any case, so on a disk that folds case (macOS's, by default) they never share one. */
export const homeKey = (agentId: string): string => `${agentId.toLowerCase()}-${createHash("sha256").update(agentId, "utf8").digest("hex").slice(0, 16)}`;
export const homeOf = (data: string, agentId: string): string => join(data, HOMES_DIR, homeKey(agentId));
