// Archil mode (Mode 2) as the owner configured it: the account key's region, the region's S3 URL and an optional pinned
// exec image (absent: DEFAULT_ARCHIL_EXEC_IMAGE), kept as one row in store.settings. The one kept credential is the account key (the file API, exec and the
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
/** The exec image a Mode 2 server runs commands in when the owner saved none: Docker's official
 *  `buildpack-deps:trixie-scm` (Debian 13 with git 2.47.3, GNU coreutils, perl-base, grep, sed, mawk, diffutils and
 *  findutils; no ripgrep), pinned to the multi-arch index digest Docker Hub served for that tag on 2026-11-11. Archil's
 *  own default exec image has git 2.34.1, and a shell under a bash policy runs git only at 2.43 or later (bash-read-only.ts
 *  POLICY_GIT_FLOOR), so a read-only agent there would get no git. Its git was read from the top layer's
 *  /var/lib/dpkg/status for amd64 and arm64 alike (`git 1:2.47.3-0+deb13u1`). To move it, read the tag's index digest
 *  again (an anonymous pull token from auth.docker.io for `repository:library/buildpack-deps:pull`, then a HEAD of
 *  registry-1.docker.io/v2/library/buildpack-deps/manifests/trixie-scm accepting an OCI index: its
 *  `docker-content-digest`), check the git its layers hold, and put it here. An image the owner saved replaces it. */
export const DEFAULT_ARCHIL_EXEC_IMAGE = "buildpack-deps@sha256:4f34e1d673fdb65371de9f88bdd32c4e30152fe692b35604aef5c0b3c0e6da10";

export interface ArchilSettings {
  /** The account key's region: the control plane every disk is made, read and minted on. */
  readonly region: string;
  /** The region's S3 endpoint (the disks' file API). */
  readonly s3Url: string;
  /** A pinned image for the disk's exec, when the owner set one; absent, DEFAULT_ARCHIL_EXEC_IMAGE. */
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

/** The disk agentrun made for an agent, stored on the agent (never its revision: a rollback moves no files). `removing`:
 *  DELETE /v2/agents/{id}/archil has begun removing it, so no launch takes it and no claim mounts it. */
export interface AgentDisk {
  readonly diskId: string;
  readonly removing?: true;
  /** Made, and not yet read `available` at Archil: a claim that finds it waits for it before it mounts. */
  readonly pending?: true;
}

/** The settings key agent `agentId`'s disk is stored under. */
export const agentDiskKey = (agentId: string): string => `${ARCHIL_SETTINGS_KEY}.agent.${agentId}`;

/** The disk stored on agent `agentId`, or undefined when it has none yet (made on its first run that uses it). */
export async function agentDiskOf(store: { settings: Pick<Settings, "get"> }, agentId: string): Promise<AgentDisk | undefined> {
  const read = await store.settings.get(agentDiskKey(agentId));
  const row = typeof read === "object" && read !== null ? (read as Record<string, unknown>) : {};
  if (typeof row.diskId !== "string" || !ARCHIL_DISK_ID.test(row.diskId)) return undefined;
  return { diskId: row.diskId, ...(row.removing === true ? { removing: true as const } : {}), ...(row.pending === true ? { pending: true as const } : {}) };
}

/** Stores `disk` on agent `agentId`, as removing when it says so. */
export async function storeAgentDisk(store: { settings: Pick<Settings, "put"> }, agentId: string, disk: AgentDisk): Promise<void> {
  await store.settings.put(agentDiskKey(agentId), { diskId: disk.diskId, ...(disk.removing ? { removing: true } : {}), ...(disk.pending ? { pending: true } : {}) });
}

/** The settings key of the agent disk run `runId` first resolved to (its launch record is written once, before any disk). */
export const runDiskKey = (runId: string): string => `${ARCHIL_SETTINGS_KEY}.run.${runId}`;

/** The agent disk run `runId` first resolved to, or undefined when none is kept: a later claim of the same run (a reopened
 *  one) uses that disk or is refused, never another. */
export async function runDiskKept(store: { settings: Pick<Settings, "get"> }, runId: string): Promise<string | undefined> {
  const read = await store.settings.get(runDiskKey(runId));
  const id = typeof read === "object" && read !== null ? (read as Record<string, unknown>).diskId : undefined;
  return typeof id === "string" && ARCHIL_DISK_ID.test(id) ? id : undefined;
}

/** Keeps disk `diskId` as the one run `runId` mounts. */
export async function keepRunDisk(store: { settings: Pick<Settings, "put"> }, runId: string, diskId: string): Promise<void> {
  await store.settings.put(runDiskKey(runId), { diskId });
}

/** Forgets agent `agentId`'s disk `diskId`, only while the agent's stored disk is still that one: its next run that uses
 *  it makes a new one, and a disk stored since (a run's, after an earlier removal) is kept. */
export async function forgetAgentDisk(store: { settings: Pick<Settings, "get" | "remove"> }, agentId: string, diskId: string): Promise<void> {
  if ((await agentDiskOf(store, agentId))?.diskId === diskId) await store.settings.remove(agentDiskKey(agentId));
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

/** The name of agent `agentId`'s own disk on server `serverId`: agentrun-<server id>-<part>, its part at most 48
 *  characters. Archil takes letters, digits, dashes and underscores. An id of those alone, at most 46 of them, is
 *  `i-<id>`; any other (a dot, or longer) is `h-<its first 21 such characters>-<24 hex digits of its SHA-256>`. The two
 *  forms start with different letters, so no id's name is another's. */
export function diskNameOf(serverId: string, agentId: string): string {
  const plain = /^[A-Za-z0-9_-]{1,46}$/.test(agentId);
  const part = plain ? `i-${agentId}` : `h-${agentId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 21)}-${createHash("sha256").update(agentId).digest("hex").slice(0, 24)}`;
  return `agentrun-${serverId}-${part}`;
}
