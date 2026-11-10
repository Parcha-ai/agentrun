// The owner's Archil routes: what turns Mode 2 on and off, and each agent's disk. Mode 2 is the Archil settings row
// present (archil-settings.ts): the account key's region, its S3 URL and an optional exec image. There is no server-wide
// disk: each agent has its own, made on its first run that needs one (workspace/run-disk.ts), and a run's launch may
// name another. The one kept credential is the account key, sealed under the claim's row name ("archil.api_key"). No
// disk token is kept: a computer's mount credential is minted per run from the account key.
//   GET    /v2/workspace/archil       on or off, the settings, and the account key as the shared secret shape: set or not,
//                                     where from, when changed (never a value)
//   PUT    /v2/workspace/archil       the settings row replaced, and the account key sealed when given (null removes it);
//                                     the exec image, when given, pinned by digest
//   DELETE /v2/workspace/archil       off (the settings row removed; the key is kept, for turning it on again)
//   POST   /v2/workspace/archil/test  one listing of the account's disks at the region's control plane, with the
//                                     account key opened as a claim opens it: { ok, detail } or { ok: false, why }
//   GET    /v2/agents/{id}/archil     the agent's disk: its id, or none yet
//   DELETE /v2/agents/{id}/archil     an archived agent with no live run: its disk removed at Archil and forgotten; a disk
//                                     a launch named is a customer's and never touched here
// And a launch's archil_disk is read here once before its run is made (checkLaunchDisk).
// archilRoute holds the routes' rules, so serve's dispatch only calls it and sends the answer, or the ApiError's status.
import { agentDiskOf, ARCHIL_API_KEY_ROW, type ArchilSettings, clearArchilSettings, forgetAgentDisk, loadArchilSettings, saveArchilSettings } from "./archil-settings.js";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { type KeyEnv, type KeyMeta, keyMetaOf } from "./key-meta.js";
import { registerNotSecretWrite, registerSecretWrite, secretName } from "./secret-writes.js";
import { putSealedKey, removeSealedKey } from "./server-keys.js";
import type { Store } from "./store/index.js";
import { unknownFields } from "./validate.js";
import { ArchilClaimRefused } from "./workspace/archil-claim.js";
import { pinnedImage } from "./workspace/archil-disk.js";
import { deleteDisk, listOneDisk } from "./workspace/archil-disks.js";
import { ARCHIL_API_KEY_ENV, archilApiKey } from "./workspace/archil-key.js";
import { launchDiskProblem } from "./workspace/run-disk.js";

/** The routes, by their operation names. */
export const ARCHIL_ROUTES: ReadonlySet<string> = new Set(["getWorkspaceArchil", "putWorkspaceArchil", "deleteWorkspaceArchil", "testWorkspaceArchil", "getAgentArchil", "deleteAgentArchil"]);

/** The key the owner gives, by the name the API takes, and the sealed-key row it is kept in. */
const KEYS: readonly { readonly name: string; readonly row: string }[] = [{ name: ARCHIL_API_KEY_ENV, row: ARCHIL_API_KEY_ROW }];
/** The key names the Archil settings take, as the document names them. */
export const ARCHIL_KEY_NAMES: readonly string[] = KEYS.map((key) => key.name);

// Every PUT of the Archil settings is a secret write (secret-writes.ts), whatever its body: the account key, and the
// region and S3 URL too, which say where every run's files go, so a token never re-points them. The server's one dispatch
// check keeps it to the owner's session. Turning Archil off keeps the key, so it is not registered.
registerSecretWrite("putWorkspaceArchil", () => true);
registerNotSecretWrite("deleteWorkspaceArchil", "Turning Archil off keeps its key: no secret is dropped or replaced.");
registerNotSecretWrite("testWorkspaceArchil", "A connection test reads the saved key and writes none.");

/** The account key as its one SecretMeta: named "workspace:archil", set by ARCHIL_API_KEY or its sealed row. */
const SECRET = { secret: secretName("workspace", "archil"), env: ARCHIL_API_KEY_ENV, row: ARCHIL_API_KEY_ROW };

/** The Archil settings as the owner reads them: the account key as `secret`, its SecretMeta, never a value. */
export type ArchilView = { on: boolean; region?: string; s3Url?: string; image?: string; secret: KeyMeta };
export type ArchilTest = { ok: true; detail: string } | { ok: false; why: string };
/** An agent's disk as GET /v2/agents/{id}/archil answers it: the one agentrun made for it (agentrun-<server id>-<agent
 *  id>), or none until its first run that uses it. */
export type AgentArchilView = { on: boolean; archil_disk: { disk_id: string } | null };

export interface ArchilRoutesOptions {
  /** The server's one store: its settings and sealed keys. */
  readonly store: Pick<Store, "settings" | "sealedKeys">;
  /** The server's seal key: there is always one (seal-key.ts bootSealKey, at the start). */
  readonly sealKey: Buffer;
  /** Another control plane than the region's, and its fetch: a test's fake. */
  readonly control?: { readonly baseUrl?: string; readonly fetch?: typeof fetch };
  /** The server's environment: an ARCHIL_API_KEY variable overrides the saved key (source "env"). */
  readonly env?: KeyEnv;
}

const OFF = "Archil is off on this server: save its region, S3 URL and account key (PUT /v2/workspace/archil)";
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const describe = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

export function createArchilRoutes(options: ArchilRoutesOptions) {
  const { store, sealKey, env = {} } = options;
  const control = (settings: ArchilSettings, key: string) => ({ region: settings.region, key: () => key, ...(options.control?.baseUrl ? { baseUrl: options.control.baseUrl } : {}), ...(options.control?.fetch ? { fetch: options.control.fetch } : {}) });

  async function view(): Promise<ArchilView> {
    const settings = await loadArchilSettings(store);
    const shown = settings === undefined ? {} : { region: settings.region, s3Url: settings.s3Url, ...(settings.image !== undefined ? { image: settings.image } : {}) };
    return { on: settings !== undefined, ...shown, secret: (await keyMetaOf(store, [SECRET], env))[0]! };
  }

  /** The settings row replaced and the keys given sealed, once every field is right; nothing is saved when one is not. */
  async function save(body: unknown): Promise<ArchilView> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("input_invalid", "the body is a JSON object: { region, s3Url, image?, keys? }");
    const given = body as Record<string, unknown>;
    const issues: InputIssue[] = unknownFields(given, ["region", "s3Url", "image", "keys"]).map((issue) =>
      issue.field === "diskId" ? { ...issue, message: "There is no server-wide disk: each agent has its own, made on its first run, and a run may name another (archil_disk on its start)." } : issue);
    if (!nonEmpty(given.region)) issues.push({ field: "region", reason: "required", message: "region is the account key's Archil region, a non-empty string" });
    if (!nonEmpty(given.s3Url) || !URL.canParse(given.s3Url) || new URL(given.s3Url).protocol !== "https:") issues.push({ field: "s3Url", reason: "invalid", message: "s3Url is the region's S3 endpoint, an https URL" });
    if (given.image !== undefined) {
      try {
        pinnedImage({ baseImage: given.image });
      } catch {
        issues.push({ field: "image", reason: "invalid", message: "image is pinned by digest: <name>@sha256:<64 hex>" });
      }
    }
    const keys = given.keys ?? {};
    if (typeof keys !== "object" || keys === null || Array.isArray(keys)) issues.push({ field: "keys", reason: "wrong_type", message: "keys is an object of ARCHIL_API_KEY" });
    const entries = typeof keys === "object" && keys !== null ? Object.entries(keys as Record<string, unknown>) : [];
    for (const [name, value] of entries) {
      if (!KEYS.some((key) => key.name === name)) issues.push({ field: `keys.${name}`, reason: "not_allowed", message: `Archil takes ARCHIL_API_KEY alone, not ${name}: no disk token is kept, a computer's mount credential is minted per run from the account key` });
      else if (value !== null && !nonEmpty(value)) issues.push({ field: `keys.${name}`, reason: "wrong_type", message: `${name} is a non-empty string, or null to remove it` });
    }
    if (issues.length) throw invalid(issues);
    const settings: ArchilSettings = { region: (given.region as string).trim(), s3Url: given.s3Url as string, ...(given.image !== undefined ? { image: given.image as string } : {}) };
    for (const [name, value] of entries) {
      const row = KEYS.find((key) => key.name === name)!.row;
      if (value === null) await removeSealedKey(store, row);
      else await putSealedKey(store, sealKey, row, value as string);
    }
    await saveArchilSettings(store, settings);
    return view();
  }

  async function off(): Promise<ArchilView> {
    await clearArchilSettings(store);
    return view();
  }

  /** One listing of the account's disks at the region's control plane, with the account key by the one resolver
   *  (archil-key.ts: the environment's, else the sealed row). The key is dropped after. */
  async function test(signal?: AbortSignal): Promise<ArchilTest> {
    const settings = await loadArchilSettings(store);
    if (settings === undefined) return { ok: false, why: OFF };
    let key: string;
    try {
      key = (await archilApiKey({ env, keys: store.sealedKeys, sealKey })).value;
    } catch (error) {
      if (error instanceof ArchilClaimRefused) return { ok: false, why: error.message };
      return { ok: false, why: `This server's Archil key can't be read: ${describe(error)}` };
    }
    const scrub = (text: string): string => text.split(key).join("[the key]");
    try {
      if (signal?.aborted) return { ok: false, why: "The test of Archil was cancelled." };
      const count = await listOneDisk(control(settings, key), signal ? { signal } : {});
      return { ok: true, detail: `Archil's ${settings.region} control plane listed the account's disks (${count} so far)` };
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) return { ok: false, why: `Archil refused the key: check ARCHIL_API_KEY in the server's Archil settings, then test again. (Archil said: ${scrub(describe(error))})` };
      return { ok: false, why: `Archil could not be reached: check the region and the network, then test again. (${scrub(describe(error))})` };
    }
  }

  /** Agent `agentId`'s disk: none until its first run that uses it. */
  async function agentView(agentId: string): Promise<AgentArchilView> {
    const on = (await loadArchilSettings(store)) !== undefined;
    const disk = on ? await agentDiskOf(store, agentId) : undefined;
    return { on, archil_disk: disk ? { disk_id: disk.diskId } : null };
  }

  /** The account key, opened now, or an ApiError `code` naming what to save (never a value). */
  async function keyOr(code: "input_invalid" | "unavailable", what: string): Promise<string> {
    try {
      return (await archilApiKey({ env, keys: store.sealedKeys, sealKey })).value;
    } catch (error) {
      if (code === "input_invalid") throw invalid([{ field: "archil_disk", reason: "not_set_up_here", message: `${what}: ${describe(error)}` }]);
      throw new ApiError(code, `${what}: ${describe(error)}`);
    }
  }

  /** Agent `agentId`'s disk removed: archived, with no live run (its folders, home and learning go with the disk), deleted
   *  at Archil, then forgotten: its next run, if it is unarchived, makes a new one. A launch's disk is never stored on the
   *  agent, so it is never reached here. */
  async function removeAgentDisk(agent: { readonly id: string; readonly archived: boolean; readonly live: number }, signal?: AbortSignal): Promise<AgentArchilView & { removed: { disk_id: string } | null }> {
    const settings = await loadArchilSettings(store);
    const disk = settings === undefined ? undefined : await agentDiskOf(store, agent.id);
    if (settings === undefined || disk === undefined) return { ...(await agentView(agent.id)), removed: null };
    if (!agent.archived) throw new ApiError("precondition_failed", `the agent ${agent.id} is not archived: archive it first (POST /v2/agents/${agent.id}/archive), then remove its disk`);
    if (agent.live > 0) throw new ApiError("precondition_failed", `the agent ${agent.id} has ${agent.live} live run${agent.live === 1 ? "" : "s"} on its disk: stop ${agent.live === 1 ? "it" : "them"} first`);
    const key = await keyOr("unavailable", `the agent's disk ${disk.diskId} can't be removed`);
    try {
      await deleteDisk(control(settings, key), disk.diskId, signal ? { signal } : {});
    } catch (error) {
      throw new ApiError("upstream_failed", `Archil did not remove the agent's disk ${disk.diskId}: ${describe(error).split(key).join("[the key]")}`);
    }
    await forgetAgentDisk(store, agent.id);
    return { ...(await agentView(agent.id)), removed: { disk_id: disk.diskId } };
  }

  /** A launch's `archil_disk`, read once at Archil before the run is made (run-disk.ts launchDiskProblem): a disk that is
   *  not there, or not in the key's region, is 422 at `archil_disk.disk_id` in words naming the region; Mode 1, or no key,
   *  is 422 at `archil_disk`; Archil not reached (or refusing the key) is 503. The claim reads it again, for a disk
   *  removed in between. */
  async function checkLaunchDisk(diskId: string, signal?: AbortSignal): Promise<void> {
    const settings = await loadArchilSettings(store);
    if (settings === undefined) throw invalid([{ field: "archil_disk", reason: "not_allowed", message: "This server keeps run folders on its own disk (Mode 1): a run names an Archil disk only in Archil mode (PUT /v2/workspace/archil).", fix: "Remove archil_disk." }]);
    const key = await keyOr("input_invalid", "This server's Archil key can't be read to check the run's disk");
    let problem: string | undefined;
    try {
      problem = await launchDiskProblem(control(settings, key), diskId, signal ? { signal } : {});
    } catch (error) {
      throw new ApiError("unavailable", `Archil could not be asked about the disk ${diskId}: ${describe(error).split(key).join("[the key]")}`);
    }
    if (problem !== undefined) throw invalid([{ field: "archil_disk.disk_id", reason: "not_an_option", message: problem }]);
  }

  return { view, save, off, test, agentView, removeAgentDisk, checkLaunchDisk };
}

export type ArchilRoutes = ReturnType<typeof createArchilRoutes>;

/** One of the owner's Archil routes at its handler: its answer (sent 200), or an ApiError (sent with its status). An
 *  agent's route takes the agent as the dispatch read it. */
export async function archilRoute(routes: ArchilRoutes, name: string, request: { readonly body?: unknown; readonly signal?: AbortSignal; readonly agent?: { readonly id: string; readonly archived: boolean; readonly live: number } }): Promise<unknown> {
  if (name === "getWorkspaceArchil") return routes.view();
  if (name === "putWorkspaceArchil") return routes.save(request.body);
  if (name === "deleteWorkspaceArchil") return routes.off();
  if (name === "testWorkspaceArchil") return routes.test(request.signal);
  if ((name === "getAgentArchil" || name === "deleteAgentArchil") && request.agent === undefined) throw new ApiError("not_found", "no agent");
  if (name === "getAgentArchil") return routes.agentView(request.agent!.id);
  if (name === "deleteAgentArchil") return routes.removeAgentDisk(request.agent!, request.signal);
  throw new ApiError("not_found", `no Archil route ${name}`);
}
