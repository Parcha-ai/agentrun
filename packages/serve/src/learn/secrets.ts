import { posix } from "node:path";
import { CREDENTIAL_NAMES, cutSpans, holds, MONEY_SHAPES, type Needles, planCut, SECRET_SHAPES, type Shape, shapeKinds, type Span, squeeze } from "../redact/match.js";

/** Whether `text` ends in a `Bearer` scheme and the blanks after it: the one place a shape is read across whitespace
 *  (the scheme, then its token), so a reader that cuts a text at whitespace must not cut there (key-refusal.ts
 *  redactedAnswer). */
export const endsInScheme = (text: string): boolean => {
  const head = text.trimEnd();
  return head.length < text.length && text.length - head.length <= 3 && /\bBearer$/i.test(head.slice(-7));
};

/** The kinds of secret-shaped text in `text` (redact/match.ts SECRET_SHAPES). */
export const secretShapes = (text: string): string[] => shapeKinds(text, SECRET_SHAPES);

/** Every secret shape, then a bank's numbers beside their words (MONEY_SHAPES): what learning never keeps. */
const LEARNED_SHAPES: readonly Shape[] = [...SECRET_SHAPES, ...MONEY_SHAPES];

/** The kinds of text in `text` learning never keeps: every secret shape, and a bank's numbers beside their words. */
export const learnedSecretShapes = (text: string): string[] => shapeKinds(text, LEARNED_SHAPES);

/** The longest field `redactSecrets` reads, in UTF-8 bytes, unless its caller names another bound. A longer one is printed
 *  whole as "[redacted]", never scanned: no field the checker prints is that long in good faith, and a crafted one (a
 *  long path) costs no scan. */
export const PRINT_MAX = 4096;

/** `text` with each of `values` (as written, as JSON writes it, and in each form the matcher finds as it stands: hex in
 *  any case, base64, a hex identifier in it folded) and each secret-shaped run replaced by "[redacted]": what the
 *  checker prints never holds a secret, wherever it was found, a file's name included, each value as a path names it too
 *  (pathSpellings) and as a URL's path writes it (percentForms). Every form is found in `text` as given, and overlapping
 *  finds are redacted as one, so one value never hides part of another from the search. A text that holds a value in a
 *  form not found as it stands (percent encoded, split by whitespace, an NFKC variant), read in `text` as given, is
 *  redacted whole, never in part, unless every character of it is inside what the finds cut: a cut can hide part of a
 *  value, so the rest is looked for before the cut (redact/match.ts planCut). So is a text over `max` bytes (PRINT_MAX
 *  unless the caller names more), and one whose cut leaves a value or a shape. */
export function redactSecrets(text: string, values: readonly string[], max = PRINT_MAX): string {
  return redactWith(text, values, max, SECRET_SHAPES);
}

/** `text` as redactSecrets cuts it, and of a bank's numbers beside their words too (MONEY_SHAPES): what learning prints
 *  and serves of what it learned or refused (a problem's path and detail, a note read), never a run's own view, which
 *  may show its user an account number. */
export function redactLearned(text: string, values: readonly string[], max = PRINT_MAX): string {
  return redactWith(text, values, max, LEARNED_SHAPES);
}

/** redactSecrets, and where it cut: the spans of `text` cut in place and the text so cut, or "whole" where redactSecrets
 *  answers "[redacted]". A reader that redacts a text in pieces (key-refusal.ts) reads the pieces as they came for a
 *  value split across them (valueLeft), each piece's cuts covering it. */
export function cutSecrets(text: string, values: readonly string[], max = PRINT_MAX): { spans: Span[]; out: string } | "whole" {
  if (Buffer.byteLength(text) > max) return "whole";
  return planCut(text, derivedOf(values), SECRET_SHAPES);
}

/** Whether `text` holds one of `values` in a form valueMatcher finds, a character of which no cut covers: what
 *  a reader that cut `text` there would still show of it. The cuts are `cuts` (merged spans of `text`, in order: where a
 *  reader that cut it in pieces cut each), or else those redactSecrets makes of `text` whole (its values' forms, hexes
 *  and folded identifiers, and the secret shapes, found as they stand). */
export function valueLeft(text: string, values: readonly string[], cuts?: readonly Span[]): boolean {
  const needles = derivedOf(values);
  return holds(text, needles, { cuts: cuts ?? cutSpans(text, needles, SECRET_SHAPES) });
}

/** redactSecrets over `shapes`, each found in place (redact/match.ts planCut). */
function redactWith(text: string, values: readonly string[], max: number, shapes: readonly Shape[]): string {
  if (Buffer.byteLength(text) > max) return "[redacted]";
  const cut = planCut(text, derivedOf(values), shapes);
  return cut === "whole" ? "[redacted]" : cut.out;
}

/** Each value set's Needles, by the array a caller passes, with a copy of the values it was derived of. A run's view
 *  redacts every row of its timeline with one array, and deriving it again for each row (path spellings, base64 at three
 *  alignments, percent forms, folded needles, for every value, a private key's PEM among them) took seconds per view.
 *  An array whose values changed since is derived again, never served a stale set: what a caller adds is always cut. */
const DERIVED = new WeakMap<readonly string[], { readonly values: readonly string[]; readonly derived: Needles }>();

/** What the matcher looks for of a set of values, whatever the text: each value, each string of a held JSON value
 *  that may be printed alone (heldFields) and their path spellings, their forms found as they stand (as written, as
 *  JSON writes it, their plain needles and percent forms), their hex and folded needles, the needles the whole-text
 *  check reads (redact/match.ts Needles), and the parts of each of many lines (partsOf), as written and squeezed. */
function derivedOf(values: readonly string[]): Needles {
  const kept = DERIVED.get(values);
  if (kept && kept.values.length === values.length && kept.values.every((value, at) => value === values[at])) return kept.derived;
  const held = values.filter((v) => v.length > 0);
  const whole = [...held, ...held.flatMap(heldFields)];
  const given = withPathSpellings(whole);
  const needles = new Map(given.filter(longEnough).map((v) => [v, needlesOf(v)]));
  const parts = [...new Set(whole.flatMap(partsOf))];
  const derived: Needles = {
    forms: [...new Set([...given.flatMap((v) => {
      const of = needles.get(v);
      return [v, asJson(v), ...(of ? [...of.plain, ...percentForms(v)] : [])];
    }), ...parts].filter((form) => form.length > 0))],
    hexes: [...needles.values()].map((of) => of.hex),
    folds: [...needles.values()].flatMap((of) => of.folded),
    plain: [...new Set([...[...needles.values()].flatMap((of) => of.plain), ...parts.map(squeeze)])],
  };
  DERIVED.set(values, { values: [...values], derived });
  return derived;
}

/** A value shorter than this matches too much text by chance to be refused. */
export const MIN_SECRET = 8;

/** An excerpt of a run's input or answer as learning keeps it: `text` cut of the secrets `shown` knows, whole, then
 *  shortened to `max` characters ("…" after a cut, never half a surrogate pair). Shortened first, a secret straddling the
 *  cut would leave its prefix, which no redactor matches after. Every stored or prompted excerpt is made here: a check's
 *  and an audit hold's disagreements (runner/promotion.ts decideCheck, runner/audit.ts applyHold), a compile turn's traces
 *  (runner/learning-end.ts traceFrom) and the compile answer a retry quotes (learn/compile.ts). */
export function excerptShown(text: string, shown: { readonly text: (text: string) => string }, max: number): string {
  const clean = shown.text(text);
  if (clean.length <= max) return clean;
  const end = /[\uD800-\uDBFF]/.test(clean.charAt(max - 1)) ? max - 1 : max;
  return `${clean.slice(0, end)}…`;
}

/** The base64 of `secret` as it can sit inside a longer blob: the characters that depend on the secret's bytes alone,
 *  at each of the three alignments, in both alphabets. */
function base64Needles(secret: Buffer): string[] {
  const out = new Set<string>();
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), secret]).toString("base64");
    const needle = encoded.slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + secret.length)) / 6));
    out.add(needle);
    out.add(needle.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return [...out];
}

const asJson = (value: string) => JSON.stringify(value).slice(1, -1);
/** A path with each run of "/" collapsed to one, each "." segment dropped ("/./", a leading "./") and a leading and a
 *  trailing "/" dropped, as a resolver writes it. */
const tidied = (value: string): string => {
  let path = value;
  for (let before = ""; before !== path; ) {
    before = path;
    path = path.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$)/g, "").replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
  }
  return path;
};

/** `value` as a path names it, each spelling that differs from it and is still long enough to be a secret. A tool that
 *  resolves a path the model wrote (pi's read) names the path it resolved in its error, so a held value comes back as
 *  the resolver writes it:
 *  - tidied: each run of "/" collapsed to one, each "." segment dropped, a leading and a trailing "/" dropped (a random
 *    base64 key holds "//" now and then);
 *  - its ".." segments resolved as posix.normalize resolves them ("a/x/../b" is "a/b": what is left is still the
 *    value's own text, and a piece of a secret is a secret);
 *  - each leading ".." consumed, one at a time: the path the model wrote may hold a folder before the value
 *    ("notes/../<value>"), which the leading ".." takes, so "../K" comes back as "K", and "../../K" as "../K" or "K". */
const pathSpellings = (value: string): string[] => {
  const tidy = tidied(value);
  const out = new Set<string>([tidy]);
  for (let resolved = tidied(posix.normalize(tidy)); ; ) {
    out.add(resolved);
    const next = tidied(resolved.replace(/^\.\.(?:\/|$)/, ""));
    if (next === resolved) break;
    resolved = next;
  }
  out.delete(value);
  return [...out].filter(longEnough);
};

/** `value` as a URL's path writes it, percent-encoded, when that differs: as encodeURIComponent writes it, its hex in
 *  upper case and in lower case as some encoders do, and as encodeURI writes it (it keeps "/", "+" and "="). Cut in
 *  place where found as it stands; any other encoding is still found by the matcher's decoded views, and the text is
 *  then cut whole. A text neither can encode (a lone surrogate) has no such form. */
const percentForms = (value: string): string[] => {
  let forms: string[];
  try {
    const upper = encodeURIComponent(value);
    forms = [upper, upper.replace(/%[0-9A-F]{2}/g, (byte) => byte.toLowerCase()), encodeURI(value)];
  } catch {
    return [];
  }
  return [...new Set(forms)].filter((form) => form !== value);
};
/** Each held value, then its path spellings: every form a cut or the guard derives, derived of each. */
const withPathSpellings = (values: readonly string[]): string[] => [...new Set(values.flatMap((value) => [value, ...pathSpellings(value)]))];

/** The separators a hex identifier is written with: a UUID's dashes, and the underscores, colons and dots of others. */
const SEPARATORS = /[-_:.]/g;
/** The fewest hex digits a run of a value must hold to be matched folded: a UUID's 32 and a Kernel profile's 20 do; a
 *  short hex run (a port, a year, a word made of a-f) does not, as its folded form would match too much text. */
const FOLD_MIN = 16;
/** A text as a folded needle is looked for in it: lowercased, its separators gone. */
const folded = (text: string) => text.toLowerCase().replace(SEPARATORS, "");

/** The hex identifiers of `value`, folded: each maximal run of hex digits and separators holding at least FOLD_MIN hex
 *  digits and at least half of the value (its identity, a short prefix aside), lowercased, its separators gone. A
 *  sign-in pointer (`ctx/<uuid>`, `agentrun-<hex>`) is found so however its hex is written: uppercased, its dashes
 *  dropped or moved. Nothing else of a value is folded: a key in mixed case is found as written, and so is a key whose
 *  hex run is only its tail (`<words>-<hex>`), whose run alone is no secret and would cut another value sharing it. */
function foldedOf(value: string): string[] {
  const out = new Set<string>();
  for (const run of value.match(/[0-9a-f_:.-]+/gi) ?? []) {
    const digits = folded(run);
    if (digits.length >= FOLD_MIN && 2 * run.length >= value.length) out.add(digits);
  }
  return [...out];
}

/** What a matcher looks for of `value`: its forms as they stand in a squeezed text (plain, as JSON writes it, base64 or
 *  base64url), its hex, in any case, and its hex identifiers folded (foldedOf). */
function needlesOf(value: string): { plain: string[]; hex: string; folded: string[] } {
  const raw = Buffer.from(value, "utf8");
  return { plain: [...new Set([squeeze(value), squeeze(asJson(value)), ...base64Needles(raw)])], hex: raw.toString("hex"), folded: foldedOf(value) };
}

const longEnough = (value: string) => [...value].length >= MIN_SECRET;

/** The fewest characters a line of a held value must have to be held as a part of it: a key's base64 line (64) is, a
 *  short line any text may hold ("-----END …-----", "}", a JSON field's name and a word) is not. */
const LINE_MIN = 40;
const ARMOR_BEGIN = /^-----BEGIN [^-]*-----$/;
const ARMOR_END = /^-----END [^-]*-----$/;

/** The parts of a held value of many lines that a reader may print without the rest (`head -n 11 key.pem`, a body
 *  with its armor stripped), each held as itself, found as it stands and cut in place, and found in each view: each
 *  line of its body of LINE_MIN characters or more, and its body with its line breaks gone. Its body is its lines but
 *  a first "-----BEGIN …-----" and a last "-----END …-----", its armor. A value of one line has none: it is matched
 *  whole. */
function partsOf(value: string): string[] {
  const lines = value.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return [];
  const body = lines.slice(ARMOR_BEGIN.test(lines[0]!) ? 1 : 0, ARMOR_END.test(lines.at(-1)!) ? -1 : lines.length);
  return [...body.filter((line) => line.length >= LINE_MIN), body.join("")].filter(longEnough);
}

/** The strings of a held JSON value (an object or an array, as it parses, at any depth) that may be printed alone, each
 *  held as itself (trimmed), as any held value: one that holds a line break (a service account's private key, `jq -r
 *  .private_key`), and one whose key, lowered, is a credential's whole name (redact/match.ts CREDENTIAL_NAMES: an OAuth
 *  client's "client_secret", a token's "refresh_token"; never "page_token"). An array's items have no key, so only the
 *  line-break rule holds them. Its other strings are not held: an id, a project, an email and public URLs ("client_id",
 *  "token_uri") are no secret, and would be cut wherever a text names them. */
function heldFields(value: string): string[] {
  const head = value.trimStart()[0];
  if (head !== "{" && head !== "[") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  const out: string[] = [];
  // Walked with a stack of its own, not a call per level: a value nested thousands deep is read as any other.
  const stack: [node: unknown, key: string | undefined][] = [[parsed, undefined]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [node, key] = next;
    if (typeof node === "string") {
      if (/[\r\n]/.test(node) || (key !== undefined && CREDENTIAL_NAMES.has(key.toLowerCase()))) out.push(node.trim());
    } else if (Array.isArray(node)) for (const item of node) stack.push([item, undefined]);
    else if (node !== null && typeof node === "object") for (const [name, item] of Object.entries(node)) stack.push([item, name]);
  }
  return out.filter(longEnough);
}

/** A matcher for `values` in a text: plain, split by whitespace, as JSON writes it, percent or form encoded, base64 or
 *  hex, and each hex identifier in a value folded: in any case, its separators dropped or moved (foldedOf). Values
 *  shorter than MIN_SECRET are left out. `fold: false`, the matcher without the folded needles. */
export function valueMatcher(values: readonly string[], { fold = true }: { fold?: boolean } = {}): (text: string) => boolean {
  const needles = derivedOf(values);
  return (text) => holds(text, needles, { fold });
}
