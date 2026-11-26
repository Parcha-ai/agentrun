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
 *  every other key, token, secret or password `env` names, and each OTLP header value and endpoint credential
 *  (keptSecrets). One shorter than the checker's MIN_SECRET, whitespace aside, matches too much text by chance to be
 *  refused, and is left out, an OTLP header value's too. */
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

/** A copy of `env` (one withSecrets made) with every own property as it is: each secret still read by name and never
 *  enumerated, savedIn still saying which were saved, and its symbols. A spread keeps none of the secrets, so a copy
 *  that is read for a key is made with this (env-copy.test.mjs scans for spreads). */
export const copyEnv = <T extends object>(env: T): T => Object.create(Object.getPrototypeOf(env), Object.getOwnPropertyDescriptors(env)) as T;

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

/** `text` percent-decoded, or undefined when it can't be. */
const decoded = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

/** The OTLP header names whose value is on no held list but is cut from the tracer's own lines (otlpHeaderCut), matched
 *  in any case: a backend's dataset or tenant, which says where spans go and carries no key. Such a value is often a
 *  word like `production`, which a held list would find in nearly every project a source capture reads and in served
 *  text. Only the names here: an unknown name's value is still held. */
export const OTLP_CUT_ONLY_HEADERS: readonly string[] = ["x-honeycomb-dataset", "x-axiom-dataset", "x-scope-orgid"];

/** An auth scheme before its credential, as a header writes it (`Bearer <token>`, `Basic <base64>`, `Api-Key <key>`,
 *  `sentry sentry_key=<key>`): a token, then a space or its `%20`. */
const AUTH_SCHEME = /^[A-Za-z][\w.+-]*(?:\s+|%20)/;

/** The auth schemes a backend's header writes before its credential, in any case, under any header name. */
const KNOWN_SCHEME = /^(?:bearer|basic|api-?key|api-?token|token|sentry|splunk|geniekey)(?:\s+|%20)/i;

/** Whether a header's or an endpoint's query parameter's name says its value is a credential (`authorization`,
 *  `x-sentry-auth`, `x-api-key`, `access_token`, `apiKey2`, `X-Amz-Signature`, `sessionid`): a name is split at each
 *  non-alphanumeric and at each lower-to-upper case change, a word's trailing digits are dropped (`key2` is `key`), and
 *  a word counts when it is one of CREDENTIAL_WORDS, ends in one of CREDENTIAL_ENDINGS (`accesstoken`, `dbpasswd`,
 *  `writekey`, `hmackey`), or starts with one of CREDENTIAL_STARTS and is more than its plural (`tokenvalue`,
 *  `passwordhash`; never `tokens`). `auth`, `key`, `sig` and `session` start no compound, so a word that only starts like
 *  one says nothing (`authority`, `keyspace`, `sessions`). */
const CREDENTIAL_WORDS = new Set(["authorization", "auth", "key", "apikey", "token", "secret", "password", "passwd", "pwd", "sig", "signature", "credential", "credentials", "jwt", "session"]);
const CREDENTIAL_ENDINGS = ["key", "token", "secret", "password", "passwd", "pwd", "auth", "authorization", "sig", "signature", "credential", "credentials", "jwt", "sessionid"];
const CREDENTIAL_STARTS = ["token", "secret", "password", "passwd", "jwt"];
const credentialWord = (word: string): boolean => {
  const bare = word.replace(/\d+$/, "");
  return CREDENTIAL_WORDS.has(bare)
    || CREDENTIAL_ENDINGS.some((ending) => bare.endsWith(ending))
    || CREDENTIAL_STARTS.some((start) => bare.startsWith(start) && bare.length > start.length + 1);
};
const credentialNamed = (name: string): boolean =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).some(credentialWord);

/** Where a URL starts: a scheme, then `://`; or `//` alone (a scheme-relative URL, `//<key>@host`) at the start of the
 *  text or after a space, a quote, `=`, `(`, `,`, `;` or `&`, never inside a path (`/a//b`). A scheme is read at most 32
 *  characters long, so a long word with no `://` after it costs one short look from each of its letters. */
const URL_START = /[A-Za-z][\w+.-]{0,31}:\/\/|(?<=^|[\s"'=(,;&])\/\//;
const URL_HEAD = /(?:[A-Za-z][\w+.-]{0,31}:)?\/\//y;

/** How many readings of one URL's userinfo urlParts takes at most, and how many characters its shorter readings (all
 *  but the RFC's and the first `@`'s) take together at most: a value can hold thousands of `@`, and a reading at each
 *  would hold, and the [otel] cut compile into one pattern, their count times the value's length. */
const MAX_READINGS = 16;
const READINGS_BUDGET = 4096;

/** How many characters of URL queries one header value's read (innerCredentials) takes after the first query it reads:
 *  a value of URLs nested each in the last's query gives each a query running to the value's end, and reading every one
 *  would hold their count times the value's length. The pair read (pairValues) still covers every query's text. */
const QUERY_BUDGET = 4096;

/** The URL queries one header value's read has taken (`spans`, each its `from to`) and the QUERY_BUDGET characters left. */
type QueriesRead = { spans: Set<string>; left: number };

/** A URL as RFC 3986 reads it, `text` from `start` (its scheme, or the `//` of a scheme-relative one) to `end`: its
 *  authority, up to the first `/`, `?` or `#`; the readings of its userinfo, the RFC's first (everything before the
 *  authority's last `@`, so a password's `;`, `&`, `=`, `,`, `'` or raw `@` stays in it), then, when the authority holds
 *  more than one `@`, the one up to its first `@` and the next shorter ones, up to MAX_READINGS in all and
 *  READINGS_BUDGET characters for those after the first two (a URL with no closing mark, followed by a pair holding an
 *  `@`, `...@relay.invalid&contact=ops@team`, reads too long a userinfo, and a redactor holding an extra candidate is
 *  safe where missing one leaks); and where its query is, from the first `?` to a `#`. Read in place, never copied to
 *  `end`: a value of thousands of URLs one inside the next costs each only its authority. Undefined when no URL starts
 *  at `start`. */
const urlParts = (text: string, start: number, end: number): { readings: string[]; query: readonly [number, number] } | undefined => {
  URL_HEAD.lastIndex = start;
  if (!URL_HEAD.test(text)) return undefined;
  const from = URL_HEAD.lastIndex;
  let stop = from;
  while (stop < end && !"/?#".includes(text[stop])) stop++;
  const authority = text.slice(from, stop);
  const ats = [...authority.matchAll(/@/g)].map((at) => at.index);
  const kept = ats.length > 1 ? [ats[ats.length - 1], ats[0]] : ats;
  let budget = READINGS_BUDGET;
  for (let next = 1; next < ats.length - 1 && kept.length < MAX_READINGS && ats[next] <= budget; next++) {
    budget -= ats[next];
    kept.push(ats[next]);
  }
  const mark = text.indexOf("?", stop);
  const hash = text.indexOf("#", stop);
  const query = mark >= 0 && mark < end && (hash < 0 || hash > mark) ? [mark + 1, hash >= 0 && hash < end ? hash : end] as const : [0, 0] as const;
  return { readings: kept.map((at) => authority.slice(0, at)), query };
};

/** A user or password as a URL parser writes it back (a client's error may quote the URL it parsed): `;`, `=`, `@`, `:`
 *  and the like percent-encoded. */
const asParsed = (part: string): string => {
  const url = new URL("http://host.invalid");
  url.password = part;
  return url.password;
};

/** The credentials a URL writes into itself (`text` from `start` to `end`, urlParts): the user and password of its
 *  userinfo (before its first `:` and after it), each as written, decoded and as a parser writes it back, the RFC's
 *  reading at any length and each shorter reading's only at MIN_SECRET or more (so a short piece of a password, `pa` of
 *  `pa@ss...`, cuts no ordinary word), and the value of each query parameter whose name says it is one
 *  (credentialNamed), the query split at `&` alone and again at `&` and `;`, as written and decoded; none when no URL
 *  starts at `start`. A query already in `queriesRead` (several URLs nested in one share it) is not read again, and
 *  after the first one read, one is read only while QUERY_BUDGET has room for all of it. */
const urlCredentials = (text: string, start = 0, end = text.length, queriesRead: QueriesRead = { spans: new Set(), left: QUERY_BUDGET }): string[] => {
  const url = urlParts(text, start, end);
  if (!url) return [];
  const userinfo = url.readings.flatMap((reading, at) => {
    const colon = reading.indexOf(":");
    const parts = (colon < 0 ? [reading] : [reading.slice(0, colon), reading.slice(colon + 1)]).flatMap((part) => [part, decoded(part) ?? part, asParsed(part)]);
    return at === 0 ? parts : parts.filter((part) => part.replace(/\s+/g, "").length >= MIN_SECRET);
  });
  const [from, to] = url.query;
  const span = `${from} ${to}`;
  if (from === to || queriesRead.spans.has(span)) return userinfo;
  if (queriesRead.spans.size > 0) {
    if (to - from > queriesRead.left) return userinfo;
    queriesRead.left -= to - from;
  }
  queriesRead.spans.add(span);
  // Read split at `&` alone (a WHATWG parser's reading, a value's raw `;` kept), and each `&` piece holding a `;` split
  // at it too (a path parameter's or a cookie's reading): both, so a key with a `;` in it is held whole and a pair after
  // a `;` alone. A query writes a space as `+`; a user and password do not.
  const pieces = text.slice(from, to).split("&");
  const query = [...pieces, ...pieces.filter((piece) => piece.includes(";")).flatMap((piece) => piece.split(";"))].flatMap((pair) => {
    const at = pair.indexOf("=");
    const name = pair.slice(0, Math.max(at, 0)).replace(/\+/g, " ");
    const value = pair.slice(at + 1);
    return at > 0 && credentialNamed(decoded(name) ?? name) ? [value, decoded(value.replace(/\+/g, " ")) ?? value] : [];
  });
  return [...userinfo, ...query];
};

/** Each URL inside a header value (a DSN, a relay's address) as the spans of text it takes, one starting at every
 *  `scheme://` (URL_START), so a URL inside another's query or path is read too: from its scheme to the quote that
 *  closes it when a `'` or `"` opens it (comes right before its scheme and is closed later), else to the first space or
 *  quote, and, when that is a quote, also on to the first space (RFC 3986 allows a raw `'` in a userinfo, so both
 *  readings are taken). Read inside a span alone (urlParts), a quoted URL's userinfo never runs past its closing quote to
 *  a later `@`, and an unquoted one's runs past any `;`, `&`, `=` or `,`. */
const urlSpans = (value: string): { start: number; end: number }[] => {
  const spans: { start: number; end: number }[] = [];
  const start = new RegExp(URL_START.source, "g");
  // The first match of `mark` at or after an index, found once for every index from the last one asked up to it: URLs
  // nested one in the next share their end, and a search from each would read the rest of the value again.
  const nextOf = (mark: RegExp): ((from: number) => number) => {
    let asked = -1;
    let found = -1;
    return (from) => {
      if (from < asked || from > found) {
        mark.lastIndex = from;
        found = mark.exec(value)?.index ?? value.length;
      }
      asked = from;
      return found;
    };
  };
  const nextStop = nextOf(/[\s'"]|$/g);
  const nextSpace = nextOf(/\s|$/g);
  for (let found = start.exec(value); found; found = start.exec(value)) {
    const open = value[found.index - 1];
    const from = found.index + found[0].length;
    const closing = open === "'" || open === '"' ? value.indexOf(open, from) : -1;
    if (closing >= 0) {
      spans.push({ start: found.index, end: closing });
      continue;
    }
    const end = nextStop(from);
    spans.push({ start: found.index, end });
    if (value[end] === "'" || value[end] === '"') spans.push({ start: found.index, end: nextSpace(end) });
  }
  return spans;
};

/** The breaks between a header value's `name=value` pairs: `;`, `&`, a comma (or its `%2C`) and spaces; and, for a
 *  second, finer read, also `?`, `#` and `/`, so a pair inside a URL that is itself a pair's value
 *  (`upstream=https://relay/v1#access_token=<token>`) or a path's segment stands alone; and three whole reads, which keep
 *  a raw `;` in a value: all but `;` (LIST_BREAK), so a credential with a `;` in a list joined by `%2C`, the usual way to
 *  write one (`api_key=<key;rest>%2Cregion=us`), is held as itself, and `&` and spaces alone (WHOLE_BREAK), so one with
 *  a comma in it too (`api_key=<key;rest%2Cmore>&region=us`) is held whole, and again at their `%26` and `%20`
 *  (ENCODED_BREAK), so that key before an encoded `&` or space is held as written too, not only decoded, and again at
 *  `%26` alone (ENCODED_AMP_BREAK), so a key with a `%20` in it before a `%26` is held, as written and decoded; a text
 *  with neither (ENCODED_SEEN) splits at both as at WHOLE_BREAK, so those reads are skipped for it. And a whole read at
 *  `&`, spaces and `%3B` (ENCODED_SEMI_BREAK), so a credential in a list joined by an encoded `;` (the SDK drops a raw
 *  `;` and all after it, so a cookie's list is written `session=<token>%3Btheme=dark`) is held as written and decoded,
 *  a `%20`, quotes or a `%26` in it too, where every read of the decoded text splits it at its space or `&`; a text
 *  with no `%3B` (ENCODED_SEMI_SEEN) skips it. All are held:
 *  every redactor matches a held value exactly, so the longer reading of any never covers a line quoting the key alone.
 *  WHOLE_BREAK also holds a value with the comma that ends it (sentry's `sentry_key=<key>%2C`); the others hold the value
 *  alone. */
const PAIR_BREAK = /[;&,\s]+|%2C/i;
const PIECE_BREAK = /[;&,\s?#/]+|%2C/i;
const LIST_BREAK = /[&,\s]+|%2C/i;
const WHOLE_BREAK = /[&\s]+/;
const ENCODED_BREAK = /[&\s]+|%26|%20/i;
const ENCODED_AMP_BREAK = /[&\s]+|%26/i;
const ENCODED_SEEN = /%26|%20/i;
const ENCODED_SEMI_BREAK = /[&\s]+|%3B/i;
const ENCODED_SEMI_SEEN = /%3B/i;

/** A pair's value in quotes, raw or written `%22` or `%27` (QUOTED), and a quote opening one (OPEN_QUOTE). */
const QUOTED = /^(["']|%22|%27)(.*)\1$/;
const OPEN_QUOTE = /^(?:["']|%22|%27)/;

/** Whether `text` reaches the held lists' floor: MIN_SECRET characters or more, decoded and whitespace aside. */
const atFloor = (text: string): boolean => (decoded(text) ?? text).replace(/\s+/g, "").length >= MIN_SECRET;

/** Whether `text`, decoded, is itself a `name=value` pair named like no credential (`theme=dark-mode`): a word, `=`,
 *  then a value that starts with no other `=` (a base64 credential's padding, `<b64>=`, makes no pair). */
const PAIR_SHAPE = /^([A-Za-z][\w.-]*)=[^=]/;
const plainPair = (text: string): boolean => {
  const pair = PAIR_SHAPE.exec(decoded(text) ?? text);
  return pair !== null && !credentialNamed(pair[1]);
};

/** What a credential's value whose part before its first `;` is empty (`;<key>`) holds after that `;`: the rest whole,
 *  as a reader that skips an empty part reads it, and its first piece up to a `;` at the floor or longer (atFloor), so
 *  `;a;<key>` gives `<key>`, never an `a` the tracer's cut would take from every word; neither when it is a pair named
 *  like no credential (plainPair, `;theme=dark-mode`). Nothing for any other value. */
const afterEmpty = (value: string): string[] => {
  if (!value.startsWith(";")) return [];
  const after = value.replace(/^;+/, "");
  const piece = after.split(";").find(atFloor);
  return [after, ...(piece === undefined ? [] : [piece])].filter((taken) => !plainPair(taken));
};

/** How many characters spacedHeads takes from one value in all, its heads together: a value of thousands of pairs
 *  joined by `%20` has a head before each, and holding every one would hold their count times the value's length. */
const HEADS_BUDGET = 4096;

/** A value up to each `%20` in it that a `name=` follows, each at the floor or longer (atFloor), while HEADS_BUDGET has
 *  room: a read that keeps a `%20` in a key also runs on past a `%20` that splits pairs
 *  (`api_key=<p>%20<n>;<s>%20region=us`), a read that splits at `%20` cuts the key at its own, and only a head of the
 *  long value is the key alone. A later pair never starts a head, so it is not held alone (`region=us` above), and a
 *  short head, which would cut ordinary words from the tracer's lines, is not taken. */
const spacedHeads = (value: string): string[] => {
  const heads: string[] = [];
  let left = HEADS_BUDGET;
  for (const space of value.matchAll(/%20(?=[\w.-]+=)/g)) {
    if (space.index > left) break;
    left -= space.index;
    const head = value.slice(0, space.index);
    if (atFloor(head)) heads.push(head);
  }
  return heads;
};

/** The value of each `name=value` pair of `text` split at `breaks` whose name says it is a credential (credentialNamed),
 *  out of any quotes around it, raw or written `%22` or `%27`, as written and decoded. A value that opens with a quote
 *  and has no closing one is taken without that quote too, at the floor or longer (atFloor): a read that ends a quoted
 *  key at a comma or `%2C` in it (a key in quotes written `%22`, `<head>%2C<rest>`) gives its head with the opening
 *  quote alone, and a line may quote the head without it; a shorter rest (`token=%27a`) would cut ordinary words from
 *  the tracer's lines. A
 *  name is what follows the last `/`, `?`, `#` or `:` before its `=` (a URL's query or fragment,
 *  `https://relay/v1?region=us`, names `region`). A value is taken up to each `%20` in it too (spacedHeads). A value
 *  whose part before its first `;` is empty, as written or decoded (`token=;<key>` read whole, `token=%3B<key>`), is
 *  taken after that `;` too (afterEmpty). A value whose decoded form is only `=`, `;`, quotes, commas and spaces (a
 *  base64 credential's padding read as a pair, `token=;` before a space, a lone `'` or its `%27`, `api_key=%2C`) is not
 *  taken, as written or decoded: otlpHeaderCut has no length floor, and it would cut those characters everywhere in the
 *  tracer's lines. */
const pairValues = (text: string, breaks: RegExp): string[] =>
  text.split(breaks).flatMap((pair) => {
    const at = pair.indexOf("=");
    if (at <= 0) return [];
    const name = pair.slice(0, at).split(/[/?#:]/).at(-1) ?? "";
    if (!credentialNamed(decoded(name) ?? name)) return [];
    const written = pair.slice(at + 1);
    const inner = written.replace(QUOTED, "$2");
    const unclosed = inner === written ? written.replace(OPEN_QUOTE, "") : inner;
    return [inner, ...(unclosed !== inner && atFloor(unclosed) ? [unclosed] : [])]
      .flatMap((value) => [value, ...afterEmpty(value), ...spacedHeads(value)])
      .flatMap((value) => [value, decoded(value) ?? value])
      .concat(afterEmpty(decoded(inner) ?? inner))
      .filter((value) => /[^=;"',\s]/.test(decoded(value) ?? value));
  });

/** The credentials a header value carries inside it, the union of two reads over the whole value as written: the value
 *  of each `name=value` pair whose name says it is a credential (pairValues, at each of PAIR_BREAK, PIECE_BREAK,
 *  LIST_BREAK, WHOLE_BREAK, ENCODED_BREAK, ENCODED_AMP_BREAK and ENCODED_SEMI_BREAK: a cookie's `session=<token>`,
 *  sentry's `sentry_key=<key>`, a path's `;jsessionid=<id>`, a URL query's or fragment's `session=` or `access_token=`), and the
 *  user, password and key parameters of each URL in it (urlSpans, urlCredentials: a DSN's `https://<key>@host/1`, a
 *  relay's whole `user:pa;ss`). A URL only adds readings: the pair read covers its text too. A value that escapes its
 *  slashes (JSON's `https:\/\/`) is read again with them plain, and what that finds is held both ways. A pair named like
 *  no credential (`theme=dark`) is not taken. */
const innerCredentials = (value: string): string[] => {
  const read = (text: string): string[] => {
    const queriesRead: QueriesRead = { spans: new Set(), left: QUERY_BUDGET };
    return [
      ...pairValues(text, PAIR_BREAK),
      ...pairValues(text, PIECE_BREAK),
      ...pairValues(text, LIST_BREAK),
      ...pairValues(text, WHOLE_BREAK),
      ...(ENCODED_SEEN.test(text) ? [...pairValues(text, ENCODED_BREAK), ...pairValues(text, ENCODED_AMP_BREAK)] : []),
      ...(ENCODED_SEMI_SEEN.test(text) ? pairValues(text, ENCODED_SEMI_BREAK) : []),
      ...urlSpans(text).flatMap(({ start, end }) => urlCredentials(text, start, end, queriesRead)),
    ];
  };
  if (!value.includes("\\/")) return read(value);
  return [...read(value), ...read(value.replace(/\\\//g, "/")).flatMap((found) => [found, found.replace(/\//g, "\\/")])];
};

/** The OTLP exporter's header values `env` names (OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_TRACES_HEADERS: a
 *  tracing backend's key is one), at any length (keptSecrets floors them for the held list; otlpHeaderCut does not),
 *  but those of a header OTLP_PLAIN_HEADERS names, and, for the held list (`held`), those OTLP_CUT_ONLY_HEADERS names.
 *  Each is held as written (percent-encoded) and as sent (decoded); and as the SDK reads the same variable, which it
 *  merges under ours (`headers`, tracer.ts exporterConfig) and which drops a `;` and what follows it, so a part ours
 *  can't decode still sends that much; and, under a credential-named header (credentialNamed) or after a known auth
 *  scheme (KNOWN_SCHEME), each of those without its first word (AUTH_SCHEME), the credential alone, as an error may
 *  quote it. For the held list, any other header's value is held whole, never its tail alone; for the cut (`held`
 *  false), every value is taken without any first word too, since cutting more of the tracer's own lines costs
 *  nothing. Under any header, each credential a value carries inside it (innerCredentials: a credential-named
 *  `name=value` pair's value, a URL's user, password and key parameters) is taken alone too. A part whose name can't
 *  be decoded is held. Commas split the variable, so a comma inside a value must be written `%2C`. */
export const otlpHeaderValues = (env: NodeJS.ProcessEnv, held: boolean): string[] =>
  [env.OTEL_EXPORTER_OTLP_HEADERS, env.OTEL_EXPORTER_OTLP_TRACES_HEADERS].flatMap((text) =>
    (text ?? "").split(",").flatMap((part) => {
      const at = part.indexOf("=");
      if (at <= 0) return [];
      const rawName = part.slice(0, at).trim();
      const name = decoded(rawName) ?? rawName;
      if (OTLP_PLAIN_HEADERS.includes(name.toLowerCase())) return [];
      if (held && OTLP_CUT_ONLY_HEADERS.includes(name.toLowerCase())) return [];
      const written = part.slice(at + 1).trim();
      const property = written.indexOf(";");
      const forms = [written, ...(property >= 0 ? [written.slice(0, property).trim()] : [])].flatMap((value) => [value, decoded(value) ?? value]);
      const named = credentialNamed(name);
      return forms.flatMap((value) => [value, ...(!held || named || KNOWN_SCHEME.test(value) ? [value.replace(AUTH_SCHEME, "")] : []), ...innerCredentials(value)]);
    })).filter((value) => value.trim() !== "");

/** The credentials the OTLP endpoints `env` names write into their URLs (OTEL_EXPORTER_OTLP_ENDPOINT and
 *  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT; urlCredentials): a user and password, and the value of each query parameter
 *  whose name says it is one, each as written and decoded. An exporter's error may quote the URL it posted to. */
export const otlpEndpointValues = (env: NodeJS.ProcessEnv): string[] =>
  [env.OTEL_EXPORTER_OTLP_ENDPOINT, env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT].flatMap((text) => urlCredentials((text ?? "").trim())).filter((value) => value.trim() !== "");

/** Every OTLP credential `env` names: its header values (otlpHeaderValues, a cut-only header's only when not `held`) and
 *  its endpoints' (otlpEndpointValues). */
const otlpValues = (env: NodeJS.ProcessEnv, held: boolean): string[] => [...otlpHeaderValues(env, held), ...otlpEndpointValues(env)];

/** `values` and every OTLP credential `env` names (otlpValues: its header values but a cut-only header's, its
 *  endpoints' user, password and key parameters) as the held list keeps them: each MIN_SECRET long or more, whitespace
 *  aside. A shorter one matches too much text by chance to be held, and some readers of the list have no floor of their
 *  own (a number equal to a held value is withheld, key-refusal.ts heldNumber; a source capture refuses a path or file
 *  holding one), so a short header value is on no held list, nor is a dataset's or tenant's (OTLP_CUT_ONLY_HEADERS):
 *  otlpHeaderCut alone cuts it, from the tracer's own lines. */
export const keptSecrets = (values: readonly string[], env: NodeJS.ProcessEnv): string[] =>
  [...new Set([...values, ...otlpValues(env, true)])].filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET);

const CUT = "[redacted]";

/** Text with every OTLP credential `env` names (otlpValues: its header values, a cut-only header's too, its endpoints'
 *  user, password and key parameters) put as "[redacted]", at any length: the one cut without the MIN_SECRET floor.
 *  The tracer's own lines take it, after the runner's redactor (otel/tracer.ts saidOf), since they are where one can
 *  show: an exporter's error may quote a header it sent or the URL it posted to, and a run's process never holds one.
 *  Every other cut keeps the floor on purpose: a needle of a few characters in every redactor would cut ordinary text
 *  everywhere. Each value is matched exactly as held, and the cut is the union of every place each one stands: at each
 *  character, the longest value (or a "[redacted]" already in the text) starting there is found without being taken,
 *  so a value starting inside another is found too, and the places, which come in order, are merged where they overlap
 *  or touch and each run cut as one "[redacted]". So no character of any held value is left, whichever of two
 *  overlapping values starts first or is longer (the SDK's reading `api_key=<key>` and a key `<key;rest>` quoted as
 *  `api_key=<key;rest>`), and a "[redacted]" already in the text is left whole. One pass over the text, one merge. */
export function otlpHeaderCut(env: NodeJS.ProcessEnv): (text: string) => string {
  const values = [...new Set([CUT, ...otlpValues(env, false)])].sort((a, b) => b.length - a.length);
  if (values.length === 1) return (text) => text;
  const needle = new RegExp(`(?=(${values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`, "g");
  return (text) => {
    if (!text) return text;
    const spans: [number, number][] = [];
    for (const found of text.matchAll(needle)) {
      const [start, end] = [found.index, found.index + found[1].length];
      const last = spans.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else spans.push([start, end]);
    }
    let out = "";
    let from = 0;
    for (const [start, end] of spans) {
      out += `${text.slice(from, start)}${CUT}`;
      from = end;
    }
    return out + text.slice(from);
  };
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
