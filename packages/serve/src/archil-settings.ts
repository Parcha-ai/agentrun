// The Archil disk the owner configured for Mode 2 (a remote disk the agent's files live on): its id, region, S3 URL and an
// optional pinned image, kept as one row in store.settings. The disk's one kept credential is the account key (the file
// API and exec), a sealed key (server-keys.ts) under the name below. No disk token is kept: a computer's mount credential
// is minted per run from the account key. Mode 2 = these settings present; absent, the server is in Mode 1 (a local
// folder). The owner sets them through the Archil routes (archil-routes.ts).
import type { Settings } from "./store/index.js";

/** The settings key the Archil disk's configuration lives under in store.settings. */
export const ARCHIL_SETTINGS_KEY = "archil";
/** The sealed-key row of the Archil account key (the file API and exec), saved through server-keys.ts. Named *_ROW: a
 *  constant named like a key holding a string reads as a literal credential to the source export. */
export const ARCHIL_API_KEY_ROW = "archil.api_key";

export interface ArchilSettings {
  readonly diskId: string;
  readonly region: string;
  readonly s3Url: string;
  /** A pinned image for the disk's exec, when the owner set one; absent, Archil's default image. */
  readonly image?: string;
}

/** The Archil settings the owner saved, or undefined when none is (Mode 1). A row that is not the expected shape reads as
 *  undefined, never a half-configured Mode 2. */
export async function loadArchilSettings(store: { settings: Pick<Settings, "get"> }): Promise<ArchilSettings | undefined> {
  const read = await store.settings.get(ARCHIL_SETTINGS_KEY);
  return isArchilSettings(read) ? read : undefined;
}

/** Saves the Archil settings (Mode 2), replacing any kept. */
export async function saveArchilSettings(store: { settings: Pick<Settings, "put"> }, settings: ArchilSettings): Promise<void> {
  await store.settings.put(ARCHIL_SETTINGS_KEY, {
    diskId: settings.diskId,
    region: settings.region,
    s3Url: settings.s3Url,
    ...(settings.image !== undefined ? { image: settings.image } : {}),
  });
}

/** Removes the Archil settings (back to Mode 1). */
export async function clearArchilSettings(store: { settings: Pick<Settings, "remove"> }): Promise<void> {
  await store.settings.remove(ARCHIL_SETTINGS_KEY);
}

/** Whether the server is in Mode 2 (the Archil disk is configured). */
export async function inArchilMode(store: { settings: Pick<Settings, "get"> }): Promise<boolean> {
  return (await loadArchilSettings(store)) !== undefined;
}

function isArchilSettings(value: unknown): value is ArchilSettings {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.diskId === "string" && typeof v.region === "string" && typeof v.s3Url === "string" && (v.image === undefined || typeof v.image === "string");
}
