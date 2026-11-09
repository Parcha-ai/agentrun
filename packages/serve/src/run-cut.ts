// A run's cut over the store: the ONE set of values everything served of a run is cut of (its view's words, its title,
// its Timeline's rows), or `withheld` when what the run was handed of its agent's browser sign-in can't be read back
// here, so nothing it said may be shown. The set is every secret this server never shows (serverSecrets: its own keys,
// the tool and model keys it keeps, trigger and source secrets) and every sign-in pointer the run was handed, live or
// forgotten, read back by the hashes its row keeps. Read anew at each call: a key rotated or a seal key restored is
// honoured at once.
import { MIN_SECRET } from "./learn/secrets.js";
import { readLaunchBody } from "./run-launch.js";
import { handedPointers, type SignInReader } from "./run-view.js";
import type { Store } from "./store/store.js";
import { keptVendor, type Plane } from "./tool-plane.js";

const SHA256 = /^[0-9a-f]{64}$/;

/** The pointers run `runId` was handed, read back by the hashes its row keeps: `{ refs }` (none for a run handed none),
 *  or `unreadable` when what it was handed can't be read back here. Its mark, as main's handedMark read it: absent (null)
 *  is no mark; a non-empty array of SHA-256 hashes is the hashes; anything else (a legacy `true`, one hash alone, an
 *  object, an empty array, a damaged value) is a mark of an unknown hand, so unreadable: fails closed. A mark with no
 *  vendor browser kept on the run's launch beside it is unreadable too (handedPointers).
 *  TODO(tl-learning handedValuesOf): replace with the extracted helper. */
export async function handedValuesOf(deps: { signIns?: SignInReader }, store: Pick<Store, "runs">, runId: string): Promise<{ refs: string[] } | "unreadable"> {
  const run = await store.runs.get(runId);
  if (!run) return { refs: [] };
  const mark: unknown = run.signInHanded;
  if (mark === null || mark === undefined) return { refs: [] };
  if (!Array.isArray(mark) || mark.length === 0 || !mark.every((hash) => typeof hash === "string" && SHA256.test(hash))) return "unreadable";
  const launch = await store.runs.launch(runId).then((row) => readLaunchBody(row.body), () => undefined);
  const browser = launch?.plane ? keptVendor(launch.plane as Plane).browser : undefined;
  return handedPointers(deps.signIns, run.agentId, browser, [...mark]);
}

/** Run `runId`'s cut: the values its served words, title and Timeline are cut of, or `withheld`. */
export async function runCutOf(deps: { serverSecrets: () => string[]; signIns?: SignInReader }, store: Pick<Store, "runs">, runId: string): Promise<string[] | "withheld"> {
  const handed = await handedValuesOf(deps, store, runId);
  if (handed === "unreadable") return "withheld";
  return [...deps.serverSecrets(), ...handed.refs.filter((ref) => ref.length >= MIN_SECRET)];
}
