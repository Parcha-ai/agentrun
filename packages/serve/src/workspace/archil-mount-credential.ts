// The Archil mount credential, one per run: minted at the claim, held in memory only, and removed at the computer's
// release and the run's end. No long-lived disk token is stored anywhere. Archil's control API (the control plane its
// SDK calls for a disk, archil-disk.ts), with the account API key as `Authorization: Bearer <key>`:
// - mint:   POST   {control}/api/disks/{disk}/users            {"type":"token","nickname":<run label>,"ttl":<duration>}
//           answers (in its `data` envelope) the token and its identifier. The ttl is the safety net if a remove never
//           comes: the run's lifetime bound, as a duration ("86400s").
// - remove: DELETE {control}/api/disks/{disk}/users/token?identifier=<identifier>, idempotent: a 404 is already gone.
// - list:   GET    {control}/api/disks/{disk}, its authorized users: a reclaim removes the run's token users of an earlier
//           claim epoch (nickname "agentrun:<run>:<epoch>") before it mints, as the janitor's releaseOlder does computers.
// The control plane is the region's (the SDK's own table), or a loopback one given for a test. Neither the token nor the
// key is ever in the environment, an argument, a file, a log line or an error: an error carries the status and Archil's
// own words, scrubbed of both.

/** The control plane of each Archil region, as Archil's SDK (`disk` 1.12.0, src/regions.ts) names them. */
export const ARCHIL_CONTROL_URLS: Readonly<Record<string, string>> = Object.freeze({
  "aws-us-east-1": "https://control.green.us-east-1.aws.prod.archil.com",
  "aws-us-west-2": "https://control.green.us-west-2.aws.prod.archil.com",
  "aws-eu-west-1": "https://control.green.eu-west-1.aws.prod.archil.com",
  "gcp-us-central1": "https://control.blue.us-central1.gcp.prod.archil.com",
});

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])$/; // key-gate: loopback-rule names loopback hosts to allow plain http only to them, in tests

export interface ArchilMountCredentialOptions {
  /** The disk's id, dsk-<16 hex digits>. */
  readonly disk: string;
  /** Its region: it names the control plane. */
  readonly region: string;
  /** The account API key, asked for on each call. */
  readonly key: () => string | Promise<string>;
  /** Another control plane than the region's: a test's loopback one (plain http only there). */
  readonly baseUrl?: string;
  /** The fetch to call it with (default the global one). */
  readonly fetch?: typeof fetch;
}

/** A minted mount credential: the token a computer's mount takes, and the identifier it is removed by. */
export interface MountCredential {
  readonly token: string;
  readonly identifier: string;
}

/** Why the control plane refused, in words: its status and Archil's own message, with no secret in them. */
export class ArchilMountCredentialError extends Error {
  override name = "ArchilMountCredentialError";
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** The control plane's base URL: the region's, or the loopback one given. */
function controlOf(options: ArchilMountCredentialOptions): string {
  if (options.baseUrl !== undefined) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.test(url.hostname))) throw new ArchilMountCredentialError("the Archil control plane must be https (plain http only to this machine's loopback, in tests)");
    return url.href.replace(/\/$/, "");
  }
  const url = Object.hasOwn(ARCHIL_CONTROL_URLS, options.region) ? ARCHIL_CONTROL_URLS[options.region] : undefined;
  if (url === undefined) throw new ArchilMountCredentialError(`Archil has no control plane for region ${JSON.stringify(options.region)}: one of ${Object.keys(ARCHIL_CONTROL_URLS).join(", ")}`);
  return url;
}

/** Archil's longest ttl, 365 days, in seconds. */
const MAX_TTL_S = 8760 * 3600;

/** A ttl as Archil reads it (a Go duration): whole seconds, at least one, at most Archil's 365 days. */
export const ttlOf = (ms: number): string => `${Math.min(MAX_TTL_S, Math.max(1, Math.ceil(ms / 1000)))}s`;

/** The nickname of run `run`'s token user under claim epoch `epoch`: the run and the epoch, so a later claim finds an
 *  earlier one's (its runner died before removing it). */
export const nicknameOf = (run: string, epoch: number): string => `agentrun:${run}:${epoch}`;

/** The run and epoch a nickname names, when it is one of nicknameOf's. */
function claimOfNickname(nickname: unknown): { run: string; epoch: number } | undefined {
  if (typeof nickname !== "string") return undefined;
  const match = /^agentrun:(.+):(0|[1-9][0-9]*)$/.exec(nickname);
  return match ? { run: match[1]!, epoch: Number(match[2]) } : undefined;
}

/** `text` with each secret replaced. */
const scrub = (text: string, secrets: readonly string[]): string => secrets.filter((one) => one.length >= 4).reduce((out, one) => out.split(one).join("[redacted]"), text);

/** Archil's words for a failed call, from its error envelope ({error, code}), cut short and scrubbed. */
async function wordsOf(response: Response, secrets: readonly string[]): Promise<string> {
  const text = await response.text().catch(() => "");
  let said = text;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    said = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : text;
  } catch {
    // not JSON: its text
  }
  return scrub(said.trim().slice(0, 300), secrets);
}

/** Mints the run's mount credential on the disk: a token user named `nickname`, which Archil ends after `ttlMs`. */
export async function mintMountToken(options: ArchilMountCredentialOptions, run: { readonly nickname: string; readonly ttlMs: number; readonly signal?: AbortSignal }): Promise<MountCredential> {
  const key = await options.key();
  const url = `${controlOf(options)}/api/disks/${encodeURIComponent(options.disk)}/users`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "token", nickname: run.nickname, ttl: ttlOf(run.ttlMs) }),
      redirect: "error",
      ...(run.signal ? { signal: run.signal } : {}),
    });
  } catch (error) {
    throw new ArchilMountCredentialError(`Archil's control plane could not be reached to mint the run's mount credential: ${scrub(error instanceof Error ? error.message : String(error), [key])}`);
  }
  if (!response.ok) throw new ArchilMountCredentialError(`Archil refused to mint the run's mount credential (${response.status}): ${await wordsOf(response, [key])}`, response.status);
  const body = (await response.json().catch(() => undefined)) as { data?: { token?: unknown; identifier?: unknown }; token?: unknown; identifier?: unknown } | undefined;
  const user = body?.data ?? body;
  if (typeof user?.token !== "string" || user.token === "" || typeof user.identifier !== "string" || user.identifier === "") {
    throw new ArchilMountCredentialError("Archil answered the mint of the run's mount credential with no token or no identifier");
  }
  return { token: user.token, identifier: user.identifier };
}

/** The disk's token users, by nickname and identifier (GET {control}/api/disks/{disk}: its authorized users). */
export async function listTokenUsers(options: ArchilMountCredentialOptions, context: { readonly signal?: AbortSignal } = {}): Promise<{ readonly nickname?: string; readonly identifier: string }[]> {
  const key = await options.key();
  const url = `${controlOf(options)}/api/disks/${encodeURIComponent(options.disk)}`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { method: "GET", headers: { Authorization: `Bearer ${key}` }, redirect: "error", ...(context.signal ? { signal: context.signal } : {}) });
  } catch (error) {
    throw new ArchilMountCredentialError(`Archil's control plane could not be reached to list the disk's token users: ${scrub(error instanceof Error ? error.message : String(error), [key])}`);
  }
  if (!response.ok) throw new ArchilMountCredentialError(`Archil refused to list the disk's token users (${response.status}): ${await wordsOf(response, [key])}`, response.status);
  const body = (await response.json().catch(() => undefined)) as { data?: { authorizedUsers?: unknown } } | undefined;
  const users = Array.isArray(body?.data?.authorizedUsers) ? (body!.data!.authorizedUsers as { type?: unknown; nickname?: unknown; identifier?: unknown }[]) : [];
  return users
    .filter((user) => user?.type === "token" && typeof user.identifier === "string")
    .map((user) => ({ identifier: user.identifier as string, ...(typeof user.nickname === "string" ? { nickname: user.nickname } : {}) }));
}

/** Removes run `run`'s token users of a claim epoch below `epoch` (a runner that died before removing its own), the way
 *  the janitor's releaseOlder does for computers, and answers their identifiers. Others' users are left alone. */
export function removeOlderMountTokens(options: ArchilMountCredentialOptions, run: string, epoch: number, context: { readonly signal?: AbortSignal } = {}): Promise<string[]> {
  return removeRunTokens(options, run, (claimed) => claimed < epoch, context);
}

/** Removes run `run`'s token users of claim epoch `epoch` and below, by their names: at a claim's revoke, a mint whose
 *  answer was lost (Archil made the user; the claim never heard of it) is one of them, as is an earlier claim's. */
export function removeRunMountTokens(options: ArchilMountCredentialOptions, run: string, epoch: number, context: { readonly signal?: AbortSignal } = {}): Promise<string[]> {
  return removeRunTokens(options, run, (claimed) => claimed <= epoch, context);
}

async function removeRunTokens(options: ArchilMountCredentialOptions, run: string, which: (epoch: number) => boolean, context: { readonly signal?: AbortSignal }): Promise<string[]> {
  const removed: string[] = [];
  for (const user of await listTokenUsers(options, context)) {
    const claim = claimOfNickname(user.nickname);
    if (claim === undefined || claim.run !== run || !which(claim.epoch)) continue;
    await removeMountToken(options, user.identifier, context);
    removed.push(user.identifier);
  }
  return removed;
}

/** Removes the run's mount credential by its identifier. Idempotent: one already gone (404) is removed. */
export async function removeMountToken(options: ArchilMountCredentialOptions, identifier: string, context: { readonly signal?: AbortSignal; readonly token?: string } = {}): Promise<void> {
  const key = await options.key();
  const secrets = [key, ...(context.token ? [context.token] : [])];
  const url = `${controlOf(options)}/api/disks/${encodeURIComponent(options.disk)}/users/token?identifier=${encodeURIComponent(identifier)}`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { method: "DELETE", headers: { Authorization: `Bearer ${key}` }, redirect: "error", ...(context.signal ? { signal: context.signal } : {}) });
  } catch (error) {
    throw new ArchilMountCredentialError(`Archil's control plane could not be reached to remove the run's mount credential: ${scrub(error instanceof Error ? error.message : String(error), secrets)}`);
  }
  if (response.ok || response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  throw new ArchilMountCredentialError(`Archil refused to remove the run's mount credential (${response.status}): ${await wordsOf(response, secrets)}`, response.status);
}
