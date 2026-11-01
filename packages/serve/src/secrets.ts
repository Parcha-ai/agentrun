// The secrets serve and each run's process hold: in this module's memory, never in the environment. The launcher
// (launcher/agentrun-serve) hands them to serve over a pipe, and serve hands each run's process those it needs over a
// pipe of its own; each side reads its pipe as this module loads, before anything else, and closes it. A value set on
// process.env would be the default environment of every child, so none is: code that needs one asks `secret(name)`,
// or gets an env object `withSecrets` made for its own use, which no spawn takes.
//
// With no launcher (a test that starts the server in its own process), a secret set in the environment is read from it.
import { closeSync, existsSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";

/** The pipe and how many bytes of it are the secrets: the launcher's, or serve's to a run's process. */
export const SECRETS_FD_ENV = "AGENTRUN_SECRETS_FD";
export const SECRETS_LEN_ENV = "AGENTRUN_SECRETS_LEN";

/** The names of the secrets: the launcher's one list, which its `env -u`, serve's handover and the tests all read. */
export const SECRET_NAMES: readonly string[] = (() => {
  const launcher = readFileSync(new URL("../launcher/agentrun-serve", import.meta.url), "utf8");
  const list = /^SECRETS='([A-Z0-9_ ]+)'$/m.exec(launcher)?.[1];
  if (!list) throw new Error("agentrun-serve's launcher names no SECRETS");
  return list.split(" ").filter(Boolean);
})();

/** The decision keys among them: a run's process gets them only on its decision descriptor (decisions.ts), never with
 *  the secrets on its pipe, which are its tools' environment. */
export const DECISION_KEYS: readonly string[] = ["TYPESAFE_API_KEY", "PARALLEL_API_KEY"];

const held = new Map<string, string>();
/** Whether this process was handed its secrets over a pipe, and closed it. */
let handed: { fd: number; closed: boolean } | undefined;

/** NAME=VALUE pairs, each ended by a NUL. */
const encode = (pairs: Iterable<readonly [string, string]>): Buffer => Buffer.concat([...pairs].map(([name, value]) => Buffer.from(`${name}=${value}\0`)));
function decode(bytes: Buffer): void {
  for (const pair of bytes.toString("utf8").split("\0")) {
    const at = pair.indexOf("=");
    if (at > 0 && SECRET_NAMES.includes(pair.slice(0, at))) held.set(pair.slice(0, at), pair.slice(at + 1));
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

/** A secret's value: as handed over, else (no launcher) as this process's environment has it now. */
export const secret = (name: string): string | undefined => held.get(name) ?? process.env[name];

/** `env` with the secrets this process holds, for this process's own reading. Each secret is a property that does not
 *  enumerate: `env.NAME` reads it, while a spread of the object, or a spawn given it (Node builds a child's environment
 *  from its enumerable keys), leaves it out. */
export const withSecrets = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of SECRET_NAMES) {
    const value = secret(name);
    if (value !== undefined) Object.defineProperty(out, name, { value, enumerable: false, writable: false, configurable: false });
  }
  return out;
};

/** The environment a child gets: `env` with every secret name taken out. */
export const withoutSecrets = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAMES.includes(name)));

/** What a run's process is handed: the secrets named `names` that this process holds, as its pipe carries them. */
export function handover(names: readonly string[]): Buffer {
  return encode(names.flatMap((name) => {
    const value = secret(name);
    return value === undefined ? [] : [[name, value] as const];
  }));
}

/** pi-ai's auth context over `env` (one `withSecrets` made): its providers find their keys there, not in process.env. */
export const authContextOf = (env: NodeJS.ProcessEnv) => ({
  env: async (name: string) => env[name],
  fileExists: async (path: string) => existsSync(path.startsWith("~") ? homedir() + path.slice(1) : path),
});

/** How this process got its secrets: over a pipe (`fd`, and whether it closed it), or none was handed over. */
export const handoverState = (): { fd: number; closed: boolean } | undefined => (handed ? { ...handed } : undefined);
