// The API keys a person makes in the console (Settings → AgentRun API keys, /v2/settings/api-keys): each a Bearer token
// an app sends on /v2 and /mcp, as it would the server's own token (api-token.ts). A key is made here at random, shown
// once in the answer that made it, and kept nowhere. The store keeps an HMAC of its `Bearer` line under a key derived
// from the server's seal key, so a copy of the store names no key and a row written without the seal key opens nothing.
//
// Making and revoking a key are secret writes (secret-writes.ts): the owner's signed-in session alone, never a token,
// so a key that leaks cannot make another or outlive its revocation. A key is not the setup code: only a token the
// server was started with sets the first password (server.ts ownerRoute).
//
// Every presented header is compared with every key, in constant time, on two 32-byte digests, as bearerCheck compares
// the server's tokens. One server holds a store (its owner lock), so the keys in this process are the store's.
//
// On a server that is one person's, or has no owner, the keys are dormant: read, listed, counted and revocable, and
// opening nothing. A key never waits unseen for a later start to take it again.
//
// The server keeps no copy of a key, so it holds no value to cut a text by, as it cuts its own token. A key is found by
// its shape instead (redact/match.ts: the prefix and 43 or more of its characters), wherever a run's views, a shared
// transcript or a learned note would show one.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError, invalid } from "./errors.js";
import { uuidv7 } from "./ids.js";
import { registerSecretPage, registerSecretWrite, type SecretMeta, secretMeta, secretName } from "./secret-writes.js";
import type { Settings } from "./store/index.js";
import { isObject, unknownFields } from "./validate.js";

registerSecretWrite("createApiKey", () => true);
registerSecretWrite("revokeApiKey", () => true);
/** Where the owner makes and revokes a key in the console. */
export const API_KEYS_PAGE = "/#/settings/api-keys";
registerSecretPage(["createApiKey", "revokeApiKey"], API_KEYS_PAGE);

/** What every key made here starts with: a person who meets one can tell what it is, and the redaction finds one by it
 *  (redact/match.ts holds the same prefix, and secrets-api-key.test.mjs holds the two together). */
export const API_KEY_PREFIX = "ar_key_";
/** The store settings a key's row is kept under: this prefix, then its id. */
export const API_KEY_SETTING = "api_key:";
/** The most keys a server keeps at once. */
export const API_KEYS_LIMIT = 50;
/** The longest name a key takes. */
export const API_KEY_NAME_MAX = 64;
/** A key's last use is written to the store at most this often: a busy key costs one write a minute, not one a request. */
export const USED_EVERY_MS = 60_000;

/** A key's row, as the store keeps it. Its fields stay in this order: a row is replaced only while it still reads as
 *  it was written (Settings.replaceIf compares the JSON text). `mac`: the HMAC of `Bearer <key>`, in hex. */
type Kept = { v: 1; id: string; name: string; mac: string; created_at: string; last_used_at: string | null };

/** A key as every read answers it: never its value, a prefix, a length or a hash. */
export type ApiKeyView = { id: string; name: string; created_at: string; last_used_at: string | null; secret: SecretMeta };

/** A key this process holds. `usedAt`: its last use, as the list says it. `triedAt`: when a write of its last use was
 *  last started, kept or not, which paces the next one. */
type Held = { row: Kept; mac: Buffer; usedAt: number | null; triedAt: number | null; saving: boolean };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isDate = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isKept = (value: unknown): value is Kept =>
  isObject(value) && value.v === 1 && typeof value.id === "string" && ID.test(value.id) && typeof value.name === "string" && typeof value.mac === "string" && /^[0-9a-f]{64}$/.test(value.mac)
  && isDate(value.created_at) && (value.last_used_at === null || isDate(value.last_used_at));

/** A key's secret's metadata, named api-key:<id>: made by this server at the owner's request (source console). */
export const apiKeySecretMeta = (id: string, createdAt: string): SecretMeta => secretMeta(secretName("api-key", id), { set: true, source: "console", changedAt: createdAt });

export type ApiKeysOptions = {
  /** The clock (a test's). */
  now?: () => number;
  /** Where a row that could not be read, or a last use that could not be written, is said: fields with no secret. */
  say?: (fields: Record<string, string | number>) => void;
  /** The keys open nothing on this server (it is one person's, or has no owner): each is still read, listed, counted
   *  and revocable, so none waits unseen for a start that takes keys again. */
  dormant?: boolean;
};

export class ApiKeys {
  readonly #settings: Settings;
  readonly #macKey: Buffer;
  readonly #now: () => number;
  readonly #say: (fields: Record<string, string | number>) => void;
  readonly #dormant: boolean;
  readonly #keys = new Map<string, Held>();
  /** The rows under the keys' prefix that are no key's, by what follows the prefix in their store key: they open
   *  nothing, and a revocation by that id removes one (it counts toward the store's limit until then). */
  readonly #unreadable = new Set<string>();
  readonly #writes = new Set<Promise<void>>();
  /** The turn now taken (inTurn): settled before the next one starts, whatever it did. */
  #turn: Promise<unknown> = Promise.resolve();

  constructor(store: { settings: Settings }, sealKey: Buffer, options: ApiKeysOptions = {}) {
    this.#settings = store.settings;
    this.#macKey = createHmac("sha256", sealKey).update("agentrun-serve api keys").digest();
    this.#now = options.now ?? Date.now;
    this.#say = options.say ?? (() => undefined);
    this.#dormant = options.dormant === true;
  }

  #mac(header: string): Buffer {
    return createHmac("sha256", this.#macKey).update(header).digest();
  }

  /** Reads the store's keys. A row that is no key's (another version's, or damaged) opens nothing and is said, with
   *  how it is removed. It is no key in the list: the list names it by id in `unreadable`, and it counts toward the
   *  store's limit while it stays. */
  async load(): Promise<void> {
    this.#keys.clear();
    this.#unreadable.clear();
    for (const row of await this.#settings.all({ prefix: API_KEY_SETTING })) {
      const kept = row.value;
      if (!isKept(kept) || row.key !== API_KEY_SETTING + kept.id) {
        const id = row.key.slice(API_KEY_SETTING.length);
        this.#unreadable.add(id);
        this.#say({ condition: "api_key_unreadable", key: row.key, effect: `ignored: it opens nothing, and counts toward the limit until DELETE /v2/settings/api-keys/${encodeURIComponent(id)} removes it` });
        continue;
      }
      const used = kept.last_used_at === null ? null : Date.parse(kept.last_used_at);
      this.#keys.set(kept.id, { row: kept, mac: Buffer.from(kept.mac, "hex"), usedAt: used, triedAt: used, saving: false });
    }
  }

  #view(held: Held): ApiKeyView {
    const { id, name, created_at } = held.row;
    return { id, name, created_at, last_used_at: held.usedAt === null ? null : new Date(held.usedAt).toISOString(), secret: apiKeySecretMeta(id, created_at) };
  }

  /** How many keys open this server now: what the one-owner rule counts (server.ts loginRefused). Read it in a turn
   *  (inTurn) to decide by it: outside one, a revocation under way has taken its key out and may yet put it back. */
  get count(): number {
    return this.#keys.size;
  }

  /** One at a time: every change to which keys open the server (create, revoke) takes a turn, and so does whatever
   *  must decide by the keys as they stand once those changes have landed or been undone (the server turns Claude
   *  Code's login on in one). A turn starts when the one before it has settled, whether it kept its write or not. */
  inTurn<T>(work: () => Promise<T>): Promise<T> {
    const mine = this.#turn.then(work, work);
    this.#turn = mine.catch(() => undefined);
    return mine;
  }

  /** GET /settings/api-keys: every key, oldest first, and the most a server keeps. `refused`: why this server makes
   *  none now (server.ts apiKeysRefused), said with the list so a page can say it before anyone tries. `unreadable`:
   *  the ids of the rows that are no key's, when there are any, so their owner sees what else counts toward the limit
   *  and removes it (revoke takes such an id). */
  list(refused?: string): { keys: ApiKeyView[]; limit: number; refused?: string; unreadable?: string[] } {
    return {
      keys: [...this.#keys.values()].sort((a, b) => (a.row.id < b.row.id ? -1 : 1)).map((held) => this.#view(held)),
      limit: API_KEYS_LIMIT,
      ...(refused ? { refused } : {}),
      ...(this.#unreadable.size ? { unreadable: [...this.#unreadable].sort() } : {}),
    };
  }

  /** POST /settings/api-keys: a new key named `name`, its value as `api_key`, this once. `refused`: why this server
   *  makes no key now, asked in the create's own turn, so nothing that would refuse it starts between the answer and
   *  the write; its words are the 403's. */
  async create(body: unknown, refused?: () => Promise<string | undefined>): Promise<ApiKeyView & { api_key: string }> {
    if (!isObject(body)) throw invalid([{ field: "body", reason: "wrong_type", message: "The body is an object: {\"name\": \"...\"}." }]);
    const unknown = unknownFields(body, ["name"]);
    if (unknown.length) throw invalid(unknown);
    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    if (name === undefined) throw invalid([{ field: "name", reason: body.name === undefined ? "required" : "wrong_type", message: "name is what this key is for, in a few words: the app or the person that will hold it." }]);
    // No control character: a name is shown in a list, on one line.
    if (name === "" || name.length > API_KEY_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
      throw invalid([{ field: "name", reason: "out_of_range", message: `name is 1 to ${API_KEY_NAME_MAX} characters, on one line.` }]);
    }
    return this.inTurn(async () => {
      const why = await refused?.();
      if (why) throw new ApiError("forbidden", why);
      const id = uuidv7(this.#now());
      const value = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
      const mac = this.#mac(`Bearer ${value}`);
      const kept: Kept = { v: 1, id, name, mac: mac.toString("hex"), created_at: new Date(this.#now()).toISOString(), last_used_at: null };
      const saved = await this.#settings.putIfAbsent(API_KEY_SETTING + id, kept, { prefix: API_KEY_SETTING, limit: API_KEYS_LIMIT });
      if (saved === undefined) throw new ApiError("api_keys_full", `This server keeps at most ${API_KEYS_LIMIT} API keys. Revoke one you no longer use, then make this one.`);
      const held: Held = { row: kept, mac, usedAt: null, triedAt: null, saving: false };
      this.#keys.set(id, held);
      return { ...this.#view(held), api_key: value };
    });
  }

  /** DELETE /settings/api-keys/{id}: the key opens nothing from now on. In a turn of its own (inTurn): while its
   *  removal is under way the key is out of this process, and a removal that fails puts it back, so nothing decides by
   *  the count in between. */
  async revoke(id: string): Promise<void> {
    return this.inTurn(async () => {
      const held = this.#keys.get(id);
      if (!held && this.#unreadable.has(id)) {
        // A row the start could not read as a key: it opens nothing already, and its removal frees its place.
        await this.#settings.remove(API_KEY_SETTING + id);
        this.#unreadable.delete(id);
        return;
      }
      if (!held) throw new ApiError("not_found", "No API key has that id: it was revoked, or never made.");
      // Out of this process first, so a request that races the store's write is refused already.
      this.#keys.delete(id);
      try {
        await this.#settings.remove(API_KEY_SETTING + id);
      } catch (error) {
        // Not removed from the store: it would open again at the next start, so it stays listed, to be revoked again.
        this.#keys.set(id, held);
        throw error;
      }
    });
  }

  /** The id of the key whose `Bearer` line `header` is, else undefined. Every key is compared on every call, with no
   *  early return, so the time taken says neither whether one matched nor which. A match is the key's last use. */
  used(header: string | undefined): string | undefined {
    if (this.#dormant) return undefined;
    const given = this.#mac(String(header ?? ""));
    let found: Held | undefined;
    for (const held of this.#keys.values()) {
      const hit = timingSafeEqual(given, held.mac);
      found = hit ? held : found;
    }
    if (found) this.#touch(found);
    return found?.row.id;
  }

  /** Marks `held` used now, and writes it to the store when the last try is USED_EVERY_MS old. Paced by the try, kept
   *  or not: while the store refuses writes, a busy key costs one try and one line a minute, not one a request. The row
   *  is replaced only while it reads as this process last wrote it, so a write that loses to a revocation writes
   *  nothing. */
  #touch(held: Held): void {
    const now = this.#now();
    held.usedAt = now;
    if (held.saving || (held.triedAt !== null && now - held.triedAt < USED_EVERY_MS)) return;
    held.saving = true;
    held.triedAt = now;
    const next: Kept = { ...held.row, last_used_at: new Date(now).toISOString() };
    const write = this.#settings.replaceIf(API_KEY_SETTING + held.row.id, held.row, next)
      .then((replaced) => {
        if (replaced) held.row = next;
      })
      .catch((error: unknown) => this.#say({ condition: "api_key_use_not_saved", id: held.row.id, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        held.saving = false;
        this.#writes.delete(write);
      });
    this.#writes.add(write);
  }

  /** Waits for the last-use writes under way, before the store closes. */
  async close(): Promise<void> {
    await Promise.all([...this.#writes]);
  }
}
