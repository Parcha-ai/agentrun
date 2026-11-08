// The Archil claim step: once per claim in Mode 2, before the run's loop starts, the claim's Archil disk is made from the
// server's Archil settings and its keys come from the store's sealed_keys rows, opened with the runner's seal key.
//
// Two rows. "archil.api_key" is the account API key the disk's file API and serverless exec take (archil-disk.ts asks for
// it on every call, and gets it from this step's memory). "archil.disk_token" is the disk token a computer's mount takes
// (ArchilWorkspace.mountSpec); it is opened only when a mount first asks, so a run with no computer never needs it.
//
// The values live in this step's memory only: never in the environment, the journal, a command row or a log line. Both
// go in `secrets`, for the redaction set. release(), or the claim's signal aborting, drops them; a call after that is
// refused. A row that is missing, or that does not open under the seal key (sealed under another key, or for another
// row), refuses in words that name the row and never hold a value. Nothing here reads the environment: the settings,
// the rows and the seal key are handed in.
import { sealedAt, unsealColumn } from "../store/seal.js";
import { type ArchilDisk, type ArchilDiskOptions, type ArchilImage, archilDisk } from "./archil-disk.js";

/** The sealed_keys row of the account API key (the disk's file API and exec). */
export const ARCHIL_API_KEY_ROW = "archil.api_key";
/** The sealed_keys row of the disk token (a computer's mount). */
export const ARCHIL_DISK_TOKEN_ROW = "archil.disk_token";

/** The server's Archil settings, none of them secret: the disk, its region, its S3 endpoint and the exec image. */
export type ArchilSettings = {
  readonly disk: string;
  readonly region: string;
  readonly s3BaseUrl: string;
  readonly image?: ArchilImage;
};

/** A claim this step refused, in words a person reads: no Archil call was made. */
export class ArchilClaimRefused extends Error {
  override name = "ArchilClaimRefused";
}

export interface ArchilClaimOptions {
  /** The server's Archil settings; undefined when they are not set up. */
  readonly settings: ArchilSettings | undefined;
  /** A sealed_keys row's sealed bytes, or undefined when none is saved. */
  readonly sealedKey: (name: string) => Promise<Uint8Array | undefined>;
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
  readonly settings: ArchilSettings;
  /** The disk token, opened the first time a mount asks. */
  token(): Promise<string>;
  /** Every value held, for the redaction set. */
  readonly secrets: ReadonlySet<string>;
  /** Drops every value held: the loop ended, or the claim is lost. */
  release(): void;
}

const RELEASED = "the run's Archil keys were released (its loop ended or its claim was lost)";

/** The Archil step of a claim: its disk made, its API key opened; the disk token opened when a mount asks. */
export async function archilClaim(options: ArchilClaimOptions): Promise<ArchilClaim> {
  const { settings, sealKey } = options;
  if (settings === undefined) {
    throw new ArchilClaimRefused("This server's Archil disk is not set up (its disk, region and S3 endpoint): Mode 2 keeps a run's folder on it, so the run can't start.");
  }
  if (sealKey === undefined) {
    throw new ArchilClaimRefused(`This runner was started without the server's seal key, so it can't open the saved ${ARCHIL_API_KEY_ROW} key: start it with the key the server keeps.`);
  }
  const open = async (name: string): Promise<string> => {
    const sealed = await options.sealedKey(name);
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
      disk: settings.disk,
      region: settings.region,
      s3BaseUrl: settings.s3BaseUrl,
      key: () => {
        if (released) throw new Error(RELEASED);
        return apiKey;
      },
    });
  } catch (error) {
    held.clear();
    throw new ArchilClaimRefused(`This server's Archil settings can't make its disk: ${(error as Error).message}`, { cause: error });
  }
  let token: Promise<string> | undefined;
  const release = (): void => {
    released = true;
    held.clear();
    token = undefined;
  };
  options.signal.addEventListener("abort", release, { once: true });
  if (options.signal.aborted) release();
  return {
    disk,
    settings,
    secrets: held,
    token: async () => {
      if (released) throw new Error(RELEASED);
      token ??= open(ARCHIL_DISK_TOKEN_ROW).then((value) => {
        if (released) throw new Error(RELEASED);
        held.add(value);
        return value;
      });
      // A refused open is not kept: the next mount asks again.
      token.catch(() => { token = undefined; });
      return token;
    },
    release,
  };
}
