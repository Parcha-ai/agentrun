// The Archil claim step: once per claim in Mode 2, before the run's loop starts, the claim's Archil disk is made from the
// server's Archil settings (archil-settings.ts, the store's one settings row) on the run's own disk (run-disk.ts: the one
// its launch names, else its agent's, made on its first run), and its keys come from the store's
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
import type { KeyEnv } from "../key-meta.js";
import type { SealedKeys } from "../store/store.js";
import { archilApiKey } from "./archil-key.js";
import { type ArchilDisk, type ArchilDiskOptions, type ArchilImage, archilDisk, pinnedImage } from "./archil-disk.js";
import { type ArchilMountCredentialOptions, type MountCredential, mintMountToken, nicknameOf, removeMountToken, removeOlderMountTokens, removeRunMountTokens } from "./archil-mount-credential.js";
import { COMPUTER_LIFETIME_MS } from "./computer-deps.js";
import type { LaunchDisk } from "../run-launch.js";
import { type RunDisk, type RunDiskOptions, runDiskOf } from "./run-disk.js";

export { ARCHIL_API_KEY_ROW, type ArchilSettings };

/** A claim this step refused, in words a person reads: no Archil call was made. */
export class ArchilClaimRefused extends Error {
  override name = "ArchilClaimRefused";
}

/** The credential's safety net: no longer than its computer can live (COMPUTER_LIFETIME_MS). It's removed at the
 *  computer's release, the run's end, a lost claim and a reclaim; the ttl only ends one whose removal never ran (a
 *  crashed server, or a reclaim's list read that missed it), and by then its only holder, the computer, is gone too. */
export const MOUNT_TTL_MS = COMPUTER_LIFETIME_MS;

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
  /** The run whose disk the claim resolves (run-disk.ts runDiskOf): its agent, the disk its launch record names, and the
   *  store the agent's disk and the server's id are kept in. Absent (a test of the claim alone): the settings' `diskId`. */
  readonly run?: { readonly agentId: string; readonly launch?: LaunchDisk; readonly store: RunDiskOptions["store"] };
}

export interface ArchilClaim {
  /** The claim's disk: its key is this step's, asked for on every call. */
  readonly disk: ArchilDisk;
  /** Whose disk it is: the run's launch named it (a customer's), or it is the run's agent's. */
  readonly diskKind: RunDisk["kind"];
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
/** How long a revoke waits to read the users list again for a mint it never heard of: past Archil's list lag (mint-4). */
const LOST_MINT_REREAD_MS = 2_000;

/** The Archil step of a claim: its disk made, its API key opened; the run's mount credential minted when a mount asks. */
export async function archilClaim(options: ArchilClaimOptions): Promise<ArchilClaim> {
  const { settings, sealKey } = options;
  if (settings === undefined) {
    throw new ArchilClaimRefused("This server's Archil disk is not set up (its key's region and S3 endpoint): Mode 2 keeps a run's folder on an Archil disk, so the run can't start.");
  }
  let image: ArchilImage | undefined;
  try {
    image = settings.image === undefined ? undefined : pinnedImage({ baseImage: settings.image });
  } catch (error) {
    throw new ArchilClaimRefused(`This server's Archil exec image ${JSON.stringify(settings.image)} can't be used: ${(error as Error).message}`, { cause: error });
  }
  // The account key by the one resolver (archil-key.ts): the server's ARCHIL_API_KEY variable first, else the sealed
  // row, for the disk and for the run's mount credential alike.
  const held = new Set<string>();
  let released = false;
  const apiKey = (await archilApiKey({ ...(options.env ? { env: options.env } : {}), keys: options.keys, sealKey })).value;
  held.add(apiKey);
  // The run's disk first (run-disk.ts): its launch's, else its agent's, made now when it has none; every call below is on
  // it alone, the run's mount credential minted, revoked and reclaimed there.
  const control = { region: settings.region, key: () => apiKey, ...(options.mount?.baseUrl ? { baseUrl: options.mount.baseUrl } : {}), ...(options.mount?.fetch ? { fetch: options.mount.fetch } : {}) };
  let chosen: RunDisk;
  try {
    if (options.run !== undefined) chosen = await runDiskOf({ store: options.run.store, agentId: options.run.agentId, ...(options.run.launch ? { launch: options.run.launch } : {}), control, signal: options.signal });
    else if (settings.diskId !== undefined) chosen = { diskId: settings.diskId, kind: "agent" };
    else throw new ArchilClaimRefused("This claim names no run whose Archil disk it could resolve.");
  } catch (error) {
    held.clear();
    throw error;
  }
  let disk: ArchilDisk;
  try {
    disk = (options.makeDisk ?? archilDisk)({
      disk: chosen.diskId,
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
  const credentialOptions: ArchilMountCredentialOptions = { ...control, disk: chosen.diskId };
  let minted: Promise<MountCredential> | undefined;
  /** A mint was asked for since the last revoke: its user may stand at Archil though no answer said so. */
  let asked = false;
  /** The identifier and token of the credential minted, until it is removed. */
  let live: MountCredential | undefined;
  const release = (): void => {
    released = true;
    held.clear();
  };
  /** Removes the credential minted, by its identifier: idempotent. Then the run's users of this claim's epoch and earlier,
   *  by their names, once per mint asked for: a mint whose answer was lost (Archil made the user, this claim never heard
   *  of it) is found there; and Archil's list, read right after another caller's mint, may not hold that user yet
   *  (mint-4), so the reclaim before this claim's mint can miss an earlier claim's, which by the run's end the list holds.
   *  A mint never heard of always gets one more read 2 s later, past that lag. Best effort: one still missed ends at its
   *  ttl. */
  const revoke = async (): Promise<void> => {
    const credential = live ?? (await minted?.catch(() => undefined));
    if (credential !== undefined) {
      await removeMountToken(credentialOptions, credential.identifier, { token: credential.token });
      if (live === credential) live = undefined;
      minted = undefined;
      held.delete(credential.token);
    }
    const mount = options.mount;
    if (!asked || mount === undefined) return;
    asked = false;
    // No signal: a lost claim's is aborted already, and this remove is what its loss asks for.
    await removeRunMountTokens(credentialOptions, mount.runId, mount.epoch).catch(() => undefined);
    // A mint never heard of: its user may not be in the list yet, whatever this read found (another epoch's user it
    // removed is not this mint's), so the list is read once more past Archil's lag, and every match then removed too.
    if (credential === undefined) {
      await new Promise((done) => setTimeout(done, LOST_MINT_REREAD_MS));
      await removeRunMountTokens(credentialOptions, mount.runId, mount.epoch).catch(() => undefined);
    }
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
    diskKind: chosen.kind,
    region: settings.region,
    image,
    secrets: held,
    token: async () => {
      if (released) throw new Error(RELEASED);
      const mount = options.mount;
      if (mount === undefined) throw new ArchilClaimRefused("This run's Archil claim was made without a mount credential to mint (its run's label and lifetime), so no computer can mount its folder.");
      // An earlier claim's credential (its runner died before removing it) goes first; then this claim's is minted.
      asked = true;
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
