import { posix } from "node:path";

const SK_KEY = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/;
const SLACK_TOKEN = /xox[abposre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}/;
const GITHUB_TOKEN = /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
/** A Standard Webhooks signing secret: `whsec_` and base64, this server's or any other's. */
const WEBHOOK_SECRET = /whsec_[A-Za-z0-9+/]{24,}={0,2}/;
/** The token after a `Bearer` scheme (RFC 6750's characters), in any case: twenty characters or more with a digit among
 *  them, so a word after "bearer" ("bearer authentication/authorization"), a placeholder (`<token>`, `$TOKEN`,
 *  `YOUR_API_KEY`) and a challenge's parameter (`Bearer realm="x"`) are none. The token alone is the match: the scheme
 *  before it stays, so a reader still sees a header was there. The scheme is at most three blanks before the token, and
 *  the digit is looked for only through the token's own characters, so the reading stays linear. */
const BEARER_TOKEN = /(?<=\bBearer\s{1,3})(?=[A-Za-z._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}={0,2}/i;
/** The value of a URL parameter named like a credential, after `?` or `&`: sixteen characters or more, to the next
 *  separator. The name is the whole parameter's (`token`, never `page_token`), and the value alone is the match, so the
 *  name stays. A signed URL's signature is one: whoever holds the URL holds what it grants. No bracket is a value's
 *  character (a URL writes one percent-encoded), so a value already cut to "[redacted]" is never read as one. */
const URL_CREDENTIAL = /(?<=[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|id[_-]?token|refresh[_-]?token|client[_-]?secret|x-amz-signature|x-amz-security-token|x-goog-signature|token|secret|password|passwd|signature|sig)=)[^\s&#"'`<>\\[\]]{16,}/i;
const URL_PASSWORD = /:\/\/[^\s/?#@:]+:[^\s/?#@]*@/;
/** A complete, single-quoted sed search expression whose password is only a capture pattern.
 * The @ inside [^@] is regex syntax, not a password terminator. Require the closing capture,
 * substitution/backreference and quote too; bracketed passwords or bare URLs are never exempt. */
const SED_URL_CAPTURE = /(?:^|[\s;(])sed[ \t]+-n[ \t]+'s\|https?:\/\/(?:[A-Za-z0-9._~-]+|\[\^:\]\*):\\\(\[\^@\]\*\\\)@[A-Za-z0-9.-]+\|\\1\|p'/g;

/** A bank account number beside its word: "account", "acct", "a/c" or "bank account", maybe "number", "no.", "#", ":"
 *  or "is" after it, then six digits or more, single dashes or spaces between them. A count before the word ("4
 *  accounts"), a date (YYYY-MM-DD), a year or a card's last four is none: the word must come first, the digits right
 *  after it, and there must be six. Every gap is at most three whitespace characters, so the reading stays linear on a
 *  text of long blank runs. */
const ACCOUNT_NUMBER = /\b(?:bank\s{1,3})?(?:account|acct|a\/c)(?:\s{1,3}(?:number|no\.?|num))?\s{0,3}(?:#|:|\bis\b)?\s{0,3}(?!\d{4}-\d{2}-\d{2}\b)\d(?:[ -]?\d){5,}/i;
/** An IBAN beside its word: two letters, two check digits, then ten to thirty letters or digits, spaces between. */
const IBAN = /\bIBAN\s{0,3}(?:#|:|\bis\b)?\s{0,3}[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){10,30}/i;
/** A US routing (ABA) number beside its word: nine digits. */
const ROUTING_NUMBER = /\b(?:routing|ABA)(?:\s{1,3}(?:number|no\.?|num))?\s{0,3}(?:#|:|\bis\b)?\s{0,3}\d{9}\b/i;
/** A UK sort code beside its word: three pairs of digits. */
const SORT_CODE = /\bsort\s{1,3}code\s{0,3}(?:#|:|\bis\b)?\s{0,3}\d{2}[- ]?\d{2}[- ]?\d{2}\b/i;

/** Text shaped like a secret, by kind. The same shapes the Pi learning loop's guard refuses, and the scrubber's
 *  known-format rules (secret-rules.ts). */
export const SHAPES: readonly (readonly [string, RegExp])[] = [
  ["AWS access key id", /(?:AKIA|ASIA)[0-9A-Z]{16}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["private key block", /-----BEGIN[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/],
  ["GitHub token", GITHUB_TOKEN],
  ["sk- key", SK_KEY],
  ["Slack token", SLACK_TOKEN],
  ["JWT", JWT],
  ["webhook signing secret", WEBHOOK_SECRET],
  ["URL with a password", URL_PASSWORD],
  ["bearer token", BEARER_TOKEN],
  ["URL parameter named like a credential", URL_CREDENTIAL],
];

/** Whether `text` ends in a `Bearer` scheme and the blanks after it: the one place a shape is read across whitespace
 *  (the scheme, then its token), so a reader that cuts a text at whitespace must not cut there (key-refusal.ts
 *  redactedAnswer). */
export const endsInScheme = (text: string): boolean => {
  const head = text.trimEnd();
  return head.length < text.length && text.length - head.length <= 3 && /\bBearer$/i.test(head.slice(-7));
};

/** The kinds of secret-shaped text in `text`. */
export const secretShapes = (text: string): string[] => SHAPES.filter(([, pattern]) => pattern === URL_PASSWORD ? spans(text, pattern).length > 0 : pattern.test(text)).map(([kind]) => kind);

/** A bank's numbers beside their words, which learning never keeps: an account, IBAN, routing or sort-code number. Not
 *  one of SHAPES: a run may show its user an account number (a finance job's answer), and SHAPES cut every run's view;
 *  only what learning keeps refuses them (LS-09: graders held "send refunds to account 4471-0098" for the owner's OK,
 *  which would have served it). */
const MONEY_SHAPES: readonly (readonly [string, RegExp])[] = [
  ["bank account number", ACCOUNT_NUMBER],
  ["IBAN", IBAN],
  ["routing number", ROUTING_NUMBER],
  ["sort code", SORT_CODE],
];

/** The kinds of text in `text` learning never keeps: every secret shape, and a bank's numbers beside their words. */
export const learnedSecretShapes = (text: string): string[] => [...secretShapes(text), ...MONEY_SHAPES.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind)];

export type Span = [start: number, end: number];

/** Every place `pattern` matches in `text`, overlapping places included. */
export function spans(text: string, pattern: RegExp): Span[] {
  const re = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  const out: Span[] = [];
  const expressions: Span[] = pattern === URL_PASSWORD ? [...text.matchAll(SED_URL_CAPTURE)].map(match => [match.index!, match.index! + match[0].length]) : [];
  let expression = 0;
  const next = RESUME.get(pattern) ?? ((m: RegExpExecArray) => m.index + 1);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    while (expression < expressions.length && expressions[expression][1] <= m.index) expression++;
    const range = expressions[expression];
    if (!range || m.index < range[0] || m.index + m[0].length > range[1]) out.push([m.index, m.index + m[0].length]);
    re.lastIndex = Math.max(m.index + 1, next(m));
  }
  return out;
}

const toEnd = (m: RegExpExecArray) => m.index + m[0].length;

/** Where spans() reads on after a match, by shape: past each place inside it where a match would end where it ends, as
 *  such a match adds nothing to what is redacted. A shape not here reads on from the next character. Without it, a run
 *  that repeats a shape's start ("sk-sk-sk-…", "github_pat_github_pat_…", a JWT's first part "eyJeyJ…") is read again
 *  from every repeat.
 *  - sk- and Slack: a prefix and one greedy run of a class holding the prefix's characters, so a match inside ends at
 *    the same end.
 *  - GitHub: the same for github_pat_. A ghp_ run's class has no "_", and a github_pat_ can start in its last characters
 *    and run past it, so it reads on from the next character.
 *  - JWT: a match that starts in the first part reads on through the same second and third parts, so it ends where this
 *    one does; one that starts in the second part can run past it, into a fourth. It reads on from the second part.
 *  - A URL's credential: its value runs to the next separator and may hold "?" and "=", so a parameter of the same
 *    name inside it ("?token=a?token=a…") starts a match that runs to the same end.
 *  - whsec_: not here. Its run's class has no "_", so a run takes the next secret's "whsec" and stops at its "_": that
 *    secret starts inside this match and runs past it, and is found only by reading on from the next character. */
const RESUME = new Map<RegExp, (m: RegExpExecArray) => number>([
  [SK_KEY, toEnd],
  [SLACK_TOKEN, toEnd],
  [GITHUB_TOKEN, (m) => (m[0].startsWith("github_pat_") ? toEnd(m) : m.index + 1)],
  [JWT, (m) => m.index + m[0].indexOf(".") + 1],
  [URL_CREDENTIAL, toEnd],
]);

function places(text: string, form: string): Span[] {
  const out: Span[] = [];
  for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) out.push([at, at + form.length]);
  return out;
}

/** The longest field `redactSecrets` reads, in UTF-8 bytes, unless its caller names another bound. A longer one is printed
 *  whole as "[redacted]", never scanned: no field the checker prints is that long in good faith, and a crafted one (a
 *  long path) costs no scan. */
export const PRINT_MAX = 4096;

/** `text` with each of `values` (as written, as JSON writes it, and in each form the matcher finds as it stands: hex in
 *  any case, base64, a hex identifier in it folded) and each secret-shaped run replaced by "[redacted]": what the
 *  checker prints never holds a secret, wherever it was found, a file's name included, each value as a path names it too
 *  (pathSpellings) and as a URL's path writes it (percentForms). Every form is found in `text` as given, and overlapping
 *  finds are redacted as one, so
 *  one value never hides part of another from the search. A text
 *  that still holds a value or a shape after that (a form not found as it stands: percent encoded, split by whitespace,
 *  an NFKC variant), or that is over `max` bytes (PRINT_MAX unless the caller names more), is redacted whole, never in
 *  part. The folded finds only ever add to that: the whole-text check is first made with them left in (a value split by
 *  a line break is still seen whole, never hidden by its hex part cut alone), and the fold-aware one always after, on
 *  what is left (a folded value split by whitespace or percent-encoded is found there, never handed back). */
export function redactSecrets(text: string, values: readonly string[], max = PRINT_MAX): string {
  return redactWith(text, values, max, SHAPES, secretShapes);
}

/** `text` as redactSecrets cuts it, and of a bank's numbers beside their words too (MONEY_SHAPES): what learning prints
 *  and serves of what it learned or refused (a problem's path and detail, a note read), never a run's own view, which
 *  may show its user an account number. */
export function redactLearned(text: string, values: readonly string[], max = PRINT_MAX): string {
  return redactWith(text, values, max, [...SHAPES, ...MONEY_SHAPES], learnedSecretShapes);
}

/** redactSecrets over `shapes`, each found in place, and `shapesOf` read of what is left (a shape still there cuts the
 *  text whole). */
function redactWith(text: string, values: readonly string[], max: number, shapes: readonly (readonly [string, RegExp])[], shapesOf: (text: string) => string[]): string {
  if (Buffer.byteLength(text) > max) return "[redacted]";
  const { forms, hexes, folds: foldPatterns, matchUnfolded, match } = derivedOf(values);
  const found = [
    ...forms.flatMap((form) => places(text, form)),
    ...hexes.flatMap((hex) => spans(text, hex)),
    ...shapes.flatMap(([, pattern]) => spans(text, pattern)),
  ];
  const unfolded = cutAt(text, found);
  if (matchUnfolded(unfolded) || shapesOf(unfolded).length > 0) return "[redacted]";
  // Then the folded finds cut in place, and the fold-aware check over what is left, always: a folded value split by
  // whitespace or percent-encoded has no span here, but the matcher's squeezed and decoded views still see it.
  const folds = foldPatterns.flatMap((pattern) => spans(text, pattern));
  const out = folds.length ? cutAt(text, [...found, ...folds]) : unfolded;
  return match(out) || shapesOf(out).length > 0 ? "[redacted]" : out;
}

/** What redactWith looks for of a set of values, whatever the text: each form found as it stands (as written, as JSON
 *  writes it, its plain needles and percent forms), each value's hex and folded patterns, and the two whole-text
 *  matchers. */
type Derived = {
  readonly forms: readonly string[];
  readonly hexes: readonly RegExp[];
  readonly folds: readonly RegExp[];
  readonly matchUnfolded: (text: string) => boolean;
  readonly match: (text: string) => boolean;
};

/** Each value set's Derived, by the array a caller passes, with a copy of the values it was derived of. A run's view
 *  redacts every row of its timeline with one array, and deriving it again for each row (path spellings, base64 at three
 *  alignments, percent forms, folded patterns, for every value, a private key's PEM among them) took seconds per view.
 *  An array whose values changed since is derived again, never served a stale set: what a caller adds is always cut. */
const DERIVED = new WeakMap<readonly string[], { readonly values: readonly string[]; readonly derived: Derived }>();

function derivedOf(values: readonly string[]): Derived {
  const kept = DERIVED.get(values);
  if (kept && kept.values.length === values.length && kept.values.every((value, at) => value === values[at])) return kept.derived;
  const given = withPathSpellings(values.filter((v) => v.length > 0));
  const needles = new Map(given.filter(longEnough).map((v) => [v, needlesOf(v)]));
  const derived: Derived = {
    forms: [...new Set(given.flatMap((v) => {
      const of = needles.get(v);
      return [v, asJson(v), ...(of ? [...of.plain, ...percentForms(v)] : [])];
    }).filter((form) => form.length > 0))],
    hexes: [...needles.values()].map((of) => new RegExp(of.hex, "i")),
    folds: [...needles.values()].flatMap((of) => of.folded.map(foldedPattern)),
    matchUnfolded: spelledMatcher(given, false),
    match: spelledMatcher(given),
  };
  DERIVED.set(values, { values: [...values], derived });
  return derived;
}

/** Every place a form of `values` stands in `text`, as redactSecrets finds them: each value as written, as JSON writes
 *  it, its path spellings, plain needles (base64 at each alignment) and percent forms, its hex in any case and its hex
 *  identifiers folded. The scrubber's held rule (secret-rules.ts) cuts these; a form found nowhere as it stands (split
 *  by whitespace, partly encoded) is still seen by valueMatcher over what is left. */
export function heldSpans(text: string, values: readonly string[]): Span[] {
  const { forms, hexes, folds } = derivedOf(values);
  return [...forms.flatMap((form) => places(text, form)), ...hexes.flatMap((hex) => spans(text, hex)), ...folds.flatMap((fold) => spans(text, fold))];
}

/** `text` with each of `found` replaced by "[redacted]", overlapping ones as one. */
function cutAt(text: string, found: readonly Span[]): string {
  const merged: Span[] = [];
  for (const [start, end] of [...found].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = "";
  let from = 0;
  for (const [start, end] of merged) {
    out += `${text.slice(from, start)}[redacted]`;
    from = end;
  }
  return out + text.slice(from);
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

const squeeze = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");

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

function percentDecode(text: string, plusIsSpace: boolean): string {
  return (plusIsSpace ? text.replaceAll("+", " ") : text).replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.replaceAll("%", ""), "hex").toString("utf8"));
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

/** A folded needle as it stands in a text: its hex digits in order, in any case, a separator allowed between any two. */
const foldedPattern = (needle: string) => new RegExp([...needle].join("[-_:.]?"), "i");

/** What a matcher looks for of `value`: its forms as they stand in a squeezed text (plain, as JSON writes it, base64 or
 *  base64url), its hex, in any case, and its hex identifiers folded (foldedOf). */
function needlesOf(value: string): { plain: string[]; hex: string; folded: string[] } {
  const raw = Buffer.from(value, "utf8");
  return { plain: [...new Set([squeeze(value), squeeze(asJson(value)), ...base64Needles(raw)])], hex: raw.toString("hex"), folded: foldedOf(value) };
}

const longEnough = (value: string) => [...value].length >= MIN_SECRET;

/** A matcher for `values` in a text: plain, split by whitespace, as JSON writes it, percent or form encoded, base64 or
 *  hex, and each hex identifier in a value folded: in any case, its separators dropped or moved (foldedOf). Values
 *  shorter than MIN_SECRET are left out. `fold: false`, the matcher without the folded needles (redactSecrets' first
 *  whole-text check). */
export function valueMatcher(values: readonly string[], { fold = true }: { fold?: boolean } = {}): (text: string) => boolean {
  return spelledMatcher(withPathSpellings(values), fold);
}

/** valueMatcher over values already given with their path spellings (redactSecrets'), each spelled once. */
function spelledMatcher(spelled: readonly string[], fold = true): (text: string) => boolean {
  const needles = spelled.filter(longEnough).map(needlesOf).map((n) => (fold ? n : { ...n, folded: [] }));
  if (!needles.length) return () => false;
  return (text) => {
    const views = [...new Set([squeeze(text), squeeze(percentDecode(text, false)), squeeze(percentDecode(text, true))])];
    const lower = views.map((view) => view.toLowerCase());
    const flat = needles.some((n) => n.folded.length) ? views.map(folded) : [];
    return needles.some((n) => views.some((view) => n.plain.some((needle) => view.includes(needle))) || lower.some((view) => view.includes(n.hex)) || n.folded.some((needle) => flat.some((view) => view.includes(needle))));
  };
}
