// The account's disks at Archil's control plane: what makes each agent's own disk, reads a disk a launch names, and
// removes an agent's own disk. With the account API key as `Authorization: Bearer <key>`, on the region's control plane
// (archil-mount-credential.ts controlOf), as Archil's API (`@archildata/api-types` 0.0.81) has them:
// - create: POST   {control}/api/disks {"name"}: Archil-managed storage (no mounts), in the control plane's region. 201
//           made it; 200 when a disk of that name is there already with this configuration (idempotent); 409 when one
//           of that name is there with another, which is found by listing that name; 403 `disk_limit_reached` when the
//           plan's per-region disk limit is reached (`organization_plan_required`: a free organization makes none). A
//           made disk comes with a default token user, which is removed at once: no standing token is kept anywhere.
// - read:   GET    {control}/api/disks/{id}: its name, region and status; 404 when the account has none of that id.
// - list:   GET    {control}/api/disks?name=<name>: the disks of that exact name.
// - remove: DELETE {control}/api/disks/{id}: the disk and everything on it. Idempotent: a 404 is already gone.
// Neither the key nor a token is ever in an error: an error carries the status and Archil's own words, scrubbed.
import { type ArchilControlOptions, controlOf, errorOf, scrub } from "./archil-mount-credential.js";

/** A call to Archil's disks refused or not answered, in words with no secret in them. */
export class ArchilDiskError extends Error {
  override name = "ArchilDiskError";
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The plan's disk limit reached: `limit` when Archil's words say how many disks it allows. */
export class ArchilDiskLimit extends ArchilDiskError {
  override name = "ArchilDiskLimit";
  readonly limit: number | undefined;
  constructor(message: string, limit: number | undefined) {
    super(message, 403, "disk_limit_reached");
    this.limit = limit;
  }
}

/** A disk as Archil reads it back. */
export interface ArchilDiskInfo {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly status: string;
}

type Context = { readonly signal?: AbortSignal };

/** One call to the control plane: its answer, or an ArchilDiskError naming `what` when it could not be reached. */
async function call(options: ArchilControlOptions, method: string, path: string, what: string, context: Context, body?: unknown): Promise<{ response: Response; key: string }> {
  const key = await options.key();
  try {
    const response = await (options.fetch ?? fetch)(`${controlOf(options)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { response, key };
  } catch (error) {
    throw new ArchilDiskError(`Archil's control plane could not be reached to ${what}: ${scrub(error instanceof Error ? error.message : String(error), [key])}`);
  }
}

/** A refusal as an ArchilDiskError, Archil's words and code in it. */
async function refused(response: Response, key: string, what: string): Promise<ArchilDiskError> {
  const { words, code } = await errorOf(response, [key]);
  return new ArchilDiskError(`Archil refused to ${what} (${response.status}): ${words}`, response.status, code);
}

const infoOf = (value: unknown): ArchilDiskInfo | undefined => {
  const disk = value as { id?: unknown; name?: unknown; region?: unknown; status?: unknown } | null | undefined;
  return typeof disk?.id === "string" ? { id: disk.id, name: typeof disk.name === "string" ? disk.name : "", region: typeof disk.region === "string" ? disk.region : "", status: typeof disk.status === "string" ? disk.status : "" } : undefined;
};

/** Disk `id` as Archil reads it, or undefined when the account has none of that id (404). */
export async function getDisk(options: ArchilControlOptions, id: string, context: Context = {}): Promise<ArchilDiskInfo | undefined> {
  const { response, key } = await call(options, "GET", `/api/disks/${encodeURIComponent(id)}`, `read the disk ${id}`, context);
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.ok) throw await refused(response, key, `read the disk ${id}`);
  const disk = infoOf(((await response.json().catch(() => undefined)) as { data?: unknown } | undefined)?.data);
  if (disk === undefined) throw new ArchilDiskError(`Archil answered the read of the disk ${id} with no disk`);
  return disk;
}

/** The account's disk named `name`, or undefined when there is none. */
export async function diskNamed(options: ArchilControlOptions, name: string, context: Context = {}): Promise<ArchilDiskInfo | undefined> {
  const { response, key } = await call(options, "GET", `/api/disks?name=${encodeURIComponent(name)}`, `find the disk ${name}`, context);
  if (!response.ok) throw await refused(response, key, `find the disk ${name}`);
  const data = ((await response.json().catch(() => undefined)) as { data?: unknown } | undefined)?.data;
  return (Array.isArray(data) ? data : []).map(infoOf).find((disk) => disk?.name === name);
}

/** How many disks a plan allows, when Archil's words for its refusal say. */
export function limitOf(words: string): number | undefined {
  const match = /\b(?:limit(?:\s+of)?|allows?|maximum(?:\s+of)?|max(?:imum)?)\s+(\d+)\b/i.exec(words) ?? /\b(\d+)\s+disks?\b/i.exec(words);
  return match ? Number(match[1]) : undefined;
}

/** Makes the disk `name` (Archil-managed storage, the control plane's region), or finds it when it is there already: its
 *  id, and whether this call made it. A disk this call made has its default token user removed before it is answered. The
 *  plan's limit is an ArchilDiskLimit. */
export async function ensureDisk(options: ArchilControlOptions, name: string, context: Context = {}): Promise<{ readonly id: string; readonly made: boolean }> {
  const { response, key } = await call(options, "POST", "/api/disks", `make the disk ${name}`, context, { name });
  if (response.status === 409) {
    await response.body?.cancel().catch(() => undefined);
    const there = await diskNamed(options, name, context);
    if (there === undefined) throw new ArchilDiskError(`Archil said a disk named ${name} is there with another configuration, and no disk of that name is listed`, 409);
    return { id: there.id, made: false };
  }
  if (response.status === 403) {
    const { words, code } = await errorOf(response, [key]);
    if (code === "disk_limit_reached") throw new ArchilDiskLimit(`Archil refused to make the disk ${name}: ${words}`, limitOf(words));
    throw new ArchilDiskError(`Archil refused to make the disk ${name} (403): ${words}`, 403, code);
  }
  if (!response.ok) throw await refused(response, key, `make the disk ${name}`);
  const data = ((await response.json().catch(() => undefined)) as { data?: { diskId?: unknown; authorizedUsers?: unknown } } | undefined)?.data;
  if (typeof data?.diskId !== "string" || data.diskId === "") throw new ArchilDiskError(`Archil answered the making of the disk ${name} with no disk id`);
  const made = response.status === 201;
  if (made) {
    // The default token user Archil makes with a disk: no one holds it, and none is kept standing.
    const users = Array.isArray(data.authorizedUsers) ? (data.authorizedUsers as { type?: unknown; identifier?: unknown }[]) : [];
    for (const user of users) {
      if (user?.type !== "token" || typeof user.identifier !== "string") continue;
      const removed = await call(options, "DELETE", `/api/disks/${encodeURIComponent(data.diskId)}/users/token?identifier=${encodeURIComponent(user.identifier)}`, `remove the new disk ${name}'s default token`, context);
      if (!removed.response.ok && removed.response.status !== 404) throw await refused(removed.response, removed.key, `remove the new disk ${name}'s default token`);
      await removed.response.body?.cancel().catch(() => undefined);
    }
  }
  return { id: data.diskId, made };
}

/** Waits until disk `id` reads `available` (a disk just made reads `creating` for a while), up to `timeoutMs`. */
export async function availableDisk(options: ArchilControlOptions, id: string, { timeoutMs = 120_000, everyMs = 1_000, signal }: { timeoutMs?: number; everyMs?: number; signal?: AbortSignal } = {}): Promise<ArchilDiskInfo> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const disk = await getDisk(options, id, signal ? { signal } : {});
    if (disk === undefined) throw new ArchilDiskError(`Archil has no disk ${id} in ${options.region}`, 404);
    if (disk.status === "available") return disk;
    if (disk.status === "failed" || disk.status === "deleting" || disk.status === "deleted") throw new ArchilDiskError(`the disk ${id} is ${disk.status} at Archil`);
    if (Date.now() >= until) throw new ArchilDiskError(`the disk ${id} was still ${disk.status || "not ready"} at Archil after ${Math.round(timeoutMs / 1000)} s`);
    await new Promise((done) => setTimeout(done, everyMs));
  }
}

/** Removes disk `id` and everything on it. Idempotent: one already gone (404) is removed. */
export async function deleteDisk(options: ArchilControlOptions, id: string, context: Context = {}): Promise<void> {
  const { response, key } = await call(options, "DELETE", `/api/disks/${encodeURIComponent(id)}`, `remove the disk ${id}`, context);
  if (response.ok || response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  throw await refused(response, key, `remove the disk ${id}`);
}

/** One page of the account's disks, at most one: what the Archil settings' test reads to know the key works. */
export async function listOneDisk(options: ArchilControlOptions, context: Context = {}): Promise<number> {
  const { response, key } = await call(options, "GET", "/api/disks?short=true&limit=1", "list the account's disks", context);
  if (!response.ok) throw await refused(response, key, "list the account's disks");
  const body = (await response.json().catch(() => undefined)) as { data?: unknown; total?: unknown } | undefined;
  return typeof body?.total === "number" ? body.total : Array.isArray(body?.data) ? body.data.length : 0;
}
