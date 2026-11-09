// A run's cut over the store: the ONE set of values everything served of a run is cut of (its view's words, its title,
// its Timeline's rows, its error), or `unreadable` when what the run was handed of its agent's browser sign-in can't be read back
// here, so nothing it said may be shown. The set is every secret this server never shows (serverSecrets: its own keys,
// the tool and model keys it keeps, trigger and source secrets) and every sign-in pointer the run was handed, live or
// forgotten, read back by the hashes its row keeps (handed-values.ts). Read anew at each call: a key rotated or a seal key restored is
// honoured at once.
import { handedValuesOf } from "./handed-values.js";
import { keyRefusal, runKeyOf } from "./key-refusal.js";
import { MIN_SECRET } from "./learn/secrets.js";
import { type RunLaunch, readLaunchBody } from "./run-launch.js";
import { type SignInReader, shownOf } from "./run-view.js";
import type { RunRow, Store } from "./store/store.js";

/** Run `runId`'s cut set: the values everything served of it is cut of (its view's words, its title, its Timeline's
 *  rows, its error), or `unreadable` when what it was handed can't be read back here (handed-values.ts handedValuesOf),
 *  so it is withheld. `known`: its row and launch, when the caller has read them. */
export async function runCutValues(deps: { serverSecrets: () => string[]; signIns?: SignInReader }, store: Pick<Store, "runs">, runId: string, known?: { readonly runRow: RunRow; readonly launch: RunLaunch | undefined }): Promise<{ values: string[] } | "unreadable"> {
  const handed = await handedValuesOf(deps, store, runId, known);
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
