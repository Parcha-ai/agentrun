// The seal key every secret is kept under (tool keys, MCP credentials, sign-ins, trigger secrets: store/seal.ts). The
// server never starts without one: AGENTRUN_SEAL_KEY as it was handed (the launcher's pipe, or the environment), else the
// one in seal/seal.key in the data directory, beside the store, made there at the server's first start. There is no other
// place a key is read from. It lives and dies with the data (a disk, a volume): a copy of the data directory is a copy of
// the secrets, so it is backed up with them.
//   - made as 32 random bytes in base64, 0600, in a directory of its own that is 0700, written whole beside its name and
//     then linked to it, so two starts at once read one key, and only its path is ever printed;
//   - a plain mkdir's directory (0755) with no key yet, this user's own, is tightened to 0700 before the key is made;
//   - a key or a directory another user can read is refused, never changed; a linked directory, or one another user owns,
//     is refused, never followed or written into.
// The store records the key's fingerprint (an HMAC of a fixed label under the key: never the key, nor a hash of it alone),
// and every process that opens the store (the server, a runner, the `import` command) checks the key it holds against it
// (bootSealKey). A store whose secrets were sealed with another key is refused, in words, and no key is ever made over
// sealed secrets, in the store or beside it in the data directory: a lost key file is not replaced by a new one. A store
// with no fingerprint takes a key that opens every value it keeps sealed, or any key when it keeps none. The server's
// start makes a key and records it (and the import's, which sets a data directory up as the server does); a runner reads
// one and checks it, and never makes or records one. Several data directories in one process each keep their own key.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, type Stats, writeSync } from "node:fs";
import { join } from "node:path";
import { unseal } from "@parcha/pi-durable-agent";
import type { Store } from "./store/index.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { handedSecret, holdSealKey } from "./secrets.js";
import { webhookKeptIn, webhookSecretIn } from "./webhooks.js";

/** The seal key's own directory in the data directory, and its file there. */
export const SEAL_KEY_DIR = "seal";
export const SEAL_KEY_FILE = "seal.key";
/** The store setting that records the key's fingerprint. */
export const SEAL_KEY_SETTING = "seal_key";
/** The fixed label the fingerprint is an HMAC of, under the key. */
const FINGERPRINT_LABEL = "agentrun seal key fingerprint v1";
/** The refusal of a store whose secrets another key sealed, word for word. */
export const SEALED_ELSEWHERE = `this store's secrets were sealed with another key; hand the server the original ${SEAL_KEY_ENV}`;

/** The server has no seal key it can use, in words: it does not start. */
export class SealKeyRefused extends Error {
  override name = "SealKeyRefused";
}

/** The key held is not the one the store's secrets were sealed with: it does not start. */
export class SealKeyNotTheStores extends SealKeyRefused {
  override name = "SealKeyNotTheStores";
}

/** The key, as bytes and as its base64 text; where it is kept (null when it was handed over); whether this start made it. */
export type SealKey = { readonly key: Buffer; readonly text: string; readonly path: string | null; readonly generated: boolean };
/** A key a start booted: on this process's redaction list (secrets.ts holdSealKey) until release(), which its holder calls
 *  as it closes. */
export type BootedSealKey = SealKey & { readonly release: () => void };

/** Where the data directory `dataDir` keeps its seal key. */
export const sealKeyPath = (dataDir: string): string => join(dataDir, SEAL_KEY_DIR, SEAL_KEY_FILE);

const HOW = `Hand the server ${SEAL_KEY_ENV} (32 random bytes in base64, e.g. \`openssl rand -base64 32\`), or let it keep one in ${SEAL_KEY_DIR}/${SEAL_KEY_FILE} in its data directory, made at the first start.`;
const refused = (why: string) => new SealKeyRefused(`No seal key: ${why}. ${HOW}`);

function lstatOf(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    // Absent, or under a path that is a file (ENOTDIR): nothing there; making it then fails, in words.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}
/** No group or other permission bits: only its owner can read it. */
const ownerOnly = (stats: Stats) => (stats.mode & 0o077) === 0;
const mine = (stats: Stats) => typeof process.getuid !== "function" || stats.uid === process.getuid();
const linked = (dir: string) => refused(`${dir} is a link, and a seal key's directory is never followed through one: make it a directory of its own (mode 0700)`);

/** The key kept in `dir`, checked: undefined when there is none (no directory, or no file in it). Throws SealKeyRefused
 *  for a linked directory, a key or directory another user can read, or a file that holds no key: never changed. */
function keptIn(dir: string): SealKey | undefined {
  const file = join(dir, SEAL_KEY_FILE);
  const held = lstatOf(dir);
  if (!held) return undefined;
  if (held.isSymbolicLink()) throw linked(dir);
  if (!held.isDirectory()) throw refused(`${dir} is not a directory`);
  const stats = lstatOf(file);
  if (!stats) return undefined;
  if (!mine(held) || !ownerOnly(held)) {
    throw refused(`${dir} can be read by another user, or is not this user's: make it 0700 (chmod 700 ${dir}); it is never changed for you once a key is in it`);
  }
  if (!stats.isFile() || !mine(stats) || !ownerOnly(stats)) {
    throw refused(`${file} is not a file only this user can read: make it 0600 (chmod 600 ${file})`);
  }
  const text = readFileSync(file, "utf8").split("\n")[0]!.trim();
  const key = sealKeyOf(text);
  if (!key) throw refused(`${file} does not hold 32 bytes in base64`);
  return { key, text, path: file, generated: false };
}

/** Writes `text` as the key in `dir` (made 0700, or a plain mkdir's directory of this user's tightened to it), whole
 *  beside its name and then linked, so a start racing another reads the one there. Whether this call wrote it. */
function writeIn(dir: string, text: string): boolean {
  const file = join(dir, SEAL_KEY_FILE);
  const before = lstatOf(dir);
  if (before?.isSymbolicLink()) throw linked(dir);
  if (before && !before.isDirectory()) throw refused(`${dir} is not a directory`);
  if (before && !mine(before)) throw refused(`${dir} is not this user's: a seal key is never written into another user's directory`);
  // A plain mkdir's directory, this user's own, with no key yet: tightened before a key is written in it.
  if (before && mine(before) && !ownerOnly(before)) chmodSync(dir, 0o700);
  if (!before) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw refused(`${dir} could not be made (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
    }
  }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, `${text}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, file);
      return true;
    } catch (error) {
      // Another start made it first: each start reads the one there.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  } catch (error) {
    throw refused(`${file} could not be written (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The key file's rules alone, with no store to check against: `given` (AGENTRUN_SEAL_KEY as it was handed) when set,
 *  else the one kept in `dataDir`, made there when there is none. A start never calls this by itself: bootSealKey checks
 *  the key against the store first, and makes one only for a store that holds no secret. */
export function ensureSealKey(given: string | undefined, { dataDir }: { dataDir: string }): SealKey {
  if (given) {
    const key = sealKeyOf(given);
    if (!key) throw refused(`${SEAL_KEY_ENV} is set but is not 32 bytes in base64`);
    return { key, text: given, path: null, generated: false };
  }
  const dir = join(dataDir, SEAL_KEY_DIR);
  const kept = keptIn(dir);
  if (kept) return kept;
  const generated = writeIn(dir, randomBytes(32).toString("base64"));
  const made = keptIn(dir);
  if (!made) throw refused(`${join(dir, SEAL_KEY_FILE)} could not be read back`);
  return { ...made, generated };
}

/** The fingerprint the store records of `key`: an HMAC of a fixed label under it. Neither the key nor a hash of it alone. */
export const sealKeyFingerprint = (key: Buffer): string => createHmac("sha256", key).update(FINGERPRINT_LABEL).digest("base64url");

/** The fingerprint a store setting's value records: undefined with none, null for one that does not read. */
function recordedIn(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const record = value as { v?: unknown; fingerprint?: unknown } | null;
  return record?.v === 1 && typeof record.fingerprint === "string" ? record.fingerprint : null;
}
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** What a store holds that names its key: the fingerprint it records, and, with none recorded, the values it keeps
 *  sealed and those its data directory keeps sealed beside it (each a check of whether a key opens it). */
type StoreSeal = { readonly fingerprint: string | null | undefined; readonly sealed: ReadonlyArray<(key: Buffer) => boolean> };

/** The store slice the check reads and writes. */
export type SealKeyStore = Pick<Store, "settings" | "sealedSecrets">;

function opensUnder(key: Buffer, sealed: Uint8Array, aad: string): boolean {
  try {
    unseal(key, Buffer.from(sealed), aad);
    return true;
  } catch {
    return false;
  }
}

/** The value data directory `dataDir` keeps sealed beside the store, under the same key: the outbound webhook's signing
 *  secret (webhooks.ts), as a check of whether a key opens it. */
function sealedBeside(dataDir: string): Array<(key: Buffer) => boolean> {
  return webhookKeptIn(dataDir) ? [(key) => "secret" in (webhookSecretIn(dataDir, key) ?? {})] : [];
}

async function storeSealOf(store: SealKeyStore, dataDir: string): Promise<StoreSeal> {
  const fingerprint = recordedIn(await store.settings.get(SEAL_KEY_SETTING));
  if (fingerprint !== undefined) return { fingerprint, sealed: [] };
  const rows = (await store.sealedSecrets.all()).map((row) => (key: Buffer) => opensUnder(key, row.sealed, row.aad));
  return { fingerprint, sealed: [...rows, ...sealedBeside(dataDir)] };
}

const holdsSecrets = (seal: StoreSeal) => seal.fingerprint !== undefined || seal.sealed.length > 0;

/** Whether `key` is the store's, or why not: the one its fingerprint records; with none recorded, one that opens every
 *  value it keeps sealed (some opening and some not is values sealed under more than one key: no key is taken over
 *  that), or any key for a store that keeps none. */
function notTheStoresWhy(seal: StoreSeal, key: Buffer): string | undefined {
  if (seal.fingerprint === null) return ` (the store's record of its key, setting ${SEAL_KEY_SETTING}, does not read)`;
  if (seal.fingerprint !== undefined) return sameText(seal.fingerprint, sealKeyFingerprint(key)) ? undefined : "";
  const shut = seal.sealed.filter((opens) => !opens(key)).length;
  if (shut === 0) return undefined;
  return shut === seal.sealed.length ? "" : ` (${shut} of the ${seal.sealed.length} values it keeps sealed do not open under this key: they were sealed under more than one)`;
}

const notTheStores = (why: string) => new SealKeyNotTheStores(`${SEALED_ELSEWHERE}. ${why}`);
const PUT_BACK = `put the original there (mode 0600, in a 0700 directory), or hand it as ${SEAL_KEY_ENV}`;

/** Who boots the key: the server's start makes one for a store that holds no secret and records its fingerprint, and so
 *  does the import, which sets a data directory up as the server does (never its dry run); a runner only reads one and
 *  checks it. */
export type SealKeyRole = "server" | "runner" | "import";

export interface BootSealKeyOptions {
  /** AGENTRUN_SEAL_KEY as this process was handed it (secrets.ts handedSecret when this is not given). */
  readonly given?: string | undefined;
  /** Who boots it (SealKeyRole): "server" by default. */
  readonly role?: SealKeyRole;
  /** Told the start line when a key is made (stderr by default). */
  readonly say?: (line: string) => void;
  /** false: nothing is written (a dry run). With no key, a store that holds no secret then has none (undefined). */
  readonly write?: boolean;
}

async function sealKeyFor(store: SealKeyStore, dataDir: string, given: string | undefined, role: SealKeyRole, write: boolean): Promise<SealKey | undefined> {
  const kept = await storeSealOf(store, dataDir);
  const dir = join(dataDir, SEAL_KEY_DIR);
  const file = join(dir, SEAL_KEY_FILE);
  let seal: SealKey | undefined;
  if (given) {
    const key = sealKeyOf(given);
    if (!key) throw refused(`${SEAL_KEY_ENV} is set but is not 32 bytes in base64`);
    const why = notTheStoresWhy(kept, key);
    if (why !== undefined) throw notTheStores(`The ${SEAL_KEY_ENV} handed now is not it${why}.`);
    seal = { key, text: given, path: null, generated: false };
  } else {
    seal = keptIn(dir);
    if (seal) {
      const why = notTheStoresWhy(kept, seal.key);
      if (why !== undefined) throw notTheStores(`${file} holds another key${why}: ${PUT_BACK}.`);
    } else if (holdsSecrets(kept)) {
      // No key here, over a store that holds secrets: never a new one.
      throw notTheStores(`There is no key in ${file}: ${PUT_BACK}.`);
    } else if (role === "runner") {
      // A runner never makes a key: it reads the one the server made.
      throw refused(`there is none in ${file}, and this store records none: start the server on this data directory first, which makes it, or hand ${SEAL_KEY_ENV}`);
    } else {
      // A store that holds no secret: its key is made here, at the server's first start (or the import's, which sets a data
      // directory up as the server does when none has); a dry run makes none, and has none.
      if (!write) return undefined;
      seal = ensureSealKey(undefined, { dataDir });
    }
  }
  if (write && role !== "runner" && kept.fingerprint === undefined) {
    // Recorded once: the first server to record it wins, and one that loses to another key's record is refused.
    const fingerprint = sealKeyFingerprint(seal.key);
    const now = recordedIn(await store.settings.putIfAbsent(SEAL_KEY_SETTING, { v: 1, fingerprint }));
    if (now === undefined || now === null || !sameText(now, fingerprint)) {
      // A key this start made for a store another process recorded first seals nothing: it goes.
      if (seal.generated && seal.path) rmSync(seal.path, { force: true });
      throw notTheStores("Another process recorded its key in this store first.");
    }
  }
  return seal;
}

/** `env` (one withSecrets made) with `text` as its seal key, read by name and never enumerated, as withSecrets gives a
 *  secret: so what reads the key from it gets the one its start checked against its store. */
export function withSealKey(env: NodeJS.ProcessEnv, text: string): NodeJS.ProcessEnv {
  // A copy, every property as it is (a withSecrets secret stays unenumerable, its saved-keys mark too), the key in place of
  // whatever it held.
  const out: NodeJS.ProcessEnv = {};
  for (const name of Reflect.ownKeys(env)) if (name !== SEAL_KEY_ENV) Object.defineProperty(out, name, Object.getOwnPropertyDescriptor(env, name)!);
  Object.defineProperty(out, SEAL_KEY_ENV, { value: text, enumerable: false, writable: false, configurable: false });
  return out;
}

/** The line a start prints about its seal key: where it is, never the key. */
export function sealKeyLine(seal: SealKey): string {
  if (!seal.path) return `agentrun-serve: the seal key is ${SEAL_KEY_ENV}, as it was handed`;
  return `agentrun-serve: ${seal.generated ? "made a new seal key" : "the seal key is"} at ${seal.path} (0600), beside the store: every secret saved here opens with it alone, so back it up with the data directory, and keep the two together`;
}

/** A refusal in the words a start says: a key that is not the store's, or none it can use. */
function startRefusal(error: SealKeyRefused): SealKeyRefused {
  if (error instanceof SealKeyNotTheStores) return new SealKeyNotTheStores(`agentrun-serve does not start: ${error.message}`, { cause: error });
  return new SealKeyRefused(`agentrun-serve does not start without a seal key. ${error.message}`, { cause: error });
}

/** The seal key every entry point boots the one way, once its store is open: the server, a runner (beside the server or
 *  its own process) and the `import` command all call this, so there is one rule. The key handed over (AGENTRUN_SEAL_KEY),
 *  else the one in `dataDir`, checked against what `store` records of its key (refused, in words, when it is not the
 *  store's). The server's start makes a key in `dataDir` for a store that holds no secret and records its fingerprint; a
 *  runner or the import never makes or records one. The key is on this process's redaction list until release()
 *  (secrets.ts holdSealKey); its holder passes it on itself (withSealKey), and nothing reads it from the process by name. Throws SealKeyRefused with the start message when there is no key it can use. */
export async function bootSealKey(store: SealKeyStore, dataDir: string, options?: BootSealKeyOptions & { readonly write?: true }): Promise<BootedSealKey>;
export async function bootSealKey(store: SealKeyStore, dataDir: string, options: BootSealKeyOptions): Promise<BootedSealKey | undefined>;
export async function bootSealKey(store: SealKeyStore, dataDir: string, options: BootSealKeyOptions = {}): Promise<BootedSealKey | undefined> {
  const given = "given" in options ? options.given : handedSecret(SEAL_KEY_ENV);
  const say = options.say ?? ((line: string) => void process.stderr.write(line));
  let seal: SealKey | undefined;
  try {
    seal = await sealKeyFor(store, dataDir, given, options.role ?? "server", options.write !== false);
  } catch (error) {
    if (error instanceof SealKeyRefused) throw startRefusal(error);
    throw error;
  }
  if (!seal) return undefined;
  // On this process's redaction list while it is open (secrets.ts holdSealKey); each holder passes its own key on.
  const release = holdSealKey(seal.text);
  if (seal.generated) say(`${sealKeyLine(seal)}\n`);
  return { ...seal, release };
}
