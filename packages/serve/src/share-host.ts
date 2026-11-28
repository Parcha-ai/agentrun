// The share host (`agentrun-serve --share-host`, AGENTRUN_SHARE_HOST=1): the serve install behind agentrun.ai/r/<id>,
// with a store of its own. It answers under /r/ alone, so the site it sits behind routes one path to it:
//   /r/<id>               a share's page (the console's share.html, its asset URLs moved under /r/_assets/)
//   /r/<id>/bundle.json   the stored bytes, exactly as they were posted and scanned
//   /r/_assets/*          the page's assets (the console's build)
//   /r/v2/shares          POST stores a bundle, GET lists the caller's own; DELETE /r/v2/shares/<id> deletes one
//   /r/v2/health          public
// Every other address is a 404, answered before anything else reads the request (server.ts): the console, /v2 and with
// it every run, agent, key, computer, sign-in, MCP and trigger route. The host runs no runner and holds no model key.
//
// An upload, in order: the token (api-token.ts; its id owns the share), the token's quota, the body within its cap, a
// canonical `agentrun.share/1` document of the export's closed shape and caps whose sha256 and file digests hold
// (checkShareBundle), then the scrubber in cut mode with this host's held values over the whole body and every string
// (screenShare). A value it finds refuses it unless the bundle declares it restored, exactly where the host's own scrub
// finds it and of a kind that restores (label, personal, jev; never a key format, a held value or a dump); a restored
// record that names no such value refuses it too, and so does a scrub that fails: 422 with counts by rule, never a
// value, nothing stored. The host never repairs a bundle: what
// it stores, and later serves, is the posted bytes it scanned. A share's URL is on AGENTRUN_PUBLIC_URL (else, on loopback,
// the server's own address), never a Host header.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { packageSha256 } from "./agent-package.js";
import { ApiError } from "./errors.js";
import { sendHostedAsset, sendHostedSharePage } from "./page.js";
import { readCapped } from "./push-handler.js";
import { type CutScrub, EXPORT_CAPS, SHARE_FORMAT, SHARE_RUN_FIELDS } from "./run-export.js";
import { RESTORABLE, SCRUB_RULES, scrub } from "./secret-cut.js";
import { type CommandFacts, commandFacts } from "./secret-rules.js";
import { type CallContext, effectContext } from "./share-context.js";
import { isObject, stable } from "./validate.js";

export { SHARE_HOST_CSP } from "./page.js";

/** Where everything a share host serves lives. */
export const SHARE_ROOT = "/r/";
/** The share host's API. */
export const SHARE_API = "/r/v2/";
/** The most shares one token keeps: a delete makes room. No share expires. */
export const SHARE_QUOTA = 100;
/** The most reads one upload's per-string scrub makes, a distinct string once per context it stands under (a file's
 *  path, a call's command): each is a scrub of its own (about 0.1 ms), so past it the upload is 413 before any is read.
 *  With the body's cap it bounds what one upload asks of the scrubber: the whole body once, and at most this many reads,
 *  each of a string with a place of its own in the body, so together no more than the body; each context's command is
 *  read once (screenShare). */
export const SHARE_STRINGS = 50_000;
/** The most workflow calls (graph.effects) a bundle may hold: as many as an export can write. The graph view writes
 *  each with ten keys (graph-view.ts); with one character a value, the least any takes, and a comma between, the
 *  export's 8 MiB holds no more. A graph past it was made by hand, and is refused (400). */
export const SHARE_EFFECTS = Math.floor(EXPORT_CAPS.documentBytes / (JSON.stringify(Object.fromEntries(["node", "executionPath", "item", "tool", "status", "input", "output", "error", "startedAt", "endedAt"].map((key) => [key, 0]))).length + 1));
/** The rule ids of Jev's cuts (Scrubber beta 3; "jev" until its id is fixed). A share host never runs Jev (it holds no
 *  model key), so a restored record of one names a value the host can't find: it is not checked, and counted in the
 *  answer, never refused. The value itself is scrubbed as every other, and a hit there needs its own record. */
export const SHARE_JEV_RULES: ReadonlySet<string> = new Set(["jev", ...SCRUB_RULES.filter((rule) => rule.kind === "jev").map((rule) => rule.id)]);
/** The most bytes an upload's body may hold: the export's document cap, and room for nothing else. */
export const SHARE_BODY_BYTES = EXPORT_CAPS.documentBytes;
/** A share's id: 128 bits of randomness in base32 (lowercase, no padding). The URL is the capability. */
export const SHARE_ID = /^[a-z2-7]{26}$/;

/** The share host's API, by method, path and name. Nothing else under /r/v2/ is served. */
export const SHARE_HOST_ROUTES: readonly { method: string; path: string; pattern: RegExp; name: string }[] = [
  { method: "GET", path: "/r/v2/health", pattern: /^\/r\/v2\/health$/, name: "getShareHealth" },
  { method: "POST", path: "/r/v2/shares", pattern: /^\/r\/v2\/shares$/, name: "createShare" },
  { method: "GET", path: "/r/v2/shares", pattern: /^\/r\/v2\/shares$/, name: "listShares" },
  { method: "DELETE", path: "/r/v2/shares/{id}", pattern: /^\/r\/v2\/shares\/([^/]+)$/, name: "deleteShare" },
];

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A new share id: 16 random bytes as 26 base32 letters. */
export function newShareId(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// ---------- the bundle's shape

/** The bundle's keys, each one there (run-export.ts exportBundle writes every one). */
const TOP = ["agent", "cuts", "files", "format", "graph", "omitted", "restored", "rows", "run", "sha256", "source"] as const;
const RUN_FIELDS: ReadonlySet<string> = new Set([...SHARE_RUN_FIELDS, "imported_from"]);
const CUT_KINDS: ReadonlySet<string> = new Set(["format", "held", "dump", "label", "personal", "jev"]);
const HEX64 = /^[0-9a-f]{64}$/;

const refuse = (why: string): never => {
  throw new ApiError("bad_request", `This is not a share bundle the host takes: ${why}.`);
};
/** A body's bytes as text, or a 400: bytes that are not UTF-8 are refused, never replaced, and a byte-order mark is kept
 *  (so the JSON read refuses it), so the text checked, scrubbed and stored is the bytes sent. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function bodyText(bytes: Uint8Array): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return refuse("the body is not UTF-8");
  }
}
/** `value` is an object whose keys are `required` and those of `optional`, no other. */
function closed(value: unknown, at: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isObject(value)) return refuse(`${at} is not an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) refuse(`${at} has a field ${JSON.stringify(key.slice(0, 64))} the format does not name`);
  for (const key of required) if (!Object.hasOwn(value, key)) refuse(`${at} has no ${key}`);
  return value;
}
const string = (value: unknown, at: string): string => (typeof value === "string" ? value : refuse(`${at} is not a string`));
const count = (value: unknown, at: string): number => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : refuse(`${at} is not a whole number`));
const array = (value: unknown, at: string): unknown[] => (Array.isArray(value) ? value : refuse(`${at} is not an array`));

/** The sha256 a bundle names: over the canonical JSON of the document without its sha256 (run-export.ts). */
const digestOf = (doc: Record<string, unknown>): string => {
  const { sha256: _named, ...rest } = doc;
  return createHash("sha256").update(stable(rest)).digest("hex");
};

/** Each run field's type as the run's view serves it (the openapi Run, and the view's own fields): a string, a number
 *  or an object, any of them null too. The page reads them as such (a title's text, a cost's figures), so a stored
 *  share never breaks its own page. */
const RUN_FIELD_TYPES: Readonly<Record<(typeof SHARE_RUN_FIELDS)[number], "string" | "number" | "object">> = {
  kind: "string", status: "string", state: "string", title: "string", created_at: "string", ended_at: "string", stopped_for: "string", effort: "string",
  approvals: "string", budget_refused_calls: "number", result: "object", error: "object", review: "object", cost: "object",
};
function runShape(run: Record<string, unknown>): void {
  for (const [field, type] of Object.entries(RUN_FIELD_TYPES)) {
    const value = run[field];
    if (value === undefined || value === null) continue;
    const ok = type === "object" ? isObject(value) : type === "number" ? Number.isFinite(value) : typeof value === "string";
    if (!ok) refuse(`run.${field} is not ${type === "object" ? "an object" : `a ${type}`} or null`);
  }
}

/** A workflow run's graph as the page draws it (RunGraphView): the fields of the route's graph it reads, each of its
 *  type, so a stored share never breaks its own page. Other keys may stay: the scrubber reads the graph whole. */
function graphShape(value: unknown): void {
  if (!isObject(value)) return refuse("graph is neither null nor an object");
  const objects = (items: unknown[], at: string) => items.forEach((item, index) => isObject(item) || refuse(`${at}/${index} is not an object`));
  const run = isObject(value.run) ? value.run : refuse("graph.run is not an object");
  string(run.status, "graph.run.status");
  if (typeof run.paused !== "boolean") refuse("graph.run.paused is not true or false");
  const flow = isObject(value.graph) ? value.graph : refuse("graph.graph is not an object");
  for (const item of array(flow.nodes, "graph.graph.nodes")) {
    const node = isObject(item) ? item : refuse("graph.graph.nodes holds a node that is not an object");
    string(node.path, "graph.graph.nodes[].path");
    string(node.kind, "graph.graph.nodes[].kind");
  }
  objects(array(flow.edges, "graph.graph.edges"), "graph.graph.edges");
  const runs = isObject(value.nodes) ? value.nodes : refuse("graph.nodes is not an object");
  for (const node of Object.values(runs)) if (!isObject(node)) refuse("graph.nodes holds a run of a node that is not an object");
  objects(array(value.decisions, "graph.decisions"), "graph.decisions");
  const effects = array(value.effects, "graph.effects");
  if (effects.length > SHARE_EFFECTS) refuse(`graph.effects holds more than ${SHARE_EFFECTS} effects, more than an export writes`);
  objects(effects, "graph.effects");
  const totals = isObject(value.totals) ? value.totals : refuse("graph.totals is not an object");
  count(totals.decisions, "graph.totals.decisions");
  count(totals.effects, "graph.totals.effects");
}

/** `text` read as a share bundle the host takes, or a 400 that says why (never quoting a value of it): canonical JSON (the
 *  bytes the export writes: what is hashed, scanned and stored is one text), `agentrun.share/1`, the export's closed keys
 *  at every level it fixes (the run's allowlist, agent, source, files, omitted, cuts, restored; rows and the graph are
 *  the served shapes, read by the scrubber whole), its caps on files, each file's size and digest, and the document's
 *  sha256. */
export function checkShareBundle(text: string): { sha256: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return refuse("the body is not JSON");
  }
  const top = closed(doc, "the bundle", TOP);
  if (top.format !== SHARE_FORMAT) refuse(`its format is not ${SHARE_FORMAT}`);
  if (stable(doc) !== text) refuse("the body is not canonical JSON (keys sorted, no whitespace), as the export writes it");
  const source = closed(top.source, "source", ["agentrun", "scrubber"]);
  string(source.agentrun, "source.agentrun");
  const scrubber = closed(source.scrubber, "source.scrubber", ["version", "rules"]);
  count(scrubber.version, "source.scrubber.version");
  string(scrubber.rules, "source.scrubber.rules");
  const agent = closed(top.agent, "agent", ["name", "kind"]);
  string(agent.name, "agent.name");
  string(agent.kind, "agent.kind");
  const run = closed(top.run, "run", [], [...RUN_FIELDS]);
  runShape(run);
  if (run.imported_from !== undefined && run.imported_from !== null) string(closed(run.imported_from, "run.imported_from", ["source"]).source, "run.imported_from.source");
  array(top.rows, "rows");
  if (top.graph !== null) graphShape(top.graph);
  const files = array(top.files, "files");
  if (files.length > EXPORT_CAPS.files) refuse(`it carries more than ${EXPORT_CAPS.files} files`);
  let total = 0;
  for (const [index, entry] of files.entries()) {
    const at = `files/${index}`;
    const file = closed(entry, at, ["path", "bytes", "sha256", "encoding", "content"]);
    const path = string(file.path, `${at}.path`);
    const content = string(file.content, `${at}.content`);
    if (file.encoding !== "utf8") refuse(`${at} is not utf8 text`);
    const bytes = Buffer.byteLength(content);
    if (bytes > EXPORT_CAPS.fileBytes) refuse(`${at} is over ${EXPORT_CAPS.fileBytes} bytes`);
    total += bytes;
    if (count(file.bytes, `${at}.bytes`) !== bytes) refuse(`${at}.bytes is not its content's size`);
    if (file.sha256 !== packageSha256([{ path, encoding: "utf8", content }])) refuse(`${at}.sha256 is not its digest`);
  }
  if (total > EXPORT_CAPS.filesBytes) refuse(`its files are over ${EXPORT_CAPS.filesBytes} bytes in all`);
  for (const [index, entry] of array(top.omitted, "omitted").entries()) {
    const item = closed(entry, `omitted/${index}`, ["what", "why"], ["path"]);
    string(item.what, `omitted/${index}.what`);
    string(item.why, `omitted/${index}.why`);
    if (item.path !== undefined) string(item.path, `omitted/${index}.path`);
  }
  const record = (entry: unknown, at: string, extra: readonly string[]) => {
    const cut = closed(entry, at, ["id", "at", "start", "end", "rule", "kind", ...extra]);
    for (const field of ["id", "at", "rule"]) string(cut[field], `${at}.${field}`);
    count(cut.start, `${at}.start`);
    count(cut.end, `${at}.end`);
    if (!CUT_KINDS.has(String(cut.kind))) refuse(`${at}.kind is not a cut's kind`);
    return cut;
  };
  for (const [index, entry] of array(top.cuts, "cuts").entries()) {
    const cut = record(entry, `cuts/${index}`, ["restorable", "shape"]);
    if (typeof cut.restorable !== "boolean") refuse(`cuts/${index}.restorable is not a boolean`);
    string(cut.shape, `cuts/${index}.shape`);
  }
  for (const [index, entry] of array(top.restored, "restored").entries()) record(entry, `restored/${index}`, []);
  const named = string(top.sha256, "sha256");
  if (!HEX64.test(named) || named !== digestOf(top)) refuse("its sha256 is not the digest of its content");
  return { sha256: named };
}

/** Where a restored value may stand: a string of the run the export cut (run-export.ts), never the bundle's own words
 *  (its format, source, cuts, restored or sha256). */
const RESTORED_AT = /^\/(?:agent|run|rows|graph|omitted)\/|^\/files\/\d+\/(?:path|content)$/;
/** A rule id a refusal may name: the scrubber's own; anything else a record says is "unknown". */
const RULE_IDS: ReadonlySet<string> = new Set([...SCRUB_RULES.map((rule) => rule.id), ...SHARE_JEV_RULES]);
/** Whether a cut of `kind` may be restored: the scrubber's table for the kind alone, never a record's or a cut's word. */
const restorable = (kind: unknown): boolean => typeof kind === "string" && Object.hasOwn(RESTORABLE, kind) && RESTORABLE[kind as keyof typeof RESTORABLE];
const pointer = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");
const bump = (counts: Record<string, number>, rule: string): void => void (counts[rule] = (counts[rule] ?? 0) + 1);

/** A string value of the bundle: its RFC 6901 pointer, its text, and where its content (inside the quotes) sits in the
 *  canonical body. */
type Place = { at: string; value: string; from: number; to: number };
/** A hit of the host's own scrub of one string: where (the string's pointer, its span) and whether its kind restores. */
type StringHit = { at: string; rule: string; restorable: boolean; start: number; end: number };

/** `doc` written as stable() writes it, and every string value's place in that text, in the order of the text. */
function placesOf(doc: unknown): { text: string; places: Place[] } {
  const parts: string[] = [];
  const places: Place[] = [];
  let length = 0;
  const put = (text: string) => void (parts.push(text), (length += text.length));
  const walk = (value: unknown, at: string): void => {
    if (typeof value === "string") {
      const encoded = JSON.stringify(value);
      places.push({ at, value, from: length + 1, to: length + encoded.length - 1 });
      put(encoded);
    } else if (Array.isArray(value)) {
      put("[");
      value.forEach((item, index) => (index && put(","), walk(item, `${at}/${index}`)));
      put("]");
    } else if (isObject(value)) {
      put("{");
      Object.keys(value).sort().forEach((key, index) => (index && put(","), put(`${JSON.stringify(key)}:`), walk(value[key], `${at}/${pointer(key)}`)));
      put("}");
    } else put(JSON.stringify(value));
  };
  walk(doc, "");
  return { text: parts.join(""), places };
}

/** What a scrub of one string is handed: a file's path, a call's command read once into its facts, and whether the
 *  string is lines flattened onto one (the run's title). */
type PassContext = { readonly path?: string; readonly facts?: CommandFacts; readonly flattened?: true };

/** A file's content's pointer in a bundle: its index is group 1. */
const FILE_CONTENT_AT = /^\/files\/(\d+)\/content$/;
/** A workflow call's output in a bundle (graph.effects[i].output), or a string inside it: the effect's index is group 1. */
const EFFECT_OUTPUT_AT = /^\/graph\/effects\/(\d+)\/output(?:\/|$)/;

/** For each index 0..value.length of `value`, its offset in JSON.stringify(value) less the opening quote. */
function encodedOffsets(value: string): number[] {
  const offsets = [0];
  let at = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    const pair = code >= 0xd800 && code <= 0xdbff && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00;
    if (pair) offsets.push(at + 1); // a valid pair is written as itself, two units
    at += JSON.stringify(value.slice(index, index + (pair ? 2 : 1))).length - 2;
    offsets.push(at);
    index += pair ? 2 : 1;
  }
  return offsets;
}

/** What a string is read knowing: its call's (CallContext), and whether it is lines flattened onto one (the run's title). */
type ReadContext = CallContext & { readonly flattened?: true };

/** The scrubber over a bundle as a host reads it, refusing (422, counts by rule id, never a value or where) unless every
 *  value it finds is a declared restore.
 *
 *  Strict at its core: the scrubber in cut mode with `held` over the whole body, and again over every string value alone
 *  (as the export cut them: each at its pointer, so a value a string's own context gives away is found though its JSON
 *  escaping hides it from the whole-body read). A scrub that fails or throws is `scrub_failed`. The one exception is a
 *  filter over those hits: a hit of one string is excused when the scrubber's table says its kind restores (label,
 *  personal, jev; never format, held or dump) AND one `restored` record names it exactly (at, rule, start, end); a hit of
 *  the whole body is excused when it lies in one string and overlaps an excused hit there of its rule. Any hit left is
 *  `scrub_found`; a `restored` record that excuses no hit (a stale or edited bundle) is `restored_unmatched`, unless its
 *  rule is Jev's (SHARE_JEV_RULES), which the host never runs: that one is counted in `unchecked`, by rule, and taken.
 *  The kind a record says is never read. More than `strings` reads (each distinct string once per context it stands
 *  under) is 413 before any scrub. The cut text is
 *  never used: the host stores what was sent or nothing. */
export async function screenShare(text: string, held: readonly string[], cutPass: CutScrub = (body, opts) => scrub(body, opts), strings = SHARE_STRINGS): Promise<{ unchecked: Record<string, number> }> {
  const failed = () => new ApiError("input_invalid", "The share host's scrub of this bundle failed, so it is refused (the scrub fails closed). Nothing was stored.", { details: { reason: "scrub_failed" } });
  const pass = async (body: string, context?: PassContext) => {
    let result: Awaited<ReturnType<CutScrub>>;
    try {
      result = await cutPass(body, { mode: "cut", held, ...(context?.path !== undefined ? { path: context.path } : {}), ...(context?.facts !== undefined ? { command: context.facts.command, commandFacts: context.facts } : {}), ...(context?.flattened ? { flattened: true } : {}) });
    } catch {
      throw failed();
    }
    if (!result.ok) throw failed();
    return result.cuts;
  };
  const doc = JSON.parse(text) as Record<string, unknown>;
  const { text: rebuilt, places } = placesOf(doc);

  // Every string value alone, read with the context the export cut it with (run-export.ts): a file's content knowing its
  // path, and every string in a workflow call's output knowing that call's tool and input (share-context.ts
  // effectContext), so a .pgpass's or a .env's plain contents are a dump. A Timeline row's output is read with none: its
  // call's context comes from the run's calls, which no bundle carries. Each context is made once, for its file or call,
  // and named by a small id: a read is keyed by that id and its text, never by the context's own text (a call's command
  // can be megabytes, and its output thousands of strings). A text is read once per context it stands under, and those
  // reads are what the cap counts: more than `strings` is 413 before any scrub. The run's title is read as the export cut
  // it (run-export.ts): lines flattened onto one, so a transcript's env command and its output there is a dump.
  const files = Array.isArray(doc.files) ? doc.files : [];
  const effects = isObject(doc.graph) && Array.isArray(doc.graph.effects) ? doc.graph.effects : [];
  const contexts: (ReadContext | undefined)[] = [undefined, { flattened: true }]; // id 0: no context; id 1: the run's title
  const ids = new Map<string, number>(); // a context's id by its path and command, interned once per file or call
  const idOfPlace = new Map<string, number>(); // "f<index>" or "e<index>": its context's id
  const intern = (context: CallContext | undefined): number => {
    if (context?.path === undefined && context?.command === undefined) return 0;
    const name = JSON.stringify([context.path ?? null, context.command ?? null]);
    let id = ids.get(name);
    if (id === undefined) ids.set(name, (id = contexts.push(context) - 1));
    return id;
  };
  const contextIdOf = (at: string): number => {
    if (at === "/run/title") return 1;
    const fileIndex = FILE_CONTENT_AT.exec(at)?.[1];
    const effectIndex = fileIndex === undefined ? EFFECT_OUTPUT_AT.exec(at)?.[1] : undefined;
    if (fileIndex === undefined && effectIndex === undefined) return 0;
    const owner = fileIndex !== undefined ? `f${fileIndex}` : `e${effectIndex}`;
    let id = idOfPlace.get(owner);
    if (id === undefined) {
      const file: unknown = fileIndex !== undefined ? files[Number(fileIndex)] : undefined;
      const context = fileIndex !== undefined ? (isObject(file) && typeof file.path === "string" ? { path: file.path } : undefined) : effectContext(effects[Number(effectIndex)]);
      idOfPlace.set(owner, (id = intern(context)));
    }
    return id;
  };
  // Each context's texts (every one of them read once), in the order first seen.
  const reads = new Map<number, Map<string, Awaited<ReturnType<typeof pass>> | undefined>>();
  const placeIds: number[] = [];
  let distinct = 0;
  for (const place of places) {
    const id = place.value ? contextIdOf(place.at) : 0;
    placeIds.push(id);
    if (!place.value) continue;
    let texts = reads.get(id);
    if (!texts) reads.set(id, (texts = new Map()));
    if (!texts.has(place.value)) {
      texts.set(place.value, undefined);
      distinct++;
    }
  }
  if (distinct > strings) throw new ApiError("payload_too_large", `This bundle holds ${distinct} distinct strings (a text under two calls' contexts counted twice), over the ${strings} a share host scrubs one by one, so it is refused before any is read. Nothing was stored.`, { details: { reason: "share_strings", limit: strings, strings: distinct } });
  const whole = await pass(text);
  // A context's texts read together, each handed the context's command facts (commandFacts), made once for them all.
  for (const [id, texts] of reads) {
    const call = contexts[id];
    const context: PassContext | undefined = call && { ...(call.path !== undefined ? { path: call.path } : {}), ...(call.command !== undefined ? { facts: commandFacts(call.command) } : {}), ...(call.flattened ? { flattened: true as const } : {}) };
    for (const value of texts.keys()) texts.set(value, await pass(value, context));
  }

  const hits = new Map<string, StringHit>();
  const hitsAt = new Map<string, StringHit[]>();
  const key = (at: unknown, rule: unknown, start: unknown, end: unknown) => JSON.stringify([at, rule, start, end]);
  for (const [index, place] of places.entries()) {
    if (!place.value) continue;
    for (const cut of reads.get(placeIds[index]!)!.get(place.value)!) {
      const hit: StringHit = { at: place.at, rule: cut.rule, restorable: restorable(cut.kind), start: cut.start, end: cut.end };
      hits.set(key(hit.at, hit.rule, hit.start, hit.end), hit);
      const at = hitsAt.get(place.at);
      if (at) at.push(hit);
      else hitsAt.set(place.at, [hit]);
    }
  }

  // The exception: each restored record excuses the one restorable hit it names exactly, once.
  const excused = new Set<StringHit>();
  const unmatched: Record<string, number> = {};
  const unchecked: Record<string, number> = {};
  for (const entry of Array.isArray(doc.restored) ? doc.restored : []) {
    const record = isObject(entry) ? entry : {};
    const hit = typeof record.at === "string" && RESTORED_AT.test(record.at) ? hits.get(key(record.at, record.rule, record.start, record.end)) : undefined;
    if (hit && hit.restorable && !excused.has(hit)) excused.add(hit);
    else if (typeof record.rule === "string" && SHARE_JEV_RULES.has(record.rule)) bump(unchecked, record.rule);
    else bump(unmatched, typeof record.rule === "string" && RULE_IDS.has(record.rule) ? record.rule : "unknown");
  }

  const found: Record<string, number> = {};
  for (const hit of hits.values()) if (!excused.has(hit)) bump(found, hit.rule);
  const wholeFound: Record<string, number> = {};
  const starts = places.map((place) => place.from);
  // Each string's offsets once, however many of the whole body's finds fall in it.
  const offsetsOf = new Map<Place, number[]>();
  const offsetsIn = (place: Place) => {
    let offsets = offsetsOf.get(place);
    if (!offsets) offsetsOf.set(place, (offsets = encodedOffsets(place.value)));
    return offsets;
  };
  for (const cut of whole) {
    const place = rebuilt === text ? places[upperBound(starts, cut.start) - 1] : undefined;
    const inside = place !== undefined && cut.start >= place.from && cut.end <= place.to;
    const offsets = inside && restorable(cut.kind) ? offsetsIn(place) : undefined;
    const covered = offsets !== undefined && (hitsAt.get(place!.at) ?? []).some((hit) => excused.has(hit) && hit.rule === cut.rule && place!.from + offsets[hit.start]! < cut.end && cut.start < place!.from + offsets[hit.end]!);
    if (!covered) bump(wholeFound, cut.rule);
  }
  // A value both reads find is one value: each rule's count is the larger read's.
  for (const [rule, n] of Object.entries(wholeFound)) found[rule] = Math.max(found[rule] ?? 0, n);

  const words = (counts: Record<string, number>) => Object.entries(counts).map(([rule, n]) => `${rule} ${n}`).join(", ");
  const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total(found) > 0) {
    const n = total(found);
    throw new ApiError("input_invalid", `The share host's scrub found ${n} value${n === 1 ? "" : "s"} in this bundle that no restore declares (by rule: ${words(found)}), so it is refused. A restore keeps a label, personal or jev cut, never a known key format, a held value or a dump. Nothing was stored; export the run again with the cuts in place.`, { details: { reason: "scrub_found", counts: found, ...(total(unmatched) ? { unmatched } : {}), ...(total(unchecked) ? { unchecked } : {}) } });
  }
  if (total(unmatched) > 0) {
    const n = total(unmatched);
    throw new ApiError("input_invalid", `${n} restored record${n === 1 ? "" : "s"} of this bundle name${n === 1 ? "s" : ""} no value the share host's scrub finds there (by rule: ${words(unmatched)}): a stale or edited bundle, so it is refused. Nothing was stored; export the run again.`, { details: { reason: "restored_unmatched", counts: unmatched, ...(total(unchecked) ? { unchecked } : {}) } });
  }
  return { unchecked };
}

/** The number of sorted `values` at or below `at`. */
function upperBound(values: readonly number[], at: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! <= at) low = mid + 1;
    else high = mid;
  }
  return low;
}

// ---------- the store: <data>/shares/<id>/{bundle.json, meta.json}

/** What the host keeps of a share beside its bytes. `deleted_at` marks one its owner deleted: its bytes are gone, and its
 *  page answers 410. */
export type ShareMeta = { id: string; sha256: string; token_id: string; created_at: string; bytes: number; deleted_at?: string };

/** The shares of one host, in files under `dir`, written to a temp file and renamed, 0600 in 0700 folders. Kept in
 *  memory once read: this process is the folder's one writer. */
export class ShareStore {
  private index: Promise<Map<string, ShareMeta>> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string) {}

  private all(): Promise<Map<string, ShareMeta>> {
    return (this.index ??= (async () => {
      const found = new Map<string, ShareMeta>();
      const names = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
      for (const name of names) {
        if (!SHARE_ID.test(name)) continue;
        const folder = join(this.dir, name);
        const meta = await readFile(join(folder, "meta.json"), "utf8").then((text) => JSON.parse(text) as ShareMeta, (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : undefined));
        // No meta: a create that stopped between the bytes and the meta (both are renamed in whole), bytes nothing names.
        if (meta === null) await rm(folder, { recursive: true, force: true });
        if (!meta || meta.id !== name) continue;
        found.set(name, meta);
        // A delete that stopped after its tombstone: its bytes go now.
        if (meta.deleted_at) await rm(join(folder, "bundle.json"), { force: true });
      }
      return found;
    })().catch((error: unknown) => {
      this.index = undefined;
      throw error;
    }));
  }

  /** One write at a time: a quota is read and a share made in one step. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async get(id: string): Promise<ShareMeta | undefined> {
    return SHARE_ID.test(id) ? (await this.all()).get(id) : undefined;
  }

  /** The live shares `tokenId` made, oldest first. */
  async list(tokenId: string): Promise<ShareMeta[]> {
    return [...(await this.all()).values()].filter((meta) => meta.token_id === tokenId && !meta.deleted_at).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  /** A 403 when `tokenId` keeps its quota of shares already. */
  async roomFor(tokenId: string, quota: number): Promise<void> {
    const used = (await this.list(tokenId)).length;
    if (used >= quota) throw new ApiError("forbidden", `This token keeps ${used} shares, its most (${quota}). Delete one (DELETE /r/v2/shares/<id>) to make room.`, { details: { reason: "share_quota", limit: quota, used } });
  }

  /** Stores `body` as a new share of `tokenId`, the quota checked again inside the write. */
  create(tokenId: string, body: string, sha256: string, quota: number): Promise<ShareMeta> {
    return this.serial(async () => {
      await this.roomFor(tokenId, quota);
      const index = await this.all();
      let id = newShareId();
      while (index.has(id)) id = newShareId();
      const folder = join(this.dir, id);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await mkdir(folder, { mode: 0o700 });
      const meta: ShareMeta = { id, sha256, token_id: tokenId, created_at: new Date().toISOString(), bytes: Buffer.byteLength(body) };
      try {
        await writeAtomic(join(folder, "bundle.json"), body);
        await writeAtomic(join(folder, "meta.json"), `${JSON.stringify(meta)}\n`);
      } catch (error) {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      index.set(id, meta);
      return meta;
    });
  }

  /** The stored bytes of live share `id`. */
  bytes(id: string): Promise<Buffer> {
    return readFile(join(this.dir, id, "bundle.json"));
  }

  /** Deletes share `id` of `tokenId`: its bytes go, its meta stays as the tombstone its page's 410 reads. */
  delete(id: string, tokenId: string): Promise<void> {
    return this.serial(async () => {
      const meta = await this.get(id);
      if (!meta) throw new ApiError("not_found", `There is no share ${id} on this host.`);
      if (meta.token_id !== tokenId) throw new ApiError("forbidden", `The share ${id} was made with another token; only that token deletes it.`);
      if (!meta.deleted_at) {
        const gone: ShareMeta = { ...meta, deleted_at: new Date().toISOString() };
        await writeAtomic(join(this.dir, id, "meta.json"), `${JSON.stringify(gone)}\n`);
        (await this.all()).set(id, gone);
      }
      // Again on a deleted share: a removal an earlier delete never finished (it failed, or the process stopped).
      await rm(join(this.dir, id, "bundle.json"), { force: true });
    });
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, text, { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}

// ---------- the routes

export interface ShareHostDeps {
  /** The server's data folder: shares live in its `shares/`. */
  readonly data: string;
  /** The id of the token an Authorization header carries (api-token.ts bearerCheck), else undefined. */
  who(req: IncomingMessage): string | undefined;
  /** A refused credential, for the server's log line. */
  authFailed?(route: string, reason: string): void;
  /** The values this host holds (its own keys and tokens): a bundle that holds one is refused. */
  held(): readonly string[];
  /** The origin a share's URL is on: AGENTRUN_PUBLIC_URL, else the server's own address. Never a request's Host. */
  origin(): string;
  /** The console's build (share.html and its assets); the one beside the server when undefined. */
  console: string | undefined;
  version: string;
  /** The scrubber in cut mode, or a test's stand-in. */
  scrub?: CutScrub;
  quota?: number;
  /** The most distinct strings an upload may hold (SHARE_STRINGS), for a test. */
  strings?: number;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(res.req?.method === "HEAD" ? undefined : bytes);
};
const notFound = (raw: string) => new ApiError("not_found", `${raw} is not served here: a share host serves /r/<id>, /r/<id>/bundle.json, /r/_assets/ and /r/v2/ alone.`);
const allow = (methods: string) => new ApiError("method_not_allowed", `this address answers ${methods}`, {}, { allow: methods });

/** The share host's answer to every request, under /r/ or not: `fail` renders a refusal (server.ts's envelope). */
export function shareHost(deps: ShareHostDeps): (req: IncomingMessage, res: ServerResponse, raw: string) => Promise<void> {
  const store = new ShareStore(join(deps.data, "shares"));
  const quota = deps.quota ?? SHARE_QUOTA;
  const urlOf = (id: string) => `${deps.origin().replace(/\/+$/, "")}${SHARE_ROOT}${id}`;
  const view = (meta: ShareMeta) => ({ id: meta.id, url: urlOf(meta.id), sha256: meta.sha256, created_at: meta.created_at, bytes: meta.bytes });
  const tokenOf = (req: IncomingMessage, route: string): string => {
    const id = deps.who(req);
    if (id !== undefined) return id;
    deps.authFailed?.(route, req.headers.authorization === undefined ? "no_token" : "wrong_token");
    throw new ApiError("unauthenticated", "the share host's API takes one of its tokens as a Bearer header");
  };
  /** A share for its bytes: live, else 410 for a deleted one, 404 for none (its page answers the same status as HTML). */
  const live = async (id: string, raw: string): Promise<ShareMeta> => {
    const meta = await store.get(id);
    if (!meta) throw notFound(raw);
    if (meta.deleted_at) throw new ApiError("purged", `The share ${id} was deleted by its owner.`, { details: { deleted_at: meta.deleted_at } });
    return meta;
  };

  return async (req, res, raw) => {
    if (!raw.startsWith(SHARE_ROOT)) throw notFound(raw);
    const method = req.method === "HEAD" ? "GET" : req.method;
    if (raw.startsWith(SHARE_API)) {
      const route = SHARE_HOST_ROUTES.filter((entry) => entry.pattern.test(raw));
      if (route.length === 0) throw notFound(raw);
      const found = route.find((entry) => entry.method === method);
      if (!found) throw allow(route.map((entry) => entry.method).join(", "));
      if (found.name === "getShareHealth") return json(res, 200, { status: "ok", share_host: true, version: deps.version });
      const tokenId = tokenOf(req, raw);
      if (found.name === "listShares") {
        const mine = await store.list(tokenId);
        return json(res, 200, { shares: mine.map(view), quota: { limit: quota, used: mine.length } });
      }
      if (found.name === "deleteShare") {
        const id = found.pattern.exec(raw)![1]!;
        if (!SHARE_ID.test(id)) throw new ApiError("not_found", "There is no such share on this host.");
        await store.delete(id, tokenId);
        res.writeHead(204, { "cache-control": "no-store" });
        return void res.end();
      }
      // createShare: the quota before the body is read, and again as the share is made.
      await store.roomFor(tokenId, quota);
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new ApiError("unsupported_media_type", "a share's body is its bundle, application/json");
      const text = bodyText(await readCapped(req, SHARE_BODY_BYTES));
      const { sha256 } = checkShareBundle(text);
      const { unchecked } = await screenShare(text, deps.held(), deps.scrub, deps.strings);
      const meta = await store.create(tokenId, text, sha256, quota);
      // Restores of Jev's cuts the host took unchecked (it never runs Jev), by rule, when there are any.
      return json(res, 201, { id: meta.id, url: urlOf(meta.id), sha256: meta.sha256, ...(Object.keys(unchecked).length ? { restored_unchecked: unchecked } : {}) });
    }
    const rest = raw.slice(SHARE_ROOT.length);
    if (method !== "GET") throw allow("GET, HEAD");
    if (rest.startsWith("_assets/")) return sendHostedAsset(req, res, raw, deps.console, rest.slice("_assets/".length));
    const page = /^([^/]+)\/?$/.exec(rest);
    const bytes = /^([^/]+)\/bundle\.json$/.exec(rest);
    const id = (page ?? bytes)?.[1];
    if (id === undefined || !SHARE_ID.test(id)) throw notFound(raw);
    if (page) {
      // A person opened the link: a deleted or unknown share is still the page, with the bundle's status, and the page
      // says why from its own read of the bundle (410 deleted, 404 none). Never the API's JSON error.
      const meta = await store.get(id);
      return sendHostedSharePage(req, res, deps.console, meta === undefined ? 404 : meta.deleted_at ? 410 : 200);
    }
    await live(id, raw);
    const body = await store.bytes(id).catch(() => undefined);
    if (body === undefined) throw notFound(raw);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8", "content-length": body.length, "x-content-type-options": "nosniff", "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox", "referrer-policy": "no-referrer", "cache-control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
