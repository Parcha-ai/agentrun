// The runner's one redactor (the secrets decision's rule three: no log, journal entry or export carries a secret value).
// A thrown error's text reaches a run's row and its journal end (runner.ts endRun and a loop it cannot make, the adapter
// loop's failed end), the runner's events, and the model route's error text that pi records. Each passes through the one
// function made here, which puts "[redacted]" in place of every secret value the runner holds, in every form a value
// can take in text (key-refusal.ts redactedAnswer: as written, JSON-escaped, base64, hex and percent-encoded).
import { redactedAnswer } from "../key-refusal.js";
import { MIN_SECRET } from "../learn/secrets.js";
import { hostSecrets, SECRET_NAMES } from "../secrets.js";
import { planOf } from "../chatgpt-plan.js";

/** Text with every secret value the redactor holds cut out. `heldValues()`, when the redactor knows them: every value it
 *  cuts, for the live ticker alone (live-ticker.ts), which must cut what is not whole text (a value still streaming, whose
 *  tail is held back; a number; an object's names). A redactor without it cuts text only. The values are raw secrets: only
 *  ever a function's answer, never a field, and the function itself is not enumerable (withHeldValues), so a redactor or
 *  anything holding one that is logged, put on a run or serialized shows none of them. */
export type Redact = ((text: string) => string) & { readonly heldValues?: () => readonly string[] };

/** `cut` answering `heldValues()`, the function defined not enumerable: JSON.stringify and util.inspect of the redactor,
 *  or of an object holding it, show no value it holds. */
function withHeldValues(cut: (text: string) => string, heldValues: () => readonly string[]): Redact {
  return Object.defineProperty(cut, "heldValues", { value: heldValues, enumerable: false });
}

/** What leaves text as it is: a runner given no secrets to cut. */
export const keepText: Redact = withHeldValues((text) => text, () => []);

/** Every secret value `env` holds for the runner: the server's held secrets, the MCP credentials and every key-, token-,
 *  secret- or password-named value (secrets.ts hostSecrets), and the value `env` itself gives each launcher name (a
 *  runner's key comes in its env, which hostSecrets reads only for names off the launcher's list), with any `extra` a
 *  caller holds. One shorter than MIN_SECRET, whitespace aside, matches too much text by chance and is left out. */
export function runnerSecrets(env: NodeJS.ProcessEnv, extra: readonly string[] = []): string[] {
  const own = SECRET_NAMES.map((name) => env[name] ?? "");
  return [...new Set([...hostSecrets(env), ...own, ...extra])].filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET);
}

/** The redactor over `values`: each one, in every form, replaced with "[redacted]". With none, text is left as it is. */
export function secretRedactor(values: readonly string[]): Redact {
  const kept = [...new Set(values.filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET))];
  if (kept.length === 0) return keepText;
  return withHeldValues((text) => (text ? redactedAnswer(text, kept) : text), () => kept);
}

/** The redactor over every secret this process's environment holds (runnerSecrets): a runner's default when it is
 *  handed none, so a runner started with none still cuts the keys it was started with. The one place the runner's
 *  redactor reads the environment; runner.ts reads no environment or argv itself. */
export const processSecretRedactor = (): Redact => secretRedactor(runnerSecrets(process.env));

/** A redactor that takes more values as the runner opens them (`hold`): the runner's one is this, so a key a claim opens
 *  from the store (claim-secrets.ts) is cut everywhere the runner's redactor reaches, as a key in its environment is. */
export interface HeldRedact extends Redact {
  /** Cut `values` too from here on, each in every form; one shorter than MIN_SECRET, whitespace aside, is left out. */
  hold(values: readonly string[]): void;
  /** Hold `values`, and cut them from run `runId`'s journal as it is written too (runner.ts): the run's own tool keys
   *  (run-keys.ts), erased at its turn's end, so no read after it could cut them. */
  carry(runId: string, values: readonly string[]): void;
  /** The cut of what run `runId` carried (`carry`), or undefined while it carried none. */
  carried(runId: string): Redact | undefined;
  /** Forget what run `runId` carried, once the runner lets its claim go: a later run's writes are never cut of it. The
   *  values stay held (`hold`). */
  dropCarried(runId: string): void;
}

const isHeld = (redact: Redact): redact is HeldRedact => typeof (redact as Partial<HeldRedact>).hold === "function";

/** `base`, then every value held since (`hold`). One that holds already is itself: wrapped once, the one instance. */
export function heldRedactor(base: Redact): HeldRedact {
  if (isHeld(base)) return base;
  const held = new Set<string>();
  /** Each run's carried values and their cut, made at its first use after a carry. */
  const carried = new Map<string, { values: Set<string>; cut?: Redact }>();
  const cut = ((text: string) => {
    const once = base(text);
    return once && held.size ? redactedAnswer(once, [...held]) : once;
  }) as HeldRedact;
  cut.hold = (values) => {
    for (const value of values) if (value.replace(/\s+/g, "").length >= MIN_SECRET) held.add(value);
  };
  cut.carry = (runId, values) => {
    cut.hold(values);
    const kept = values.filter((value) => held.has(value));
    if (!kept.length) return;
    const run = new Set([...(carried.get(runId)?.values ?? []), ...kept]);
    carried.set(runId, { values: run });
  };
  cut.carried = (runId) => {
    const run = carried.get(runId);
    if (!run) return undefined;
    return (run.cut ??= secretRedactor([...run.values]));
  };
  cut.dropCarried = (runId) => void carried.delete(runId);
  // Its values are the base's and every one held since; a base that does not know its own leaves them unknown.
  const known = base.heldValues;
  if (known) withHeldValues(cut, () => [...new Set([...known(), ...held])]);
  return cut;
}

/** Where a claim of run `runId` hands the run's own keys it lays (claim-secrets.ts ClaimSecretsDeps.carry): `redact`. */
export const carryTo = (redact: HeldRedact, runId: string) => (values: readonly string[]): void => redact.carry(runId, values);

/** Every string inside `value` cut by `cut`: what the run's process writes, as the runner's redactor would cut it in a
 *  loop of its own (rule three: no secret the runner holds is written). `names`: each object's and map's names too (a
 *  model may write a value as a JSON name); two names cut to one are both kept, the later ones numbered. */
export function cutDeep<T>(value: T, cut: (text: string) => string, names = false): T {
  if (typeof value === "string") return cut(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map((item) => cutDeep(item, cut, names)) as T;
  const named = (taken: (name: string) => boolean, key: string): string => {
    const once = names ? cut(key) : key;
    let name = once;
    for (let n = 2; taken(name); n++) name = `${once} (${n})`;
    return name;
  };
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value) out.set(typeof k === "string" ? named((name) => out.has(name), k) : k, cutDeep(v, cut, names));
    return out as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) Object.defineProperty(out, named((name) => Object.hasOwn(out, name), key), { value: cutDeep((value as Record<string, unknown>)[key], cut, names), enumerable: true, writable: true, configurable: true });
  return out as T;
}

/** The secrets a claim opened from the store (`env`, claimSecrets' environment for the run) held by `redact`, the run's
 *  one redactor, so a host tool's or a provider's error that echoes one is cut in the run's record, its end and its logs. */
export function holdClaimed(redact: HeldRedact, env: NodeJS.ProcessEnv): void {
  redact.hold(runnerSecrets(env));
  // A ChatGPT plan's tokens, each one as the claim reads or renews it.
  planOf(env)?.watch((tokens) => redact.hold(tokens));
}
