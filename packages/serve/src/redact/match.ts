// The one matcher served text is redacted with (learn/secrets.ts redactSecrets and redactLearned run on it): the secret
// and bank shapes as scanners, the held values' forms found as they stand, and the whole-text check over the views a
// value can hide in (whitespace gone, NFKC, percent-decoded, folded). Nothing here reads attacker text with a
// backtracking regex: each shape is a prefix found with indexOf, then runs of a character class read forward, and a
// start inside a run already read is not read again. So a text costs time in proportion to its length, whatever it
// repeats. The few bank shapes that stay regexes are tried only at their words, each reading a bounded head and one
// run of digits.
//
// The whole-text check reads the text as it came, never the text after its cut: a cut can hide part of a held value
// (a credential parameter's value cut in place, the rest of the held value past a line break), and the rest would then
// read as no value at all. A held value found in a view is cut only when every character the view read of it comes
// from text a cut covers; otherwise the text is withheld whole.

export type Span = [start: number, end: number];

/** The characters the shape scanners have visited in this process: the text each prefix search passes over, each run
 *  read, each guard read back. A test sets it to 0, redacts, and reads it: a scanner that read a run once per start
 *  inside it would count the square of the run's length. */
export const scanned = { chars: 0 };

// ---- Character classes, as the regexes they replace wrote them.

/** JavaScript's \s. */
function isSpace(code: number): boolean {
  if (code < 128) return code === 32 || (code >= 9 && code <= 13);
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

type Class = (code: number) => boolean;

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGIT = "0123456789";
const ALNUM = UPPER + LOWER + DIGIT;

const tableOf = (chars: string): Uint8Array => {
  const table = new Uint8Array(128);
  for (const char of chars) table[char.charCodeAt(0)] = 1;
  return table;
};
/** The ASCII characters `chars`. */
const only = (chars: string): Class => {
  const table = tableOf(chars);
  return (code) => code < 128 && table[code] === 1;
};
/** Any character but whitespace and `chars`. */
const allBut = (chars: string): Class => {
  const table = tableOf(chars);
  return (code) => (code < 128 ? table[code] === 0 : true) && !isSpace(code);
};

const WORD = only(`${ALNUM}_`);
const ALNUM_CLASS = only(ALNUM);
const PART = only(`${ALNUM}_-`);
const isDigit = (code: number) => code >= 48 && code <= 57;

// ---- Reading.

/** Where the run of `cls` starting at `from` ends. */
function run(text: string, from: number, cls: Class): number {
  let at = from;
  while (at < text.length && cls(text.charCodeAt(at))) at++;
  scanned.chars += at - from + 1;
  return at;
}

/** Whether `count` characters of `cls` start at `from`. */
function fixed(text: string, from: number, count: number, cls: Class): boolean {
  let at = from;
  while (at < text.length && at - from < count && cls(text.charCodeAt(at))) at++;
  scanned.chars += at - from + 1;
  return at - from === count;
}

/** The next place `prefix` stands in `hay` at or after `from`. */
function seek(hay: string, prefix: string, from: number): number {
  const at = hay.indexOf(prefix, from);
  scanned.chars += (at < 0 ? hay.length : at + prefix.length) - from;
  return at < 0 ? Number.POSITIVE_INFINITY : at;
}

/** `text` with A-Z lowered and nothing else changed, so each offset is the same in both. */
export const asciiLower = (text: string): string => text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());

// ---- Shapes.

/** What a scan of one start found: the span it matched (start -1 for none), and where the search for the next prefix
 *  goes on. */
type Found = { start: number; end: number; next: number };
const none = (next: number): Found => ({ start: -1, end: -1, next });

/** A secret's shape as a scanner: its prefixes (found as written, or in the text lowered with `ci`), and what reads on
 *  from one. Each scan says where the next start is looked for: past the run it read, less the prefix's length but one,
 *  as a prefix can start in a run's last characters and end past it; a start inside the run is not read again, as it
 *  ends where the run does and is no longer than this one. Where a shape's run can hold its own prefix and start a
 *  different run (a Bearer scheme inside a token), its scan says so. */
export type Shape = {
  readonly kind: string;
  readonly prefixes: readonly string[];
  readonly ci?: boolean;
  readonly scan: (text: string, at: number, prefix: string) => Found;
};

/** A prefix, then a run of `cls` of at least `min` characters to the end of that run. */
const prefixRun = (kind: string, prefixes: readonly string[], cls: Class, min: number, guard?: (text: string, at: number) => boolean): Shape => ({
  kind,
  prefixes,
  scan(text, at, prefix) {
    if (guard && !guard(text, at)) return none(at + 1);
    const from = at + prefix.length;
    const end = run(text, from, cls);
    const next = end - (prefix.length - 1);
    return end - from >= min ? { start: at, end, next } : none(next);
  },
});

/** A prefix, then exactly `count` characters of `cls`. */
const prefixFixed = (kind: string, prefixes: readonly string[], cls: Class, count: number): Shape => ({
  kind,
  prefixes,
  scan: (text, at, prefix) => (fixed(text, at + prefix.length, count, cls) ? { start: at, end: at + prefix.length + count, next: at + 1 } : none(at + 1)),
});

const PRIVATE_KEY_HEADER = only(` ${UPPER}${DIGIT}`);
/** A private key block's header: "-----BEGIN", its key type (RSA, EC, OPENSSH, ENCRYPTED) at most 64 characters each
 *  side of "PRIVATE KEY", then "-----". Each start reads at most 140 characters. */
const PRIVATE_KEY: Shape = {
  kind: "private key block",
  prefixes: ["-----BEGIN"],
  scan(text, at) {
    const from = at + 10;
    let end = from;
    while (end < text.length && end - from < 140 && PRIVATE_KEY_HEADER(text.charCodeAt(end))) end++;
    scanned.chars += end - from + 1;
    const length = end - from;
    if (length >= 140 || !text.startsWith("-----", end)) return none(at + 1);
    for (let i = Math.max(0, length - 75); i <= Math.min(64, length - 11); i++) {
      scanned.chars += 11;
      if (text.startsWith("PRIVATE KEY", from + i)) return { start: at, end: end + 5, next: at + 1 };
    }
    return none(at + 1);
  },
};

/** A JWT: three base64url parts, the first two JSON objects ("eyJ"), each 8 characters or more after it. It starts at
 *  the first "eyJ" of a run of a part's characters, wherever that run starts ("token-eyJ…", "x9eyJ…"): a later "eyJ" in
 *  the same run reaches the same "." with fewer characters. Whether an "eyJ" is the first is read back to the "eyJ"
 *  before it or the run's start, so the reads back add up to one pass. A scan that fails reads on past the part it
 *  failed in: a start in an earlier part reads the same parts and fails there too. One that matched reads on from its
 *  second part, as a match starting there can run past this one into a fourth. */
const JWT: Shape = {
  kind: "JWT",
  prefixes: ["eyJ"],
  scan(text, at) {
    let back = at - 1;
    while (back >= 0 && PART(text.charCodeAt(back))) {
      if (back >= 2 && text.startsWith("eyJ", back - 2)) {
        scanned.chars += at - back;
        return none(at + 1);
      }
      back--;
    }
    scanned.chars += at - back;
    const first = run(text, at + 3, PART);
    if (first - (at + 3) < 8 || text[first] !== ".") return none(first - 2);
    if (!text.startsWith("eyJ", first + 1)) return none(first + 1);
    const second = run(text, first + 4, PART);
    if (second - (first + 4) < 8 || text[second] !== ".") return none(second - 2);
    const third = run(text, second + 1, PART);
    if (third - (second + 1) < 8) return none(third - 2);
    return { start: at, end: third, next: first + 1 };
  },
};

const WEBHOOK_BODY = only(`${ALNUM}+/`);
/** A Standard Webhooks signing secret: `whsec_` and base64, this server's or any other's. Its run's class has no "_",
 *  so the run can take the next secret's "whsec" and stop at its "_": that secret starts in this run's last characters. */
const WEBHOOK_SECRET: Shape = {
  kind: "webhook signing secret",
  prefixes: ["whsec_"],
  scan(text, at) {
    const from = at + 6;
    const body = run(text, from, WEBHOOK_BODY);
    if (body - from < 24) return none(body - 5);
    let end = body;
    while (end < body + 2 && text[end] === "=") end++;
    return { start: at, end, next: body - 5 };
  },
};

const URL_USER = allBut("/?#@:");
const URL_PASS = allBut("/?#@");
const SED_HOST = only(`${ALNUM}._~-`);
const SED_TARGET = only(`${ALNUM}.-`);
const isBlank = (char: string | undefined) => char === " " || char === "\t";

/** Whether the URL password at `at` ("://"), ending at `end`, is the capture pattern of a complete single-quoted sed
 *  search expression: `sed -n 's|https://<host or [^:]*>:\([^@]*\)@<host>|\1|p'`, opened at the text's start, after
 *  whitespace, ";" or "(". The "@" inside "[^@]" is regex syntax, not a password's end. A bracketed password or a bare
 *  URL is never one. Read back from the "://" over the expression's head and forward over its tail, each once. */
function inSedCapture(text: string, at: number, end: number): boolean {
  let head = text.startsWith("https", at - 5) ? at - 5 : text.startsWith("http", at - 4) ? at - 4 : -1;
  if (head < 0 || !text.startsWith("'s|", head - 3)) return false;
  head -= 3;
  let blanks = head;
  while (blanks > 0 && isBlank(text[blanks - 1])) blanks--;
  if (blanks === head || !text.startsWith("-n", blanks - 2)) return false;
  const flag = blanks - 2;
  blanks = flag;
  while (blanks > 0 && isBlank(text[blanks - 1])) blanks--;
  scanned.chars += at - blanks;
  if (blanks === flag || !text.startsWith("sed", blanks - 3)) return false;
  const sed = blanks - 3;
  if (sed > 0 && !(isSpace(text.charCodeAt(sed - 1)) || text[sed - 1] === ";" || text[sed - 1] === "(")) return false;
  let tail = at + 3;
  if (text.startsWith("[^:]*", tail)) tail += 5;
  else {
    const host = run(text, tail, SED_HOST);
    if (host === tail) return false;
    tail = host;
  }
  if (!text.startsWith(":\\([^@]*\\)@", tail)) return false;
  const target = run(text, tail + 11, SED_TARGET);
  if (target === tail + 11 || !text.startsWith("|\\1|p'", target)) return false;
  return end <= target + 6;
}

/** A URL with a user and password: "://", a user, ":", a password, then "@". An authority that stops at a "/" may stop
 *  at the next URL's "://", so a failed scan reads on from two characters before where it stopped. */
const URL_PASSWORD: Shape = {
  kind: "URL with a password",
  prefixes: ["://"],
  scan(text, at) {
    const user = run(text, at + 3, URL_USER);
    if (user === at + 3 || text[user] !== ":") return none(user - 2);
    const password = run(text, user + 1, URL_PASS);
    if (text[password] !== "@") return none(password - 2);
    return inSedCapture(text, at, password + 1) ? none(password - 2) : { start: at, end: password + 1, next: password - 2 };
  },
};

const BEARER_TOKEN_CLASS = only(`${ALNUM}._~+/-`);
/** The token after a `Bearer` scheme (RFC 6750's characters), in any case: twenty characters or more with a digit among
 *  them, so a word after "bearer" ("bearer authentication/authorization"), a placeholder (`<token>`, `$TOKEN`,
 *  `YOUR_API_KEY`) and a challenge's parameter (`Bearer realm="x"`) are none. The token alone is the match: the scheme
 *  before it stays, so a reader still sees a header was there. The scheme is at most three blanks before the token. A
 *  token can hold the word "bearer" and then a blank and another token, so the next scheme is looked for from this
 *  token's start: each token is still read once. */
const BEARER_TOKEN: Shape = {
  kind: "bearer token",
  prefixes: ["bearer"],
  ci: true,
  scan(text, at) {
    if (at > 0 && WORD(text.charCodeAt(at - 1))) return none(at + 1);
    let token = at + 6;
    while (token < text.length && token - (at + 6) < 4 && isSpace(text.charCodeAt(token))) token++;
    scanned.chars += token - at - 5;
    const blanks = token - (at + 6);
    if (blanks < 1 || blanks > 3) return none(at + 1);
    let end = token;
    let digit = false;
    for (; end < text.length; end++) {
      const code = text.charCodeAt(end);
      if (!BEARER_TOKEN_CLASS(code)) break;
      digit ||= isDigit(code);
    }
    scanned.chars += end - token + 1;
    if (end - token < 20 || !digit) return none(token);
    const body = end;
    while (end < body + 2 && text[end] === "=") end++;
    return { start: token, end, next: token };
  },
};

/** Each name a credential parameter goes by, as written after "?" or "&" and lowered. */
const CREDENTIAL_NAMES = new Set([
  ...["api", "access", "auth", "id", "refresh", "client"].flatMap((head) => {
    const tail = head === "api" ? "key" : head === "client" ? "secret" : "token";
    return [`${head}${tail}`, `${head}_${tail}`, `${head}-${tail}`];
  }),
  "x-amz-signature", "x-amz-security-token", "x-goog-signature", "token", "secret", "password", "passwd", "signature", "sig",
]);
const NAME_CHAR = only(`${UPPER}${LOWER}_-`);
const URL_VALUE = allBut("&#\"'`<>\\[]");
/** The value of a URL parameter named like a credential, after `?` or `&`: sixteen characters or more, to the next
 *  separator. The name is the whole parameter's (`token`, never `page_token`), and the value alone is the match, so the
 *  name stays. A signed URL's signature is one: whoever holds the URL holds what it grants. No bracket is a value's
 *  character (a URL writes one percent-encoded), so a value already cut to "[redacted]" is never read as one. A value
 *  may hold "?" and "=", so a parameter of the same name inside it ends where it ends: the next start is looked for past
 *  it. */
const URL_CREDENTIAL: Shape = {
  kind: "URL parameter named like a credential",
  prefixes: ["?", "&"],
  scan(text, at) {
    let name = at + 1;
    while (name < text.length && name - at <= 21 && NAME_CHAR(text.charCodeAt(name))) name++;
    scanned.chars += name - at;
    if (text[name] !== "=" || !CREDENTIAL_NAMES.has(text.slice(at + 1, name).toLowerCase())) return none(at + 1);
    const end = run(text, name + 1, URL_VALUE);
    return end - (name + 1) >= 16 ? { start: name + 1, end, next: end } : none(end);
  },
};

/** Text shaped like a secret, by kind. The same shapes the Pi learning loop's guard refuses. */
export const SECRET_SHAPES: readonly Shape[] = [
  prefixFixed("AWS access key id", ["AKIA", "ASIA"], only(UPPER + DIGIT), 16),
  prefixFixed("Google API key", ["AIza"], only(`${ALNUM}_-`), 35),
  PRIVATE_KEY,
  prefixRun("GitHub token", ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], ALNUM_CLASS, 30),
  prefixRun("GitHub token", ["github_pat_"], WORD, 20),
  prefixRun("sk- key", ["sk-"], PART, 20, (text, at) => at === 0 || !ALNUM_CLASS(text.charCodeAt(at - 1))),
  prefixRun("Slack token", [..."abposre"].map((kind) => `xox${kind}-`).concat("xapp-"), only(`${ALNUM}-`), 10),
  JWT,
  WEBHOOK_SECRET,
  URL_PASSWORD,
  BEARER_TOKEN,
  URL_CREDENTIAL,
];

/** A bank's number beside its word, tried as `pattern` at each of its words only. Each try reads its word's bounded
 *  head (`head` characters), and ACCOUNT_NUMBER's digits, single dashes or spaces between them, to their end: what the
 *  regex can read from that start. */
const besideWord = (kind: string, words: readonly string[], pattern: RegExp, head: number, digits = false): Shape => {
  const sticky = new RegExp(pattern.source, "iy");
  return {
    kind,
    prefixes: words,
    ci: true,
    scan(text, at) {
      let reach = Math.min(text.length, at + head);
      if (digits) while (reach < text.length && /[\d -]/.test(text[reach]!)) reach++;
      scanned.chars += reach - at + 1;
      sticky.lastIndex = at;
      const match = sticky.exec(text);
      return match ? { start: at, end: at + match[0].length, next: at + 1 } : none(at + 1);
    },
  };
};

/** A bank account number beside its word: "account", "acct", "a/c" or "bank account", maybe "number", "no.", "#", ":"
 *  or "is" after it, then six digits or more, single dashes or spaces between them. A count before the word ("4
 *  accounts"), a date (YYYY-MM-DD), a year or a card's last four is none: the word must come first, the digits right
 *  after it, and there must be six. Every gap is at most three whitespace characters. */
const ACCOUNT_NUMBER = /\b(?:bank\s{1,3})?(?:account|acct|a\/c)(?:\s{1,3}(?:number|no\.?|num))?\s{0,3}(?:#|:|\bis\b)?\s{0,3}(?!\d{4}-\d{2}-\d{2}\b)\d(?:[ -]?\d){5,}/;
/** An IBAN beside its word: two letters, two check digits, then ten to thirty letters or digits, spaces between. */
const IBAN = /\bIBAN\s{0,3}(?:#|:|\bis\b)?\s{0,3}[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){10,30}/;
/** A US routing (ABA) number beside its word: nine digits. */
const ROUTING_NUMBER = /\b(?:routing|ABA)(?:\s{1,3}(?:number|no\.?|num))?\s{0,3}(?:#|:|\bis\b)?\s{0,3}\d{9}\b/;
/** A UK sort code beside its word: three pairs of digits. */
const SORT_CODE = /\bsort\s{1,3}code\s{0,3}(?:#|:|\bis\b)?\s{0,3}\d{2}[- ]?\d{2}[- ]?\d{2}\b/;

/** A bank's numbers beside their words, which learning never keeps: an account, IBAN, routing or sort-code number. Not
 *  one of SECRET_SHAPES: a run may show its user an account number (a finance job's answer), and those shapes cut every
 *  run's view; only what learning keeps refuses them. */
export const MONEY_SHAPES: readonly Shape[] = [
  besideWord("bank account number", ["bank", "account", "acct", "a/c"], ACCOUNT_NUMBER, 40, true),
  besideWord("IBAN", ["iban"], IBAN, 80),
  besideWord("routing number", ["routing", "aba"], ROUTING_NUMBER, 40),
  besideWord("sort code", ["sort"], SORT_CODE, 40),
];

/** Every span `shape` matches in `text` (only the first with `first`). `lower`: the text lowered (asciiLower), for a
 *  shape found in any case. */
function spansOf(text: string, lower: () => string, shape: Shape, first = false): Span[] {
  const hay = shape.ci ? lower() : text;
  const { prefixes } = shape;
  const next = prefixes.map(() => -1);
  const out: Span[] = [];
  for (let from = 0; ; ) {
    let at = Number.POSITIVE_INFINITY;
    let prefix = "";
    for (let i = 0; i < prefixes.length; i++) {
      if (next[i]! < from) next[i] = seek(hay, prefixes[i]!, from);
      if (next[i]! < at) {
        at = next[i]!;
        prefix = prefixes[i]!;
      }
    }
    if (at === Number.POSITIVE_INFINITY) return out;
    const found = shape.scan(text, at, prefix);
    if (found.start >= 0) {
      out.push([found.start, found.end]);
      if (first) return out;
    }
    from = Math.max(at + 1, found.next);
  }
}

/** A text lowered once, on first use, counted as a read of the text. */
function lowered(text: string): () => string {
  let low: string | undefined;
  return () => {
    if (low === undefined) {
      scanned.chars += text.length;
      low = asciiLower(text);
    }
    return low;
  };
}

/** The kinds of `shapes` in `text`, each once, in their order. */
export function shapeKinds(text: string, shapes: readonly Shape[]): string[] {
  const lower = lowered(text);
  const kinds: string[] = [];
  for (const shape of shapes) if (!kinds.includes(shape.kind) && spansOf(text, lower, shape, true).length > 0) kinds.push(shape.kind);
  return kinds;
}

// ---- Held values.

/** What the matcher looks for of a set of held values (learn/secrets.ts derives it of each value and its spellings):
 *  - `forms`: found as they stand and cut in place (as written, as JSON writes it, squeezed, base64, percent);
 *  - `hexes`: a value's hex, lowered, found in any case and cut in place;
 *  - `folds`: a hex identifier's digits, found in any case with one separator ("-", "_", ":", ".") allowed between any
 *    two, and cut in place;
 *  - `plain`: what the whole-text check looks for in each squeezed view (with `hexes` in it lowered, `folds` in it
 *    folded). */
export type Needles = {
  readonly forms: readonly string[];
  readonly hexes: readonly string[];
  readonly folds: readonly string[];
  readonly plain: readonly string[];
};

/** Adds each place `needle` stands in `hay` to `out`, overlapping places too. */
function places(hay: string, needle: string, out: Span[]): void {
  if (!needle) return;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) out.push([at, at + needle.length]);
}

const isSeparator = (code: number) => code === 45 || code === 95 || code === 58 || code === 46;

/** Each place a folded needle stands in `text`: its digits in order, in any case, at most one separator between any
 *  two. Found in the text lowered with its separators gone, each character's offset in the text kept, and a place kept
 *  only where no two of its digits are more than one separator apart. */
function foldSpans(text: string, folds: readonly string[], out: Span[]): void {
  const lower = asciiLower(text);
  const at = new Int32Array(text.length);
  const parts: string[] = [];
  let count = 0;
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && !isSeparator(text.charCodeAt(i))) {
      at[count++] = i;
      continue;
    }
    if (i > from) parts.push(lower.slice(from, i));
    from = i + 1;
  }
  const flat = parts.join("");
  // The start of the stretch each character is in: a stretch ends where two kept characters are more than one apart.
  const stretch = new Int32Array(count);
  for (let k = 1; k < count; k++) stretch[k] = at[k]! - at[k - 1]! > 2 ? k : stretch[k - 1]!;
  for (const needle of folds) {
    if (!needle) continue;
    for (let i = flat.indexOf(needle); i >= 0; i = flat.indexOf(needle, i + 1)) {
      const last = i + needle.length - 1;
      if (stretch[last]! <= i) out.push([at[i]!, at[last]! + 1]);
    }
  }
}

/** `found` in order, each run of overlapping or touching spans as one. */
export function merged(found: readonly (readonly [number, number])[]): Span[] {
  const out: Span[] = [];
  for (const [start, end] of [...found].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** `text` with each of `spans` (merged, in order) replaced by "[redacted]". */
export function cutAt(text: string, spans: readonly Span[]): string {
  let out = "";
  let from = 0;
  for (const [start, end] of spans) {
    out += `${text.slice(from, start)}[redacted]`;
    from = end;
  }
  return out + text.slice(from);
}

// ---- Views: the text as a value can hide in it, each character's source in the text kept as whether a cut covers it.

/** A view of a text, and the stretches of it (in its own offsets, in order, apart) whose every character comes from
 *  text a cut covers. */
type View = { readonly text: string; readonly covered: readonly Span[] };

const HEX = only("0123456789abcdefABCDEF");
const BLANKS = /[\t-\r ]+/y;

/** What a view decodes where its trigger character stands: given the text and that place, the end of what it decoded,
 *  each character it decodes to handed to `unit` with the text it came from; or -1 where nothing there decodes. */
type Decoder = { readonly trigger: string; readonly decode: (text: string, at: number, unit: Sink) => number };
type Sink = (char: string, from: number, to: number) => void;

/** A run of percent-encoded bytes, decoded as UTF-8 (decoded). */
const PERCENT: Decoder = {
  trigger: "%",
  decode(text, at, unit) {
    let end = at;
    while (text[end] === "%" && HEX(text.charCodeAt(end + 1)) && HEX(text.charCodeAt(end + 2))) end += 3;
    if (end === at) return -1;
    decoded(text, at, end, unit);
    return end;
  },
};
/** "+" as a space, as a form's encoding writes one. */
const PLUS: Decoder = { trigger: "+", decode: (_text, at, unit) => (unit(" ", at, at + 1), at + 1) };

/** A view the whole-text check reads: the text decoded by `decoders`, then squeezed (viewOf), read only where `when`
 *  says the text holds what a decoder decodes. `special`: where viewOf stops to do more than copy. */
type ViewSpec = { readonly when: (text: string) => boolean; readonly decoders: readonly Decoder[]; readonly special: RegExp };
const viewSpec = (when: (text: string) => boolean, decoders: readonly Decoder[]): ViewSpec => ({
  when,
  decoders,
  special: new RegExp(`[\\s${decoders.map((decoder) => `\\${decoder.trigger}`).join("")}\\u0080-\\uffff]`, "g"),
});
/** The views of a text read for each held value, in order: squeezed; percent-decoded; percent-decoded with "+" as a
 *  space. Each is lowered for hexes and flattened for folded identifiers in holds. */
const VIEWS: readonly ViewSpec[] = [
  viewSpec(() => true, []),
  viewSpec((text) => /%[0-9a-fA-F]{2}/.test(text), [PERCENT]),
  viewSpec((text) => text.includes("+"), [PERCENT, PLUS]),
];

/** `text` as the whole-text check reads it: decoded by `spec`'s decoders, NFKC, and its whitespace gone, as
 *  learn/secrets.ts has always squeezed it. NFKC is applied to each stretch of non-ASCII characters with the ASCII
 *  character before it, which gives what it gives over the whole text (an ASCII character is a starter nothing composes
 *  onto), and each character it makes comes from that whole stretch. With `cuts` (merged spans of `text`), the view's
 *  covered stretches: where every character comes from inside one cut. */
function viewOf(text: string, spec: ViewSpec, cuts?: readonly Span[]): View {
  const out: string[] = [];
  const covered: Span[] = [];
  let length = 0;
  let cut = 0;
  const cover = (from: number, to: number) => {
    const last = covered.at(-1);
    if (last && last[1] === from) last[1] = to;
    else covered.push([from, to]);
  };
  /** Text characters [from, to) as they are, all ASCII and none whitespace. */
  const emitSlice = (from: number, to: number) => {
    if (to <= from) return;
    out.push(text.slice(from, to));
    if (cuts) {
      while (cut < cuts.length && cuts[cut]![1] <= from) cut++;
      for (let k = cut; k < cuts.length && cuts[k]![0] < to; k++) {
        const start = Math.max(from, cuts[k]![0]);
        const end = Math.min(to, cuts[k]![1]);
        if (start < end) cover(length + start - from, length + end - from);
      }
    }
    length += to - from;
  };
  /** View characters `chars`, each made of text [from, to). */
  const emit = (chars: string, from: number, to: number) => {
    if (!chars) return;
    out.push(chars);
    if (cuts) {
      while (cut < cuts.length && cuts[cut]![1] <= from) cut++;
      if (cut < cuts.length && cuts[cut]![0] <= from && to <= cuts[cut]![1]) cover(length, length + chars.length);
    }
    length += chars.length;
  };
  // The last ASCII character read, held back in case a non-ASCII one composes onto it; and the stretch being gathered
  // for NFKC.
  type Unit = { char: string; from: number; to: number };
  let held: Unit | undefined;
  let group: { chars: string; from: number; to: number; lead?: Unit } | undefined;
  const flushHeld = () => {
    if (held && !isSpace(held.char.charCodeAt(0))) emit(held.char, held.from, held.to);
    held = undefined;
  };
  const nfkc = (chars: string) => chars.normalize("NFKC").replace(/\s+/gu, "");
  const flushGroup = () => {
    if (!group) return;
    const made = nfkc(group.chars);
    const { lead } = group;
    const rest = lead ? nfkc(group.chars.slice(lead.char.length)) : "";
    // Where nothing composed onto the ASCII character, it comes from itself alone: a value cut in place right before
    // a non-ASCII character is still covered to its last character.
    if (lead && made === nfkc(lead.char) + rest) {
      held = lead;
      flushHeld();
      emit(rest, lead.to, group.to);
    } else emit(made, group.from, group.to);
    group = undefined;
  };
  const unit = (char: string, from: number, to: number) => {
    if (char.charCodeAt(0) >= 128) {
      if (group) {
        group.chars += char;
        group.to = to;
      } else {
        group = held ? { chars: held.char + char, from: held.from, to, lead: held } : { chars: char, from, to };
        held = undefined;
      }
      return;
    }
    flushGroup();
    flushHeld();
    held = { char, from, to };
  };
  const special = new RegExp(spec.special.source, "g");
  let at = 0;
  while (at < text.length) {
    special.lastIndex = at;
    const hit = special.exec(text);
    const stop = hit ? hit.index : text.length;
    if (stop > at) {
      flushGroup();
      flushHeld();
      emitSlice(at, stop - 1);
      held = { char: text[stop - 1]!, from: stop - 1, to: stop };
    }
    if (!hit) break;
    const char = text[stop]!;
    let end = -1;
    for (const decoder of spec.decoders) if (decoder.trigger === char) end = decoder.decode(text, stop, unit);
    if (end >= 0) at = end;
    else if (char.charCodeAt(0) < 128 && isSpace(char.charCodeAt(0))) {
      // A run of ASCII whitespace is gone from the view: only its last character is held, as the one a non-ASCII
      // character after it could compose onto.
      BLANKS.lastIndex = stop;
      BLANKS.test(text);
      flushGroup();
      flushHeld();
      held = { char: text[BLANKS.lastIndex - 1]!, from: BLANKS.lastIndex - 1, to: BLANKS.lastIndex };
      at = BLANKS.lastIndex;
    } else {
      unit(char, stop, stop + 1);
      at = stop + 1;
    }
  }
  flushGroup();
  flushHeld();
  return { text: out.join(""), covered };
}

/** The characters a run of percent-encoded bytes text[from, to) decodes to (as UTF-8, invalid bytes as U+FFFD, as
 *  Buffer decodes the run whole), each with the bytes it came from; a run whose bytes decode otherwise one sequence at
 *  a time has each character come from the whole run. */
function decoded(text: string, from: number, to: number, unit: Sink): void {
  // An ASCII byte is its own character: a run of them (the common "%20", "%2F%3D") is read without a buffer.
  let ascii = true;
  for (let at = from + 1; at < to && ascii; at += 3) ascii = text.charCodeAt(at) < 56;
  if (ascii) {
    for (let at = from; at < to; at += 3) unit(String.fromCharCode(Number.parseInt(text.slice(at + 1, at + 3), 16)), at, at + 3);
    return;
  }
  const bytes = Buffer.from(text.slice(from, to).replaceAll("%", ""), "hex");
  const whole = bytes.toString("utf8");
  const pieces: [string, number, number][] = [];
  for (let k = 0; k < bytes.length; ) {
    const lead = bytes[k]!;
    const size = Math.min(bytes.length - k, lead < 0x80 ? 1 : lead >> 5 === 6 ? 2 : lead >> 4 === 14 ? 3 : lead >> 3 === 30 ? 4 : 1);
    pieces.push([bytes.subarray(k, k + size).toString("utf8"), from + 3 * k, from + 3 * (k + size)]);
    k += size;
  }
  if (pieces.map(([chars]) => chars).join("") === whole) {
    for (const [chars, start, end] of pieces) for (const char of chars) for (let i = 0; i < char.length; i++) unit(char[i]!, start, end);
  } else for (let i = 0; i < whole.length; i++) unit(whole[i]!, from, to);
}

/** A view with its separators ("-", "_", ":", ".") gone, its covered stretches moved to match. */
function flatOf(view: View): View {
  const parts: string[] = [];
  const kept = new Int32Array(view.text.length + 1);
  let from = 0;
  let count = 0;
  for (let i = 0; i < view.text.length; i++) {
    kept[i] = count;
    if (isSeparator(view.text.charCodeAt(i))) {
      if (i > from) parts.push(view.text.slice(from, i));
      from = i + 1;
    } else count++;
  }
  kept[view.text.length] = count;
  if (view.text.length > from) parts.push(view.text.slice(from));
  const covered: Span[] = [];
  for (const [start, end] of view.covered) {
    const [a, b] = [kept[start]!, kept[end]!];
    if (a >= b) continue;
    const last = covered.at(-1);
    if (last && last[1] === a) last[1] = b;
    else covered.push([a, b]);
  }
  return { text: parts.join(""), covered };
}

/** Whether [start, end) of a view lies in one of its covered stretches. */
function inside(covered: readonly Span[], start: number, end: number): boolean {
  let lo = 0;
  let hi = covered.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (covered[mid]![0] <= start) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 && covered[hi]![1] >= end;
}

/** Whether `view` holds one of `needles` outside its covered stretches (with no `covered`, anywhere). */
function holdsIn(view: string, covered: readonly Span[] | undefined, needles: readonly string[]): boolean {
  for (const needle of needles) {
    if (!needle) continue;
    if (!covered) {
      if (view.includes(needle)) return true;
      continue;
    }
    for (let at = view.indexOf(needle); at >= 0; at = view.indexOf(needle, at + 1)) if (!inside(covered, at, at + needle.length)) return true;
  }
  return false;
}

/** Whether `text` holds a held value in a form the cut does not find as it stands: split by whitespace, percent or
 *  form encoded, an NFKC variant, its hex in any case, a hex identifier folded (`fold`). With `cuts`, a value whose
 *  every character the view read comes from inside the cuts is not held: it is cut in place. */
export function holds(text: string, needles: Needles, { fold = true, cuts }: { fold?: boolean; cuts?: readonly Span[] } = {}): boolean {
  const folds = fold ? needles.folds : [];
  if (!needles.plain.length && !needles.hexes.length && !folds.length) return false;
  for (const spec of VIEWS) {
    if (!spec.when(text)) continue;
    const view = viewOf(text, spec, cuts);
    const covered = cuts ? view.covered : undefined;
    if (holdsIn(view.text, covered, needles.plain)) return true;
    if (!needles.hexes.length && !folds.length) continue;
    const lower = { text: asciiLower(view.text), covered: view.covered };
    if (holdsIn(lower.text, covered, needles.hexes)) return true;
    if (!folds.length) continue;
    const flat = flatOf(lower);
    if (holdsIn(flat.text, cuts ? flat.covered : undefined, folds)) return true;
  }
  return false;
}

/** planCut's first step: every form, hex, folded identifier and shape of `text` as it came, and `held`, merged. */
export function cutSpans(text: string, needles: Needles, shapes: readonly Shape[], held: readonly (readonly [number, number])[] = []): Span[] {
  const lower = lowered(text);
  const found: Span[] = held.map(([start, end]): Span => [start, end]);
  for (const form of needles.forms) places(text, form, found);
  for (const hex of needles.hexes) places(lower(), hex, found);
  // One by one: a text of very many finds would overflow the stack as one call's arguments.
  for (const shape of shapes) for (const span of spansOf(text, lower, shape)) found.push(span);
  if (needles.folds.length) foldSpans(text, needles.folds, found);
  return merged(found);
}

/** Where `text` is cut of `needles` and of each of `shapes`, and the text so cut; or "whole" when it must be withheld
 *  whole. `held`: spans cut in place beside the finds. The order is fixed:
 *  1. every form, hex, folded identifier and shape is found in the text as it came, and the spans merged;
 *  2. the views of the text as it came are read for each held value: one any of whose characters comes from outside
 *     the spans withholds the text (a cut can hide part of a value, so the check never reads the cut text for it);
 *  3. the spans are cut;
 *  4. what is left is read again, for a value or a shape the cut made (a value whose rest the cut joined, a shape whose
 *     guard the cut removed), and withholds the text if it holds one. */
export function planCut(text: string, needles: Needles, shapes: readonly Shape[], held: readonly (readonly [number, number])[] = []): { spans: Span[]; out: string } | "whole" {
  const spans = cutSpans(text, needles, shapes, held);
  if (holds(text, needles, { cuts: spans })) return "whole";
  const out = spans.length ? cutAt(text, spans) : text;
  if (spans.length && (holds(out, needles) || shapeKinds(out, shapes).length > 0)) return "whole";
  return { spans, out };
}
