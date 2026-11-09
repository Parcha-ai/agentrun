// The Archil claim step: once per claim in Mode 2, before the run's loop starts, the claim's Archil disk is made from the
// server's Archil settings (archil-settings.ts, the store's one settings row) and its keys come from the store's
// sealed_keys rows under archil-settings.ts's names, opened with the runner's seal key. A saved exec image must be pinned
// by digest (`<name>@sha256:<64 hex>`): any other refuses the claim before a key is read.
//
// One row: "archil.api_key", the account API key the disk's file API and serverless exec take (archil-disk.ts asks for
// it on every call, and gets it from this step's memory). The disk token a computer's mount takes
// (ArchilWorkspace.mountSpec) is no saved row: it is minted per run, at Archil's control plane with that key, the first
// time a mount asks (archil-mount-credential.ts), so a run with no computer never has one; revoke() removes it at the
// computer's release and the run's end, and its ttl (the run's lifetime bound) ends it if no remove ever comes.
//
// The values live in this step's memory only: never in the environment, the journal, a command row or a log line. Both
// go in `secrets`, for the redaction set. release(), or the claim's signal aborting, drops them; a call after that is
// refused. A row that is missing, or that does not open under the seal key (sealed under another key, or for another
// row), refuses in words that name the row and never hold a value. Nothing here reads the environment: the settings,
// the store's sealed keys and the seal key are handed in.
import { ARCHIL_API_KEY_ROW, type ArchilSettings } from "../archil-settings.js";
import { envValue, type KeyEnv } from "../key-meta.js";

/** The environment variable that names the Archil account key (archil-routes.ts's key name). */
const ARCHIL_API_KEY_NAME = "ARCHIL_API_KEY";
import { sealedAt, unsealColumn } from "../store/seal.js";
import type { SealedKeys } from "../store/store.js";
import { type ArchilDisk, type ArchilDiskOptions, type ArchilImage, archilDisk, pinnedImage } from "./archil-disk.js";
import { type ArchilMountCredentialOptions, type MountCredential, mintMountToken, nicknameOf, removeMountToken, removeOlderMountTokens } from "./archil-mount-credential.js";

export { ARCHIL_API_KEY_ROW, type ArchilSettings };

/** A claim this step refused, in words a person reads: no Archil call was made. */
export class ArchilClaimRefused extends Error {
  override name = "ArchilClaimRefused";
}

/** The credential's safety net, not its lifetime: it's removed at the computer's release, the run's end, a lost claim and a
 *  reclaim; the ttl only ends one whose removal never ran (a crashed server), and by then its only holder, the computer, is
 *  gone. Seven days: longer than any run keeps one computer mounted. */
export const MOUNT_TTL_MS = 7 * 24 * 60 * 60_000;

export interface ArchilClaimOptions {
  /** The server's Archil settings (loadArchilSettings); undefined when they are not set up. */
  readonly settings: ArchilSettings | undefined;
  /** The store's sealed_keys rows (store.sealedKeys): a row's sealed bytes, or undefined when none is saved. */
  readonly keys: Pick<SealedKeys, "get">;
  /** The runner's seal key (the server's): undefined when it was started without one. */
  readonly sealKey: Buffer | undefined;
  /** The claim's signal: aborted when the claim is lost or the runner stops. */
  readonly signal: AbortSignal;
  /** Makes the disk (default archilDisk): a test's capture. */
  readonly makeDisk?: (options: ArchilDiskOptions) => ArchilDisk;
  /** The run's mount credential, minted when a mount first asks: the run and this claim's epoch (its token user's
   *  nickname, agentrun:<run>:<epoch>, so a reclaim removes an earlier claim's first) and its ttl (the run's lifetime
   *  bound, the safety net if the remove never comes); a loopback control plane and its fetch in a test. Absent: a mount
   *  is refused in words. */
  readonly mount?: { readonly runId: string; readonly epoch: number; readonly ttlMs: number; readonly baseUrl?: string; readonly fetch?: typeof fetch };
  /** The server's environment, passed in (never read here): an ARCHIL_API_KEY variable overrides the saved key. */
  readonly env?: KeyEnv;
}

export interface ArchilClaim {
  /** The claim's disk: its key is this step's, asked for on every call. */
  readonly disk: ArchilDisk;
  /** The disk's region (a computer's mount names it). */
  readonly region: string;
  /** The exec image, pinned by digest; undefined for Archil's default. */
  readonly image: ArchilImage | undefined;
  /** The run's mount credential's token, minted the first time a mount asks (once per claim), held in memory only. */
  token(): Promise<string>;
  /** Removes the run's mount credential at Archil by its identifier (the computer's release, the run's end). Idempotent:
   *  none minted, or removed already, is nothing to do. */
  revoke(): Promise<void>;
  /** Every value held, for the redaction set. */
  readonly secrets: ReadonlySet<string>;
  /** Drops every value held: the loop ended, or the claim is lost. */
  release(): void;
}

const RELEASED = "the run's Archil keys were released (its loop ended or its claim was lost)";

/** The Archil step of a claim: its disk made, its API key opened; the run's mount credential minted when a mount asks. */
export async function archilClaim(options: ArchilClaimOptions): Promise<ArchilClaim> {
  const { settings, sealKey } = options;
  if (settings === undefined) {
    throw new ArchilClaimRefused("This server's Archil disk is not set up (its disk, region and S3 endpoint): Mode 2 keeps a run's folder on it, so the run can't start.");
  }
  let image: ArchilImage | undefined;
  try {
    image = settings.image === undefined ? undefined : pinnedImage({ baseImage: settings.image });
  } catch (error) {
    throw new ArchilClaimRefused(`This server's Archil exec image ${JSON.stringify(settings.image)} can't be used: ${(error as Error).message}`, { cause: error });
  }
  // The server's environment wins (key-meta.ts): an ARCHIL_API_KEY variable is the account key, over a saved one, for
  // the disk and for the run's mount credential alike.
  const fromEnv = options.env === undefined ? undefined : envValue(options.env, ARCHIL_API_KEY_NAME);
  if (fromEnv === undefined && sealKey === undefined) {
    throw new ArchilClaimRefused(`This runner was started without the server's seal key, so it can't open the saved ${ARCHIL_API_KEY_ROW} key: start it with the key the server keeps.`);
  }
  const open = async (name: string): Promise<string> => {
    if (sealKey === undefined) throw new ArchilClaimRefused(`This runner was started without the server's seal key, so it can't open the saved ${name} key: start it with the key the server keeps.`);
    const sealed = await options.keys.get(name);
    if (sealed === undefined) throw new ArchilClaimRefused(`no ${name} key is saved on this server: save it in the server's keys, then run again.`);
    try {
      return unsealColumn(sealKey, sealedAt.sealedKey(name), sealed).toString("utf8").trim();
    } catch {
      throw new ArchilClaimRefused(`the saved ${name} key does not open under this server's seal key (it was saved under another key, or for another row): save it again.`);
    }
  };
  const held = new Set<string>();
  let released = false;
  const apiKey = fromEnv ?? (await open(ARCHIL_API_KEY_ROW));
  held.add(apiKey);
  let disk: ArchilDisk;
  try {
    disk = (options.makeDisk ?? archilDisk)({
      disk: settings.diskId,
      region: settings.region,
      s3BaseUrl: settings.s3Url,
      key: () => {
        if (released) throw new Error(RELEASED);
        return apiKey;
      },
    });
  } catch (error) {
    held.clear();
    throw new ArchilClaimRefused(`This server's Archil settings can't make its disk: ${(error as Error).message}`, { cause: error });
  }
  const credentialOptions: ArchilMountCredentialOptions = {
    disk: settings.diskId,
    region: settings.region,
    key: () => apiKey,
    ...(options.mount?.baseUrl ? { baseUrl: options.mount.baseUrl } : {}),
    ...(options.mount?.fetch ? { fetch: options.mount.fetch } : {}),
  };
  let minted: Promise<MountCredential> | undefined;
  /** The identifier and token of the credential minted, until it is removed. */
  let live: MountCredential | undefined;
  const release = (): void => {
    released = true;
    held.clear();
  };
  /** Removes the credential minted, by its identifier: idempotent. Then the run's earlier epochs once more: Archil's list,
   *  read right after another caller's mint, may not hold that user yet (mint-4), so the reclaim before this claim's mint
   *  can miss an earlier claim's; by the run's end the list holds it. Best effort: one still missed ends at its ttl. */
  const revoke = async (): Promise<void> => {
    const credential = live ?? (await minted?.catch(() => undefined));
    if (credential === undefined) return;
    await removeMountToken(credentialOptions, credential.identifier, { token: credential.token });
    if (live === credential) live = undefined;
    minted = undefined;
    held.delete(credential.token);
    const mount = options.mount;
    // No signal: a lost claim's is aborted already, and this remove is what its loss asks for.
    if (mount !== undefined) await removeOlderMountTokens(credentialOptions, mount.runId, mount.epoch).catch(() => undefined);
  };
  // A lost claim (or a stopped runner): the values dropped, and the credential removed at once, not left for the ttl.
  const lost = (): void => {
    release();
    void revoke().catch(() => undefined);
  };
  options.signal.addEventListener("abort", lost, { once: true });
  if (options.signal.aborted) lost();
  return {
    disk,
    region: settings.region,
    image,
    secrets: held,
    token: async () => {
      if (released) throw new Error(RELEASED);
      const mount = options.mount;
      if (mount === undefined) throw new ArchilClaimRefused("This run's Archil claim was made without a mount credential to mint (its run's label and lifetime), so no computer can mount its folder.");
      // An earlier claim's credential (its runner died before removing it) goes first; then this claim's is minted.
      minted ??= removeOlderMountTokens(credentialOptions, mount.runId, mount.epoch, { signal: options.signal })
        .then(() => mintMountToken(credentialOptions, { nickname: nicknameOf(mount.runId, mount.epoch), ttlMs: mount.ttlMs, signal: options.signal }))
        .then(
        (credential) => {
          held.add(credential.token);
          live = credential;
          return credential;
        },
        (error: unknown) => {
          throw new ArchilClaimRefused(`This run's folder can't be mounted in its computer: ${(error as Error).message}`, { cause: error });
        },
      );
      // A refused mint is not kept: the next mount asks again.
      minted.catch(() => { minted = undefined; });
      const credential = await minted;
      if (released) throw new Error(RELEASED);
      return credential.token;
    },
    revoke,
    release,
  };
}
