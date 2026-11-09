// The secrets serve and each run's process hold: in this module's memory, never in the environment. The launcher
// (launcher/agentrun-serve) hands them to serve over a pipe, and serve hands each run's process those it needs over a
// pipe of its own; each side reads its pipe as this module loads, before anything else, and closes it. A value set on
// process.env would be the default environment of every child, so none is: code that needs one asks `secret(name)`,
// or gets an env object `withSecrets` made for its own use, which no spawn takes. In the server, a secret it was not
// started with may be a tool key saved through the settings API (tool-keys.ts): read by the same name, opened when asked
// for, and handed to a run's process over its pipe like the launcher's, at each launch.
//
// With no launcher (a test that starts the server in its own process), a secret set in the environment is read from it.
import { closeSync, existsSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { keyShaped } from "./secret-cut.js";
import { MIN_SECRET } from "./learn/secrets.js";

/** The pipe and how many bytes of it are the secrets: the launcher's, or serve's to a run's process. */
export const SECRETS_FD_ENV = "AGENTRUN_SECRETS_FD";
export const SECRETS_LEN_ENV = "AGENTRUN_SECRETS_LEN";

/** The names of the secrets: the launcher's one list, which its `env -u`, serve's handover and the tests all read. Every
 *  key pi-ai's providers read is on it (model.ts' PROVIDER_KEYS, which the custody test checks against pi-ai's own
 *  table), so a key set for any provider's model is held here, never left in an environment. */
export const SECRET_NAMES: readonly string[] = (() => {
  const launcher = readFileSync(new URL("../launcher/agentrun-serve", import.meta.url), "utf8");
  const list = /^SECRETS='([A-Z0-9_ ]+)'$/m.exec(launcher)?.[1];
  if (!list) throw new Error("agentrun-serve's launcher names no SECRETS");
  return list.split(" ").filter(Boolean);
})();

/** A run's remote MCP servers' credentials, the one entry its pipe holds that is not on the launcher's list: JSON, each
 *  server the run's revision grants a tool of with its URL now and, when that is the run's pinned one, its headers
 *  (mcp-gateway.ts McpCredentials). A run that grants none gets no entry. */
export const MCP_AUTH = "AGENTRUN_MCP_AUTH";

/** The decision keys among them: a run's process gets them only on its decision descriptor (decisions.ts), never with
 *  the secrets on its pipe, which are its tools' environment. */
export const DECISION_KEYS: readonly string[] = ["TYPESAFE_API_KEY", "PARALLEL_API_KEY"];

const held = new Map<string, string>();
/** Whether this process was handed its secrets over a pipe, and closed it. */
let handed: { fd: number; closed: boolean } | undefined;
/** The pair a run's saved sign-in comes as on the same pipe (sign-ins.ts): JSON `{provider, ref, save}`, held apart from
 *  the secrets, so it is no tool's environment and no key a scan looks for by name. */
const SIGN_IN_PAIR = "AGENTRUN_SIGN_IN";
let signIn: string | undefined;

/** NAME=VALUE pairs, each ended by a NUL. */
const encode = (pairs: Iterable<readonly [string, string]>): Buffer => Buffer.concat([...pairs].map(([name, value]) => Buffer.from(`${name}=${value}\0`)));
function decode(bytes: Buffer): void {
  for (const pair of bytes.toString("utf8").split("\0")) {
    const at = pair.indexOf("=");
    if (at > 0 && (SECRET_NAMES.includes(pair.slice(0, at)) || pair.slice(0, at) === MCP_AUTH)) held.set(pair.slice(0, at), pair.slice(at + 1));
    else if (pair.slice(0, at) === SIGN_IN_PAIR) signIn = pair.slice(at + 1);
  }
}

/** Exactly `length` bytes of `fd`: the writer keeps its end open (the launcher's FIFO is open read-write), so there is
 *  no end of file to wait for. */
function readExactly(fd: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let read = 0; read < length; ) {
    const got = readSync(fd, bytes, read, length - read, null);
    if (got === 0) throw new Error(`the secrets' pipe ended after ${read} of ${length} bytes`);
    read += got;
  }
  return bytes;
}

{
  const fd = process.env[SECRETS_FD_ENV];
  const length = process.env[SECRETS_LEN_ENV];
  delete process.env[SECRETS_FD_ENV];
  delete process.env[SECRETS_LEN_ENV];
  if (fd !== undefined) {
    handed = { fd: Number(fd), closed: false };
    try {
      decode(readExactly(handed.fd, Number(length ?? 0)));
    } finally {
      // Every child this process starts would otherwise get the pipe: an inherited descriptor has no close-on-exec.
      closeSync(handed.fd);
      handed.closed = true;
    }
  }
  for (const name of SECRET_NAMES) {
    const value = process.env[name];
    if (value === undefined) continue;
    if (!held.has(name)) held.set(name, value);
    delete process.env[name];
  }
}

/** Reads a tool key a person saved through a server's settings API (tool-keys.ts), by name, opened when asked for. Each
 *  server hands its own to what reads for it (its reading, its runs' handover), never through this module, so two
 *  servers in one process never read each other's saved keys. A run's process has none: it gets what it needs over its
 *  pipe, as it gets the rest. */
export type StoredKeys = (name: string) => string | undefined;

/** A name an environment gives a secret: a key, a token, a secret or a password. */
const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i;

/** This host's secrets, for a scan of what a run wrote: each one the launcher lists, as this process holds it (never in
 *  the environment once handed over, so a scan of process.env alone sees none of them), and beside it the key a person
 *  saved under that name on the server `stored` reads for (a run that names its tool is handed it), and the value of
 *  every other key, token, secret or password `env` names. One shorter than the checker's MIN_SECRET,
 *  whitespace aside, matches too much text by chance to be refused, and is left out. */
export const hostSecrets = (env: NodeJS.ProcessEnv, stored?: StoredKeys): string[] => {
  const held = [...SECRET_NAMES.flatMap((name) => [secret(name) ?? "", stored?.(name) ?? ""]), ...mcpSecretValues(mcpCredentials())];
  const named = Object.entries(env).filter(([name]) => SECRET_NAME.test(name) && !SECRET_NAMES.includes(name)).map(([, value]) => value ?? "");
  return [...new Set([...held, ...named])].filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET);
};

/** The secrets this process made itself for want of one it was handed: the seal key a start keeps under the config home
 *  (seal-key.ts) when none was given. Read last, after the handed and the environment's, so a given one always wins;
 *  never in the environment, so no child inherits it. */
const made = new Map<string, string>();

/** Holds a secret this process made (seal-key.ts' generated seal key), read by name like one it was handed. */
export function holdMadeSecret(name: string, value: string): void {
  if (!SECRET_NAMES.includes(name)) throw new Error(`${name} is not a secret the launcher lists`);
  made.set(name, value);
}

/** A secret this process was started with: as handed over, else (no launcher) as its environment has it now, else one it
 *  made itself (holdMadeSecret). */
const own = (name: string): string | undefined => held.get(name) ?? process.env[name] ?? made.get(name);

/** A secret this process was handed (over its pipe, or in its environment), never one it made itself: what a start asks
 *  to tell a handed seal key from none, so a second server in one process makes or reads its own and is not handed the
 *  first one's. */
export const handedSecret = (name: string): string | undefined => held.get(name) ?? process.env[name];

/** A secret's value: this process's own, which wins (tool-keys.ts' `source: "server"` is exactly these), else a key
 *  saved on the server `stored` reads for, opened now. One that does not open is absent, never a crash. */
export const secret = (name: string, stored?: StoredKeys): string | undefined => {
  const value = own(name);
  return value || (stored?.(name) ?? value);
};

/** The names whose values a withSecrets env took from the keys saved on the server (StoredKeys), not its own. */
const SAVED = Symbol("agentrun.saved-keys");

/** `env` with the secrets this process holds, for this process's own reading: every one, or (`"own"`) only those it was
 *  started with, none saved. Each secret is a property that does not enumerate: `env.NAME` reads it, while a spread of
 *  the object, or a spawn given it (Node builds a child's environment from its enumerable keys), leaves it out. Which
 *  came from a saved key is said too (savedIn), never a value. */
export const withSecrets = (env: NodeJS.ProcessEnv, which: "all" | "own" = "all", stored?: StoredKeys): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...env };
  const saved = new Set<string>();
  for (const name of SECRET_NAMES) {
    const value = which === "own" ? own(name) : secret(name, stored);
    if (value !== undefined) Object.defineProperty(out, name, { value, enumerable: false, writable: false, configurable: false });
    if (value !== undefined && which === "all" && !own(name)) saved.add(name);
  }
  Object.defineProperty(out, SAVED, { value: saved, enumerable: false });
  return out;
};

/** The secrets of `env` (one withSecrets made) that were saved on the server, not its own, by name. */
export const savedIn = (env: NodeJS.ProcessEnv): ReadonlySet<string> => (env as { [SAVED]?: Set<string> })[SAVED] ?? new Set();

/** The environment a child gets: `env` with every secret name taken out, and every other name shaped like a key
 *  (secret-cut.ts' keyShaped) with them, a backstop for a key no list names. Nothing passes the rule by name: a run's own
 *  descriptors (its secrets' pipe, its decision keys') are set on the environment after this cut. The server holds only
 *  the names on the launcher's list, so such a key stays in its own environment, never in a run's or another child's.
 *  Every environment serve builds for a child from its own takes this cut. */
export const withoutSecrets = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAMES.includes(name) && !keyShaped(name)));

/** What a run's process is handed: the secrets named `names` that this process holds, or its server saved (`stored`),
 *  as its pipe carries them. */
export function handover(names: readonly string[], stored?: StoredKeys): Buffer {
  return encode(names.flatMap((name) => {
    const value = secret(name, stored);
    return value === undefined ? [] : [[name, value] as const];
  }));
}

/** The MCP credentials this process was handed (MCP_AUTH), by server; none when it was handed none. */
export function mcpCredentials(): Record<string, { url: string; headers?: Record<string, string>; unopened?: string }> {
  try {
    const parsed: unknown = JSON.parse(held.get(MCP_AUTH) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as never) : {};
  } catch {
    return {};
  }
}

/** Every header value of `credentials`: what a secret scan refuses. */
export const mcpSecretValues = (credentials: Record<string, { headers?: Record<string, string> }>): string[] =>
  Object.values(credentials).flatMap((server) => Object.values(server.headers ?? {})).flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")]);

/** The pipe's MCP entry for `credentials`, to follow the secrets `handover` encodes. */
export const mcpHandover = (credentials: Record<string, unknown>): Buffer => encode([[MCP_AUTH, JSON.stringify(credentials)]]);

/** A run's saved sign-in as its pipe carries it, after its secrets (handover). */
export const handoverSignIn = (value: { provider: string; ref: string; save: boolean }): Buffer => encode([[SIGN_IN_PAIR, JSON.stringify(value)]]);

/** The saved sign-in this run's process was handed over its pipe, if any: read by the browser tool alone. */
export function handedSignIn(): { provider: string; ref: string; save: boolean } | undefined {
  try {
    const value = signIn === undefined ? undefined : (JSON.parse(signIn) as { provider?: unknown; ref?: unknown; save?: unknown });
    return value && typeof value.provider === "string" && typeof value.ref === "string" && value.ref && typeof value.save === "boolean" ? { provider: value.provider, ref: value.ref, save: value.save } : undefined;
  } catch {
    return undefined;
  }
}

/** pi-ai's auth context over `env` (one `withSecrets` made): its providers find their keys there, not in process.env. */
export const authContextOf = (env: NodeJS.ProcessEnv) => ({
  env: async (name: string) => env[name],
  fileExists: async (path: string) => existsSync(path.startsWith("~") ? homedir() + path.slice(1) : path),
});

/** How this process got its secrets: over a pipe (`fd`, and whether it closed it), or none was handed over. */
export const handoverState = (): { fd: number; closed: boolean } | undefined => (handed ? { ...handed } : undefined);
