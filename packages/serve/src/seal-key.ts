// The seal key every secret is kept under (tool keys, MCP credentials, sign-ins, trigger secrets: store/seal.ts). The
// server never starts without one: AGENTRUN_SEAL_KEY as it was handed (the launcher's pipe, or the environment), else
// the one in agentrun/seal.key under the config home (XDG_CONFIG_HOME, else ~/.config), made there at the first start.
// The same rules as the launcher's (launcher/agentrun-serve):
//   - made as 32 random bytes in base64, 0600, in a directory of its own that is 0700, written whole beside its name and
//     then linked to it, so two starts at once read one key, and only its path is ever printed;
//   - a plain mkdir's directory (0755) with no key yet, this user's own, is tightened to 0700 before the key is made;
//   - a key or a directory another user can read is refused, never changed; a linked directory is refused, never followed.
// It is outside the data directory on purpose: a copy of that holds the secrets as ciphertext alone.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, type Stats, writeSync } from "node:fs";
import { join } from "node:path";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";

export const SEAL_KEY_DIR = "agentrun";
export const SEAL_KEY_FILE = "seal.key";

/** The server has no seal key it can use, in words: it does not start. */
export class SealKeyRefused extends Error {
  override name = "SealKeyRefused";
}

/** The key, as bytes and as its base64 text; where it is kept (null when it was handed over); whether this start made it. */
export type SealKey = { readonly key: Buffer; readonly text: string; readonly path: string | null; readonly generated: boolean };

/** The config home a seal key is kept under: XDG_CONFIG_HOME, else ~/.config; undefined with neither. */
export const sealKeyHome = (env: NodeJS.ProcessEnv): string | undefined => env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : undefined);

const HOW = `Hand the server ${SEAL_KEY_ENV} (32 random bytes in base64, e.g. \`openssl rand -base64 32\`), or let it keep one in ${SEAL_KEY_DIR}/${SEAL_KEY_FILE} under $XDG_CONFIG_HOME (~/.config by default), made at the first start.`;
const refused = (why: string) => new SealKeyRefused(`No seal key: ${why}. ${HOW}`);

function lstatOf(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** No group or other permission bits: only its owner can read it. */
const ownerOnly = (stats: Stats) => (stats.mode & 0o077) === 0;
const mine = (stats: Stats) => typeof process.getuid !== "function" || stats.uid === process.getuid();

/**
 * The server's seal key: `given` (AGENTRUN_SEAL_KEY as it was handed) when set, else the one kept under `configHome`,
 * made there at the first start. Throws SealKeyRefused, in words, when there is none it can use: the server does not start.
 */
export function ensureSealKey(given: string | undefined, { configHome }: { configHome: string | undefined }): SealKey {
  if (given) {
    const key = sealKeyOf(given);
    if (!key) throw refused(`${SEAL_KEY_ENV} is set but is not 32 bytes in base64`);
    return { key, text: given, path: null, generated: false };
  }
  if (!configHome) throw refused(`${SEAL_KEY_ENV} is not set, and there is no config directory to keep one in (XDG_CONFIG_HOME or HOME)`);
  const dir = join(configHome, SEAL_KEY_DIR);
  const file = join(dir, SEAL_KEY_FILE);
  const before = lstatOf(dir);
  if (before?.isSymbolicLink()) throw refused(`${dir} is a link, and a seal key's directory is never followed through one: make it a directory of its own (mode 0700)`);
  if (before && !before.isDirectory()) throw refused(`${dir} is not a directory`);
  let generated = false;
  if (!lstatOf(file)) {
    // A plain mkdir's directory, this user's own, with no key yet: tightened before a key is written in it.
    if (before && mine(before) && !ownerOnly(before)) chmodSync(dir, 0o700);
    if (!before) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (error) {
        throw refused(`${dir} could not be made (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
      }
    }
    const text = randomBytes(32).toString("base64");
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
        generated = true;
      } catch (error) {
        // Another start made it first: each start reads the one there.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } catch (error) {
      throw refused(`${file} could not be written (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  const held = lstatOf(dir);
  if (!held || held.isSymbolicLink() || !held.isDirectory() || !mine(held) || !ownerOnly(held)) {
    throw refused(`${dir} can be read by another user, or is not this user's: make it 0700 (chmod 700 ${dir}); it is never changed for you once a key is in it`);
  }
  const stats = lstatOf(file);
  if (!stats || !stats.isFile() || !mine(stats) || !ownerOnly(stats)) {
    throw refused(`${file} is not a file only this user can read: make it 0600 (chmod 600 ${file}), or remove it to have a new one made at the next start`);
  }
  const text = readFileSync(file, "utf8").split("\n")[0]!.trim();
  const key = sealKeyOf(text);
  if (!key) throw refused(`${file} does not hold 32 bytes in base64: remove it to have a new one made at the next start (the secrets kept under the old one will not open)`);
  return { key, text, path: file, generated };
}

/** The line a start prints about its seal key: where it is, never the key. */
export function sealKeyLine(seal: SealKey): string {
  if (!seal.path) return `agentrun-serve: the seal key is ${SEAL_KEY_ENV}, as it was handed`;
  return `agentrun-serve: ${seal.generated ? "made a new seal key" : "the seal key is"} at ${seal.path} (0600): every secret saved here opens with it alone, so keep it, and keep it apart from the data directory`;
}
