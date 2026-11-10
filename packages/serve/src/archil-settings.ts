// Archil mode (Mode 2) as the owner configured it: the account key's region, the region's S3 URL and an optional pinned
// exec image, kept as one row in store.settings. The one kept credential is the account key (the file API, exec and the
// control plane), a sealed key (server-keys.ts) under the name below. No disk token is kept: a computer's mount
// credential is minted per run from the account key. Mode 2 = these settings present; absent, the server is in Mode 1 (a
// local folder). The owner sets them through the Archil routes (archil-routes.ts).
//
// There is no server-wide disk: every agent has its own (agentDiskOf), made on its first run that needs it, and a run's
// launch may name another (a disk per customer: run-launch.ts archilDisk). A row saved before that still names a
// `diskId`: it is dropped on read, and no agent uses that disk.
import { createHash, randomBytes } from "node:crypto";
import type { Settings } from "./store/index.js";

/** The settings key the Archil configuration lives under in store.settings. */
export const ARCHIL_SETTINGS_KEY = "archil";
/** The sealed-key row of the Archil account key (the file API and exec), saved through server-keys.ts. Named *_ROW: a
 *  constant named like a key holding a string reads as a literal credential to the source export. */
export const ARCHIL_API_KEY_ROW = "archil.api_key";

export interface ArchilSettings {
  /** The account key's region: the control plane every disk is made, read and minted on. */
  readonly region: string;
  /** The region's S3 endpoint (the disks' file API). */
  readonly s3Url: string;
  /** A pinned image for the disk's exec, when the owner set one; absent, Archil's default image. */
  readonly image?: string;
}

/** The Archil settings the owner saved, or undefined when none is (Mode 1). A row that is not the expected shape reads as
 *  undefined, never a half-configured Mode 2; a field it no longer keeps (an old row's `diskId`) is dropped. */
export async function loadArchilSettings(store: { settings: Pick<Settings, "get"> }): Promise<ArchilSettings | undefined> {
  const read = await store.settings.get(ARCHIL_SETTINGS_KEY);
  if (typeof read !== "object" || read === null) return undefined;
  const { region, s3Url, image } = read as Record<string, unknown>;
  if (typeof region !== "string" || typeof s3Url !== "string" || (image !== undefined && typeof image !== "string")) return undefined;
  return { region, s3Url, ...(image !== undefined ? { image } : {}) };
}

/** Saves the Archil settings (Mode 2), replacing any kept. */
export async function saveArchilSettings(store: { settings: Pick<Settings, "put"> }, settings: ArchilSettings): Promise<void> {
  await store.settings.put(ARCHIL_SETTINGS_KEY, {
    region: settings.region,
    s3Url: settings.s3Url,
    ...(settings.image !== undefined ? { image: settings.image } : {}),
  });
}

/** Removes the Archil settings (back to Mode 1). */
export async function clearArchilSettings(store: { settings: Pick<Settings, "remove"> }): Promise<void> {
  await store.settings.remove(ARCHIL_SETTINGS_KEY);
}

/** Whether the server is in Mode 2 (the Archil settings are saved). */
export async function inArchilMode(store: { settings: Pick<Settings, "get"> }): Promise<boolean> {
  return (await loadArchilSettings(store)) !== undefined;
}

// ---- the agent's own disk -----------------------------------------------------------------------------------------

/** An Archil disk id as Archil's API returns and addresses them: dsk-<16 hex digits>. */
export const ARCHIL_DISK_ID = /^dsk-[0-9a-f]{16}$/;

/** The disk agentrun made for an agent, stored on the agent (never its revision: a rollback moves no files). */
export interface AgentDisk {
  readonly diskId: string;
}

/** The settings key agent `agentId`'s disk is stored under. */
export const agentDiskKey = (agentId: string): string => `${ARCHIL_SETTINGS_KEY}.agent.${agentId}`;

/** The disk stored on agent `agentId`, or undefined when it has none yet (made on its first run that uses it). */
export async function agentDiskOf(store: { settings: Pick<Settings, "get"> }, agentId: string): Promise<AgentDisk | undefined> {
  const read = await store.settings.get(agentDiskKey(agentId));
  const diskId = typeof read === "object" && read !== null ? (read as Record<string, unknown>).diskId : undefined;
  return typeof diskId === "string" && ARCHIL_DISK_ID.test(diskId) ? { diskId } : undefined;
}

/** Stores `disk` on agent `agentId`. */
export async function storeAgentDisk(store: { settings: Pick<Settings, "put"> }, agentId: string, disk: AgentDisk): Promise<void> {
  await store.settings.put(agentDiskKey(agentId), { diskId: disk.diskId });
}

/** Forgets agent `agentId`'s disk: its next run that uses it makes a new one. */
export async function forgetAgentDisk(store: { settings: Pick<Settings, "remove"> }, agentId: string): Promise<void> {
  await store.settings.remove(agentDiskKey(agentId));
}

/** The settings key of this server's id. */
export const SERVER_ID_KEY = "server_id";

/** This server's id: 12 hex digits, made once and kept in its store (the first writer wins a race), so its agents' disk
 *  names stay the same across restarts and tell its disks from another server's on one Archil account. */
export async function serverIdOf(store: { settings: Pick<Settings, "putIfAbsent"> }): Promise<string> {
  const kept = await store.settings.putIfAbsent(SERVER_ID_KEY, { v: 1, id: randomBytes(6).toString("hex") });
  const id = (kept as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id)) throw new Error(`this server's store keeps a ${SERVER_ID_KEY} that does not read as one`);
  return id;
}

/** The name of agent `agentId`'s own disk on server `serverId`: agentrun-<server id>-<agent id>. Archil takes letters,
 *  digits, dashes and underscores: an id with anything else (a dot), or past 48 characters, is kept as its first 32 such
 *  characters and 8 hex digits of its SHA-256, so two ids never share a name. */
export function diskNameOf(serverId: string, agentId: string): string {
  const plain = /^[A-Za-z0-9_-]{1,48}$/.test(agentId);
  const part = plain ? agentId : `${agentId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32)}-${createHash("sha256").update(agentId).digest("hex").slice(0, 8)}`;
  return `agentrun-${serverId}-${part}`;
}
