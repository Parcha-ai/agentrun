// The Archil claim step: once per claim in Mode 2, before the run's loop starts, the claim's Archil disk is made from the
// server's Archil settings (archil-settings.ts, the store's one settings row) and its account key comes from the store's
// sealed_keys row under archil-settings.ts's name, opened with the runner's seal key. A saved exec image must be pinned
// by digest (`<name>@sha256:<64 hex>`): any other refuses the claim before a key is read.
//
// One row: "archil.api_key", the account API key the disk's file API and serverless exec take (archil-disk.ts asks for it
// on every call, and gets it from this step's memory). No disk token is kept: a computer's mount credential is minted per
// run from the account key, by the claim (run-workspace.ts's mountToken).
//
// The value lives in this step's memory only: never in the environment, the journal, a command row or a log line. It
// goes in `secrets`, for the redaction set. release(), or the claim's signal aborting, drops it; a call after that is
// refused. A row that is missing, or that does not open under the seal key (sealed under another key, or for another
// row), refuses in words that name the row and never hold a value. Nothing here reads the environment: the settings,
// the store's sealed keys and the seal key are handed in.
import { ARCHIL_API_KEY_ROW, type ArchilSettings } from "../archil-settings.js";
import { sealedAt, unsealColumn } from "../store/seal.js";
import type { SealedKeys } from "../store/store.js";
import { type ArchilDisk, type ArchilDiskOptions, type ArchilImage, archilDisk, pinnedImage } from "./archil-disk.js";

export { ARCHIL_API_KEY_ROW, type ArchilSettings };

/** A claim this step refused, in words a person reads: no Archil call was made. */
export class ArchilClaimRefused extends Error {
  override name = "ArchilClaimRefused";
}

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
}

export interface ArchilClaim {
  /** The claim's disk: its key is this step's, asked for on every call. */
  readonly disk: ArchilDisk;
  /** The disk's region (a computer's mount names it). */
  readonly region: string;
  /** The exec image, pinned by digest; undefined for Archil's default. */
  readonly image: ArchilImage | undefined;
  /** Every value held, for the redaction set. */
  readonly secrets: ReadonlySet<string>;
  /** Drops every value held: the loop ended, or the claim is lost. */
  release(): void;
}

const RELEASED = "the run's Archil keys were released (its loop ended or its claim was lost)";

/** The Archil step of a claim: its disk made, its account key opened. */
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
  if (sealKey === undefined) {
    throw new ArchilClaimRefused(`This runner was started without the server's seal key, so it can't open the saved ${ARCHIL_API_KEY_ROW} key: start it with the key the server keeps.`);
  }
  const open = async (name: string): Promise<string> => {
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
  const apiKey = await open(ARCHIL_API_KEY_ROW);
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
  const release = (): void => {
    released = true;
    held.clear();
  };
  options.signal.addEventListener("abort", release, { once: true });
  if (options.signal.aborted) release();
  return { disk, region: settings.region, image, secrets: held, release };
}
