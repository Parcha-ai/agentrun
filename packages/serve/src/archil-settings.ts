// The Archil disk the owner configured for Mode 2 (a remote disk the agent's files live on): its id, region, S3 URL and an
// optional pinned exec image (absent: DEFAULT_ARCHIL_EXEC_IMAGE), kept as one row in store.settings. The disk's one kept credential is the account key (the file
// API and exec), a sealed key (server-keys.ts) under the name below. No disk token is kept: a computer's mount credential
// is minted per run from the account key. Mode 2 = these settings present; absent, the server is in Mode 1 (a local
// folder). The owner sets them through the Archil routes (archil-routes.ts), or the operator in the server's environment
// (ARCHIL_SETTINGS_ENV), which wins over a saved row as ARCHIL_API_KEY wins over the saved key, and is never written to
// the store: unset again, the saved row (or Mode 1) is back.
import type { InputIssue } from "./errors.js";
import { envValue, type KeyEnv } from "./key-meta.js";
import type { Settings } from "./store/index.js";
import { pinnedImage } from "./workspace/archil-disk.js";

/** The settings key the Archil disk's configuration lives under in store.settings. */
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
  readonly diskId: string;
  readonly region: string;
  readonly s3Url: string;
  /** A pinned image for the disk's exec, when the owner set one; absent, DEFAULT_ARCHIL_EXEC_IMAGE. */
  readonly image?: string;
}

/** The environment variable that sets each field, for a server whose operator sets the disk where it is started (a
 *  headless deploy, where no owner's session can save it). The first three are all set or none; the image is optional. */
export const ARCHIL_SETTINGS_ENV = { diskId: "AGENTRUN_ARCHIL_DISK", region: "AGENTRUN_ARCHIL_REGION", s3Url: "AGENTRUN_ARCHIL_S3_URL", image: "AGENTRUN_ARCHIL_IMAGE" } as const;
const REQUIRED = ["diskId", "region", "s3Url"] as const;

/** The Archil settings in the server's environment are not whole or not right: the start stops, in these words. */
export class ArchilSettingsEnvInvalid extends Error {
  override readonly name = "ArchilSettingsEnvInvalid";
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** What is wrong with each settings field given, by the one rule the PUT and the environment share: a disk id and a
 *  region, an https S3 URL, and an image, when given, pinned by digest. Empty when every field is right. */
export function archilSettingsIssues(given: Readonly<Record<string, unknown>>): InputIssue[] {
  const issues: InputIssue[] = [];
  for (const field of ["diskId", "region"]) if (!nonEmpty(given[field])) issues.push({ field, reason: "required", message: `${field} is a non-empty string` });
  if (!nonEmpty(given.s3Url) || !URL.canParse(given.s3Url) || new URL(given.s3Url).protocol !== "https:") issues.push({ field: "s3Url", reason: "invalid", message: "s3Url is the disk's S3 endpoint, an https URL" });
  if (given.image !== undefined) {
    try {
      pinnedImage({ baseImage: given.image });
    } catch {
      issues.push({ field: "image", reason: "invalid", message: "image is pinned by digest: <name>@sha256:<64 hex>" });
    }
  }
  return issues;
}

/** The settings of fields archilSettingsIssues found right. */
export const archilSettingsOf = (given: Readonly<Record<string, unknown>>): ArchilSettings => ({
  diskId: (given.diskId as string).trim(), region: (given.region as string).trim(), s3Url: given.s3Url as string,
  ...(given.image !== undefined ? { image: given.image as string } : {}),
});

/** The Archil settings the server's environment sets, or undefined when it sets none of ARCHIL_SETTINGS_ENV. Some but
 *  not every required one, or a value the PUT would refuse, is ArchilSettingsEnvInvalid naming each variable, never a
 *  half-configured Mode 2. The environment is passed in: process.env is never read here. */
export function archilSettingsFromEnv(env: KeyEnv): ArchilSettings | undefined {
  const given: Record<string, string> = {};
  for (const [field, name] of Object.entries(ARCHIL_SETTINGS_ENV)) {
    const value = envValue(env, name);
    if (value !== undefined) given[field] = value.trim();
  }
  const set = Object.keys(given);
  if (set.length === 0) return undefined;
  const missing = REQUIRED.filter((field) => given[field] === undefined).map((field) => ARCHIL_SETTINGS_ENV[field]);
  const named = set.map((field) => ARCHIL_SETTINGS_ENV[field as keyof typeof ARCHIL_SETTINGS_ENV]);
  if (missing.length) throw new ArchilSettingsEnvInvalid(`This server is started with ${named.join(", ")} but not ${missing.join(", ")}: set ${REQUIRED.map((field) => ARCHIL_SETTINGS_ENV[field]).join(", ")} together to keep run folders on that Archil disk (Mode 2), or none of them.`);
  const issues = archilSettingsIssues(given);
  if (issues.length) throw new ArchilSettingsEnvInvalid(`This server's Archil settings in its environment are not right: ${issues.map((issue) => issue.message.replace(/^\w+/, ARCHIL_SETTINGS_ENV[issue.field as keyof typeof ARCHIL_SETTINGS_ENV])).join("; ")}.`);
  return archilSettingsOf(given);
}

/** The Archil settings in force, or undefined when there are none (Mode 1): the server's environment's (`env`), else the
 *  row the owner saved. A row that is not the expected shape reads as undefined, never a half-configured Mode 2. */
export async function loadArchilSettings(store: { settings: Pick<Settings, "get"> }, env: KeyEnv = {}): Promise<ArchilSettings | undefined> {
  const fromEnv = archilSettingsFromEnv(env);
  if (fromEnv !== undefined) return fromEnv;
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

/** Whether the server is in Mode 2 (the Archil disk is configured, in `env` or saved). */
export async function inArchilMode(store: { settings: Pick<Settings, "get"> }, env: KeyEnv = {}): Promise<boolean> {
  return (await loadArchilSettings(store, env)) !== undefined;
}

function isArchilSettings(value: unknown): value is ArchilSettings {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.diskId === "string" && typeof v.region === "string" && typeof v.s3Url === "string" && (v.image === undefined || typeof v.image === "string");
}
