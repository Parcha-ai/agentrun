// A model provider that refuses the run's key (401) says so in a person's words, naming the key and where to set it,
// in place of the provider's raw answer as each harness passes it on. Formed where a run's error is (runs.ts), so it
// holds on every harness. Only the shapes the harnesses give count (REFUSED); a 401 anywhere else in an error (a
// count, a file name, a duration, another service's status) is no refused key, and the error is left as it is.
import { DEFAULT_HARNESS } from "./harness.js";
import { harnessOf } from "./harness-table.js";
import { endsInScheme, redactSecrets, valueMatcher } from "./learn/secrets.js";
import { hostModel, MODEL_KEYS } from "./model.js";
import { modelWire, openRouterOnly, WIRES } from "./provider.js";
import { savedGatewayIn } from "./model-gateway.js";

/** The key a run's model requests carry, and who reads it: a provider's (saved in Settings → Model keys, or set where
 *  AgentRun starts), or serve's gateway's (set where AgentRun starts only). */
export type RunKey = { who: string; field: string; saved: boolean; where?: string };

const row = (id: string): RunKey | undefined => {
  const found = MODEL_KEYS.find((r) => r.id === id);
  return found && { who: found.label, field: found.field, saved: true };
};

/** The key `harness`'s run of model `ref` (the revision's; none, this host's default for the harness) sends, by the route
 *  its wire takes (provider.ts; pi's, model.ts); undefined where it is not a model key this server names. */
export function runKeyOf(env: NodeJS.ProcessEnv, harness: string = DEFAULT_HARNESS, ref?: string): RunKey | undefined {
  const named = ref ?? hostModel(env, "default", harness);
  const provider = named?.includes("/") ? named.slice(0, named.indexOf("/")) : undefined;
  // A gateway saved in the console (model-gateway.ts) is fixed there, never where AgentRun starts.
  const gateway: RunKey = savedGatewayIn(env) ? { who: "The model gateway saved in Settings → Model keys", field: "its key", saved: true, where: "enter its key again in Settings → Model keys → Use a model gateway, and test it there." } : { who: "The gateway at AGENT_MODEL_BASE_URL", field: "AGENT_MODEL_API_KEY", saved: false };
  const wire = harnessOf(env, harness)?.facts?.wire;
  // A harness billed to its own plan (Cursor's) runs on no model key of this server's.
  if (wire && !modelWire(wire)) return undefined;
  // Serve's gateway takes every request of the wire it serves, pi's too; a wire it does not serve never goes there.
  if (env.AGENT_MODEL_BASE_URL && (!wire || WIRES[wire].gateway)) return gateway;
  if (wire) return row(provider === "openrouter" || openRouterOnly(wire, env) ? "openrouter" : WIRES[wire].vendor);
  return provider === undefined ? undefined : row(provider);
}

/** The provider's own words after its 401: the message of the JSON it answered, else the text, its status word and any
 *  `url:` tail cut; its first sentence only, at most 200 characters. */
function detailOf(rest: string): string {
  const brace = rest.indexOf("{");
  if (brace >= 0) {
    try {
      const body = JSON.parse(rest.slice(brace, rest.lastIndexOf("}") + 1)) as { error?: { message?: unknown } | string; message?: unknown };
      const said = typeof body.error === "object" ? body.error?.message : body.error ?? body.message;
      if (typeof said === "string") rest = said;
    } catch {
      rest = rest.slice(0, brace);
    }
  }
  const text = rest.replace(/^[\s:.-]*(unauthorized\b)?[\s:.-]*/i, "").replace(/,?\s*url:.*$/is, "").trim();
  return (text.split(/(?<=[.!?])\s/)[0] ?? "").slice(0, 200).replace(/[.\s]+$/, "");
}

/** The most of a run's error or a tool's output serve ever shows: a Timeline row's text, cut at 2000 characters
 *  (`CAPS.text` in timeline/; a summary and a tool result's preview at 500), which the error box reads too. */
const SHOWN = 2000;

/** `text`, a run's error as serve shows it, with no held secret in it: the one rule learning's checker uses
 *  (learn/secrets.ts redactSecrets: each value as written, JSON-escaped, base64 at each offset, hex and percent-encoded,
 *  and secret-shaped text), over `secrets`, the values the server holds and handed its run.
 *
 *  Only the head serve can show is read: SHOWN characters, plus room for the longest held value in its widest encoded
 *  form (6 times it, for JSON's \uXXXX; percent is 3, hex 2, base64 4/3) and 16 more. A key whose start the cut can show
 *  starts before SHOWN, so it ends inside that head and is found whole; one that starts later is never shown. So a long
 *  error costs no more to redact than a short one, whatever it holds. `shown`: a head of another length, for a reader
 *  that is shown more. */
export function redacted(text: string, secrets: readonly string[], shown = SHOWN): string {
  const longest = secrets.reduce((most, value) => Math.max(most, value.length), 0);
  const window = shown + 6 * longest + 16;
  if (text.length <= window) return redactSecrets(text, secrets, Buffer.byteLength(text));
  const out = redactSecrets(text.slice(0, window), secrets, window * 4);
  // A replacement moves what follows it left by at most S characters in all: the shortening, plus 2 for each "[redacted]"
  // (a value of 8 or 9 characters grows into it). So output[0, shown - S) comes from raw text before `shown`, where every
  // key that starts ends inside the window and was found whole; past that, a copy the window cut could come into view.
  const shift = window - out.length + 2 * out.split("[redacted]").length - 2;
  const keep = shown - shift;
  return keep <= 0 ? "[redacted]" : `${out.slice(0, keep)}...`;
}

/** The most of a run's answer one redaction pass reads: learning's redactSecrets restarts after each overlapping match,
 *  so its cost grows with the square of what it reads; pieces this size keep each pass small. */
const ANSWER_PIECE = 8192;

/** How many texts redactedAnswer has read in this process: a test reads it to see a run's view served from what an
 *  earlier view redacted (runs.ts servedOnce). */
export const answerPasses = { count: 0 };

/** `text`, a run's answer as serve serves it (its final answer, or a string in its workflow output), with no held secret
 *  in it, and NEVER cut: an answer is shown whole. The same rule as redacted() (redactSecrets over `secrets`), over the
 *  whole text, read in pieces of about ANSWER_PIECE characters cut at whitespace. No form of a held value redactSecrets
 *  finds as it stands (as written, JSON-escaped, base64, hex) holds whitespace, so a cut there splits none; the one shape
 *  read across whitespace, a Bearer scheme and its token, is never cut between the two (endsInScheme). A run with no
 *  whitespace past a piece is cut at the end of a JSON string in it, or, a run of a JSON array's numbers only, after a
 *  comma (runCut), so compact JSON reads in pieces too. A run of more than ANSWER_PIECE characters with neither is no
 *  person's text and is shown as "[redacted]", unread. A value split across a cut, or a form only found across pieces,
 *  still shows to one valueMatcher pass over the joined output (with the head of each run left unread, where the rest of
 *  a value split before it would be), and then the whole answer is "[redacted]", as redactSecrets does with a text that
 *  still holds a value. */
export function redactedAnswer(text: string, secrets: readonly string[]): string {
  if (!text) return text;
  answerPasses.count++;
  const { out, seen } = inPieces(text, secrets);
  return valueMatcher(secrets)(seen) ? "[redacted]" : out;
}

/** `text`, a call's result as a grader's read shows it (timeline calls, tool_result_text), with no held secret in it:
 *  read in pieces as redactedAnswer reads an answer, then one valueMatcher pass over what the pieces show. Only the head
 *  the reader is shown is read: pieces stop once they show more than `shown` characters and the longest held value's
 *  widest form (6 times it, plus 16) in characters other than whitespace is read past them, so a value whose start they
 *  show ends inside what was read, split by whitespace or not; the caller cuts to `shown`. So no redaction pass reads
 *  more than a piece, however long the result or its head. */
export function redactedCall(text: string, secrets: readonly string[], shown: number): string {
  if (!text) return text;
  const { out, seen } = inPieces(text, secrets, shown);
  return valueMatcher(secrets)(seen) ? "[redacted]" : out;
}

/** `text` read in pieces as redactedAnswer says (pieceEnd), each redacted by itself: what the pieces show, joined, and
 *  what the valueMatcher pass after them reads, the same with the head of each run left unread put back before its
 *  "[redacted]". With `enough`, no piece is read once the pieces show more than `enough` characters and `hold`
 *  characters other than whitespace are read past those. */
function inPieces(text: string, secrets: readonly string[], enough = Number.POSITIVE_INFINITY): { out: string; seen: string } {
  const hold = 6 * secrets.reduce((most, value) => Math.max(most, value.length), 0) + 16;
  const out: string[] = [];
  const seen: string[] = [];
  let shown = 0;
  let past = 0;
  for (let from = 0; from < text.length && (shown <= enough || past < hold); ) {
    const to = pieceEnd(text, from);
    const raw = text.slice(from, to);
    const unread = raw.length > ANSWER_PIECE;
    const part = unread ? "[redacted]" : redactSecrets(raw, secrets, Buffer.byteLength(raw));
    if (shown > enough) past += raw.replace(/\s+/g, "").length;
    out.push(part);
    seen.push(unread ? `${raw.slice(0, hold)}${part}` : part);
    shown += part.length;
    from = to;
  }
  return { out: out.join(""), seen: seen.join("") };
}

/** Where the piece of `text` read from `from` ends: at its last whitespace before ANSWER_PIECE characters; with none, at
 *  runCut's place, else at the next whitespace (a run read as one, or unread past ANSWER_PIECE). */
function pieceEnd(text: string, from: number): number {
  const to = Math.min(text.length, from + ANSWER_PIECE);
  if (to === text.length) return to;
  const head = text.slice(from, to);
  const space = head.search(/\s[^\s]*$/);
  if (space <= 0) {
    const cut = runCut(text, from, to);
    return cut > from ? cut : runEnd(text, to);
  }
  const end = from + space + 1;
  // A cut after a Bearer scheme would leave its token at the head of the next piece, where no shape reads it (the shape
  // is the scheme, then the token). The cut moves back to the whitespace before the scheme; with none in this piece, the
  // scheme and its token are read as one run, to the next whitespace, as a run with no whitespace is.
  if (!endsInScheme(text.slice(from, end))) return end;
  const before = text.slice(from, end).trimEnd().search(/\s[^\s]*$/);
  return before > 0 ? from + before + 1 : runEnd(text, end);
}

/** The next whitespace in `text` at or after `at`, or its end. */
function runEnd(text: string, at: number): number {
  const next = text.slice(at).search(/\s/);
  return next < 0 ? text.length : at + next;
}

/** Where a run with no whitespace in text[from, to) may be cut, or -1: after the last quote in it that ends a JSON
 *  string (no backslash before it; a comma, colon or closing bracket after it), as no secret shape holds a quote there;
 *  or, a run of a JSON array's numbers only, after its last comma, as no shape is digits alone. A held value cut there
 *  still shows to the valueMatcher pass over the joined pieces, and withholds the text whole. */
function runCut(text: string, from: number, to: number): number {
  for (let at = text.lastIndexOf('"', to - 1); at >= from; at = at > 0 ? text.lastIndexOf('"', at - 1) : -1) {
    if (text[at - 1] !== "\\" && /[,:\]}]/.test(text[at + 1] ?? "")) return at + 1;
  }
  const head = text.slice(from, to);
  const comma = head.lastIndexOf(",");
  return comma > 0 && /^\s?[-+.\deE,[\]{}:]+$/.test(head) ? from + comma + 1 : -1;
}

/** Whether a number shows a held value. A held value can be all digits (a gateway's key), and a record or a call's
 *  arguments can quote it as a number: one whose digits hold a held value, by the same rule as a string's, is held. A
 *  number can also EQUAL a held value whose text differs from its own (a leading zero, 1e21, a long key read lossy). A
 *  boolean's text is shorter than any held value. */
export function heldNumber(value: number | bigint, secrets: readonly string[]): boolean {
  const text = String(value);
  return redactedAnswer(text, secrets) !== text || secrets.some((secret) => secret.trim() !== "" && Number(secret) === Number(value));
}

/** `value`, a run's workflow output, with redactedAnswer applied to each string and number in it, property NAMES
 *  included (a dictionary field can be keyed by anything a run wrote), its shape kept. Two names of one object that come
 *  out the same would merge one value over the other: that object is withheld whole, as "[redacted]". */
export function redactedOutput(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactedAnswer(value, secrets);
  if (typeof value === "number" || typeof value === "bigint") return heldNumber(value, secrets) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map((item) => redactedOutput(item, secrets));
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [redactedAnswer(key, secrets), redactedOutput(item, secrets)] as const);
    return new Set(entries.map(([key]) => key)).size === entries.length ? Object.fromEntries(entries) : "[redacted]";
  }
  return value;
}

/** What a thinking or text block may show while it streams: what has streamed so far,
 *  redacted by the same rule as redacted(), less a fixed tail held back until the block ends, when its settled row
 *  replaces this one whole. A key whose head has streamed but not its tail cannot be found by any redactor, and a key
 *  ending inside the tail would show its head. So the tail is the most a held value takes in its widest form (6 times it,
 *  plus 16), and only output that comes from raw text before it is kept: as in redacted(), each replacement moves what
 *  follows it left by at most S characters in all, so output[0, visible - S) comes from raw text before `visible`, where
 *  every key that starts ends inside what was read and was found whole, a key split by a line break among them. At most
 *  SHOWN characters are read past the tail, so a long stream costs no more than a short one. */
export function redactedLive(text: string, secrets: readonly string[]): string {
  const hold = 6 * secrets.reduce((most, value) => Math.max(most, value.length), 0) + 16;
  const visible = Math.min(SHOWN, text.length - hold);
  if (visible <= 0) return "";
  const window = Math.min(text.length, visible + hold);
  const out = redactSecrets(text.slice(0, window), secrets, window * 4);
  const shift = window - out.length + 2 * (out.split("[redacted]").length - 1);
  const keep = visible - shift;
  return keep <= 0 ? "" : out.slice(0, keep);
}

/** A provider's 401 as each harness puts it, at the start of the run's error:
 *  - pi-ai: `401: <body>` (its OpenAI-shaped APIs, OpenRouter's chat completions among them), `401 <body>` (Anthropic's
 *    SDK), or `<provider> API error (401): <body>` (its Responses API, serve's gateway's `agent-model API error (401): …`);
 *  - the Claude CLI, named by its adapter: `claude-agent: Failed to authenticate. API Error: 401 <message>`;
 *  - the Codex binary, named by its adapter: `codex: unexpected status 401 Unauthorized: <message>, url: …`.
 *  The match ends at the status, and the provider's words follow it. */
const REFUSED = /^(?:401\b|[^:\n]*\berror \(401\)|(?:claude-agent: )?(?:Failed to authenticate\. )?API Error: 401\b|(?:codex: )?unexpected status 401\b)/;

/** `text`, a run's error, in a person's words when it is a provider's 401 for `key` (REFUSED), with no value of
 *  `secrets` in it; undefined when it is not one. */
export function keyRefusal(text: string | undefined, key: RunKey | undefined, secrets: readonly string[] = []): string | undefined {
  if (!text || !key) return undefined;
  // Every held key's value out of the whole text first: cut afterwards, a key the provider echoed across the cut would
  // keep its start in the words.
  const said = redacted(text, secrets);
  const at = REFUSED.exec(said);
  if (!at) return undefined;
  const detail = detailOf(said.slice(at[0].length));
  const where = key.where ?? (key.saved ? "set it where AgentRun starts, or save it in Settings → Model keys." : "set it where AgentRun starts.");
  return `${key.who} refused ${key.field} (401${detail ? `: ${detail}` : ""}): ${where}`;
}

/** Codex's errors end on the address it sent the request to (", url: " and then serve's own loopback model proxy, with
 *  its port and /v1/responses); any loopback address in a run's error is the host's, never a person's. Only a loopback
 *  host itself: a host name that only starts with a loopback name goes on past it, is a public host, and keeps its
 *  address. Every pattern is tried at one place or advances past what it read, so a rewrite takes time in proportion to
 *  the text. */
const LOOPBACK_TAIL = /^url:\s*https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?![\w.-])(:\d+)?\S*\s*$/i; // key-gate: loopback-rule strips the loopback proxy address codex prints
/** A loopback host, by any of its names. */
const LOOPBACK_HOST = String.raw`(?:127\.0\.0\.1|localhost|\[::1\])`; // key-gate: loopback-rule the loopback host names every address pattern below shares
/** What ends an address's path: a space, a quote, a backslash (a JSON string's escape), a closing mark, the text's end, or
 *  a full stop followed by one of those (a sentence's, which stays). */
const STOP = String.raw`[\s,;:)\x22\x27\]\\]`;
const PATH = String.raw`[^\s,;:)\x22\x27\]\\]*?(?=${STOP}|\.(?:${STOP}|$)|$)`;
/** One with a scheme, its port and its path. */
const LOOPBACK = new RegExp(String.raw`https?:\/\/${LOOPBACK_HOST}(?![\w.-])(?::\d+)?${PATH}`, "gi"); // key-gate: loopback-rule replaces any loopback address with a scheme
/** A bare one: its port, then its path when one follows. A port followed by a letter, a digit, a dash or a full stop
 *  that ends no sentence names no address of the host's, so it is kept. */
const LOOPBACK_BARE = new RegExp(String.raw`(?<![\w.\/-])${LOOPBACK_HOST}:\d+(?:\/${PATH})?(?![\w-])(?!\.(?!${STOP}|$))`, "gi"); // key-gate: loopback-rule replaces a bare loopback address with its port, a refused connection to the proxy

/** `text` with each loopback address in it, with a scheme or bare with its port, its path with it, as "a local address",
 *  and nothing else of it changed: a sentence's full stop, a label before it, its line's end and a JSON string's quotes
 *  stay. What a learning text is served through (learning.ts secretsShown), and what withoutLoopback ends with. */
export function withoutLoopbackAddresses(text: string): string {
  return text.replace(LOOPBACK, "a local address").replace(LOOPBACK_BARE, "a local address");
}

/** `text`, a run's error, with no loopback address in it: Codex's `url:` tail goes (tried at the last "url:" only), and
 *  any other address alone becomes "a local address" (withoutLoopbackAddresses). */
export function withoutLoopback(text: string): string {
  let at = -1;
  for (const found of text.matchAll(/url:/gi)) at = found.index;
  let out = text;
  if (at >= 0 && LOOPBACK_TAIL.test(text.slice(at))) {
    out = text.slice(0, at).trimEnd();
    if (out.endsWith(",")) out = out.slice(0, -1);
  }
  return withoutLoopbackAddresses(out);
}

/** `value` with each string in it, however deep, through `cut`: what a run error's details hold is served and kept as its
 *  message is (runs.ts). */
export function cutStrings(value: unknown, cut: (text: string) => string): unknown {
  if (typeof value === "string") return cut(value);
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, cut));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutStrings(item, cut)]));
  return value;
}
