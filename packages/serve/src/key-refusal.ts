// A model provider that refuses the run's key (401) says so in a person's words, naming the key and where to set it,
// in place of the provider's raw answer as each harness passes it on. Formed where a run's error is (runs.ts), so it
// holds on every harness. Only the shapes the harnesses give count (REFUSED); a 401 anywhere else in an error (a
// count, a file name, a duration, another service's status) is no refused key, and the error is left as it is.
import { DEFAULT_HARNESS } from "./harness.js";
import { harnessOf } from "./harness-table.js";
import { cutSecrets, endsInScheme, foldsHeld, redactSecrets, secretShapes, valueLeft, valueMatcher } from "./learn/secrets.js";
import { hostModel, MODEL_KEYS } from "./model.js";
import { modelWire, openRouterOnly, WIRES } from "./provider.js";
import { entityAt, jsonEscapeAt, scanned, squeeze, type Span } from "./redact/match.js";
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
 *  whitespace past a piece is cut at the end of a JSON string in it (never in a URL's user and password), or, a run of
 *  a JSON array's numbers only, after a comma (runCut), so compact JSON reads in pieces too. A run of more than ANSWER_PIECE characters with neither is no
 *  person's text and is shown as "[redacted]", unread, from where its run starts. A value or a secret shape split across
 *  a cut, or a form only found across pieces, still shows to one pass over the joined pieces (heldIn: valueLeft over
 *  them as they came, and secretShapes over them redacted; with the head of each run left unread, where the rest of a
 *  value split before it would be, and its tail, where the head of a value split after it would be), and then the whole
 *  answer is "[redacted]", as redactSecrets does with a text that still holds a value. So is an answer whose pieces,
 *  as shown, read as a held value together (heldIn reads the text it returns too). A value split inside one piece withholds only that piece, by the piece's own redaction. */
export function redactedAnswer(text: string, secrets: readonly string[]): string {
  if (!text) return text;
  answerPasses.count++;
  const { out, seen } = inPieces(text, secrets);
  return heldIn(seen, secrets, out) ? "[redacted]" : out;
}

/** `text`, a call's result as a grader's read shows it (timeline calls, tool_result_text), with no held secret in it:
 *  read in pieces as redactedAnswer reads an answer, each piece redacted, then shown as `show` makes it (the timeline's
 *  scrubUrls), then one pass over the pieces (heldIn). Every check reads the text as it came, redacted, and not only as
 *  shown: shown, a URL's query, fragment and userinfo are cut apart, and a held value in one no longer reads as itself;
 *  what it returns is read too, for a held value its pieces show only together. A piece
 *  never splits a URL (it is cut at whitespace, after a quote, or in a run of numbers), so a piece shows as the whole
 *  text would. Only the head the reader is shown is read: pieces stop once they show more than `shown` characters, and
 *  the pass also reads the text where they stopped (peek), so a value or a shape the stop split is seen whole. Every
 *  character returned was read; the caller cuts it to `shown`. So no redaction pass reads more than a piece, however long
 *  the result or its head. */
export function redactedCall(text: string, secrets: readonly string[], shown: number, show: (piece: string) => string = (piece) => piece): string {
  if (!text) return text;
  const { out, seen, short } = inPieces(text, secrets, shown, show);
  // A read that stopped on what it read, before what it shows reached `shown`, ends as a cut does ("...", timeline/util.ts
  // cut), so a reader (the link check) knows it is not whole.
  const result = short ? `${out}...` : out;
  return heldIn(seen, secrets, result) ? "[redacted]" : result;
}

/** Whether redactSecrets withholds `text` whole: it holds a held value or a secret shape no cut in place takes (split by
 *  whitespace, encoded, written as JSON's \uXXXX escapes). Read whole, never in pieces: the caller bounds what it reads
 *  (a web call's strings, joined: timeline calls.holds). */
export function withheldWhole(text: string, secrets: readonly string[]): boolean {
  return redactSecrets(text, secrets, Number.POSITIVE_INFINITY) === "[redacted]";
}

/** Whether the text a reader is about to be shown (`shown`, what the caller returns) holds a held value, or the joined
 *  pieces still hold one or a secret shape: one a cut split. `shown` is read whole for a held value (valueMatcher, one
 *  linear pass): however the pieces were put together, as each was cut or shown, or an unread run's "[redacted]" between
 *  them, no text that reads as a held value is returned (a held value holding "[redacted]", its parts on either side of
 *  a cut in another piece). A value is also looked for in the pieces as they came, joined by line breaks, each piece's
 *  own cuts covering it (valueLeft): a piece's cut can take part of a value split across pieces (a credential
 *  parameter's value cut in place at the end of a piece, the rest of the held value in the next), and the rest then no
 *  longer reads as the value. A piece withheld whole covers all of itself, so a value split inside one piece is that
 *  piece's own redaction's, and only a value no cut covers across pieces (or in the text read past where they stopped)
 *  withholds the text. Each unread run's head and tail are covered (it shows as "[redacted]") and read: its head for the
 *  rest of a value split before it, its tail for the head of a value whose rest comes after it. A shape is looked for in
 *  the pieces each redacted (a shape whole in one is no shape a cut split). A peek too long to read (`unread`) withholds
 *  the text too. */
function heldIn(seen: Seen, secrets: readonly string[], shown: string): boolean {
  return seen.unread || valueMatcher(secrets)(shown) || valueLeft(seen.raw, secrets, seen.cuts) || secretShapes(seen.shapes).length > 0;
}

/** What the pass after the pieces reads: their text as it came, joined by line breaks (`raw`), with the spans of it the
 *  pieces cut (`cuts`), and the pieces each redacted, for the shapes (`shapes`). */
type Seen = { raw: string; cuts: Span[]; shapes: string; unread: boolean };
/** A stretch of the text as it came, as the pass reads it, and the spans of it its piece cut. */
type Read = { text: string; cuts: readonly Span[] };

/** `text` read in pieces as redactedAnswer says (pieceEnd), each redacted by itself: what the pieces show, joined, and
 *  what the pass after them reads (heldIn): each piece as it came and the spans its redaction cut, and each piece
 *  redacted, with the head and the tail of each unread run put back (covered, as they came; the head redacted by itself
 *  before its "[redacted]" for the shapes). A run runCut cut that then goes on past a piece with
 *  no place to cut is unread from its start, the pieces of it already read taken back, so no piece shows the head of a
 *  value or a shape the cut split. With `enough`, no piece is read once the pieces show more than `enough` characters,
 *  and the text where they stopped, `hold` characters the matcher sees of it (peek), goes to the pass the same way.
 *  Each piece is redacted, then shown as `show` makes it: `out` is what the pieces show, the pass reads them unshown. */
function inPieces(text: string, secrets: readonly string[], enough = Number.POSITIVE_INFINITY, show: (piece: string) => string = (piece) => piece): { out: string; seen: Seen; short: boolean } {
  const hold = 6 * secrets.reduce((most, value) => Math.max(most, value.length), 0) + 16;
  const fold = foldsHeld(secrets);
  const out: string[] = [];
  const shapes: string[] = [];
  const reads: Read[] = [];
  let shown = 0;
  let unread = false;
  // The run runCut is cutting: where it starts in `text`, and its first piece's index in `out`.
  let run: { from: number; at: number } | undefined;
  let from = 0;
  // Also stops past 4 × `enough` characters read: text that shows as almost nothing (URLs whose queries are elided) is
  // not read to its end. Where it stops, the peek reads on as at any stop.
  while (from < text.length && shown <= enough && from <= 4 * enough) {
    const to = pieceEnd(text, from);
    const raw = text.slice(from, to);
    if (raw.length > ANSWER_PIECE) {
      const start = run?.from ?? from;
      if (run) {
        for (const part of out.splice(run.at)) shown -= part.length;
        shapes.splice(run.at);
        reads.splice(run.at);
      }
      const head = peek(text, start, hold, fold);
      if (head === undefined) unread = true;
      else {
        shapes.push(`${redactSecrets(head, secrets, Buffer.byteLength(head))}[redacted]`);
        // The run is shown as "[redacted]": its head is read, covered, for the rest of a value split before it, and its
        // tail (at most `hold` characters, at most a piece), covered too, for the head of a value whose rest comes after
        // it. One read, the two joined by a line break, as each piece is one.
        const tail = text.slice(Math.max(start, to - Math.min(hold, ANSWER_PIECE)), to);
        const both = `${head}\n${tail}`;
        reads.push({ text: both, cuts: [[0, both.length]] });
      }
      out.push("[redacted]");
      shown += "[redacted]".length;
      run = undefined;
    } else {
      const cut = cutSecrets(raw, secrets, Buffer.byteLength(raw));
      const part = cut === "whole" ? "[redacted]" : cut.out;
      reads.push({ text: raw, cuts: cut === "whole" ? [[0, raw.length]] : cut.spans });
      // A piece that ends inside a run (runCut's): its run goes on in the next piece.
      if (to < text.length && /\S/.test(text[to - 1] ?? "") && /\S/.test(text[to] ?? "")) run ??= { from, at: out.length };
      else run = undefined;
      const showsAs = show(part);
      out.push(showsAs);
      shapes.push(part);
      shown += showsAs.length;
    }
    from = to;
  }
  if (from < text.length) {
    // Stopped inside a run runCut cut: the rest of it, to its next whitespace (at most a piece), goes to the pass too.
    const space = run ? text.slice(from, from + ANSWER_PIECE).search(/\s/) : 0;
    scanned.chars += space < 0 ? Math.min(ANSWER_PIECE, text.length - from) : space + 1;
    const runTo = from + (space < 0 ? ANSWER_PIECE : space);
    const ahead = peek(text, from, hold, fold);
    if (ahead === undefined) unread = true;
    else {
      const rest = runTo > from + ahead.length ? text.slice(from, runTo) : ahead;
      shapes.push(redactSecrets(rest, secrets, Buffer.byteLength(rest)));
      reads.push({ text: rest, cuts: [] });
    }
  }
  // The reads joined by line breaks, each one's cuts moved to where it stands in the join. The matcher's views read a
  // line break as nothing, so a value whole across two pieces is no form found as it stands there, and is left.
  let raw = "";
  const cuts: Span[] = [];
  reads.forEach((read, at) => {
    if (at > 0) raw += "\n";
    for (const [start, end] of read.cuts) cuts.push([raw.length + start, raw.length + end]);
    raw += read.text;
  });
  const [shows, cutShapes] = [out.join(""), shapes.join("")];
  // Each of the three joins read once.
  scanned.chars += raw.length + shows.length + cutShapes.length;
  return { out: shows, seen: { raw, cuts, shapes: cutShapes, unread }, short: from < text.length && shown <= enough };
}

/** text from `from` on, as far as `count` characters the matcher sees (all of it, if it holds fewer), each run of
 *  whitespace in it one space. The matcher reads "+" as a space and decodes percent-encoded bytes, JSON's escapes (one
 *  level and two, as the JSON view reads them) and HTML's numeric character references, so a "+", an encoded byte, an
 *  escape and a reference that decode to whitespace
 *  count no more than whitespace does, and any other escape counts as what the view keeps of the character it decodes
 *  to. A character that renders as nothing (a zero-width space, a soft hyphen) or a combining mark counts as nothing
 *  too: the views drop it. So does a quote or JSON's punctuation ("{", "}", "[", "]", ",", ":"), which the join view
 *  drops between a text's strings, and, with `fold` (a held value folds: learn/secrets.ts foldsHeld), a separator ("-",
 *  "_", ":", "."), which the fold view drops. Padding of any of them never hides the rest of a value split before it.
 *  Undefined, so the caller withholds the text, when that takes more than a piece of text (a run of whitespace counted
 *  as one): no redaction pass reads more than a piece. */
function peek(text: string, from: number, count: number, fold: boolean): string | undefined {
  const parts: string[] = [];
  let span = 0;
  let found = 0;
  let escape: { char: string; end: number } | undefined;
  for (let at = from; at < text.length && found < count; ) {
    SPACES.lastIndex = at;
    let end = SPACES.test(text) ? SPACES.lastIndex : at;
    if (end > at) {
      parts.push(" ");
      span++;
    } else {
      while (end - at <= ANSWER_PIECE && text[end] === "%" && HEX_PAIR.test(text.slice(end + 1, end + 3))) end += 3;
      if (end > at) found += kept(Buffer.from(text.slice(at, end).replaceAll("%", ""), "hex").toString("utf8"), fold);
      else if ((text[at] === "\\" && (escape = jsonEscapeAt(text, at)) !== undefined) || (text[at] === "&" && (escape = entityAt(text, at)) !== undefined)) {
        end = escape.end;
        found += kept(escape.char, fold);
      } else {
        end = at + 1;
        if (text[at] !== "+") found += kept(text[at]!, fold);
      }
      parts.push(text.slice(at, end));
      span += end - at;
    }
    // Each character read, a percent-encoded run's twice more (its hex parsed, then decoded).
    scanned.chars += text[at] === "%" && end > at + 1 ? 3 * (end - at) : end - at;
    if (span > ANSWER_PIECE) return undefined;
    at = end;
  }
  return parts.join("");
}
const SPACES = /\s+/y;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
/** What every view drops between a text's strings: a quote and JSON's punctuation (the join view). */
const JOIN_DROPS = new Set(['"', "{", "}", "[", "]", ",", ":"]);
/** What the fold view drops: the separators of a hex identifier. */
const FOLD_DROPS = new Set(["-", "_", ":", "."]);
/** How many characters the views keep of `chars` at the least (peek): squeezed, less each the join view drops, and,
 *  with `fold`, each the fold view drops. */
function kept(chars: string, fold: boolean): number {
  let count = 0;
  for (const char of squeeze(chars)) if (!JOIN_DROPS.has(char) && !(fold && FOLD_DROPS.has(char))) count += char.length;
  return count;
}

/** Where the piece of `text` read from `from` ends: at its last whitespace before ANSWER_PIECE characters; with none, at
 *  runCut's place, else at the next whitespace (a run read as one, or unread past ANSWER_PIECE). */
function pieceEnd(text: string, from: number): number {
  const to = Math.min(text.length, from + ANSWER_PIECE);
  if (to === text.length) return to;
  const head = text.slice(from, to);
  const space = head.search(/\s[^\s]*$/);
  // The search for the piece's last whitespace reads each run of the piece twice at most (to the run's end, then back);
  // the scheme's check after it, as much again.
  scanned.chars += 4 * head.length;
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
  scanned.chars += next < 0 ? text.length - at : next + 1;
  return next < 0 ? text.length : at + next;
}

/** Where a run with no whitespace in text[from, to) may be cut, or -1: after the last quote in it that ends a JSON
 *  string (no backslash before it; a comma, colon or closing bracket after it) and is in no URL's authority
 *  (authorities); or, a run of a JSON array's numbers only, after its last comma. The one secret shape that may hold a
 *  quote is a URL's user and password, so no cut splits a shape, whatever its length: a run with no other place to cut
 *  is read to its end, or unread from its start. A held value cut there still shows to the pass over the joined pieces
 *  (heldIn), and withholds the text whole. Each search keeps to text[from, to), but for where a URL's authority ends,
 *  which is read once per URL, to the end of its run at most. */
function runCut(text: string, from: number, to: number): number {
  const head = text.slice(from, to);
  // The head read three times: back from its end for each quote, and for a JSON array's numbers twice.
  scanned.chars += 3 * head.length;
  const urls = authorities(text, from, head);
  let url = urls.length - 1;
  for (let at = head.lastIndexOf('"'); at >= 0; at = at > 0 ? head.lastIndexOf('"', at - 1) : -1) {
    // The authority starting last before this quote, the one it could be in: they do not overlap.
    while (url >= 0 && urls[url]![0] >= at) url--;
    const inUrl = url >= 0 && at < urls[url]![1];
    if (!inUrl && (at > 0 ? head[at - 1] : text[from - 1]) !== "\\" && /[,:\]}]/.test(text[from + at + 1] ?? "")) return from + at + 1;
  }
  const comma = head.lastIndexOf(",");
  return comma > 0 && /^\s?[-+.\deE,[\]{}:]+$/.test(head) ? from + comma + 1 : -1;
}

/** Each URL authority in `head` (text from `from`) that holds a user and password, as [start, end) in `head`: from its
 *  "://" to the "@" that ends it, past the head's end if need be. One whose first whitespace, "/", "?" or "#" comes
 *  before any "@" (a URL with no password, then the rest of the JSON it is in) holds none, so none of it is kept whole. */
function authorities(text: string, from: number, head: string): [number, number][] {
  const found: [number, number][] = [];
  const stop = /[\s/?#@]/g;
  for (let at = head.indexOf("://"); at >= 0; at = head.indexOf("://", at)) {
    stop.lastIndex = from + at + 3;
    const hit = stop.exec(text);
    const end = (hit?.index ?? text.length) - from;
    // Its authority, from the "://" to the stop (the head's search for "://" counts with runCut's reads).
    scanned.chars += end - at;
    if (hit?.[0] === "@") found.push([at, end]);
    if (end >= head.length) break;
    // Past an "@", on; past any other stop, from the character before it: a "/" may be the first of the next "://".
    at = hit?.[0] === "@" ? end : end - 1;
  }
  return found;
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
