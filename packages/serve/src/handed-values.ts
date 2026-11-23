// What a run was handed of its agent's browser sign-in, read back from the one store: the run row's `sign_in_handed`
// mark (the SHA-256 of each pointer, never the pointer), the browser vendor its launch's plane kept, and the agent's
// sign-ins (live and forgotten) opened to find each pointer the mark names (run-view.ts handedPointers). One read for
// every place that must cut a run of what it was handed: the store-backed run view (store-view.ts) and the runner's
// learning end (runner/learning-end.ts), which refuses to learn it. Beside them, what the run's caller handed it at its
// launch or with a message (its MCP credentials, its own model key and tool keys: store/seal.ts RunLaunchSecrets), opened
// from the launch's sealed part while the run holds it (launchValuesOf), and once its end erased that, where in its files
// they sat (the launch's census, run-census.ts).
import { heldSpans, MIN_SECRET } from "./learn/secrets.js";
import { launchSecrets } from "./runner/store-secrets.js";
import { ServerSecrets } from "./server-secrets.js";
import { sealedAt, unsealColumn } from "./store/seal.js";
import { type Handed, handedMark, handedPointers, type SignInReader } from "./run-view.js";
import { type RunLaunch, readLaunchBody } from "./run-launch.js";
import { type RunRow, type Store, StoreLaunchMissing } from "./store/store.js";
import { keptVendor, type Plane } from "./tool-plane.js";

/** The run's launch body read back, or undefined when it has none (an old run, or one not started with one). */
export async function launchOf(store: Pick<Store, "runs">, runId: string): Promise<RunLaunch | undefined> {
  try {
    const row = await store.runs.launch(runId);
    return readLaunchBody(row.body);
  } catch {
    return undefined;
  }
}

/** The pointers a run was handed, as its row kept them (never the pointers, their SHA-256), read by the one rule a
 *  the stored mark is read by (run-view.ts handedMark): a column that is absent or null is no mark; a non-empty array
 *  of SHA-256 hashes is the mark; anything else (`true`, an object, a string, an empty array, which no writer writes, or
 *  an array holding anything but a hash) is MALFORMED, which handedPointers reads as unreadable: fails closed. */
export const handedOf = (runRow: RunRow): Handed | undefined => (runRow.signInHanded === null || runRow.signInHanded === undefined ? undefined : handedMark(runRow.signInHanded));

/** The pointers run `runId` was handed, read back (handedPointers): none for a run with no mark, else each one, or
 *  `unreadable` when what it was handed can't be known here (a mark with no vendor browser kept beside it, no sign-ins to
 *  read, a hash that matches no pointer that opens). A run whose row can't be read is `unreadable` too: fails closed.
 *  `known`, the run's row and launch when the caller has read them already. Every ref is returned; a caller that cuts
 *  text drops those shorter than MIN_SECRET, as every cut does. */
export async function handedValuesOf(deps: { readonly signIns?: SignInReader }, store: Pick<Store, "runs">, runId: string, known?: { readonly runRow: RunRow; readonly launch: RunLaunch | undefined }): Promise<{ refs: string[] } | "unreadable"> {
  const runRow = known ? known.runRow : await store.runs.get(runId).catch(() => undefined);
  if (!runRow) return "unreadable";
  const launch = known ? known.launch : await launchOf(store, runId);
  const browser = launch?.plane ? keptVendor(launch.plane as Plane).browser : undefined;
  return handedPointers(deps.signIns, runRow.agentId, browser, handedOf(runRow));
}

/** Run `runId`'s launch row as a cut reads it: its body, its sealed part (null when it holds none) and its census (null when
 *  no end erased a sealed part). A run with no launch row (one started before launch rows) holds neither; a read that fails
 *  is `unreadable`, so the run is withheld, never cut of a shorter set. */
export async function launchRowOf(store: Pick<Store, "runs">, runId: string): Promise<{ readonly body: RunLaunch | undefined; readonly sealed: Uint8Array | null; readonly census: string | null } | "unreadable"> {
  try {
    const row = await store.runs.launch(runId);
    let body: RunLaunch | undefined;
    try {
      body = readLaunchBody(row.body);
    } catch {
      body = undefined;
    }
    return { body, sealed: row.sealed, census: row.census };
  } catch (error) {
    return error instanceof StoreLaunchMissing ? { body: undefined, sealed: null, census: null } : "unreadable";
  }
}

/** What run `runId`'s launch holds sealed now (`sealed`: its caller's MCP credentials, its own model key and tool keys),
 *  opened with this server's `sealKey`: each value as the runner's own cut lists it (runner/store-secrets.ts
 *  launchSecrets), in every spelling the server's list has (ServerSecrets), each at least MIN_SECRET long. None when it
 *  holds none (none handed, or its end erased them); `unreadable` when its bytes don't open here (no seal key, another
 *  key, damaged): what the run was handed can't be known, so it is withheld. */
export function launchValuesOf(sealKey: Buffer | undefined, runId: string, sealed: Uint8Array | null): string[] | "unreadable" {
  if (sealed === null) return [];
  if (!sealKey) return "unreadable";
  let plain: string;
  try {
    plain = unsealColumn(sealKey, sealedAt.runLaunch(runId), sealed).toString("utf8");
  } catch {
    return "unreadable";
  }
  // A message sealed over bytes that did not open here (store/seal.ts RunLaunchSecrets.lost): what they held is unknown.
  if (lostIn(plain)) return "unreadable";
  return launchValuesIn(plain);
}

/** Whether a launch's sealed JSON `plain` says a message sealed over bytes that did not open (RunLaunchSecrets.lost). */
function lostIn(plain: string): boolean {
  try {
    return (JSON.parse(plain) as { lost?: unknown } | null)?.lost === true;
  } catch {
    return false;
  }
}

/** Every value a launch's sealed JSON `plain` holds, as a cut lists them: each as the runner's own cut lists it
 *  (runner/store-secrets.ts launchSecrets), in every spelling the server's list has (ServerSecrets), each at least
 *  MIN_SECRET long. */
export function launchValuesIn(plain: string): string[] {
  const list = new ServerSecrets();
  list.add("handed", () => (plain.trimStart().startsWith("{") ? launchSecrets(plain) : [plain]));
  return list.values().filter((value) => value.length >= MIN_SECRET);
}

/** Each value the launch secrets `before` hold (their `retired` too) that `after` no longer hold, as the runner's cut
 *  lists them (launchSecrets): what a message's seal keeps as `retired` (store/seal.ts RunLaunchSecrets), so a value it
 *  replaced mid-turn is still cut, live and in the end's census. */
export function retiredValues(before: object, after: object): string[] {
  const kept = new Set(launchSecrets(JSON.stringify(after)));
  return [...new Set(launchSecrets(JSON.stringify(before)).filter((value) => !kept.has(value)))];
}

/** The values a start or a message hands (`mcp_auth`, `model_key`, `keys`: server.ts Handed), as launchValuesIn lists
 *  them from the launch they are sealed in. None when it hands none. */
export function handedSecretValues(handed: { readonly mcp?: unknown; readonly model?: string; readonly keys?: Readonly<Record<string, string>> }): string[] {
  if (handed.mcp === undefined && handed.model === undefined && handed.keys === undefined) return [];
  return launchValuesIn(JSON.stringify({ ...(handed.mcp !== undefined ? { mcp: handed.mcp } : {}), ...(handed.model !== undefined ? { model: { key: handed.model } } : {}), ...(handed.keys !== undefined ? { keys: handed.keys } : {}) }));
}

/** `value` with every string in it cut of `values` alone (each in every form redactSecrets finds it, learn/secrets.ts
 *  heldSpans; a string where one still shows in another form is "[redacted]" whole), and nothing else changed: no secret
 *  shape is cut, no length blanks it. What the server writes of a start or a message (its input, which a run's title is
 *  read from, its text) is cut so of what that start or message hands, so no read after the run's end erased those
 *  values (when no cut holds them) shows them. Its names are left as they are. */
export function cutHanded<T>(value: T, values: readonly string[]): T {
  if (!values.length) return value;
  const cutText = (text: string): string => {
    const spans = heldSpans(text, values);
    if (spans === "whole") return "[redacted]";
    let out = "";
    let from = 0;
    for (const [start, end] of spans) {
      out += `${text.slice(from, start)}[redacted]`;
      from = end;
    }
    return out + text.slice(from);
  };
  const walk = (one: unknown): unknown => {
    if (typeof one === "string") return cutText(one);
    if (Array.isArray(one)) return one.map(walk);
    if (one !== null && typeof one === "object") return Object.fromEntries(Object.entries(one).map(([name, inner]) => [name, walk(inner)]));
    return one;
  };
  return walk(value) as T;
}

/** The browser vendors that keep a sign-in (sign-ins-store.ts vendorOf). */
const SIGN_IN_VENDORS = ["browserbase", "kernel"] as const;

/** Why what an agent learned is withheld (403): a pointer of its sign-in can't be read here, so the cut would be shorter
 *  than what a note may hold. */
export const WITHHELD_LEARNING = "This server can't read the agent's browser sign-in (its seal key changed or is missing, or the sign-in is damaged), so what it learned is not shown.";

/** Every sign-in pointer agent `agentId` ever held, live and forgotten (the store keeps every forgotten one, never only
 *  the newest), at each vendor that keeps one (each at least MIN_SECRET long, as every cut takes them): what the learning
 *  routes cut beside the server's secrets, so a note, a skill or a run's learning that wrote one never shows it. `unreadable` when one does not open under this server's key, or a read
 *  fails: what the agent learned may hold that pointer, so it is withheld (WITHHELD_LEARNING), never shown over a
 *  shorter list. */
export async function agentPointers(signIns: SignInReader | undefined, agentId: string): Promise<string[] | "unreadable"> {
  if (!signIns) return [];
  const refs: string[] = [];
  for (const vendor of SIGN_IN_VENDORS) {
    const live = await signIns.peek(agentId, vendor).catch(() => "unreadable" as const);
    const gone = await signIns.forgotten(agentId, vendor).catch(() => "unreadable" as const);
    if (live === "unreadable" || gone === "unreadable" || gone.unreadable) return "unreadable";
    if (live) refs.push(live.ref);
    refs.push(...gone.refs);
  }
  return [...new Set(refs)].filter((ref) => ref.length >= MIN_SECRET);
}
