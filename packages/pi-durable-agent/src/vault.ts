import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { type AgentHome, type HomeAccess, inClaimedHome, readState } from "./home.js";
import { put, VaultDoc, type VaultRecord } from "./kinds.js";
import { AgentHomeError, readFamily, type Store } from "./store.js";

/** A key the host holds and the home never does: a KMS key, an OS keychain item, a 1Password item. It wraps the home's
 *  vault key. `context` is bound into the wrapping, so a wrapped key opens only for the home and key it was made for. */
export type HostKey = {
  readonly id: string;
  wrap(plain: Uint8Array, context: string): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array, context: string): Promise<Uint8Array>;
};

/** A cookie as a browser session holds it. `expires` is seconds since the epoch, as CDP gives it; absent, it is a session
 *  cookie. */
export type VaultCookie = { name: string; value: string; domain: string; path: string; expires?: number; httpOnly: boolean; secure: boolean; sameSite?: "Strict" | "Lax" | "None" };
/** A browser session's state: a local Chrome's cookies and localStorage (by origin), or a provider's context, an opaque
 *  id that the provider keeps the state behind. */
export type CapturedState =
  | { kind: "cdp"; capturedAt: string; cookies: VaultCookie[]; localStorage: Record<string, Record<string, string>> }
  | { kind: "provider-context"; capturedAt: string; provider: "browserbase" | "kernel"; contextId: string };
/** What a browser host asks of a session vault: keep a session at release, give it back at create, forget it. */
export type SessionVaultPort = {
  capture(input: { sessionKey: string; origins: string[]; state: CapturedState }): Promise<void>;
  restore(input: { sessionKey: string; origins: string[] }): Promise<CapturedState | null>;
  forget(sessionKey: string): Promise<void>;
};
/** A saved session as `list` shows it: never its contents. */
export type VaultEntry = { sessionKey: string; kind: CapturedState["kind"]; origins: string[]; capturedAt: string; provider?: string };
export type SessionVault = SessionVaultPort & {
  /** Destroy every item key and the home's vault key: every saved session, and every earlier revision of one, is dead. */
  forgetAll(): Promise<void>;
  list(): Promise<VaultEntry[]>;
  /** Every secret value `restore` has returned through this handle: for a redactor (pi-browser's `redact.values`). */
  handedOut(): string[];
};

/** The vault's keys, beside `agent.sqlite`: the home's vault key wrapped by the host key, and each item key wrapped by
 *  the home's. Kept out of the store because a pi-durable store keeps every revision: a key there could never be
 *  destroyed. */
export const VAULT_KEYS_FILE = "vault.keys";
/** The longest a session cookie (one with no `expires`) is restored after its capture, and the default. */
export const MAX_SESSION_COOKIE_AGE_MS = 24 * 60 * 60 * 1000;

/** A captured state as a capture keeps it, before the vault stamps `capturedAt`. */
type Kept = CapturedState extends infer State ? (State extends unknown ? Omit<State, "capturedAt"> : never) : never;
type KeyFile = { v: 1; agentId: string; hostKeyId: string; homeKey: { id: string; wrapped: string }; items: Record<string, string> };

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PLAIN_BYTES = 1024 * 1024;
const MAX_ORIGINS = 64;
const MAX_COOKIES = 2_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const invalid = (message: string) => new AgentHomeError("invalid", message);
const format = (message: string) => new AgentHomeError("format", message);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
const newId = () => randomBytes(12).toString("hex");

/** AES-256-GCM over `plain`, bound to `aad`: the IV, the ciphertext and the tag, in that order. */
function seal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** `seal`'s inverse; it throws when the bytes, the key or the `aad` differ from the sealing's. */
function unseal(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error("too short");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV_BYTES)).setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
}

/** A host key held in this process as 32 bytes (from a 1Password item or the environment, for one), AES-256-GCM. */
export function localHostKey(id: string, key: Uint8Array): HostKey {
  if (typeof id !== "string" || !KEY_ID.test(id)) throw invalid(`the host key id ${JSON.stringify(id)} is not letters, digits, ".", "_", ":" or "-" (at most 128)`);
  if (!(key instanceof Uint8Array) || key.length !== 32) throw invalid("a host key is 32 bytes");
  const bytes = Buffer.from(key);
  return {
    id,
    wrap: async (plain, context) => seal(bytes, Buffer.from(plain), `host-key|${id}|${context}`),
    unwrap: async (wrapped, context) => unseal(bytes, Buffer.from(wrapped), `host-key|${id}|${context}`),
  };
}

/** A session key as pi-browser's vault side takes one, so neither accepts a key the other refuses. */
const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function checkSessionKey(sessionKey: unknown): string {
  if (typeof sessionKey !== "string" || !SESSION_KEY.test(sessionKey)) throw invalid("the session key is not 1 to 128 of letters, digits, \"_\", \".\", \":\" or \"-\", starting with a letter or digit");
  return sessionKey;
}

function checkOrigins(origins: unknown): string[] {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > MAX_ORIGINS) throw invalid(`the origins are not a list of 1 to ${MAX_ORIGINS}`);
  for (const origin of origins) {
    const url = typeof origin === "string" ? URL.parse(origin) : null;
    if (!url || url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw invalid(`${JSON.stringify(origin)} is not an http(s) origin (scheme, host and port only)`);
  }
  return [...new Set(origins as string[])];
}

/** Whether a cookie for `domain` is sent to `origin`: the origin's host is the domain or under it. */
function domainMatches(domain: string, origin: string): boolean {
  const host = new URL(origin).hostname;
  const bare = domain.replace(/^\./, "").toLowerCase();
  return bare !== "" && (host === bare || host.endsWith(`.${bare}`));
}

const SAME_SITE = new Set(["Strict", "Lax", "None"]);

/** A cookie with the fields the vault keeps, or a refusal that names its index, never its value. */
function cookieOf(cookie: unknown, index: number): VaultCookie {
  const at = `the cookie at index ${index}`;
  if (!isObject(cookie)) throw invalid(`${at} is not an object`);
  const { name, value, domain, path: cookiePath, expires, httpOnly, secure, sameSite } = cookie;
  if (typeof name !== "string" || name.length > 4096) throw invalid(`${at} has no name of at most 4096 characters`);
  if (typeof value !== "string" || value.length > 16_384) throw invalid(`${at} has no value of at most 16384 characters`);
  if (typeof domain !== "string" || domain === "" || domain.length > 255) throw invalid(`${at} has no domain`);
  if (typeof cookiePath !== "string" || cookiePath.length > 1024) throw invalid(`${at} has no path`);
  if (expires !== undefined && (typeof expires !== "number" || !Number.isFinite(expires))) throw invalid(`${at} has an expiry that is not a number of seconds`);
  if (typeof httpOnly !== "boolean" || typeof secure !== "boolean") throw invalid(`${at} has no httpOnly and secure flags`);
  if (sameSite !== undefined && !SAME_SITE.has(sameSite as string)) throw invalid(`${at} has a sameSite that is not Strict, Lax or None`);
  // CDP gives a session cookie an expiry of -1 (and `session: true`): no expiry.
  return { name, value, domain, path: cookiePath, ...(typeof expires === "number" && expires > 0 ? { expires } : {}), httpOnly, secure, ...(sameSite !== undefined ? { sameSite: sameSite as VaultCookie["sameSite"] } : {}) };
}

/** What a capture keeps of `state`: only what belongs to the allowed origins. */
function keptOf(state: unknown, origins: string[]): Kept {
  if (!isObject(state)) throw invalid("the captured state is not an object");
  if (state.kind === "cdp") {
    if (!Array.isArray(state.cookies) || state.cookies.length > MAX_COOKIES) throw invalid(`the cookies are not a list of at most ${MAX_COOKIES}`);
    const cookies = state.cookies.map(cookieOf).filter((cookie) => origins.some((origin) => domainMatches(cookie.domain, origin)));
    const storage = state.localStorage ?? {};
    if (!isObject(storage)) throw invalid("the localStorage is not origins to items");
    const localStorage: Record<string, Record<string, string>> = {};
    for (const [origin, items] of Object.entries(storage)) {
      if (!isObject(items) || !Object.values(items).every((item) => typeof item === "string")) throw invalid(`the localStorage of ${origin} is not names to strings`);
      if (origins.includes(origin)) localStorage[origin] = { ...(items as Record<string, string>) };
    }
    return { kind: "cdp", cookies, localStorage };
  }
  if (state.kind === "provider-context") {
    if (state.provider !== "browserbase" && state.provider !== "kernel") throw invalid("the provider is not browserbase or kernel");
    if (typeof state.contextId !== "string" || state.contextId === "" || state.contextId.length > 512) throw invalid("the context id is not 1 to 512 characters");
    return { kind: "provider-context", provider: state.provider, contextId: state.contextId };
  }
  throw invalid("the captured state's kind is not cdp or provider-context");
}

function checkKeyFile(value: unknown): KeyFile {
  const ok = isObject(value) && value.v === 1 && typeof value.agentId === "string" && typeof value.hostKeyId === "string"
    && isObject(value.homeKey) && typeof value.homeKey.id === "string" && typeof value.homeKey.wrapped === "string"
    && isObject(value.items) && Object.values(value.items).every((item) => typeof item === "string");
  if (!ok) throw format(`${VAULT_KEYS_FILE} is not a vault key file`);
  return value as KeyFile;
}

async function readKeys(agentDir: string): Promise<KeyFile | null> {
  let text: string;
  try {
    text = await readFile(path.join(agentDir, VAULT_KEYS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return checkKeyFile(JSON.parse(text));
  } catch (error) {
    if (error instanceof AgentHomeError) throw error;
    throw format(`${VAULT_KEYS_FILE} is not JSON`);
  }
}

/** Replace `vault.keys` whole, owner-only: a new file, synced, renamed over the old one, the directory synced. */
async function writeKeys(agentDir: string, keys: KeyFile): Promise<void> {
  const final = path.join(agentDir, VAULT_KEYS_FILE);
  const temporary = path.join(agentDir, `.${VAULT_KEYS_FILE}.${newId()}`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(keys)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, final);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const dir = await open(agentDir, constants.O_RDONLY);
  try { await dir.sync(); } finally { await dir.close(); }
}

const homeKeyContext = (agentId: string, homeKeyId: string) => `home-key|${agentId}|${homeKeyId}`;
const itemKeyAad = (agentId: string, homeKeyId: string, keyId: string) => `item-key|${agentId}|${homeKeyId}|${keyId}`;
const recordAad = (agentId: string, sessionKey: string, keyId: string, kind: string) => `vault|v1|${agentId}|${sessionKey}|${keyId}|${kind}`;

/**
 * The agent's session vault, opened with the host key it is bound to. Each saved session is AES-256-GCM ciphertext in
 * `agent.vault` (a secret kind: never exported, packed or seeded into a run) under its own item key; a capture mints a
 * new item key and destroys the one before it, `forget` destroys a session's key and `forgetAll` every key. The first
 * capture binds the home to `hostKey`; any other host key is refused (`key`). Session cookies come back for at most
 * `maxSessionCookieAgeMs` after their capture (24 hours, the most; a host may only lower it). A capture is dated by its
 * state's `capturedAt` (a time to come counts as now), and one older than the session already kept is ignored. With
 * `runId`, a capture is refused (`busy`) while another live run holds that session's save lease.
 */
export function sessionVault(home: AgentHome, options: { hostKey: HostKey; maxSessionCookieAgeMs?: number; runId?: string; access?: HomeAccess; now?: () => number }): SessionVault {
  const hostKey = options?.hostKey;
  if (!isObject(hostKey) || typeof hostKey.id !== "string" || !KEY_ID.test(hostKey.id) || typeof hostKey.wrap !== "function" || typeof hostKey.unwrap !== "function") {
    throw invalid("the host key is not { id, wrap, unwrap }");
  }
  const cap = options.maxSessionCookieAgeMs ?? MAX_SESSION_COOKIE_AGE_MS;
  if (typeof cap !== "number" || !(cap > 0 && cap <= MAX_SESSION_COOKIE_AGE_MS)) throw invalid(`maxSessionCookieAgeMs is not more than 0 and at most ${MAX_SESSION_COOKIE_AGE_MS} (24 hours)`);
  const runId = options.runId;
  if (runId !== undefined && (typeof runId !== "string" || runId === "")) throw invalid("the run id is not a non-empty string");
  const now = options.now ?? Date.now;
  const handed = new Set<string>();
  const inVault = <T>(work: (store: Store, agentDir: string) => Promise<T>) => inClaimedHome(home, options.access, work);

  const homeKeyOf = async (keys: KeyFile, agentId: string): Promise<Buffer> => {
    if (keys.agentId !== agentId) throw format(`${VAULT_KEYS_FILE} belongs to agent ${keys.agentId}, not ${agentId}`);
    if (keys.hostKeyId !== hostKey.id) throw new AgentHomeError("key", `the vault is bound to host key ${keys.hostKeyId}; this host gave ${hostKey.id}`);
    let key: Uint8Array;
    try {
      key = await hostKey.unwrap(Buffer.from(keys.homeKey.wrapped, "base64"), homeKeyContext(agentId, keys.homeKey.id));
    } catch {
      throw new AgentHomeError("key", `the host key ${hostKey.id} does not open this home's vault key`);
    }
    if (key.length !== 32) throw new AgentHomeError("key", `the host key ${hostKey.id} does not open this home's vault key`);
    return Buffer.from(key);
  };

  /** Drop every item key no current session names: a forgotten or replaced session's key is destroyed here. */
  const collect = async (store: Store, agentDir: string, keys: KeyFile): Promise<void> => {
    const live = new Set(Object.values(await readFamily<VaultRecord>(store, VaultDoc)).map((record) => record.keyId));
    const items = Object.fromEntries(Object.entries(keys.items).filter(([keyId]) => live.has(keyId)));
    if (Object.keys(items).length !== Object.keys(keys.items).length) await writeKeys(agentDir, { ...keys, items });
  };

  return {
    async capture(input) {
      const sessionKey = checkSessionKey(input?.sessionKey);
      const origins = checkOrigins(input?.origins);
      const kept = keptOf(input?.state, origins);
      const stamp = (input.state as { capturedAt?: unknown }).capturedAt;
      const taken = typeof stamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stamp) ? Date.parse(stamp) : Number.NaN;
      if (!Number.isFinite(taken)) throw invalid("the captured state's capturedAt is not an ISO 8601 time");
      await inVault(async (store, agentDir) => {
        const state = await readState(store);
        const agentId = state.identity.id;
        if (runId !== undefined) {
          if (!own(state.runs, runId)) throw invalid(`${runId} is not a run of this agent`);
          const lease = own(state.leases, sessionKey);
          const live = lease && Date.parse(lease.expiresAt) > now() && own(state.runs, lease.runId)?.endedAt === undefined;
          if (lease && live && lease.runId !== runId) throw new AgentHomeError("busy", `the save lease for ${sessionKey} is held by run ${lease.runId}`);
        }
        let keys = await readKeys(agentDir);
        let homeKey: Buffer;
        if (keys) {
          homeKey = await homeKeyOf(keys, agentId);
        } else {
          homeKey = randomBytes(32);
          const homeKeyId = newId();
          const wrapped = await hostKey.wrap(homeKey, homeKeyContext(agentId, homeKeyId));
          keys = { v: 1, agentId, hostKeyId: hostKey.id, homeKey: { id: homeKeyId, wrapped: Buffer.from(wrapped).toString("base64") }, items: {} };
        }
        // When the browser was read, never later than now: an older capture never replaces a newer session.
        const at = Math.min(taken, now());
        const held = own(await readFamily<VaultRecord>(store, VaultDoc), sessionKey);
        if (held && Date.parse(held.capturedAt) > at) return;
        const capturedAt = new Date(at).toISOString();
        const plain = Buffer.from(JSON.stringify({ ...kept, capturedAt }), "utf8");
        if (plain.length > MAX_PLAIN_BYTES) throw invalid(`the captured state is ${plain.length} bytes; a session holds at most ${MAX_PLAIN_BYTES}`);
        const keyId = newId();
        const itemKey = randomBytes(32);
        const sealed = seal(itemKey, plain, recordAad(agentId, sessionKey, keyId, kept.kind));
        keys = { ...keys, items: { ...keys.items, [keyId]: seal(homeKey, itemKey, itemKeyAad(agentId, keys.homeKey.id, keyId)).toString("base64") } };
        await writeKeys(agentDir, keys);
        const record: VaultRecord = {
          kind: kept.kind, origins, capturedAt, ...(kept.kind === "provider-context" ? { provider: kept.provider } : {}),
          keyId, iv: sealed.subarray(0, IV_BYTES).toString("base64"), ciphertext: sealed.subarray(IV_BYTES).toString("base64"), alg: "A256GCM", v: 1,
        };
        await store.session.commit(async (tx) => { put(await tx.doc(VaultDoc, sessionKey, null), record); }, BACKGROUND);
        await collect(store, agentDir, keys);
      });
    },

    async restore(input) {
      const sessionKey = checkSessionKey(input?.sessionKey);
      const requested = checkOrigins(input?.origins);
      return inVault(async (store, agentDir) => {
        const record = own(await readFamily<VaultRecord>(store, VaultDoc), sessionKey);
        if (!record) return null;
        const origins = record.origins.filter((origin) => requested.includes(origin));
        if (origins.length === 0) return null;
        const agentId = (await readState(store)).identity.id;
        const keys = await readKeys(agentDir);
        if (!keys) throw format(`the vault holds ${sessionKey} but ${VAULT_KEYS_FILE} is missing`);
        const homeKey = await homeKeyOf(keys, agentId);
        const wrapped = own(keys.items, record.keyId);
        if (wrapped === undefined) throw format(`the key of ${sessionKey} is not in ${VAULT_KEYS_FILE}`);
        let captured: CapturedState;
        try {
          const itemKey = unseal(homeKey, Buffer.from(wrapped, "base64"), itemKeyAad(agentId, keys.homeKey.id, record.keyId));
          const sealed = Buffer.concat([Buffer.from(record.iv, "base64"), Buffer.from(record.ciphertext, "base64")]);
          captured = JSON.parse(unseal(itemKey, sealed, recordAad(agentId, sessionKey, record.keyId, record.kind)).toString("utf8")) as CapturedState;
        } catch {
          throw format(`the saved session ${sessionKey} does not decrypt: it was changed, or moved from another row`);
        }
        if (captured.kind !== record.kind) throw format(`the saved session ${sessionKey} is not the kind its row says`);
        const at = now();
        if (captured.kind === "provider-context") {
          handed.add(captured.contextId);
          return { ...captured, capturedAt: record.capturedAt };
        }
        const fresh = (cookie: VaultCookie) => (cookie.expires === undefined ? at - Date.parse(record.capturedAt) <= cap : cookie.expires * 1000 > at);
        const cookies = captured.cookies.filter((cookie) => origins.some((origin) => domainMatches(cookie.domain, origin)) && fresh(cookie));
        const localStorage = Object.fromEntries(Object.entries(captured.localStorage).filter(([origin]) => origins.includes(origin)));
        if (cookies.length === 0 && Object.keys(localStorage).length === 0) return null;
        for (const cookie of cookies) handed.add(cookie.value);
        for (const items of Object.values(localStorage)) for (const item of Object.values(items)) handed.add(item);
        return { kind: "cdp", capturedAt: record.capturedAt, cookies, localStorage };
      });
    },

    async forget(sessionKey) {
      const key = checkSessionKey(sessionKey);
      await inVault(async (store, agentDir) => {
        if (own(await readFamily(store, VaultDoc), key)) await store.session.commit(async (tx) => { await tx.retireDoc(VaultDoc, key); }, BACKGROUND);
        const keys = await readKeys(agentDir);
        if (keys) await collect(store, agentDir, keys);
      });
    },

    async forgetAll() {
      await inVault(async (store, agentDir) => {
        const keys = Object.keys(await readFamily(store, VaultDoc));
        if (keys.length) await store.session.commit(async (tx) => { for (const key of keys) await tx.retireDoc(VaultDoc, key); }, BACKGROUND);
        await rm(path.join(agentDir, VAULT_KEYS_FILE), { force: true });
        const dir = await open(agentDir, constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      });
    },

    async list() {
      return inVault(async (store) => Object.entries(await readFamily<VaultRecord>(store, VaultDoc)).map(([sessionKey, record]) => ({
        sessionKey, kind: record.kind, origins: [...record.origins], capturedAt: record.capturedAt, ...(record.provider !== undefined ? { provider: record.provider } : {}),
      })));
    },

    handedOut: () => [...handed],
  };
}
