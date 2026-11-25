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
import { secretValues } from "./api-token.js";

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

/** NAME=VALUE pairs, each ended by a NUL: what a pipe of secrets carries. A runner writes a run's own process its pairs
 *  with it (run-child-host.ts), as a launcher writes its server's. */
export const encode = (pairs: Iterable<readonly [string, string]>): Buffer => Buffer.concat([...pairs].map(([name, value]) => Buffer.from(`${name}=${value}\0`)));
function decode(bytes: Buffer): void {
  for (const pair of bytes.toString("utf8").split("\0")) {
    const at = pair.indexOf("=");
    if (at > 0 && (SECRET_NAMES.includes(pair.slice(0, at)) || pair.slice(0, at) === MCP_AUTH)) held.set(pair.slice(0, at), pair.slice(at + 1));
    else if (pair.slice(0, at) === SIGN_IN_PAIR) signIn = pair.slice(at + 1);
  }
}

/** Exactly `length` bytes of `fd`, read as the launcher's writer writes them: the end of file before then is a writer
 *  gone short, and refused. */
function readExactly(fd: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  // A run's process gets its pipe from Node's spawn as a socket that does not block: a read before the runner's write
  // lands is EAGAIN, waited out here for as long as a slow start may take, never past it.
  const until = Date.now() + 60_000;
  for (let read = 0; read < length; ) {
    let got: number;
    try {
      got = readSync(fd, bytes, read, length - read, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || Date.now() > until) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }
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
 *  every other key, token, secret or password `env` names, and each OTLP header value (otlpHeaderValues). One shorter
 *  than the checker's MIN_SECRET, whitespace aside, matches too much text by chance to be refused, and is left out, an
 *  OTLP header value's too (keptSecrets). */
export const hostSecrets = (env: NodeJS.ProcessEnv, stored?: StoredKeys): string[] => {
  // AGENTRUN_TOKENS's each secret too, not only the list whole (api-token.ts secretValues).
  const held = [...SECRET_NAMES.flatMap((name) => [...secretValues(name, secret(name) ?? ""), stored?.(name) ?? ""]), ...mcpSecretValues(mcpCredentials()), ...sealKeys.keys(), ...heldTokens];
  const named = Object.entries(env).filter(([name]) => SECRET_NAME.test(name) && !SECRET_NAMES.includes(name)).map(([, value]) => value ?? "");
  return keptSecrets([...held, ...named], env);
};

/** The seal keys this process's open stores were booted with (seal-key.ts bootSealKey), by how many hold each: several
 *  data directories in one process each keep their own. Never read as a secret by name (each holder passes its own key
 *  on): only listed by hostSecrets, so what a run writes is cut of every one. */
const sealKeys = new Map<string, number>();

/** Lists `text` among this process's seal keys, for redaction alone, until the returned release is called. */
export function holdSealKey(text: string): () => void {
  sealKeys.set(text, (sealKeys.get(text) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (sealKeys.get(text) ?? 1) - 1;
    if (left > 0) sealKeys.set(text, left);
    else sealKeys.delete(text);
  };
}

/** Tokens this process read that no environment names (a ChatGPT sign-in's access and refresh tokens), newest last, for
 *  redaction alone: kept after they rotate, since text written before a renewal can still hold the old one. */
const heldTokens = new Set<string>();
const HELD_TOKENS = 64;

/** Lists each of `texts` among this process's secrets, for redaction alone. */
export function holdSecret(...texts: string[]): void {
  for (const text of texts) {
    if (!text) continue;
    heldTokens.delete(text);
    heldTokens.add(text);
  }
  for (const oldest of heldTokens) {
    if (heldTokens.size <= HELD_TOKENS) break;
    heldTokens.delete(oldest);
  }
}

/** A secret this process was started with: as handed over, else (no launcher) as its environment has it now. */
const own = (name: string): string | undefined => held.get(name) ?? process.env[name];

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

/** A `key=value,key=value` list (OTEL_EXPORTER_OTLP_HEADERS, OTEL_RESOURCE_ATTRIBUTES), each part percent-decoded; a
 *  part that is not one is skipped. */
export function keyValues(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? "").split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    try {
      const key = decodeURIComponent(part.slice(0, at).trim());
      if (key) out[key] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      continue;
    }
  }
  return out;
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

/** The OTLP header names whose value is not held (otlpHeaderValues), matched in any case: the standard headers that say
 *  how a body is sent, which carry no key. Every other header's value is held, an unknown name's too: a name not on this
 *  list never means its value is safe. */
export const OTLP_PLAIN_HEADERS: readonly string[] = ["content-type", "accept", "content-encoding", "user-agent"];

/** The OTLP exporter's header values `env` names (OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_TRACES_HEADERS: a
 *  tracing backend's key is one), at any length (keptSecrets floors them for the held list; otlpHeaderCut does not),
 *  but those of a header OTLP_PLAIN_HEADERS names: each as sent
 *  and as written (percent-encoded), and a `Bearer` one's token alone. A part whose name can't be decoded is held. */
export const otlpHeaderValues = (env: NodeJS.ProcessEnv): string[] =>
  [env.OTEL_EXPORTER_OTLP_HEADERS, env.OTEL_EXPORTER_OTLP_TRACES_HEADERS].flatMap((text) =>
    (text ?? "").split(",").flatMap((part) => {
      const at = part.indexOf("=");
      if (at <= 0) return [];
      const [sent] = Object.entries(keyValues(part));
      if (sent && OTLP_PLAIN_HEADERS.includes(sent[0].toLowerCase())) return [];
      return [...(sent ? [sent[1]] : []), part.slice(at + 1).trim()].flatMap((value) => [value, value.replace(/^Bearer(?:\s+|%20)/i, "")]);
    })).filter((value) => value.trim() !== "");

/** `values` and every OTLP header value `env` names (otlpHeaderValues) as the held list keeps them: each MIN_SECRET long
 *  or more, whitespace aside. A shorter one matches too much text by chance to be held, and some readers of the list
 *  have no floor of their own (a number equal to a held value is withheld, key-refusal.ts heldNumber; a source capture
 *  refuses a path or file holding one), so a short header value is on no held list: otlpHeaderCut alone cuts it, from
 *  the tracer's own lines. */
export const keptSecrets = (values: readonly string[], env: NodeJS.ProcessEnv): string[] =>
  [...new Set([...values, ...otlpHeaderValues(env)])].filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET);

const CUT = "[redacted]";

/** Text with every OTLP header value `env` names (otlpHeaderValues) put as "[redacted]", at any length: the one cut
 *  without the MIN_SECRET floor. The tracer's own lines take it, after the runner's redactor (otel/tracer.ts saidOf),
 *  since they are where a header value can show: an exporter's error may quote a header it sent, and a run's process
 *  never holds one. Every other cut keeps the floor on purpose: a needle of a few characters in every redactor would cut
 *  ordinary text everywhere. Each value is matched exactly as held, the longest first, so one inside another is cut
 *  whole; a "[redacted]" already in the text is left whole. */
export function otlpHeaderCut(env: NodeJS.ProcessEnv): (text: string) => string {
  const values = [...new Set(otlpHeaderValues(env))].sort((a, b) => b.length - a.length);
  if (!values.length) return (text) => text;
  const needle = new RegExp([CUT, ...values].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text) => (text ? text.replace(needle, () => CUT) : text);
}

/** Every header value of `credentials`: what a secret scan refuses. */
export const mcpSecretValues = (credentials: Record<string, { headers?: Record<string, string> }>): string[] =>
  Object.values(credentials).flatMap((server) => Object.values(server.headers ?? {})).flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")]);



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
