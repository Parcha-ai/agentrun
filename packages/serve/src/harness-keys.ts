// The keys a plan-billed harness recipe runs on, saved for that harness alone (HARNESS.md#keys). Each is a sealed row of
// the one store's sealed_keys (server-keys.ts, AAD sealed_keys|<row>|sealed) named harness:<harness>:<KEY>, so a key saved
// for one harness is never another's, even under the same name; the store holds ciphertext alone. A value replaced or
// removed is kept sealed as a retired row (harness-retired:<harness>:<KEY>:<time>), up to RETIRED_KEPT per key, so the
// cut (the server's secretStores, and a runner's storeSecrets, which reads every sealed_keys row) still holds it, and a
// timeline written while it was live stays cut after it changes.
//
// Each current row is bound to the recipe it was saved for and the seal key it was sealed under, in one settings row
// beside them (HARNESS_KEY_BINDS: the recipe file's sha256, the seal key's fingerprint, the sha256 of the sealed bytes it
// was written with, none a secret). A row opens for a run only on the recipe it was saved for: a later recipe file of the
// same id (another agent, another vendor) never takes it, and a row whose seal key changed says so. The binding is kept
// outside the sealed value and its AAD, since the cut opens every row as a bare key; the digest of the sealed bytes ties
// the two reads together, so a claim that reads one value's binding and then, after a save, another value's bytes never
// opens them. A recipe the server no longer names keeps its keys (still sealed, still cut, run by
// nothing): listed by its id, and removed by DELETE.
//
// The server reads and writes them through HarnessKeysOverStore (its Settings → Harness keys routes, owner only). A
// runner opens a claim's own at its claim (openHarnessKeys), for that run's recipe alone, and lays them on its adapter's
// environment where only the agent's start reads them (runner/cli-run-spec.ts): never on its tools, never another run's.
import { createHash } from "node:crypto";
import { ApiError, invalid } from "./errors.js";
import { HARNESS_KEY_REENTER, type Opened, openSealed, putSealedKey, removeSealedKey, sealFingerprint } from "./server-keys.js";
import type { PlanRecipe } from "./harness-table.js";
import { registerSecretPage, registerSecretWrite, secretMeta, secretName, type SecretMeta } from "./secret-writes.js";
// isObject from the store, never validate.ts: this module loads while model.ts does (harness-table.ts →
// harness-recipe-entry.ts), and validate.ts reaches key-words.ts, which reads model.ts's MODEL_KEYS before it is set.
import { isObject, type SealedKeys, sealColumn, sealedAt, type Settings } from "./store/index.js";

// Every value saved here is a secret: saving one or removing it takes the owner's session (secret-writes.ts), never the
// token, and the token's refusal names the console's page.
registerSecretWrite("saveHarnessKey", () => true);
registerSecretWrite("deleteHarnessKey", () => true);
/** The console's page for these keys (Settings → Harness keys). */
export const HARNESS_KEYS_PAGE = "/#/settings/harness-keys";
registerSecretPage(["saveHarnessKey", "deleteHarnessKey"], HARNESS_KEYS_PAGE);

/** The plane of a harness key's name (its row's, and its view's: harness:<harness>:<KEY>). */
export const HARNESS_KEY_PLANE = "harness";
const RETIRED_PLANE = "harness-retired";
/** How many replaced or removed values of one key stay sealed for the cut: the oldest beyond it leaves. */
export const RETIRED_KEPT = 8;
/** The settings row each current key row's binding is kept in: { v: 1, rows: { <row>: { seal, recipe, sealed } } }, `seal`
 *  the fingerprint of the seal key it was sealed under (server-keys.ts sealFingerprint), `recipe` the sha256 of the recipe
 *  file it was saved for (PlanRecipe.digest), `sealed` the sha256 of the sealed bytes written with it (sealedDigest). */
export const HARNESS_KEY_BINDS = "harness-keys";
/** A value's bounds: under 8 characters or holding whitespace, no cut could hold it whole (server-secrets.ts' floor). */
const MIN_VALUE = 8;
const MAX_VALUE_BYTES = 1024;
const UNFIT = /[\s\x00-\x1f\x7f-\x9f]/;

/** The row (and view) name of `key` saved for `harness`. */
export const harnessKeyRow = (harness: string, key: string): string => secretName(HARNESS_KEY_PLANE, harness, key);
const retiredPrefix = (harness: string, key: string): string => `${secretName(RETIRED_PLANE, harness, key)}:`;
/** The harness and key a current row's name holds, else undefined (a retired row, or another layer's). */
const rowParts = (name: string): { harness: string; key: string } | undefined => {
  if (!name.startsWith(`${HARNESS_KEY_PLANE}:`)) return undefined;
  const rest = name.slice(HARNESS_KEY_PLANE.length + 1);
  const at = rest.lastIndexOf(":");
  return at > 0 && at < rest.length - 1 ? { harness: rest.slice(0, at), key: rest.slice(at + 1) } : undefined;
};

export { HARNESS_KEY_REENTER };
export type HarnessKeyWhy = (typeof HARNESS_KEY_REENTER)[number];

type Bind = { readonly seal: string; readonly recipe: string; readonly sealed: string };
/** The sha256 of a row's sealed bytes (base64url): a binding holds the one its value was written with, so bytes read
 *  apart from it open only when they are those bytes. Of ciphertext, never of a value. */
const sealedDigest = (sealed: Uint8Array): string => createHash("sha256").update(sealed).digest("base64url");
/** The recipe `bind` binds `sealed` to: none when there is no binding, or it was written with other bytes (a save landed
 *  between the reads of one and the other, or the row was put by hand). */
const boundRecipe = (bind: Bind | undefined, sealed: Uint8Array): string | undefined => (bind !== undefined && bind.sealed === sealedDigest(sealed) ? bind.recipe : undefined);
/** The bindings the settings row holds, failing closed: an unreadable row, or a binding with no digest of its bytes,
 *  reads as none, so no key opens until saved again. */
function bindsOf(read: unknown): Map<string, Bind> {
  const binds = new Map<string, Bind>();
  if (isObject(read) && read.v === 1 && isObject(read.rows)) {
    for (const [row, bind] of Object.entries(read.rows)) {
      if (isObject(bind) && typeof bind.seal === "string" && typeof bind.recipe === "string" && typeof bind.sealed === "string") binds.set(row, { seal: bind.seal, recipe: bind.recipe, sealed: bind.sealed });
    }
  }
  return binds;
}
const readBinds = async (store: { readonly settings: Pick<Settings, "get"> }) => bindsOf(await store.settings.get(HARNESS_KEY_BINDS));

type HarnessKeysStore = { readonly sealedKeys: Pick<SealedKeys, "all" | "get" | "put" | "remove">; readonly settings: Pick<Settings, "get" | "put">; flush(): Promise<void> };
/** The recipe a claim's keys are opened for: its id, the keys it runs on, and its file's digest they must be bound to. */
type RecipeBound = Pick<PlanRecipe, "id" | "keys" | "digest">;

/** The keys `recipe` runs on that are saved for it (bound to its digest) and open under `sealKey`, by name. One saved for
 *  another recipe file of its id, or that does not open (another seal key, or damaged), reads as not saved, never a clear
 *  fallback. For a runner's claim, whose run is on that recipe. */
export async function openHarnessKeys(store: { readonly sealedKeys: Pick<SealedKeys, "get">; readonly settings: Pick<Settings, "get"> }, sealKey: Buffer, recipe: RecipeBound): Promise<Record<string, string>> {
  const binds = await readBinds(store);
  const opened: Record<string, string> = {};
  for (const name of recipe.keys) {
    const row = harnessKeyRow(recipe.id, name);
    const bind = binds.get(row);
    if (bind?.recipe !== recipe.digest) continue;
    const sealed = await store.sealedKeys.get(row);
    // The bytes read after the binding are the ones it was written with, or a save came between: never another value.
    if (sealed === undefined || boundRecipe(bind, sealed) !== recipe.digest) continue;
    const open = openSealed(sealKey, row, sealed, bind.seal);
    if ("value" in open) opened[name] = open.value;
  }
  return opened;
}

/** Whether every key `recipe` runs on has a row saved for it, bound to its digest (its bytes never opened): a trigger's
 *  check, and a runner's claim before it opens them. */
export async function harnessKeysSaved(store: { readonly sealedKeys: Pick<SealedKeys, "all">; readonly settings: Pick<Settings, "get"> }, recipe: RecipeBound): Promise<boolean> {
  if (!recipe.keys.length) return false;
  const rows = new Set((await store.sealedKeys.all()).map((row) => row.name));
  const binds = await readBinds(store);
  return recipe.keys.every((name) => {
    const row = harnessKeyRow(recipe.id, name);
    return rows.has(row) && binds.get(row)?.recipe === recipe.digest;
  });
}

/** Whether a claim laid every key of `names` on `env` (layHarnessKeys: own, never enumerable, not empty), which is when
 *  a start takes the keys route (harness-recipe-entry.ts serverRoute). A variable of the same name the environment
 *  carries enumerable (one the operator's shell set) is never one: a run takes the keys saved for its harness alone. */
export function keysLaid(env: NodeJS.ProcessEnv, names: readonly string[]): boolean {
  return names.length > 0 && names.every((name) => {
    const laid = Object.getOwnPropertyDescriptor(env, name);
    return laid !== undefined && laid.enumerable === false && typeof laid.value === "string" && laid.value !== "";
  });
}

/** For each data directory a server in this process serves, the harnesses whose every key it holds saved
 *  (HarnessKeysOverStore keeps its own in step with its snapshot; another server's writes never touch it): what that
 *  server's listing, offers and trigger checks read (harness-recipe-entry.ts `why`), so a save shows with no restart. A
 *  start never reads it: it runs only on the keys its claim laid (keysLaid). The snapshot is loaded at the server's start,
 *  so a second server on the same store sees another's write at its next start; its runs fail closed meanwhile, since
 *  each claim opens the rows itself. */
const savedHere = new Map<string, ReadonlySet<string>>();
export const harnessKeysSavedHere = (data: string, harness: string): boolean => savedHere.get(data)?.has(harness) === true;

/** The words a run no person started (a schedule's, a trigger's, a learned workflow's audit shadow or replay:
 *  run-launch.ts personStarted) on a plan-billed recipe is refused in at its claim (runner/harness-loops.ts,
 *  runner/cli-run-spec.ts): such a run takes keys saved for that harness, never its owner's own sign-in, and not every
 *  one is saved, or not every one opened. */
export const RECIPE_SIGN_IN_PERSON_ONLY = `A run its owner did not start (a scheduled or triggered run, a learned workflow's audit or replay) on a harness recipe billed to its vendor's plan runs on keys saved for that harness, never on its owner's own sign-in, and not every one of its keys is saved: save them in Settings → Harness keys (${HARNESS_KEYS_PAGE}), start this run yourself, or run the agent on a harness billed through this server's model proxy.`;

/** The words a trigger's message is refused in by a session its claim started with not every key of its plan-billed
 *  recipe laid (runner/adapter-loop.ts, the spec's personOnly): that session runs on its owner's own sign-in, or on
 *  nothing, whatever was saved since, so a turn no person sent never goes into it. */
export const RECIPE_TURN_PERSON_ONLY = `This run started on its owner's own sign-in (its harness recipe is billed to its vendor's plan, and its claim opened not every key saved for that harness), so a trigger's message never runs in it, keys saved since or not: message the run yourself, or target a run started once every key was saved in Settings → Harness keys (${HARNESS_KEYS_PAGE}).`;

/** Lays `keys` on `env` where only a direct read finds them: never enumerable, so no spread, copy or child environment
 *  built from `env` carries them (claim-secrets.ts withModelKeys). */
export function layHarnessKeys(env: NodeJS.ProcessEnv, keys: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(keys)) Object.defineProperty(env, name, { value, enumerable: false, configurable: true, writable: false });
}

/** A current row as loaded: opened now (or why not), the recipe digest it is bound to, when it changed. */
type Current = { opened: Opened; recipe: string | undefined; changedAt: number };

/** What one harness's keys look like in Settings → Harness keys, never a value. `named`: a plan-billed recipe this
 *  server is started with; else an id whose recipe it no longer names, its keys kept until removed. `keys`: each key its
 *  recipe runs on (none when not named), set once saved for this recipe file. `kept`: each key saved for this id that its
 *  recipe runs on no more (or no recipe does): no run gets it, and DELETE removes it. `ready`: every one of `keys` saved,
 *  which is when its runs take the keys route. `reenter`: each of `keys` saved but not one its runs get, and why. */
export type HarnessKeysView = {
  readonly id: string; readonly label: string; readonly named: boolean; readonly keys: SecretMeta[]; readonly kept: SecretMeta[]; readonly ready: boolean;
  readonly reenter: { readonly name: string; readonly why: HarnessKeyWhy }[];
};

/** What a DELETE may remove: a named recipe's keys and those kept for it, or the kept keys of an id no recipe names. */
export type HarnessKeysHeld = { readonly id: string; readonly label: string; readonly keys: readonly string[] };

/** The saved harness keys over the one store, for the server (the one writer of these rows): a snapshot loaded once at
 *  start (load()) and kept in step with every write, so a read answers without a round trip. */
export class HarnessKeysOverStore {
  private current = new Map<string, Current>();
  private retired = new Map<string, { row: string; value: string; at: number }[]>();
  private binds = new Map<string, Bind>();
  private readonly seal: string;
  /** The last write in flight (save, remove): each waits for the one before it, so two that overlap never read the same
   *  value as the one they replace, every value a claim may have opened is retired, and the binding row is written whole
   *  by one at a time. */
  private writing: Promise<void> = Promise.resolve();

  /** `work` once every write before it has settled, its failure its own. A write that fails partway (a value put and its
   *  binding not) reads the store again before the next one, so the snapshot, and the cut it gives (values()), holds
   *  every value the store does. */
  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.writing.then(async () => {
      try {
        await work();
      } catch (error) {
        await this.load().catch(() => undefined);
        throw error;
      }
    });
    this.writing = next.catch(() => undefined);
    return next;
  }

  /** `recipes`: the plan-billed recipes this server is started with (harness-table.ts planRecipesOf), the only harnesses
   *  whose keys it saves. `data`: its data directory, which its registry (harnessKeysSavedHere) is kept under. */
  constructor(private readonly store: HarnessKeysStore, private readonly sealKey: Buffer, readonly recipes: readonly PlanRecipe[], private readonly data: string) {
    this.seal = sealFingerprint(sealKey);
  }

  /** This server's registry (harnessKeysSavedHere) set from the snapshot: each recipe whose every key is saved. */
  private mark(): void {
    savedHere.set(this.data, new Set(this.recipes.filter((recipe) => this.saved(recipe)).map((recipe) => recipe.id)));
  }

  /** Reads every harness key row once, and their bindings: each current one opened (or why not), each retired one opened
   *  for the cut. */
  async load(): Promise<void> {
    const binds = await readBinds(this.store);
    const current = new Map<string, Current>();
    const retired = new Map<string, { row: string; value: string; at: number }[]>();
    for (const row of await this.store.sealedKeys.all()) {
      if (rowParts(row.name)) {
        const bind = binds.get(row.name);
        current.set(row.name, { opened: openSealed(this.sealKey, row.name, row.sealed, bind?.seal), recipe: boundRecipe(bind, row.sealed), changedAt: row.updatedAt });
        continue;
      }
      if (!row.name.startsWith(`${RETIRED_PLANE}:`)) continue;
      const opened = openSealed(this.sealKey, row.name, row.sealed, undefined);
      if (!("value" in opened)) continue;
      const of = row.name.slice(0, row.name.lastIndexOf(":") + 1);
      retired.set(of, [...(retired.get(of) ?? []), { row: row.name, value: opened.value, at: row.updatedAt }]);
    }
    for (const list of retired.values()) list.sort((a, b) => a.at - b.at);
    this.binds = binds;
    this.current = current;
    this.retired = retired;
    this.mark();
  }

  /** `key`'s row for `recipe` when its runs get it: it opens, and is bound to this recipe file. */
  private bound(recipe: Pick<PlanRecipe, "id" | "digest">, key: string): (Current & { opened: { value: string } }) | undefined {
    const entry = this.current.get(harnessKeyRow(recipe.id, key));
    return entry && "value" in entry.opened && entry.recipe === recipe.digest ? (entry as Current & { opened: { value: string } }) : undefined;
  }

  /** Whether every key `recipe` runs on is saved for it. */
  saved(recipe: Pick<PlanRecipe, "id" | "keys" | "digest">): boolean {
    return recipe.keys.length > 0 && recipe.keys.every((name) => this.bound(recipe, name) !== undefined);
  }

  /** Every value to cut: each saved key's that opens, whatever recipe it is bound to (or none), and each retired one's
   *  still kept. */
  values(): string[] {
    return [
      ...[...this.current.values()].flatMap((entry) => ("value" in entry.opened ? [entry.opened.value] : [])),
      ...[...this.retired.values()].flat().map((entry) => entry.value),
    ];
  }

  /** The keys saved for `id` that `named` does not hold, each as its view says it. */
  private kept(id: string, named: readonly string[]): SecretMeta[] {
    return [...this.current].flatMap(([row, entry]) => {
      const parts = rowParts(row);
      if (parts?.harness !== id || named.includes(parts.key)) return [];
      return [secretMeta(row, "value" in entry.opened ? { set: true, source: "console", changedAt: new Date(entry.changedAt) } : { set: false })];
    });
  }

  /** GET: `recipe`'s keys, each by name, whether saved for it and when it changed, and those to enter again: never a value. */
  view(recipe: PlanRecipe): HarnessKeysView {
    const keys = recipe.keys.map((name) => {
      const saved = this.bound(recipe, name);
      return secretMeta(harnessKeyRow(recipe.id, name), saved ? { set: true, source: "console", changedAt: new Date(saved.changedAt) } : { set: false });
    });
    const reenter = recipe.keys.flatMap((name) => {
      const row = harnessKeyRow(recipe.id, name);
      const entry = this.current.get(row);
      if (!entry || this.bound(recipe, name)) return [];
      const why: HarnessKeyWhy = "unreadable" in entry.opened ? entry.opened.unreadable : entry.recipe === undefined ? "not_bound" : "recipe_changed";
      return [{ name: row, why }];
    });
    return { id: recipe.id, label: recipe.label, named: true, keys, kept: this.kept(recipe.id, recipe.keys), ready: this.saved(recipe), reenter };
  }

  /** Each id with keys saved whose recipe this server does not name, sorted: the page lists them (list), to remove. */
  unnamed(): string[] {
    const named = new Set(this.recipes.map((recipe) => recipe.id));
    return [...new Set([...this.current.keys()].flatMap((row) => rowParts(row)?.harness ?? []))].filter((id) => !named.has(id)).sort();
  }

  /** GET /settings/harness-keys: every plan-billed recipe this server is started with, its keys by name; then each id
   *  with keys saved whose recipe it no longer names (unnamed), its keys kept. */
  list(): { harnesses: HarnessKeysView[] } {
    return {
      harnesses: [
        ...this.recipes.map((recipe) => this.view(recipe)),
        ...this.unnamed().map((id) => ({ id, label: id, named: false, keys: [], kept: this.kept(id, []), ready: false, reenter: [] })),
      ],
    };
  }

  /** The plan-billed recipe `id` names on this server, else 404: what a PUT saves for. */
  recipe(id: string): PlanRecipe {
    return planRecipeOr404(this.recipes, id);
  }

  /** What a DELETE of `id`'s keys may remove: a named recipe's keys and those kept for it, or the keys kept for an id no
   *  recipe on this server names; else 404. */
  held(id: string): HarnessKeysHeld {
    const recipe = this.recipes.find((entry) => entry.id === id);
    const kept = [...this.current.keys()].flatMap((row) => {
      const parts = rowParts(row);
      return parts?.harness === id && !recipe?.keys.includes(parts.key) ? [parts.key] : [];
    });
    if (!recipe && !kept.length) return planRecipeOr404(this.recipes, id);
    return { id, label: recipe?.label ?? id, keys: [...(recipe?.keys ?? []), ...kept] };
  }

  /** PUT: `value` sealed as `key` for `recipe`'s harness alone, bound to its file; a value it replaces kept as a retired
   *  row. Durable before it resolves, so a 204 never outruns the store. */
  async save(recipe: PlanRecipe, key: string, body: unknown): Promise<void> {
    const value = admit(recipe, key, body);
    const row = harnessKeyRow(recipe.id, key);
    await this.serial(async () => {
      const was = this.current.get(row);
      const wasValue = was && "value" in was.opened ? was.opened.value : undefined;
      if (wasValue === value && was?.recipe === recipe.digest && this.binds.get(row)?.seal === this.seal) return;
      if (wasValue !== undefined && wasValue !== value) await this.retire(recipe.id, key, wasValue);
      // Unbound before the new value is written, bound after: a write cut short leaves a row bound to no recipe (opened by
      // none), never a value bound to a recipe it was not saved for.
      if (this.binds.delete(row)) await this.writeBinds();
      const sealed = sealColumn(this.sealKey, sealedAt.sealedKey(row), value);
      await this.store.sealedKeys.put(row, sealed);
      this.binds.set(row, { seal: this.seal, recipe: recipe.digest, sealed: sealedDigest(sealed) });
      await this.writeBinds();
      this.current.set(row, { opened: { value }, recipe: recipe.digest, changedAt: Date.now() });
      this.mark();
      await this.store.flush();
    });
  }

  /** DELETE: `key`'s value for `held`'s harness gone from its runs, kept as a retired row for the cut. A row that does not
   *  open under this server's seal key is removed too, so no claim counts it saved. */
  async remove(held: HarnessKeysHeld, key: string): Promise<void> {
    known(held, key, true);
    const row = harnessKeyRow(held.id, key);
    await this.serial(async () => {
      const was = this.current.get(row);
      if (was && "value" in was.opened) await this.retire(held.id, key, was.opened.value);
      await removeSealedKey(this.store, row);
      if (this.binds.delete(row)) await this.writeBinds();
      this.current.delete(row);
      this.mark();
      await this.store.flush();
    });
  }

  /** The bindings written back as one settings row. */
  private async writeBinds(): Promise<void> {
    await this.store.settings.put(HARNESS_KEY_BINDS, { v: 1, rows: Object.fromEntries(this.binds) });
  }

  /** `value`, which `key` held, sealed as a retired row of its own; the oldest beyond RETIRED_KEPT leaves. */
  private async retire(harness: string, key: string, value: string): Promise<void> {
    const of = retiredPrefix(harness, key);
    const list = this.retired.get(of) ?? [];
    const at = Math.max(Date.now(), (list.at(-1)?.at ?? 0) + 1);
    const row = `${of}${at}`;
    await putSealedKey(this.store, this.sealKey, row, value);
    list.push({ row, value, at });
    while (list.length > RETIRED_KEPT) await removeSealedKey(this.store, list.shift()!.row);
    this.retired.set(of, list);
  }
}

/** 422 unless `key` is one `recipe` runs on (or, for a DELETE, one it holds): a key no recipe names is never saved. A
 *  DELETE's refusal names the keys held, which for an id no recipe names are kept keys, never ones it runs on. */
function known(recipe: Pick<PlanRecipe, "label" | "keys">, key: string, remove = false): void {
  if (recipe.keys.includes(key)) return;
  const keys = recipe.keys.join(", ");
  throw invalid([{ field: "key", reason: "not_an_option", message: remove ? `${recipe.label}'s keys are ${keys}.` : `${recipe.label} runs on ${keys}.` }]);
}

/** What a PUT may save: `body.value`, text of 8 to 1024 bytes with no whitespace or control character, for a key the
 *  recipe names. No message holds the value. */
function admit(recipe: PlanRecipe, key: string, body: unknown): string {
  known(recipe, key);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid([{ field: "value", reason: "wrong_type", message: "The body is { value }." }]);
  const extra = Object.keys(body).filter((name) => name !== "value");
  if (extra.length) throw invalid(extra.map((name) => ({ field: name, reason: "unknown", message: "The body is { value }." })));
  const value = (body as { value?: unknown }).value;
  if (typeof value !== "string" || value === "") throw invalid([{ field: "value", reason: value === undefined ? "missing" : "wrong_type", message: `${key} is text, not empty` }]);
  if (UNFIT.test(value)) throw invalid([{ field: "value", reason: "invalid", message: `${key} holds whitespace or a control character` }]);
  if ([...value].length < MIN_VALUE) throw invalid([{ field: "value", reason: "too_short", message: `${key} is at least ${MIN_VALUE} characters` }]);
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw invalid([{ field: "value", reason: "too_long", message: `${key} is at most ${MAX_VALUE_BYTES} bytes` }]);
  return value;
}

/** 404 for a harness that is not a plan-billed recipe on this server's table: its keys are saved nowhere. */
export function planRecipeOr404(recipes: readonly PlanRecipe[], id: string): PlanRecipe {
  const recipe = recipes.find((entry) => entry.id === id);
  if (!recipe) throw new ApiError("not_found", `No harness recipe billed to its vendor's plan is named ${id} on this server, and no key is kept for it: its keys are saved for a recipe the server is started with (--harness-recipe).`);
  return recipe;
}

/** The bytes a value would be sealed as, for a test that checks a key is sealed at rest. */
export const sealedHarnessKeyBytes = (key: Buffer, harness: string, name: string, value: string): Uint8Array => sealColumn(key, sealedAt.sealedKey(harnessKeyRow(harness, name)), value);
