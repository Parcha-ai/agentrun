// The Archil account key, resolved one way for every reader: the Archil routes' test, the server's read-only view of a
// run's folder (server-run-workspace.ts) and the claim with its per-run mount credential (archil-claim.ts). The server's
// environment first: an ARCHIL_API_KEY variable, not empty, wins (source "env", the secrets plan's rule 4). Else the
// sealed "archil.api_key" row, opened with the seal key (source "console"). A key that cannot be had is refused in words
// naming what to save, never a value. The environment is passed in: process.env is never read here.
import { ARCHIL_API_KEY_ROW } from "../archil-settings.js";
import type { KeyEnv } from "../key-meta.js";
import { envValue } from "../key-meta.js";
import { sealedAt, unsealColumn } from "../store/seal.js";
import type { SealedKeys } from "../store/store.js";
import { ArchilClaimRefused } from "./archil-claim.js";

/** The environment variable that sets the account key. */
export const ARCHIL_API_KEY_ENV = "ARCHIL_API_KEY";

export interface ArchilKeyOptions {
  /** The server's environment. */
  readonly env?: KeyEnv;
  /** The store's sealed_keys rows. */
  readonly keys: Pick<SealedKeys, "get">;
  /** The server's seal key; undefined when it was started without one. */
  readonly sealKey: Buffer | undefined;
}

/** The account key and where it came from. */
export async function archilApiKey(options: ArchilKeyOptions): Promise<{ value: string; source: "env" | "console" }> {
  const fromEnv = envValue(options.env ?? {}, ARCHIL_API_KEY_ENV);
  if (fromEnv !== undefined) return { value: fromEnv.trim(), source: "env" };
  const { sealKey } = options;
  if (sealKey === undefined) {
    throw new ArchilClaimRefused(`This server was started without its seal key, so it can't open the saved ${ARCHIL_API_KEY_ROW} key: start it with the key it keeps, or set ${ARCHIL_API_KEY_ENV}.`);
  }
  const sealed = await options.keys.get(ARCHIL_API_KEY_ROW);
  if (sealed === undefined) throw new ArchilClaimRefused(`no ${ARCHIL_API_KEY_ROW} key is saved on this server: save ${ARCHIL_API_KEY_ENV} in the server's Archil settings (PUT /v2/workspace/archil), or set it in the server's environment.`);
  try {
    return { value: unsealColumn(sealKey, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), sealed).toString("utf8").trim(), source: "console" };
  } catch {
    throw new ArchilClaimRefused(`the saved ${ARCHIL_API_KEY_ROW} key does not open under this server's seal key (it was saved under another key, or for another row): save it again.`);
  }
}
