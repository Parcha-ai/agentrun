// The owner's Archil routes: what turns Mode 2 on and off. Mode 2 is the Archil settings row present (archil-settings.ts);
// the disk's two credentials are sealed keys under the claim's row names ("archil.api_key", "archil.disk_token").
//   GET    /v2/workspace/archil       on or off, the settings, and each key saved or not (never a value)
//   PUT    /v2/workspace/archil       the settings row replaced, and the keys given sealed (null removes one); the exec
//                                     image, when given, pinned by digest
//   DELETE /v2/workspace/archil       off (the settings row removed; the keys are kept, for turning it on again)
//   POST   /v2/workspace/archil/test  one listing of the disk's root through its file API, with the account key opened
//                                     as a claim opens it (archilClaim): { ok, detail } or { ok: false, why }
// archilRoute holds the routes' rules, so serve's dispatch only calls it and sends the answer, or the ApiError's status.
import { ARCHIL_API_KEY_ROW, ARCHIL_DISK_TOKEN_ROW, type ArchilSettings, clearArchilSettings, loadArchilSettings, saveArchilSettings } from "./archil-settings.js";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { putSealedKey, removeSealedKey, sealedKeyNames } from "./server-keys.js";
import type { Store } from "./store/index.js";
import { unknownFields } from "./validate.js";
import { ArchilClaimRefused, archilClaim } from "./workspace/archil-claim.js";
import { type ArchilDisk, type ArchilDiskOptions, pinnedImage } from "./workspace/archil-disk.js";

/** The routes, by their operation names. */
export const ARCHIL_ROUTES: ReadonlySet<string> = new Set(["getWorkspaceArchil", "putWorkspaceArchil", "deleteWorkspaceArchil", "testWorkspaceArchil"]);

/** The keys the owner gives, by the names the API takes, and the sealed-key row each is kept in. */
const KEYS: readonly { readonly name: string; readonly row: string }[] = [
  { name: "ARCHIL_API_KEY", row: ARCHIL_API_KEY_ROW },
  { name: "ARCHIL_DISK_TOKEN", row: ARCHIL_DISK_TOKEN_ROW },
];

export type ArchilView = { on: boolean; diskId?: string; region?: string; s3Url?: string; image?: string; keys: { name: string; saved: boolean }[] };
export type ArchilTest = { ok: true; detail: string } | { ok: false; why: string };

export interface ArchilRoutesOptions {
  /** The server's one store: its settings and sealed keys. */
  readonly store: Pick<Store, "settings" | "sealedKeys">;
  /** The server's seal key; absent, no key is kept here. */
  readonly sealKey: Buffer | undefined;
  /** Makes the disk for the test (default archilDisk): a test's fake. */
  readonly makeDisk?: (options: ArchilDiskOptions) => ArchilDisk;
}

const OFF = "Archil is off on this server: save its disk, region and S3 URL (PUT /v2/workspace/archil)";
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const describe = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

export function createArchilRoutes(options: ArchilRoutesOptions) {
  const { store, sealKey } = options;

  async function view(): Promise<ArchilView> {
    const settings = await loadArchilSettings(store);
    const saved = new Set(await sealedKeyNames(store));
    return { on: settings !== undefined, ...(settings ?? {}), keys: KEYS.map((key) => ({ name: key.name, saved: saved.has(key.row) })) };
  }

  /** The settings row replaced and the keys given sealed, once every field is right; nothing is saved when one is not. */
  async function save(body: unknown): Promise<ArchilView> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("input_invalid", "the body is a JSON object: { diskId, region, s3Url, image?, keys? }");
    const given = body as Record<string, unknown>;
    const issues: InputIssue[] = unknownFields(given, ["diskId", "region", "s3Url", "image", "keys"]);
    for (const field of ["diskId", "region"]) if (!nonEmpty(given[field])) issues.push({ field, reason: "required", message: `${field} is a non-empty string` });
    if (!nonEmpty(given.s3Url) || !URL.canParse(given.s3Url) || new URL(given.s3Url).protocol !== "https:") issues.push({ field: "s3Url", reason: "invalid", message: "s3Url is the disk's S3 endpoint, an https URL" });
    if (given.image !== undefined) {
      try {
        pinnedImage({ baseImage: given.image });
      } catch {
        issues.push({ field: "image", reason: "invalid", message: "image is pinned by digest: <name>@sha256:<64 hex>" });
      }
    }
    const keys = given.keys ?? {};
    if (typeof keys !== "object" || keys === null || Array.isArray(keys)) issues.push({ field: "keys", reason: "wrong_type", message: "keys is an object of ARCHIL_API_KEY and ARCHIL_DISK_TOKEN" });
    const entries = typeof keys === "object" && keys !== null ? Object.entries(keys as Record<string, unknown>) : [];
    for (const [name, value] of entries) {
      if (!KEYS.some((key) => key.name === name)) issues.push({ field: `keys.${name}`, reason: "not_allowed", message: `Archil takes ARCHIL_API_KEY and ARCHIL_DISK_TOKEN, not ${name}` });
      else if (value !== null && !nonEmpty(value)) issues.push({ field: `keys.${name}`, reason: "wrong_type", message: `${name} is a non-empty string, or null to remove it` });
    }
    if (!sealKey && entries.some(([, value]) => value !== null)) issues.push({ field: "keys", reason: "unavailable", message: "this server was given no seal key, so it keeps no key: start it with AGENTRUN_SEAL_KEY" });
    if (issues.length) throw invalid(issues);
    const settings: ArchilSettings = { diskId: (given.diskId as string).trim(), region: (given.region as string).trim(), s3Url: given.s3Url as string, ...(given.image !== undefined ? { image: given.image as string } : {}) };
    for (const [name, value] of entries) {
      const row = KEYS.find((key) => key.name === name)!.row;
      if (value === null) await removeSealedKey(store, row);
      else await putSealedKey(store, sealKey!, row, value as string);
    }
    await saveArchilSettings(store, settings);
    return view();
  }

  async function off(): Promise<ArchilView> {
    await clearArchilSettings(store);
    return view();
  }

  /** One listing of the disk's root, with its key opened as a claim opens it; the exec image is left out, as nothing runs. */
  async function test(signal?: AbortSignal): Promise<ArchilTest> {
    const settings = await loadArchilSettings(store);
    if (settings === undefined) return { ok: false, why: OFF };
    let disk: ArchilDisk;
    let secrets: ReadonlySet<string> = new Set();
    const done = new AbortController();
    try {
      const claim = await archilClaim({ settings: { diskId: settings.diskId, region: settings.region, s3Url: settings.s3Url }, keys: store.sealedKeys, sealKey, signal: done.signal, ...(options.makeDisk ? { makeDisk: options.makeDisk } : {}) });
      disk = claim.disk;
      secrets = new Set(claim.secrets);
    } catch (error) {
      if (error instanceof ArchilClaimRefused) return { ok: false, why: error.message };
      throw error;
    }
    const scrub = (text: string): string => [...secrets].reduce((out, value) => (value ? out.split(value).join("[the key]") : out), text);
    try {
      if (signal?.aborted) return { ok: false, why: "The test of Archil was cancelled." };
      await disk.listPage("", { recursive: false });
      return { ok: true, detail: `the disk ${settings.diskId} answered its root listing` };
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) return { ok: false, why: `Archil refused the key: check ARCHIL_API_KEY in the server's Archil settings, then test again. (Archil said: ${scrub(describe(error))})` };
      if (status === 404) return { ok: false, why: `Archil has no disk ${settings.diskId} in ${settings.region}: check the disk and region, then test again.` };
      return { ok: false, why: `Archil could not be reached: check the S3 URL and the network, then test again. (${scrub(describe(error))})` };
    } finally {
      done.abort();
    }
  }

  return { view, save, off, test };
}

export type ArchilRoutes = ReturnType<typeof createArchilRoutes>;

/** One of the owner's Archil routes at its handler: its answer (sent 200), or an ApiError (sent with its status). */
export async function archilRoute(routes: ArchilRoutes, name: string, request: { readonly body?: unknown; readonly signal?: AbortSignal }): Promise<unknown> {
  if (name === "getWorkspaceArchil") return routes.view();
  if (name === "putWorkspaceArchil") return routes.save(request.body);
  if (name === "deleteWorkspaceArchil") return routes.off();
  if (name === "testWorkspaceArchil") return routes.test(request.signal);
  throw new ApiError("not_found", `no Archil route ${name}`);
}
