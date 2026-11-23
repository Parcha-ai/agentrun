// The keys a plan-billed harness recipe runs on, saved for that harness alone (HARNESS.md#keys). Each is a sealed row of
// the one store's sealed_keys (server-keys.ts, AAD sealed_keys|<row>|sealed) named harness:<harness>:<KEY>, so a key saved
// for one harness is never another's, even under the same name; the store holds ciphertext alone. A value replaced or
// removed is kept sealed as a retired row (harness-retired:<harness>:<KEY>:<time>), up to RETIRED_KEPT per key, so the
// cut (the server's secretStores, and a runner's storeSecrets, which reads every sealed_keys row) still holds it, and a
// timeline written while it was live stays cut after it changes.
//
// The server reads and writes them through HarnessKeysOverStore (its Settings → Harness keys routes, owner only). A
// runner opens a claim's own at its claim (openHarnessKeys), for that run's harness alone, and lays them on its adapter's
// environment where only the agent's start reads them (runner/cli-run-spec.ts): never on its tools, never another run's.
import { ApiError, invalid } from "./errors.js";
import { getSealedKey, putSealedKey, removeSealedKey } from "./server-keys.js";
import type { PlanRecipe } from "./harness-table.js";
import { registerSecretPage, registerSecretWrite, secretMeta, secretName, type SecretMeta } from "./secret-writes.js";
import { type SealedKeys, sealColumn, sealedAt, unsealColumn } from "./store/index.js";

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
/** A value's bounds: under 8 characters or holding whitespace, no cut could hold it whole (server-secrets.ts' floor). */
const MIN_VALUE = 8;
const MAX_VALUE_BYTES = 1024;
const UNFIT = /[\s\u0000-\u001f\u007f-\u009f]/;

/** The row (and view) name of `key` saved for `harness`. */
export const harnessKeyRow = (harness: string, key: string): string => secretName(HARNESS_KEY_PLANE, harness, key);
const retiredPrefix = (harness: string, key: string): string => `${secretName(RETIRED_PLANE, harness, key)}:`;

type HarnessKeysStore = { readonly sealedKeys: Pick<SealedKeys, "all" | "get" | "put" | "remove">; flush(): Promise<void> };

/** The keys of `names` saved for `harness` that open under `sealKey`, by name. One that does not open (another seal key, or
 *  damaged) reads as not saved, never a clear fallback. For a runner's claim, whose run is on that harness. */
export async function openHarnessKeys(store: { sealedKeys: Pick<SealedKeys, "get"> }, sealKey: Buffer, harness: string, names: readonly string[]): Promise<Record<string, string>> {
  const opened: Record<string, string> = {};
  for (const name of names) {
    const value = await getSealedKey(store, sealKey, harnessKeyRow(harness, name));
    if (value !== undefined) opened[name] = value;
  }
  return opened;
}

/** Whether every key of `names` has a row saved for `harness` (its bytes never opened): a trigger's check, and a runner's
 *  claim before it opens them. */
export async function harnessKeysSaved(store: { sealedKeys: Pick<SealedKeys, "all"> }, harness: string, names: readonly string[]): Promise<boolean> {
  if (!names.length) return false;
  const rows = new Set((await store.sealedKeys.all()).map((row) => row.name));
  return names.every((name) => rows.has(harnessKeyRow(harness, name)));
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

type Current = { value: string; changedAt: number };

/** What one plan-billed recipe's keys look like in Settings → Harness keys: each key's SecretMeta (never a value), and
 *  whether every one is saved, which is when its runs take the keys route. */
export type HarnessKeysView = { readonly id: string; readonly label: string; readonly keys: SecretMeta[]; readonly ready: boolean };

/** The saved harness keys over the one store, for the server (the one writer of these rows): a snapshot loaded once at
 *  start (load()) and kept in step with every write, so a read answers without a round trip. */
export class HarnessKeysOverStore {
  private current = new Map<string, Current>();
  private retired = new Map<string, { row: string; value: string; at: number }[]>();
  /** The last write in flight (save, remove): each waits for the one before it, so two that overlap never read the same
   *  value as the one they replace, and every value a claim may have opened is retired. */
  private writing: Promise<void> = Promise.resolve();

  /** `work` once every write before it has settled, its failure its own. */
  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.writing.then(work);
    this.writing = next.catch(() => undefined);
    return next;
  }

  /** `recipes`: the plan-billed recipes this server is started with (harness-table.ts planRecipesOf), the only harnesses
   *  whose keys it saves or shows. `data`: its data directory, which its registry (harnessKeysSavedHere) is kept under. */
  constructor(private readonly store: HarnessKeysStore, private readonly sealKey: Buffer, readonly recipes: readonly PlanRecipe[], private readonly data: string) {}

  /** This server's registry (harnessKeysSavedHere) set from the snapshot: each recipe whose every key is saved. */
  private mark(): void {
    savedHere.set(this.data, new Set(this.recipes.filter((recipe) => this.saved(recipe)).map((recipe) => recipe.id)));
  }

  /** Reads every harness key row once: each current one opened, each retired one opened for the cut. A row that does not
   *  open reads as not saved. */
  async load(): Promise<void> {
    const current = new Map<string, Current>();
    const retired = new Map<string, { row: string; value: string; at: number }[]>();
    for (const row of await this.store.sealedKeys.all()) {
      const isCurrent = row.name.startsWith(`${HARNESS_KEY_PLANE}:`);
      if (!isCurrent && !row.name.startsWith(`${RETIRED_PLANE}:`)) continue;
      let value: string;
      try {
        value = unsealColumn(this.sealKey, sealedAt.sealedKey(row.name), row.sealed).toString("utf8");
      } catch {
        continue;
      }
      if (isCurrent) current.set(row.name, { value, changedAt: row.updatedAt });
      else {
        const of = row.name.slice(0, row.name.lastIndexOf(":") + 1);
        retired.set(of, [...(retired.get(of) ?? []), { row: row.name, value, at: row.updatedAt }]);
      }
    }
    for (const list of retired.values()) list.sort((a, b) => a.at - b.at);
    this.current = current;
    this.retired = retired;
    this.mark();
  }

  /** Whether every key `recipe` runs on is saved for it. */
  saved(recipe: Pick<PlanRecipe, "id" | "keys">): boolean {
    return recipe.keys.length > 0 && recipe.keys.every((name) => this.current.has(harnessKeyRow(recipe.id, name)));
  }

  /** Every value to cut: each saved key's, and each retired one's still kept. */
  values(): string[] {
    return [...[...this.current.values()].map((entry) => entry.value), ...[...this.retired.values()].flat().map((entry) => entry.value)];
  }

  /** GET: `recipe`'s keys, each by name, whether saved and when it changed: never a value. */
  view(recipe: PlanRecipe): HarnessKeysView {
    const keys = recipe.keys.map((name) => {
      const row = harnessKeyRow(recipe.id, name);
      const saved = this.current.get(row);
      return secretMeta(row, saved ? { set: true, source: "console", changedAt: new Date(saved.changedAt) } : { set: false });
    });
    return { id: recipe.id, label: recipe.label, keys, ready: this.saved(recipe) };
  }

  /** GET /settings/harness-keys: every plan-billed recipe this server is started with, its keys by name. */
  list(): { harnesses: HarnessKeysView[] } {
    return { harnesses: this.recipes.map((recipe) => this.view(recipe)) };
  }

  /** The plan-billed recipe `id` names on this server, else 404. */
  recipe(id: string): PlanRecipe {
    return planRecipeOr404(this.recipes, id);
  }

  /** PUT: `value` sealed as `key` for `recipe`'s harness alone; a value it replaces kept as a retired row. Durable before it
   *  resolves, so a 204 never outruns the store. */
  async save(recipe: PlanRecipe, key: string, body: unknown): Promise<void> {
    const value = admit(recipe, key, body);
    const row = harnessKeyRow(recipe.id, key);
    await this.serial(async () => {
      const was = this.current.get(row);
      if (was?.value === value) return;
      if (was) await this.retire(recipe.id, key, was.value);
      await putSealedKey(this.store, this.sealKey, row, value);
      this.current.set(row, { value, changedAt: Date.now() });
      this.mark();
      await this.store.flush();
    });
  }

  /** DELETE: `key`'s value for `recipe`'s harness gone from its runs, kept as a retired row for the cut. A row the snapshot
   *  does not hold (one that does not open under this server's seal key) is removed too, so no claim counts it saved. */
  async remove(recipe: PlanRecipe, key: string): Promise<void> {
    known(recipe, key);
    const row = harnessKeyRow(recipe.id, key);
    await this.serial(async () => {
      const was = this.current.get(row);
      if (was) await this.retire(recipe.id, key, was.value);
      await removeSealedKey(this.store, row);
      this.current.delete(row);
      this.mark();
      await this.store.flush();
    });
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

/** 422 unless `key` is one `recipe` runs on (recipe.keys): a key no recipe names is never saved for it. */
function known(recipe: PlanRecipe, key: string): void {
  if (!recipe.keys.includes(key)) throw invalid([{ field: "key", reason: "not_an_option", message: `${recipe.label} runs on ${recipe.keys.join(", ")}.` }]);
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
  if (!recipe) throw new ApiError("not_found", `No harness recipe billed to its vendor's plan is named ${id} on this server: its keys are saved for a recipe the server is started with (--harness-recipe).`);
  return recipe;
}

/** The bytes a value would be sealed as, for a test that checks a key is sealed at rest. */
export const sealedHarnessKeyBytes = (key: Buffer, harness: string, name: string, value: string): Uint8Array => sealColumn(key, sealedAt.sealedKey(harnessKeyRow(harness, name)), value);
