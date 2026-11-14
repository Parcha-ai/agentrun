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

/** How many times `underCut` builds again against a cut that grew while it built, before it gives up and withholds. */
const CUT_TRIES = 5;

/** `build` against run `runId`'s cut, and the cut read again once it is built: `build` is made again, under the cut as it then
 *  stood, until the cut it ran under is the cut after it. The cut only grows (a value saved stays held), so a cut that is the
 *  same after a build holds every value saved before that build's reads, and what `build` rendered under it is cut of all
 *  of them. A cut that keeps growing past CUT_TRIES builds fails closed: `build` is made under `unreadable`, the run withheld. */
export async function underCut<T>(read: () => Promise<Awaited<ReturnType<typeof runCutValues>>>, build: (cut: Awaited<ReturnType<typeof runCutValues>>) => Promise<T>): Promise<T> {
  const same = (a: Awaited<ReturnType<typeof runCutValues>>, b: Awaited<ReturnType<typeof runCutValues>>) =>
    a === "unreadable" || b === "unreadable" ? a === b : new Set(a.values).size === new Set([...a.values, ...b.values]).size && new Set(b.values).size === new Set(a.values).size;
  let cut = await read();
  for (let tries = 1; ; tries++) {
    const built = await build(cut);
    const now = await read();
    if (same(cut, now)) return built;
    if (tries >= CUT_TRIES) return build("unreadable");
    cut = now;
  }
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
