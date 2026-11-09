// A run's cut over the store: the ONE set of values everything served of a run is cut of (its view's words, its title,
// its Timeline's rows, its error), or `unreadable` when what the run was handed of its agent's browser sign-in can't be read back
// here, so nothing it said may be shown. The set is every secret this server never shows (serverSecrets: its own keys,
// the tool and model keys it keeps, trigger and source secrets) and every sign-in pointer the run was handed, live or
// forgotten, read back by the hashes its row keeps. Read anew at each call: a key rotated or a seal key restored is
// honoured at once.
import { keyRefusal, runKeyOf } from "./key-refusal.js";
import { MIN_SECRET } from "./learn/secrets.js";
import { readLaunchBody } from "./run-launch.js";
import { handedPointers, type SignInReader, shownOf } from "./run-view.js";
import type { Store } from "./store/store.js";
import { keptVendor, type Plane } from "./tool-plane.js";

const SHA256 = /^[0-9a-f]{64}$/;

/** The pointers run `runId` was handed, read back by the hashes its row keeps: `{ refs }` (none for a run handed none),
 *  or `unreadable` when what it was handed can't be read back here. Its mark, as main's handedMark read it: absent (null)
 *  is no mark; a non-empty array of SHA-256 hashes is the hashes; anything else (a legacy `true`, one hash alone, an
 *  object, an empty array, a damaged value) is a mark of an unknown hand, so unreadable: fails closed. A mark with no
 *  vendor browser kept on the run's launch beside it is unreadable too (handedPointers), and so is a run with no row.
 *  The hashes are read once each.
 *  TODO(tl-learning handedValuesOf): replace with the extracted helper. */
export async function handedValuesOf(deps: { signIns?: SignInReader }, store: Pick<Store, "runs">, runId: string): Promise<{ refs: string[] } | "unreadable"> {
  const run = await store.runs.get(runId);
  if (!run) return "unreadable";
  const mark: unknown = run.signInHanded;
  if (mark === null || mark === undefined) return { refs: [] };
  if (!Array.isArray(mark) || mark.length === 0 || !mark.every((hash) => typeof hash === "string" && SHA256.test(hash))) return "unreadable";
  const launch = await store.runs.launch(runId).then((row) => readLaunchBody(row.body), () => undefined);
  const browser = launch?.plane ? keptVendor(launch.plane as Plane).browser : undefined;
  return handedPointers(deps.signIns, run.agentId, browser, [...new Set(mark as string[])]);
}

/** Run `runId`'s cut set: the values everything served of it is cut of (its view's words, its title, its Timeline's
 *  rows, its error), or `unreadable` when what it was handed can't be read back here, so it is withheld. */
export async function runCutValues(deps: { serverSecrets: () => string[]; signIns?: SignInReader }, store: Pick<Store, "runs">, runId: string): Promise<{ values: string[] } | "unreadable"> {
  const handed = await handedValuesOf(deps, store, runId);
  if (handed === "unreadable") return "unreadable";
  return { values: [...deps.serverSecrets(), ...handed.refs.filter((ref) => ref.length >= MIN_SECRET)] };
}

/** Run `runId`'s cut as a function of a text: the one rule its served words are shown by (run-view.ts shownOf: no value
 *  of the cut set, in any spelling, and no loopback address), or `unreadable` when the run is withheld. */
export async function runCutOf(deps: { serverSecrets: () => string[]; signIns?: SignInReader }, store: Pick<Store, "runs">, runId: string): Promise<((text: string) => string) | "unreadable"> {
  const cut = await runCutValues(deps, store, runId);
  return cut === "unreadable" ? "unreadable" : shownOf(cut.values);
}

/** Run `runId`'s error words: how its error text reads wherever it is served (its view's error, its Timeline's error
 *  rows), main's errorWords: a refused key in plain words (key-refusal.ts keyRefusal, the key its harness's route sends
 *  by this server's settings and keys), else the text by the one rule (shownOf); `unreadable` when the run is withheld.
 *  A workflow's nodes run on their own tiers' models and its error doesn't say which failed, so its words are never
 *  turned to a key's (`workflow`). `keyEnv`: the environment the run's key is read from, with the keys a person saved. */
export async function runErrorWordsOf(
  deps: { serverSecrets: () => string[]; signIns?: SignInReader; keyEnv: () => NodeJS.ProcessEnv },
  store: Pick<Store, "runs">,
  runId: string,
  { workflow }: { workflow: boolean },
): Promise<((text: string) => string) | "unreadable"> {
  const cut = await runCutValues(deps, store, runId);
  if (cut === "unreadable") return "unreadable";
  const shown = shownOf(cut.values);
  if (workflow) return shown;
  const launch = await store.runs.launch(runId).then((row) => readLaunchBody(row.body), () => undefined);
  const key = runKeyOf(deps.keyEnv(), launch?.harness, launch?.model ? `${launch.model.provider}/${launch.model.modelId}` : undefined);
  return (text) => shown(keyRefusal(text, key, cut.values) ?? text);
}
