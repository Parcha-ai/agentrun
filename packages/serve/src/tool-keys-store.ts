// The keys a person saves for this server's tools, over the one store (A), the store-backed replacement for tool-keys.ts's
// tool-keys.json field store. Each field's value is a sealed row in store.sealedKeys (server-keys.ts, AAD
// sealed_keys|<name>|sealed); the store holds ciphertext alone and never opens it. The per-key provider checks and the
// seal-key fingerprints that tell "sealed under another key" from "damaged" live in one store.settings row (no secret: a
// check is state and a time, a fingerprint is an HMAC of a fixed label, neither the key nor a hash of it). Only this
// process opens a value, with the seal key the launcher hands it (AGENTRUN_SEAL_KEY), never in the data directory.
//
// The surface is ToolKeys' (tool-keys.ts), byte for byte, so the switch swaps `new ToolKeys(data, env, say)` for
// `toolKeysOverStore(store, env, say)` without touching a route: value/values/view/refused/checkServer/check are the same
// shapes, and save/remove return a promise the handler awaits (durable before the 204, as writeDurableSync was). The reads
// are served from an in-memory snapshot the server (the one writer of these rows) loads once at start (load()) and keeps in
// step with every write, so a read answers without a round trip, exactly as ToolKeys read its file.
import { createHmac } from "node:crypto";
import { decisionsOf } from "./decisions.js";
import { ApiError, invalid } from "./errors.js";
import { checkKey, type KeyCheck } from "./key-check.js";
import { putSealedKey, removeSealedKey } from "./server-keys.js";
import { rowSecrets, rowUnlocks, SEAL_KEY_ENV, sealKeyOf, type StartCheck, TOOL_KEYS, UNREADABLE } from "./tool-keys.js";
import { toolsView } from "./tools.js";
import { type SealedKeys, sealColumn, sealedAt, type Settings, unsealColumn } from "./store/index.js";
import { isObject, unknownFields } from "./validate.js";

/** Where the per-key checks and seal-key fingerprints live in store.settings: one row, outside the sealed values. */
export const TOOL_KEY_CHECKS_KEY = "tool-key-checks";
const MAX_VALUE_BYTES = 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Every field a person may save (the fields of every key row), the same set ToolKeys keeps. */
const FIELDS: readonly string[] = TOOL_KEYS.flatMap((row) => row.fields);
type Unreadable = (typeof UNREADABLE)[number];
type Opened = { value: string } | { unreadable: Unreadable };

/** The check a key kept before this server checked keys reads as: none was made. Mirrors ToolKeys' UNCHECKED. */
const UNCHECKED: KeyCheck = { state: "not_checked", reason: "Saved before this server checked keys; save it again to check it" };
/** A check as the store row keeps it, else undefined (mirrors ToolKeys' keptCheck). */
const keptCheck = (entry: unknown): KeyCheck | undefined =>
  !isObject(entry) ? undefined
  : entry.state === "accepted" && typeof entry.at === "string" ? { state: "accepted", at: entry.at }
  : entry.state === "not_checked" && typeof entry.reason === "string" ? { state: "not_checked", reason: entry.reason, ...(typeof entry.at === "string" ? { at: entry.at } : {}) }
  : undefined;

/** The store slice this layer reads and writes: the sealed key rows and the one settings row for checks. */
type ToolKeysStore = { readonly sealedKeys: Pick<SealedKeys, "all" | "put" | "remove">; readonly settings: Pick<Settings, "get" | "put">; flush(): Promise<void> };

/** The fingerprint of a seal key: an HMAC of a fixed label under it, stable across restarts, so a value whose fingerprint
 *  no longer matches was sealed under another key (seal_key_changed), told apart from one that is simply damaged. */
const fingerprint = (key: Buffer): string => createHmac("sha256", key).update("agentrun-serve sealed_keys key check").digest("base64url");

/** The one snapshot the server reads from and keeps in step with every write. `fields` holds each stored field's opened
 *  result (value, or why it does not open); `checks` the per-key provider checks; `seals` the seal-key fingerprint each
 *  field was sealed under, kept so a later start under another key reads it as seal_key_changed; `changed` when each
 *  field's value was saved: its own sealed_keys row's updated_at (one row holds one field's value, and only that field's
 *  save writes it, so the row's time is the credential's own). */
type Snapshot = { fields: Map<string, Opened>; checks: Map<string, KeyCheck>; seals: Map<string, string>; changed: Map<string, number> };

/** The store-backed ToolKeys. `toolKeysOverStore` builds it; the switch awaits load() once before the first read. */
class ToolKeysOverStore {
  private readonly key: Buffer | undefined;
  private readonly sealCheck: string | undefined;
  private said = "";
  private snapshot: Snapshot = { fields: new Map(), checks: new Map(), seals: new Map(), changed: new Map() };
  /** The checks of the keys the server was started with, by key id, each once it answered (checkServer). In memory only. */
  private readonly started: Record<string, StartCheck> = {};

  constructor(private readonly store: ToolKeysStore, private readonly env: NodeJS.ProcessEnv, private readonly say: (fields: Record<string, string>) => void) {
    this.key = sealKeyOf(env[SEAL_KEY_ENV]);
    this.sealCheck = this.key && fingerprint(this.key);
    if (env[SEAL_KEY_ENV] !== undefined && !this.key) say({ condition: "seal_key_invalid", name: SEAL_KEY_ENV });
  }

  /** Reads the store once into the snapshot: each sealed field opened now, the checks and the fingerprints beside them.
   *  Awaited once at start, before the first read. */
  async load(): Promise<void> {
    const { checks, seals } = this.readChecks(await this.store.settings.get(TOOL_KEY_CHECKS_KEY));
    const fields = new Map<string, Opened>();
    const changed = new Map<string, number>();
    for (const row of await this.store.sealedKeys.all()) {
      if (!FIELDS.includes(row.name)) continue; // the sealed_keys table also holds Archil's keys, which are not tool keys
      fields.set(row.name, this.openAt(row.name, row.sealed, seals.get(row.name)));
      changed.set(row.name, row.updatedAt);
    }
    this.snapshot = { fields, checks, seals, changed };
  }

  /** The checks and fingerprints the settings row holds, failing closed (an unreadable row reads as none, so no value is
   *  lost and each field is just asked to be checked again). */
  private readChecks(read: unknown): { checks: Map<string, KeyCheck>; seals: Map<string, string> } {
    const checks = new Map<string, KeyCheck>();
    const seals = new Map<string, string>();
    if (isObject(read) && read.v === 1) {
      if (isObject(read.checks)) for (const [id, entry] of Object.entries(read.checks)) { const check = keptCheck(entry); if (check) checks.set(id, check); }
      if (isObject(read.seals)) for (const [name, fp] of Object.entries(read.seals)) if (typeof fp === "string") seals.set(name, fp);
    }
    return { checks, seals };
  }

  /** Opens a field's sealed bytes now, or why not: no seal key (seal_key_missing); a fingerprint that no longer matches
   *  (seal_key_changed); else unseal, which fails as file_unreadable. */
  private openAt(name: string, sealed: Uint8Array, fp: string | undefined): Opened {
    if (!this.key) return { unreadable: "seal_key_missing" };
    if (fp !== undefined && fp !== this.sealCheck) return { unreadable: "seal_key_changed" };
    try {
      return { value: unsealColumn(this.key, sealedAt.sealedKey(name), sealed).toString("utf8") };
    } catch {
      return { unreadable: "file_unreadable" };
    }
  }

  /** The stored value of the field `name`, opened; undefined with none, or one that does not open: never a clear fallback. */
  value(name: string): string | undefined {
    if (!FIELDS.includes(name)) return undefined;
    const opened = this.snapshot.fields.get(name);
    return opened && "value" in opened ? opened.value : undefined;
  }

  /** Every stored value that opens, by field name. */
  values(): Record<string, string> {
    return Object.fromEntries(FIELDS.flatMap((name) => {
      const value = this.value(name);
      return value === undefined ? [] : [[name, value] as const];
    }));
  }

  /** GET: each key's fields, whether set and where from (never a value), what it unlocks, its check, and what to enter
   *  again, with why. The ToolKeys.view shape, over the snapshot. */
  view(offers: Parameters<typeof rowUnlocks>[3] = []) {
    const again: { name: string; why: Unreadable }[] = [];
    const tools = toolsView(this.env);
    const providers = decisionsOf(this.env);
    const keys = TOOL_KEYS.map((row) => {
      const fields = row.fields.map((name) => {
        if (this.env[name]) return { name, set: true, source: "server" as const };
        const opened = this.snapshot.fields.get(name);
        if (opened && "value" in opened) return { name, set: true, source: "stored" as const };
        if (opened) again.push({ name, why: opened.unreadable });
        return { name, set: false, source: null, ...(opened ? { stored_unreadable: true as const } : {}) };
      });
      const check = fields[0].source === "stored" ? (this.snapshot.checks.get(row.id) ?? UNCHECKED) : fields[0].source === "server" ? (this.started[row.id] ?? null) : null;
      const secrets = rowSecrets(row, fields, (name) => {
        const at = this.snapshot.changed.get(name);
        return at === undefined ? null : new Date(at).toISOString();
      });
      return { id: row.id, kind: row.kind, label: row.label, ...rowUnlocks(row, tools, providers, offers), fields, secrets, check };
    });
    const reason = UNREADABLE.find((why) => again.some((field) => field.why === why));
    const reenter = reason ? { reason, fields: again.map((field) => field.name) } : null;
    const said = JSON.stringify(reenter);
    if (reenter && said !== this.said) this.say({ condition: reenter.reason, file: "store:sealed_keys", fields: reenter.fields.join(",") || "unknown" });
    this.said = said;
    return { keys, reenter };
  }

  /** Each tool key the server is started with, checked against its provider once (key-check.ts), all at once; `answered`
   *  as each answers unless `stop` came first. Held in memory for this start, like ToolKeys.checkServer. */
  async checkServer(fetchFor: (id: string) => Promise<typeof fetch | null>, stop: AbortSignal, answered: () => void): Promise<void> {
    await Promise.all(TOOL_KEYS.filter((row) => row.kind === "tool" && this.env[row.fields[0]]).map(async (row) => {
      const name = row.fields[0];
      let fetcher: typeof fetch | null;
      try {
        fetcher = await fetchFor(row.id);
      } catch (error) {
        if (stop.aborted) return;
        const why = (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? "an error";
        this.started[row.id] = { state: "not_checked", reason: `${row.label}'s key could not be checked: its check did not start (${why})`, at: new Date().toISOString() };
        answered();
        return;
      }
      if (!fetcher) return;
      const outcome = await checkKey(row, this.env[name] as string, this.env, fetcher, undefined, stop, name).catch(() => undefined);
      if (!outcome || stop.aborted) return;
      this.started[row.id] = outcome.state === "refused" ? { state: "refused", reason: `${outcome.message} when this server started: set the right one where AgentRun starts, then restart it`, at: new Date().toISOString() } : outcome;
      answered();
    }));
  }

  /** The variables of the keys the server was started with that their provider refused at the start, each with why. */
  refused(): Record<string, string> {
    return Object.fromEntries(TOOL_KEYS.flatMap((row) => {
      const check = this.started[row.id];
      return check?.state === "refused" ? [[row.fields[0], check.reason] as const] : [];
    }));
  }

  /** A PUT's check, before save(): the key it sends checked against its provider, or 422 when the provider refuses it;
   *  undefined when the body sends no key. The ToolKeys.check shape. */
  async check(id: string, body: Record<string, unknown>, fetchFor: (id: string) => Promise<typeof fetch | undefined>, stop?: AbortSignal): Promise<KeyCheck | undefined> {
    const { row, values } = this.admit(id, body);
    const name = row.fields[0];
    if (values[name] === undefined) return undefined;
    const outcome = await checkKey(row, values[name] as string, this.env, await fetchFor(row.id), undefined, stop);
    if (outcome.state === "refused") throw invalid([{ field: `values.${name}`, reason: "refused_by_provider", message: outcome.message }]);
    return outcome;
  }

  /** PUT: each of `body.values` sealed under the seal key in its own row, the check kept for the key when given; the key's
   *  other fields stay as they are. Durable before it resolves (as writeDurableSync was), so a 204 never outruns the disk. */
  async save(id: string, body: Record<string, unknown>, check?: KeyCheck): Promise<void> {
    const { row, values } = this.admit(id, body);
    for (const [name, value] of Object.entries(values)) {
      await putSealedKey(this.store, this.key!, name, value as string);
      this.snapshot.fields.set(name, { value: value as string });
      this.snapshot.seals.set(name, this.sealCheck!);
    }
    // Each saved field's time is its row's, as the store wrote it (as a restart reads it back): the others' stay.
    for (const stored of await this.store.sealedKeys.all()) if (Object.hasOwn(values, stored.name)) this.snapshot.changed.set(stored.name, stored.updatedAt);
    if (values[row.fields[0]] !== undefined) this.snapshot.checks.delete(row.id);
    if (check) this.snapshot.checks.set(row.id, check);
    await this.writeChecks();
    await this.store.flush();
  }

  /** DELETE: the key's stored fields gone, and its check. Refused only when the server sets every field of it. */
  async remove(id: string): Promise<void> {
    const row = this.row(id);
    if (row.fields.every((name) => this.env[name])) this.notServers(row.fields);
    if (!row.fields.some((name) => this.snapshot.fields.has(name))) return;
    for (const name of row.fields) {
      if (this.snapshot.fields.has(name)) await removeSealedKey(this.store, name);
      this.snapshot.fields.delete(name);
      this.snapshot.seals.delete(name);
      this.snapshot.changed.delete(name);
    }
    this.snapshot.checks.delete(row.id);
    await this.writeChecks();
    await this.store.flush();
  }

  /** The checks and fingerprints written back as one settings row. */
  private async writeChecks(): Promise<void> {
    await this.store.settings.put(TOOL_KEY_CHECKS_KEY, { v: 1, checks: Object.fromEntries(this.snapshot.checks), seals: Object.fromEntries(this.snapshot.seals) });
  }

  /** What a PUT may save: the key's row and the body's values, or 422 (the body), 409 (a field the server's, or no seal
   *  key). No message holds a value. The ToolKeys.admit, byte for byte. */
  private admit(id: string, body: Record<string, unknown>) {
    const row = this.row(id);
    const issues = unknownFields(body, ["values"]);
    const values = isObject(body.values) ? body.values : {};
    if (!Object.keys(values).length) issues.push({ field: "values", reason: body.values === undefined ? "missing" : "wrong_type", message: `values holds one or more of ${row.fields.join(", ")}, by name` });
    for (const [name, value] of Object.entries(values)) {
      const field = `values.${name}`;
      if (!(row.fields as readonly string[]).includes(name)) issues.push({ field, reason: "not_allowed", message: `The key ${row.id} has the fields ${row.fields.join(", ")}.` });
      else if (typeof value !== "string" || value === "") issues.push({ field, reason: "wrong_type", message: `${name} is text, not empty` });
      else if (CONTROL.test(value)) issues.push({ field, reason: "invalid", message: `${name} holds a control character` });
      else if (Buffer.byteLength(value) > MAX_VALUE_BYTES) issues.push({ field, reason: "too_long", message: `${name} is at most ${MAX_VALUE_BYTES} bytes` });
    }
    if (issues.length) throw invalid(issues);
    this.notServers(Object.keys(values));
    if (!this.key) throw new ApiError("no_sealing_key", `This server was handed no seal key (${SEAL_KEY_ENV}), so it keeps no tool key: it never keeps one in the clear.`);
    return { row, values };
  }

  private row(id: string) {
    const row = TOOL_KEYS.find((r) => r.id === id);
    if (!row) throw invalid([{ field: "key_id", reason: "not_an_option", message: `The tool keys are ${TOOL_KEYS.map((r) => r.id).join(", ")}.` }]);
    return row;
  }

  /** 409 when this server's own environment sets one of `names`: that one wins, and is changed where the server starts. */
  private notServers(names: readonly string[]): void {
    const held = names.filter((name) => this.env[name]);
    if (held.length) throw new ApiError("key_set_by_server", `This server is started with ${held.join(" and ")}: change it where the server is started.`, { details: { fields: held } });
  }
}

export type { ToolKeysOverStore };

/** The ToolKeys surface over the one store: the switch swaps `new ToolKeys(data, env, say)` for this, then awaits load()
 *  once at start before the first read. `env` is what the server is started with (its own keys; never a saved one), as
 *  ToolKeys takes it. */
export function toolKeysOverStore(store: ToolKeysStore, env: NodeJS.ProcessEnv, say: (fields: Record<string, string>) => void): ToolKeysOverStore {
  return new ToolKeysOverStore(store, env, say);
}

/** The bytes a value would be sealed as, for a test that checks a field is sealed at rest, not in the clear. */
export const sealedToolKeyBytes = (key: Buffer, name: string, value: string): Uint8Array => sealColumn(key, sealedAt.sealedKey(name), value);
