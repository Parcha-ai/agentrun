// The one matcher served text is redacted with (learn/secrets.ts redactSecrets and redactLearned run on it): the secret
// and bank shapes as scanners, the held values' forms found as they stand, and the whole-text check over the views a
// value can hide in (whitespace gone, NFKC, percent-decoded, folded, a JSON text's strings joined). Nothing here reads attacker text with a
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

/** The characters the redaction pipeline has visited in this process: the text each prefix search passes over, each
 *  run read, each guard read back (the shape scanners); each form, hex, folded and plain needle's search, and the text
 *  it passes over (find); each view built (its special characters found, its blanks, its decoders' reads, its non-ASCII
 *  stretches squeezed, each cut its cover passes), lowered and flattened; each covered stretch a find in a view is
 *  checked against (inside); the finds merged and the text cut; and
 *  key-refusal.ts's reads of a text in pieces. A test sets it to 0, redacts, and reads it: a stage that read again from
 *  the start at each find would count the text once per find. */
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

/** Where `needle` next stands in `hay` at or after `from`, or -1: a needle's search, counted as seek counts a prefix's. */
function find(hay: string, needle: string, from: number): number {
  const at = hay.indexOf(needle, from);
  scanned.chars += Math.max(0, (at < 0 ? hay.length : at + needle.length) - from);
  return at;
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

const PRIVATE_KEY_TYPE = only(` ${UPPER}${DIGIT}`);
/** Where a private key block's armor line at `at` ends, past its closing "-----", or -1. Its opening ("-----BEGIN" or
 *  "-----END", `head` characters) is already read; then its key type (RSA, EC, OPENSSH, ENCRYPTED, an armored key's
 *  "PGP ... BLOCK"), at most 64 characters each side of "PRIVATE KEY", then "-----". It reads at most 140 characters,
 *  and 11 at each place "PRIVATE KEY" may stand. */
function armorEnd(text: string, at: number, head: number): number {
  const from = at + head;
  let end = from;
  while (end < text.length && end - from < 140 && PRIVATE_KEY_TYPE(text.charCodeAt(end))) end++;
  scanned.chars += end - from + 1;
  const length = end - from;
  if (length >= 140 || !text.startsWith("-----", end)) return -1;
  for (let i = Math.max(0, length - 75); i <= Math.min(64, length - 11); i++) {
    scanned.chars += 11;
    if (text.startsWith("PRIVATE KEY", from + i)) return end + 5;
  }
  return -1;
}

/** The most characters between a key's header and its END line, and the most base64 characters on a body line. */
const KEY_BODY_MAX = 16384;
/** The most lines of a key's body read when no END line is in reach. */
const KEY_LINES = 1024;
/** The most characters of a legacy PEM's or armored key's header line after its colon. */
const KEY_HEADER_MAX = 256;
const KEY_BASE64 = only(`${ALNUM}+=`);
/** A header line's text: any character but a line break, a backslash, a quote or a "<". */
const KEY_HEADER_TEXT: Class = (code) =>
  code !== 10 && code !== 13 && code !== 92 && code !== 34 && code !== 39 && code !== 60;
const KEY_HEADER_WORDS = ["Proc-Type:", "DEK-Info:", "Version:", "Comment:"];

/** How many backslashes stand at `at`, at most 9 read: an escape takes 1 to 8 (a string four deep); 9 is too many. */
function backslashes(text: string, at: number): number {
  let end = at;
  while (end < text.length && end - at < 9 && text.charCodeAt(end) === 92) end++;
  scanned.chars += end - at + 1;
  return end - at;
}

/** Where an escape at `at` of one of `chars`, after 1 to 8 backslashes, ends, or -1. */
function escapeEnd(text: string, at: number, chars: string): number {
  const count = backslashes(text, at);
  const ok = count >= 1 && count <= 8 && at + count < text.length && chars.includes(text[at + count]!);
  return ok ? at + count + 1 : -1;
}

/** Where each spelling of a line break at `at` ends, in the order the key's reading tries them: CRLF, then CR alone;
 *  LF; an escaped CR followed by an escaped LF, then the CR alone; an escaped LF. */
function keyBreaks(text: string, at: number): number[] {
  if (at >= text.length) return [];
  scanned.chars += 2;
  const code = text.charCodeAt(at);
  if (code === 13) return text.charCodeAt(at + 1) === 10 ? [at + 2, at + 1] : [at + 1];
  if (code === 10) return [at + 1];
  if (code !== 92) return [];
  const count = backslashes(text, at);
  if (count > 8) return [];
  const after = text[at + count];
  if (after === "n") return [at + count + 1];
  if (after !== "r") return [];
  const lf = escapeEnd(text, at + count + 1, "n");
  return lf >= 0 ? [lf, at + count + 1] : [at + count + 1];
}

/** Where the blanks at `at` end: spaces, tabs and escaped tabs. */
function keyBlanks(text: string, at: number): number {
  let end = at;
  for (;;) {
    const code = text.charCodeAt(end);
    scanned.chars += 1;
    if (code === 32 || code === 9) end++;
    else if (code !== 92) return end;
    else {
      const tab = escapeEnd(text, end, "t");
      if (tab < 0) return end;
      end = tab;
    }
  }
}

/** Where the base64 at `at` ends: at most KEY_BODY_MAX of its characters, each a letter, a digit, "+", "=" or a "/"
 *  (maybe escaped, "\/"). */
function keyBase64(text: string, at: number): number {
  let end = at;
  for (let count = 0; count < KEY_BODY_MAX; count++) {
    const code = text.charCodeAt(end);
    scanned.chars += 1;
    if (KEY_BASE64(code) || code === 47) end++;
    else if (code !== 92) return end;
    else {
      const slash = escapeEnd(text, end, "/");
      if (slash < 0) return end;
      end = slash;
    }
  }
  return end;
}

/** Where a legacy PEM's or armored key's header line at `at` ends ("Proc-Type:", "DEK-Info:", "Version:" or "Comment:",
 *  then at most KEY_HEADER_MAX characters of its text), or -1. */
function keyHeaderLine(text: string, at: number): number {
  for (const word of KEY_HEADER_WORDS) {
    scanned.chars += word.length;
    if (!text.startsWith(word, at)) continue;
    const from = at + word.length;
    let end = from;
    while (end < text.length && end - from < KEY_HEADER_MAX && KEY_HEADER_TEXT(text.charCodeAt(end))) end++;
    scanned.chars += end - from + 1;
    return end;
  }
  return -1;
}

/** Whether a body line may end at `at`: a line break or a closing quote (either maybe escaped), a tag's "<", the text's
 *  end. */
function keyLineEnds(text: string, at: number): boolean {
  if (at >= text.length) return true;
  scanned.chars += 1;
  const code = text.charCodeAt(at);
  if (code === 10 || code === 13 || code === 34 || code === 39 || code === 60) return true;
  return code === 92 && escapeEnd(text, at, `rn"'`) >= 0;
}

/** Where a body line at `at` ends, or -1: blanks, then base64, or a header line, or nothing, then blanks, at a place a
 *  line may end. Each is tried in that order and the first that ends at such a place is the line. */
function keyLine(text: string, at: number): number {
  const start = keyBlanks(text, at);
  const base64 = keyBase64(text, start);
  if (base64 > start) {
    const end = keyBlanks(text, base64);
    if (keyLineEnds(text, end)) return end;
  }
  const header = keyHeaderLine(text, start);
  if (header >= 0) {
    const end = keyBlanks(text, header);
    if (keyLineEnds(text, end)) return end;
  }
  return keyLineEnds(text, start) ? start : -1;
}

/** Where a line break at `at` and the body line after it end, the break's spellings tried in order, or -1. */
function keyNextLine(text: string, at: number): number {
  for (const start of keyBreaks(text, at)) {
    const end = keyLine(text, start);
    if (end >= 0) return end;
  }
  return -1;
}

/** Where the END line of a block whose header ends at `header` ends, or -1: the first "-----" after the header, at most
 *  KEY_BODY_MAX characters on, must start one. The search stops at that "-----", so a reading from one header never
 *  passes the next header's dashes. */
function keyEndLine(text: string, header: number): number {
  const dashes = find(text, "-----", header);
  if (dashes < 0 || dashes - header > KEY_BODY_MAX) return -1;
  scanned.chars += 3;
  return text.startsWith("-----END", dashes) ? armorEnd(text, dashes, 8) : -1;
}

/** Where the body lines after a header that ends at `header` end, or -1 when not even an empty line stands there: a
 *  first line (after a line break, or glued to the header), then at most KEY_LINES - 1 more, each after a line break,
 *  as long as one follows. */
function keyBodyLines(text: string, header: number): number {
  let end = keyNextLine(text, header);
  if (end < 0) end = keyLine(text, header);
  for (let lines = 1; end >= 0 && lines < KEY_LINES; lines++) {
    const next = keyNextLine(text, end);
    if (next < 0) break;
    end = next;
  }
  return end;
}

/** A private key block, whole: its BEGIN line through its body to its END line, the key itself, not its header alone (a
 *  cut read serves a run's whole file). Ported from #3617's rule, one regex there, read here by hand with every
 *  character counted.
 *  - With its END line within KEY_BODY_MAX characters, all between is cut, whatever wraps the body's lines (a code
 *    string literal on each, a "#" or ">" before each, an XML or HTML line break, an escape, an armored key's headers):
 *    the body is any character but a "-" that starts "-----", so the END line can only start at the first "-----"
 *    after the header, and the reading from one header stops there.
 *  - With no END line in reach (a key cut short, one past the bound, one the edge of a window key-refusal.ts reads
 *    crosses), it is cut through its body's lines: the first maybe glued to its header, at most KEY_LINES in all. A
 *    line break is LF, CRLF or CR, or one escaped in a quoted string ("\n", "\r\n", "\\n" in a string within a string:
 *    at most 8 backslashes, four strings deep). A line is blanks (a space, a tab, or an escaped tab), then base64 of at
 *    most KEY_BODY_MAX characters (its slashes maybe escaped, "\/"), or a legacy PEM's or armored key's header
 *    (Proc-Type, DEK-Info, Version, Comment) of at most KEY_HEADER_MAX after its colon, or nothing (a blank line), then
 *    blanks; it ends at a line break or a closing quote (either maybe escaped), an XML or HTML tag's "<", or the text's
 *    end. Text after the body that is no such line (prose, a field) stays.
 *  - A header with not even an empty line after it (prose on its line, another header glued to it) is cut alone, as
 *    the header shape before this one cut it.
 *  A block read whole or through its lines reads on from its end: a "-----BEGIN" inside it can only stand in a header
 *  line's text, already cut. Each part is bounded, a line break's spellings try the line after it at most three times,
 *  and the search for the END line stops at the next "-----": the reading stays linear. */
const PRIVATE_KEY: Shape = {
  kind: "private key block",
  prefixes: ["-----BEGIN"],
  scan(text, at) {
    const header = armorEnd(text, at, 10);
    if (header < 0) return none(at + 1);
    const whole = keyEndLine(text, header);
    if (whole >= 0) return { start: at, end: whole, next: whole };
    const lines = keyBodyLines(text, header);
    return lines >= 0 ? { start: at, end: lines, next: lines } : { start: at, end: header, next: at + 1 };
  },
};

/** Where the private key block whose "-----BEGIN" stands at `at` ends, past its END line, or -1: no key's header there,
 *  or no END line in reach, as PRIVATE_KEY reads it whole. key-refusal.ts reads it so that no piece of an answer ends
 *  inside a block. Whether any "-----" stands within KEY_BODY_MAX of the header is read back from there first (the
 *  header's own closing dashes stop that read), so a header with none after it reads no further. */
export function privateKeyEnd(text: string, at: number): number {
  if (!text.startsWith("-----BEGIN", at)) return -1;
  const header = armorEnd(text, at, 10);
  if (header < 0) return -1;
  const reach = Math.min(text.length, header + KEY_BODY_MAX);
  const last = text.lastIndexOf("-----", reach);
  scanned.chars += reach - Math.max(last, header - 5);
  return last < header ? -1 : keyEndLine(text, header);
}

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

/** Each name a credential parameter goes by, as written after "?" or "&" and lowered; and each key, lowered, of a held
 *  JSON value whose string is held as itself (learn/secrets.ts heldFields). */
export const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
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

const isUpper = (code: number) => code >= 65 && code <= 90;
/** An API key made in this server's console (api-keys.ts): `ar_key_` and its 32 random bytes in base64url, 43
 *  characters or more to the end of that run, so a key glued to more of its characters is cut whole. The server keeps
 *  no copy of such a key (only a keyed hash), so its shape is the one way it is found in a text, and it is found
 *  whatever stands before it: after a word's character too (the `n` of a line break as JSON text writes it, a name
 *  glued to it). What tells a key from a long name that only holds the prefix's letters (`similar_key_for_the_...`) is
 *  in the run itself: a capital or a digit, which 32 random bytes all but always hold and a snake_case name does not.
 *  A start inside a run already read ends where that run ends and holds no more of it, so it is not read again. */
const AGENTRUN_API_KEY: Shape = {
  kind: "AgentRun API key",
  prefixes: ["ar_key_"],
  scan(text, at, prefix) {
    const from = at + prefix.length;
    let end = from;
    let mixed = false;
    for (; end < text.length; end++) {
      const code = text.charCodeAt(end);
      if (!PART(code)) break;
      mixed ||= isDigit(code) || isUpper(code);
    }
    scanned.chars += end - from + 1;
    const next = end - (prefix.length - 1);
    return end - from >= 43 && mixed ? { start: at, end, next } : none(next);
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
  AGENTRUN_API_KEY,
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
/** A US routing (ABA) number beside its word: nine digits. The word ends at a word end, so an id or hash whose hex
 *  holds "aba" glued to nine digits (a UUID's last group, a sha cut to twelve) is none. The other words hold a letter
 *  no hex does, so no id spells them. */
const ROUTING_NUMBER = /\b(?:routing|ABA)\b(?:\s{1,3}(?:number|no\.?|num))?\s{0,3}(?:#|:|\bis\b)?\s{0,3}\d{9}\b/;
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

/** Every span `shape` matches in `text`, each on its own (not merged), in order: the scrubber's known-format rules
 *  (secret-rules.ts) read each match, a URL's password inside its `://user:password@`, a PEM header stretched to its
 *  block's end. */
export function shapeSpans(text: string, shape: Shape): Span[] {
  return spansOf(text, lowered(text), shape);
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
 *    folded);
 *  - `joined`: a held value that holds a "," or a ":", squeezed, with them gone: what the whole-text check also looks
 *    for in the join view alone, which drops JSON's punctuation between strings, so a value JSON split there
 *    ({"alice":"<rest>"}, two strings of an array) reads as itself. */
export type Needles = {
  readonly forms: readonly string[];
  readonly hexes: readonly string[];
  readonly folds: readonly string[];
  readonly plain: readonly string[];
  readonly joined?: readonly string[];
};

/** Adds each place `needle` stands in `hay` to `out`, overlapping places too. */
function places(hay: string, needle: string, out: Span[]): void {
  if (!needle) return;
  for (let at = find(hay, needle, 0); at >= 0; at = find(hay, needle, at + 1)) out.push([at, at + needle.length]);
}

const isSeparator = (code: number) => code === 45 || code === 95 || code === 58 || code === 46;

/** Each place a folded needle stands in `text`: its digits in order, in any case, at most one separator between any
 *  two. Found in the text lowered with its separators gone, each character's offset in the text kept, and a place kept
 *  only where no two of its digits are more than one separator apart. */
function foldSpans(text: string, folds: readonly string[], out: Span[]): void {
  // The text lowered, then read once for its separators.
  scanned.chars += 2 * text.length;
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
    for (let i = find(flat, needle, 0); i >= 0; i = find(flat, needle, i + 1)) {
      const last = i + needle.length - 1;
      if (stretch[last]! <= i) out.push([at[i]!, at[last]! + 1]);
    }
  }
}

/** `found` in order, each run of overlapping or touching spans as one. */
export function merged(found: readonly (readonly [number, number])[]): Span[] {
  // Each find read once: they come as one sorted run per form, hex, fold and shape, which the sort merges.
  scanned.chars += found.length;
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
  scanned.chars += text.length;
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
/** `marked`, where a terminal control is in the text: its units (the characters viewOf's decoders and its copy handed
 *  on, in order) as they came. */
type View = { readonly text: string; readonly covered: readonly Span[]; readonly marked?: string };
/** Which of a text's units a terminal shows (`shown`), and how many it hides before each unit (`hiddenBefore`). */
type Screen = { readonly shown: Uint8Array; readonly hiddenBefore: Int32Array };

const HEX = only("0123456789abcdefABCDEF");
const BLANKS = /[\t-\r ]+/y;
/** Whether a UTF-16 unit is a control character that is no whitespace: U+0000-0008, U+000E-001F, U+007F-009F (a NUL,
 *  an escape, a delete, a C1 control). It renders as nothing, so the views drop it as they drop whitespace. Tab, line
 *  feed, vertical tab, form feed and carriage return (U+0009-000D) are whitespace (isSpace) and read as such. */
const isControl = (code: number): boolean => code <= 0x08 || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
/** The control characters a terminal acts on as it renders: ESC, BEL, a backspace, and the 8-bit CSI, ST and OSC.
 *  viewOf drops each as any control and marks the view, and each marked view is read twice (readingsOf): with them
 *  dropped, and as a terminal shows it. */
const isTerminal = (code: number): boolean => code === 0x1b || code === 0x07 || code === 0x08 || code === 0x9b || code === 0x9c || code === 0x9d;
/** What ends each pass of a join (joinOf). Every view keeps it, and no needle holds it, so no held value reads across
 *  it. It cannot be a NUL, as the views drop control characters wherever they come from (the text, or an escape or an
 *  encoding that decodes to one), and a separator they dropped would join the passes. It is U+FFFF, a noncharacter:
 *  squeeze, which every plain and joined needle is made with, drops it, and a hex, folded or base64 needle is ASCII.
 *  Only the one joinOf puts there separates. One the text brought shows as a box at most, and a reader reads a held
 *  value through it, so the views drop it as they drop a control character, as it stands or as a decoder made it, and
 *  joinOf reads one in a part's text as a NUL (one character for one, so every offset stays, and dropped too). A
 *  caller that marks places in a text with its own (secret-cut.ts) asks holds for `separated`. */
export const SEPARATOR = "\uffff";
/** A character that renders as nothing (a zero-width space, a soft hyphen, a byte order mark, a variation selector, a
 *  control character that is no whitespace: isControl), and SEPARATOR; and one that renders as a box or a blank, which
 *  a reader reads a value through: U+FFFE, the interlinear annotation characters (U+FFF9-FFFB), the noncharacters
 *  U+FDD0-FDEF, a private use character (U+E000-F8FF), the braille blank (U+2800, no whitespace) and a lone surrogate
 *  (with the u flag a surrogate pair is one character, and stays). */
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000e-\u001f\u007f-\u009f\u2800\ud800-\udfff\ue000-\uf8ff\ufdd0-\ufdef\ufff9-\ufffb\ufffe\uffff]+/gu;
const GONE = /[\s\p{Default_Ignorable_Code_Point}]+/gu;

/** Combining marks: an accent, a cedilla, an enclosing circle. */
const MARKS = /\p{M}+/gu;

/** `text` as a view reads it, and as a held value's needles are read: decomposed (NFKD), its combining marks dropped,
 *  then NFKC, with its whitespace and its characters that render as nothing gone, before (so one between a letter and
 *  its accent hides neither) and after. A held value with a zero-width space or a soft hyphen between its characters
 *  reads as itself, and so does one with a control character between them (a NUL, an escape); so does one with a
 *  combining mark after a letter, which NFKC alone composes into another letter
 *  ("Z" and U+0301 into "Ź"), and one written with a precomposed letter in place of its own ("Ź" for "Z"). A held
 *  value's accents are dropped the same way, so it reads as itself with them or without: more cutting, never less.
 *  SEPARATOR goes too, so no needle holds it (a join's view keeps it, never squeezing it). */
export const squeeze = (text: string): string => text.replace(IGNORABLE, "").normalize("NFKD").replace(MARKS, "").normalize("NFKC").replace(GONE, "");

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
    // Each byte read, and the three characters past the run that end it.
    scanned.chars += end - at + 3;
    if (end === at) return -1;
    decoded(text, at, end, unit);
    return end;
  },
};
/** "+" as a space, as a form's encoding writes one. */
const PLUS: Decoder = { trigger: "+", decode: (_text, at, unit) => (scanned.chars++, unit(" ", at, at + 1), at + 1) };
/** What JSON's one-character escapes stand for. */
const ESCAPED: Readonly<Record<string, string>> = {
  n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f",
};
/** A character of `text` at `at` read through one level of JSON's escapes, and where it ends: a "\" and one of
 *  ESCAPED's keys, or "\u" and four hex digits (a UTF-16 unit), or else the character as it stands. */
type Char = { char: string; end: number };
function unescaped(text: string, at: number): Char | undefined {
  // Counted as the most it reads, six characters ("\u" and four hex digits), whatever it reads.
  if (at >= text.length) return undefined;
  scanned.chars += Math.min(6, text.length - at);
  if (text[at] !== "\\") return { char: text[at]!, end: at + 1 };
  const next = text[at + 1];
  if (next !== undefined && ESCAPED[next] !== undefined) return { char: ESCAPED[next]!, end: at + 2 };
  if (next !== "u") return undefined;
  for (let i = at + 2; i < at + 6; i++) if (!HEX(text.charCodeAt(i))) return undefined;
  return { char: String.fromCharCode(Number.parseInt(text.slice(at + 2, at + 6), 16)), end: at + 6 };
}
/** JSON's escapes, decoded twice: a held value a JSON writer wrote, every character or some ("\n", a "\u" and four hex
 *  digits), and one written again as a JSON string's text (JSON in JSON: "\\n", "\\u0041"). Where one level's "\"
 *  starts an escape of the next, each character that escape decodes to comes from all of the raw text the two levels
 *  read; a "\" that starts none is itself. A surrogate pair is two escapes, two units, NFKC'd together as any non-ASCII
 *  stretch is. Line breaks written "\r\n" decode to whitespace, gone from the view. An escaped quote, at either level
 *  (a backslash and a quote, or one more level of it, or the "\u" escape whose digits are 0022), decodes to nothing
 *  with `dropQuote`: it is where a string written in a string starts or ends, and a held value split across it reads
 *  whole, as one split across two strings does in the join view (joinOf). Without it, a quote, as the base's view of
 *  JSON's escapes alone read it (a held value with a quote of its own, written escaped). With `levels` 1, the first level
 *  alone: a "\\" is a backslash, read no further. */
const jsonEscape = (dropQuote: boolean, levels: 1 | 2 = 2): Decoder => ({
  trigger: "\\",
  decode(text, at, unit) {
    const put = (char: string, end: number) => {
      if (!dropQuote || char !== '"') unit(char, at, end);
      return end;
    };
    const first = unescaped(text, at);
    if (!first) return -1;
    if (levels === 1 || first.char !== "\\") return put(first.char, first.end);
    // The first level decoded a "\": what follows it, itself read through the first level, may be a second escape.
    const second = unescaped(text, first.end);
    if (second && ESCAPED[second.char] !== undefined) return put(ESCAPED[second.char]!, second.end);
    if (second?.char === "u") {
      let end = second.end;
      let digits = "";
      for (let i = 0; i < 4; i++) {
        const digit = unescaped(text, end);
        if (!digit || !HEX(digit.char.charCodeAt(0))) break;
        digits += digit.char;
        end = digit.end;
      }
      if (digits.length === 4) return put(String.fromCharCode(Number.parseInt(digits, 16)), end);
    }
    unit("\\", at, first.end);
    return first.end;
  },
});
const JSON_ESCAPE = jsonEscape(true);
/** JSON's escapes as the base's one-family view read them: an escaped quote is a quote. */
const JSON_ESCAPE_QUOTED = jsonEscape(false);
/** JSON's escapes, decoded once: a "\" that starts an escape and what follows it, as one character, an escaped quote a
 *  quote: a JSON string's text as JSON.parse reads it. A held value that holds a backslash before a character an escape
 *  starts with ("\n", "A" as written), written by a JSON writer ("\\n", "\u0041"), reads as itself here, where the
 *  two levels JSON_ESCAPE reads make the escaped backslash and what follows it one escape; so does one with a quote of
 *  its own, written once. */
const JSON_ESCAPE_ONCE = jsonEscape(false, 1);
/** One of Python's own escapes at `at`, as its repr writes a str: an escaped apostrophe ("\'", in a string that holds
 *  both quotes) is an apostrophe, "\x" and two hex digits the character they number; with `levels` 2, either written
 *  once more as a JSON string's text too ("\\'", "\\x41": a dict a model wrote in a call's arguments, read one level
 *  down). The character and where it ends; undefined where none starts. It reads at most five characters. key-refusal.ts's
 *  peek counts an escape by it (both levels), so the read past a call's stop counts "\x20" as the views that read
 *  Python's escapes do: a space. */
export function pythonEscapeAt(text: string, at: number, levels: 1 | 2 = 2): { char: string; end: number } | undefined {
  if (text[at] !== "\\") return undefined;
  scanned.chars += Math.min(5, text.length - at);
  const from = levels === 2 && text[at + 1] === "\\" ? at + 2 : at + 1;
  if (text[from] === "'") return { char: "'", end: from + 1 };
  if (text[from] !== "x" || !HEX(text.charCodeAt(from + 1)) || !HEX(text.charCodeAt(from + 2))) return undefined;
  return { char: String.fromCharCode(Number.parseInt(text.slice(from + 1, from + 3), 16)), end: from + 3 };
}
/** Python's escapes (pythonEscapeAt) at `levels`, and the rest as `json` reads them: a single-quoted dict's strings as
 *  its repr wrote them, with one level of JSON's escapes ("\\", "\n", "\u" and four hex digits); and, written in a
 *  JSON string, both levels of each ("\\'" and "\\x41", "\\\\" and "\\n"). */
const pythonEscape = (levels: 1 | 2, json: Decoder): Decoder => ({
  trigger: "\\",
  decode(text, at, unit) {
    const found = pythonEscapeAt(text, at, levels);
    if (!found) return json.decode(text, at, unit);
    unit(found.char, at, found.end);
    return found.end;
  },
});
const PYTHON_ESCAPE = pythonEscape(1, JSON_ESCAPE_ONCE);
const PYTHON_ESCAPE_TWICE = pythonEscape(2, JSON_ESCAPE_QUOTED);
/** What JSON_ESCAPE reads at `at`: the character the escape there decodes to, through both levels ("" for an escaped
 *  quote, which decodes to nothing), and where it ends; undefined where no escape starts (the "\" is then itself).
 *  key-refusal.ts's peek counts an escape by it, so the read past a call's stop and the JSON view see the same
 *  characters. */
export function jsonEscapeAt(text: string, at: number): { char: string; end: number } | undefined {
  let char = "";
  const end = JSON_ESCAPE.decode(text, at, (decoded) => {
    char = decoded;
  });
  return end < 0 ? undefined : { char, end };
}

const DECIMAL = only(DIGIT);
/** The named references a writer's HTML escape emits (and a no-break space), each with its ";". */
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", AMP: "&", LT: "<", GT: ">", QUOT: '"' };
/** The character an HTML character reference at `at` stands for, as a browser reads one in text, and where it ends:
 *  - a named one of NAMED, with its ";" ("&amp;" is "&"); it reads at most 6 characters;
 *  - a numeric one: "&#" and decimal digits, or "&#x" or "&#X" and hex digits, any zeros first (read as nothing:
 *    "&#00065;" is "A"), then at most 7 decimal or 6 hex digits, then ";" or not (a browser reads "&#65" before a letter
 *    as "A" too). It reads its zeros and one digit past the most, each once and counted: a run of zeros is read again
 *    only by the view that copies it where no reference stands.
 *  Undefined where none starts, or it stands for no character (zero, a surrogate, past U+10FFFF, or more digits than
 *  that). key-refusal.ts's peek counts a reference by it, so the read past a call's stop and the views see the same
 *  characters. */
export function entityAt(text: string, at: number): { char: string; end: number } | undefined {
  if (text[at] !== "&") {
    scanned.chars++;
    return undefined;
  }
  if (text[at + 1] !== "#") {
    scanned.chars += Math.min(6, text.length - at);
    for (let length = 2; length <= 4; length++) {
      const name = text.slice(at + 1, at + 1 + length);
      if (text[at + 1 + length] === ";" && Object.hasOwn(NAMED, name)) return { char: NAMED[name]!, end: at + 2 + length };
    }
    return undefined;
  }
  const hex = text[at + 2] === "x" || text[at + 2] === "X";
  const from = at + (hex ? 3 : 2);
  const digit = hex ? HEX : DECIMAL;
  const most = hex ? 6 : 7;
  let start = from;
  while (start < text.length && text.charCodeAt(start) === 48) start++;
  let end = start;
  while (end < text.length && end - start <= most && digit(text.charCodeAt(end))) end++;
  scanned.chars += end - at + 1;
  if (end === from || end - start > most) return undefined;
  const code = end === start ? 0 : Number.parseInt(text.slice(start, end), hex ? 16 : 10);
  if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return undefined;
  return { char: String.fromCodePoint(code), end: text[end] === ";" ? end + 1 : end };
}
/** An HTML character reference (entityAt), as the character it stands for (a character past U+FFFF as its two UTF-16
 *  units, each from the whole reference). */
const ENTITY: Decoder = {
  trigger: "&",
  decode(text, at, unit) {
    const found = entityAt(text, at);
    if (!found) return -1;
    for (let i = 0; i < found.char.length; i++) unit(found.char[i]!, at, found.end);
    return found.end;
  },
};

/** What a text holds that a view decodes or joins, each found by one read of the text (familiesOf): a percent-encoded
 *  byte, one of JSON's escapes, an escaped quote (at either level, or as its "\u" escape), an HTML character reference's
 *  start (a numeric one's "&#", or a named one of NAMED whole), a "+", a quote, an apostrophe, an escaped backslash (or
 *  its "\u" escape: where a second level of JSON's escapes can start), one of Python's own escapes ("\'" or "\x" and
 *  two hex digits). */
type Families = { percent: boolean; escape: boolean; quoteEscape: boolean; entity: boolean; plus: boolean; quote: boolean; apostrophe: boolean; deep: boolean; python: boolean };
const PERCENT_BYTE = /%[0-9a-fA-F]{2}/;
const JSON_ESCAPED = /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/;
const QUOTE_ESCAPED = /\\"|\\u00[2]2/;
const BACKSLASH_ESCAPED = /\\\\|\\u005[cC]/;
const PYTHON_ESCAPED = /\\(?:'|x[0-9a-fA-F]{2})/;
const ENTITY_START = /&(?:#|(?:amp|lt|gt|quot|apos|nbsp|AMP|LT|GT|QUOT);)/;
function familiesOf(text: string): Families {
  // Nine reads of the text, each to its first find at most.
  scanned.chars += 9 * text.length;
  return { percent: PERCENT_BYTE.test(text), escape: JSON_ESCAPED.test(text), quoteEscape: QUOTE_ESCAPED.test(text), entity: ENTITY_START.test(text), plus: text.includes("+"), quote: text.includes('"'), apostrophe: text.includes("'"), deep: BACKSLASH_ESCAPED.test(text), python: PYTHON_ESCAPED.test(text) };
}

/** Which join of a JSON text's strings a view reads (joinOf): `nested`, each string's contents, a value's read again for
 *  the strings written in it (JSON in a string); `strings`, each string's contents whole, as JSON.parse gives them;
 *  `quoted`, as `strings`, with a string opened by an apostrophe too and closed by the next one (a Python repr's
 *  {'alice': 'secretpw'}); `again`, the text of each value written in quotes that `quoted` reads, read as `quoted` one
 *  level down, and nothing else (a dict written in a JSON string: a call's arguments); `both`, the `quoted` join then the
 *  `again` join, each as holds builds it once, the first's closing SEPARATOR between them. */
type JoinKind = "nested" | "strings" | "quoted" | "again" | "both";
/** A view the whole-text check reads: the text decoded by `decoders`, then squeezed (viewOf), read only where `when`
 *  says the text holds what a decoder decodes (familiesOf). `special`: where viewOf stops to do more than copy. `join`:
 *  the view reads that join of the text's JSON strings (joinOf) in place of the text. */
type ViewSpec = { readonly when: (has: Families) => boolean; readonly decoders: readonly Decoder[]; readonly special: RegExp; readonly join?: JoinKind };
const viewSpec = (when: (has: Families) => boolean, decoders: readonly Decoder[], join?: JoinKind): ViewSpec => ({
  when,
  decoders,
  special: new RegExp(`[\\s${decoders.map((decoder) => `\\${decoder.trigger}`).join("")}\\u0000-\\u0008\\u000e-\\u001f\\u007f-\\uffff]`, "g"),
  ...(join ? { join } : {}),
});
/** The views of a text read for each held value, in order:
 *  - squeezed;
 *  - the views of one family each, as they were before the stacked ones: percent-decoded; percent-decoded with "+" as a
 *    space; JSON's escapes decoded twice, an escaped quote a quote; and decoded once, where the text holds an escape that
 *    decodes to a backslash (elsewhere the two levels read as one does). Each reads a held value that holds another
 *    family's text of its own (a literal "\n", a literal "%41", "&#65;") as itself, which a stacked view decodes, so
 *    keeping them keeps every find they made;
 *  - stacked: its percent-encoded bytes, JSON's escapes (twice, an escaped quote as nothing) and HTML's character
 *    references (entityAt) each decoded where it stands, so a value split by an encoded space of one family and an escaped one of
 *    another, or written half in each, or split by an escaped quote, reads whole; and the same with "+" as a space. Each
 *    is read only where it can read otherwise than the one-family views: the text has a character reference, an escaped
 *    quote, or both percent-encoding and JSON's escapes (and, with "+", any of JSON's escapes);
 *  - for a text with a quote in it, its JSON strings joined (joinOf), each string's contents read again for the strings
 *    written in it, decoded as the stacked view; and the same with "+" as a space, where the text has a "+" (a "+" after
 *    a held value's head with a character reference in it, or in JSON written in a string);
 *  - for a text with a quote in it, its JSON strings joined whole, read as the base's check of a web call's strings read
 *    them (decoded as JSON.parse decodes them, then through the one-family views): one level of JSON's escapes, an
 *    escaped quote a quote, so a held value with a quote of its own reads whole across two strings; the same
 *    percent-decoded, and with "+" as a space (a "+" after a held value's head in one string and its rest in the next);
 *    and JSON's escapes decoded twice, an escaped quote a quote (only where the text has an escaped backslash: otherwise
 *    it reads as the first). Each is read only where the text holds what it decodes;
 *  - for a text with an apostrophe in it, its strings joined whole with an apostrophe opening one too (a Python repr's
 *    single-quoted dict), one level of JSON's escapes decoded, followed by the again join (the text of each value
 *    written in quotes, read as the quoted join one level down: a dict written in a JSON string, a call's arguments)
 *    read the same way (a backslash of the dict's own, written once). A view of its own, so the views before it read an
 *    apostrophe outside a "..." string as they did; and the quoted join alone decoded through Python's escapes, where
 *    the text holds one ("\'" in a string with both quotes, "\x41"), beside it, so a backslash read as itself there
 *    still is; and, where the text holds a quote too, the again join alone through both levels of Python's escapes and
 *    of JSON's ("\\'", "\\x41", "\\t", "\"", or none). Neither level's parts are read beside the other's, so no held
 *    value reads across the two. The quoted join is never read through two levels: in a dict escaped once with no JSON
 *    string around it, "\\t" is a backslash and a "t", and a tab there would be a second decode, not a find.
 *  The decoders of a view decode in one pass: each reads at its own trigger character, so a view costs one read of the
 *  text whatever it decodes. Each view is lowered for hexes and flattened for folded identifiers in holds. */
const VIEWS: readonly ViewSpec[] = [
  viewSpec(() => true, []),
  viewSpec((has) => has.percent, [PERCENT]),
  viewSpec((has) => has.plus, [PERCENT, PLUS]),
  viewSpec((has) => has.escape, [JSON_ESCAPE_QUOTED]),
  viewSpec((has) => has.deep, [JSON_ESCAPE_ONCE]),
  viewSpec((has) => has.entity || has.quoteEscape || (has.percent && has.escape), [PERCENT, JSON_ESCAPE, ENTITY]),
  viewSpec((has) => has.plus && (has.entity || has.escape), [PERCENT, PLUS, JSON_ESCAPE, ENTITY]),
  viewSpec((has) => has.quote, [PERCENT, JSON_ESCAPE, ENTITY], "nested"),
  viewSpec((has) => has.quote && has.plus, [PERCENT, PLUS, JSON_ESCAPE, ENTITY], "nested"),
  viewSpec((has) => has.quote, [JSON_ESCAPE_ONCE], "strings"),
  viewSpec((has) => has.quote && has.percent, [PERCENT, JSON_ESCAPE_ONCE], "strings"),
  viewSpec((has) => has.quote && has.plus, [PERCENT, PLUS, JSON_ESCAPE_ONCE], "strings"),
  viewSpec((has) => has.quote && has.deep, [JSON_ESCAPE_QUOTED], "strings"),
  viewSpec((has) => has.apostrophe, [JSON_ESCAPE_ONCE], "both"),
  viewSpec((has) => has.apostrophe && has.python, [PYTHON_ESCAPE], "quoted"),
  viewSpec((has) => has.apostrophe && has.quote, [PYTHON_ESCAPE_TWICE], "again"),
];

// ---- The join view: a JSON text's strings read joined, so a held value split across two of them reads whole.

/** A stretch of a text the join view reads: a string's contents (a property name's, `name`), or a run of characters
 *  outside any string (a number, a word, a line after the JSON). */
type Part = { from: number; to: number; name: boolean };

/** JSON's punctuation between its values. */
const STRUCTURE = only("{}[],:");

/** The character of a JSON text at `at` (before `to`) as `level` reads it, and where it ends: at level 0 each raw
 *  character is itself; at level 1, the text of a string, an escape is the character it stands for ("\" and one
 *  character, "\u" and four hex digits), so a string written in that string has its quotes as "\"". */
function unitAt(text: string, at: number, to: number, level: 0 | 1): { char: string; end: number } {
  if (level === 0 || text[at] !== "\\" || at + 1 >= to) {
    scanned.chars++;
    return { char: text[at]!, end: at + 1 };
  }
  const next = text[at + 1]!;
  if (next === "u" && at + 6 <= to) {
    scanned.chars += 6;
    let hex = true;
    for (let i = at + 2; i < at + 6; i++) hex &&= HEX(text.charCodeAt(i));
    if (hex) return { char: String.fromCharCode(Number.parseInt(text.slice(at + 2, at + 6), 16)), end: at + 6 };
  }
  scanned.chars += 2;
  return { char: ESCAPED[next] ?? next, end: at + 2 };
}

/** The parts of text[from, to) as JSON at `level`, in order, added to `out`: each string's contents, a property name's
 *  (a string the next character after whitespace of which is ":") whole; a value's, at level 0 with `nested`, read again
 *  at level 1 for the strings written in it (JSON in a string), each of its parts added in its place, and else whole; and
 *  each run of characters outside a string that are neither whitespace nor JSON's punctuation. A string with no closing
 *  quote runs to `to`. Any text is read so, JSON or not: a quote in prose opens a string as one in JSON does. With
 *  `quoted`, an apostrophe opens a string too, closed by the next apostrophe (a quote inside it is text, as an
 *  apostrophe inside a "..." string is), and at level 0, with `written`, the span of each value written in quotes is added
 *  to it (the again join reads it one level down). Each character is read at most three times (at level 0, at level 1,
 *  and in the whitespace after a string looking for a ":"). */
function partsOf(text: string, from: number, to: number, level: 0 | 1, out: Part[], kind: JoinKind = "nested", written?: Span[]): void {
  let bare = -1;
  const endBare = (end: number) => {
    if (bare >= 0) out.push({ from: bare, to: end, name: false });
    bare = -1;
  };
  for (let at = from; at < to; ) {
    const { char, end } = unitAt(text, at, to, level);
    const code = char.charCodeAt(0);
    if (char !== '"' && !(kind === "quoted" && char === "'")) {
      if (isSpace(code) || STRUCTURE(code)) endBare(at);
      else if (bare < 0) bare = at;
      at = end;
      continue;
    }
    endBare(at);
    // The string: to its closing quote, each escape (a "\" and the character after it) passed over whole.
    let close = end;
    while (close < to) {
      const inner = unitAt(text, close, to, level);
      if (inner.char === char) break;
      close = inner.char === "\\" && inner.end < to ? unitAt(text, inner.end, to, level).end : inner.end;
    }
    const after = close < to ? unitAt(text, close, to, level).end : to;
    // A name, when the next character past whitespace is a ":".
    let ahead = after;
    let next = "";
    while (ahead < to) {
      const unit = unitAt(text, ahead, to, level);
      if (!isSpace(unit.char.charCodeAt(0))) {
        next = unit.char;
        break;
      }
      ahead = unit.end;
    }
    if (next === ":") out.push({ from: end, to: close, name: true });
    else if (level === 0 && kind === "nested") partsOf(text, end, close, 1, out);
    else {
      out.push({ from: end, to: close, name: false });
      if (level === 0 && char === '"') written?.push([end, close]);
    }
    at = after;
  }
  endBare(to);
}

/** `text`'s join of `kind` (JoinKind): its parts (partsOf) read three times over, each time joined, each part followed by a space (gone
 *  from the view, and no escape reads past it): the values and the runs outside strings; the property names; then all
 *  of them. Each pass is closed by SEPARATOR, which a view of a join keeps and no needle holds, so no value reads across
 *  two passes (holds reads a U+FFFF the text brought as a NUL first, so it is the only one). A held value split across two values with a name between them ({"title":"see <H>","snippet":"<R> more"}),
 *  across two names, across a name and its value, across a quote of JSON written in a string, or across a string and
 *  the line after the JSON reads whole in one of them. A view decodes and squeezes the join as any text (viewOf), each
 *  part's characters keeping their source: with `cuts` (merged spans of `text`), the spans of each part a cut covers
 *  are moved to where the part stands in the join (`cuts` of the join), so a value the finds cut in place in each
 *  string is covered there too. The cuts' cursor only goes forward within a pass: each cut is passed once a pass. A
 *  join is the same for every view that reads it: holds builds each kind once per text. */
function joinOf(text: string, kind: Exclude<JoinKind, "both">, cuts?: readonly Span[]): { text: string; cuts?: Span[] } {
  const parts: Part[] = [];
  if (kind === "again") {
    // The quoted join's values written in quotes, each read one level down, in the text's order.
    const written: Span[] = [];
    partsOf(text, 0, text.length, 0, [], "quoted", written);
    for (const [start, end] of written) partsOf(text, start, end, 1, parts, "quoted");
  } else partsOf(text, 0, text.length, 0, parts, kind);
  const pieces: string[] = [];
  const moved: Span[] = [];
  let length = 0;
  const passes: readonly ((part: Part) => boolean)[] = [(part) => !part.name, (part) => part.name, () => true];
  for (const pass of passes) {
    let cut = 0;
    for (const part of parts) {
      if (!pass(part)) continue;
      scanned.chars++;
      if (cuts) {
        while (cut < cuts.length && cuts[cut]![1] <= part.from) {
          cut++;
          scanned.chars++;
        }
        for (let k = cut; k < cuts.length && cuts[k]![0] < part.to; k++) {
          scanned.chars++;
          const start = Math.max(part.from, cuts[k]![0]);
          const end = Math.min(part.to, cuts[k]![1]);
          if (start < end) moved.push([length + start - part.from, length + end - part.from]);
        }
      }
      pieces.push(text.slice(part.from, part.to), " ");
      length += part.to - part.from + 1;
    }
    pieces.push(SEPARATOR);
    length++;
  }
  // The join written once.
  scanned.chars += length;
  return { text: pieces.join(""), ...(cuts ? { cuts: moved } : {}) };
}

/** Two joins one after the other (JoinKind `both`), the second's cuts moved past the first; written once. */
function bothOf(first: { text: string; cuts?: Span[] }, second: { text: string; cuts?: Span[] }): { text: string; cuts?: Span[] } {
  const text = first.text + second.text;
  scanned.chars += text.length;
  if (!first.cuts || !second.cuts) return { text };
  const at = first.text.length;
  return { text, cuts: [...first.cuts, ...second.cuts.map(([start, end]): Span => [at + start, at + end])] };
}

/** `text` as the whole-text check reads it: decoded by `spec`'s decoders, then squeezed (squeeze: NFKC, its whitespace
 *  and its characters that render as nothing gone), as a held value's needles are. The squeeze is applied to each
 *  stretch of non-ASCII characters with the ASCII character before it, which gives what it gives over the whole text (an
 *  ASCII character is a starter nothing composes onto), and each character it makes comes from that whole stretch. A
 *  control character (isControl) is dropped, as it stands or as a decoder made it, and so is SEPARATOR, unless
 *  `separates` and it stands in the text as it is (a join's own, or a caller's: holds), where it is copied, never
 *  squeezed. A terminal control (isTerminal) is dropped as any control is, and the view is then `marked` with the
 *  units it read, for readingsOf; with `screen`, each unit it does not show is dropped too. With `cuts` (merged spans of `text`), the view's
 *  covered stretches: where every character comes from inside one cut. */
function viewOf(text: string, spec: ViewSpec, cuts?: readonly Span[], separates = false, screen?: Screen): View {
  const out: string[] = [];
  const covered: Span[] = [];
  let length = 0;
  let cut = 0;
  let marked = false;
  // The characters the decoders and the copy hand on (units), counted and kept as they come (record), for readingsOf
  // where a terminal control is among them. With `screen`, a unit it does not show is skipped as a control is.
  let units = 0;
  const record: string[] = [];
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
      // The cover's cursor only goes forward: each cut is passed once in the whole view.
      while (cut < cuts.length && cuts[cut]![1] <= from) {
        cut++;
        scanned.chars++;
      }
      for (let k = cut; k < cuts.length && cuts[k]![0] < to; k++) {
        scanned.chars++;
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
      while (cut < cuts.length && cuts[cut]![1] <= from) {
        cut++;
        scanned.chars++;
      }
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
  const flushGroup = () => {
    if (!group) return;
    // The stretch squeezed twice: whole, and without its lead.
    scanned.chars += 2 * group.chars.length;
    const made = squeeze(group.chars);
    const { lead } = group;
    const rest = lead ? squeeze(group.chars.slice(lead.char.length)) : "";
    // Where nothing composed onto the ASCII character, it comes from itself alone: a value cut in place right before
    // a non-ASCII character is still covered to its last character. A stretch that squeezes to nothing (characters that
    // render as nothing) adds nothing to the view, as whitespace adds nothing.
    if (lead && made === squeeze(lead.char) + rest) {
      held = lead;
      flushHeld();
      emit(rest, lead.to, group.to);
    } else emit(made, group.from, group.to);
    group = undefined;
  };
  const unit = (char: string, from: number, to: number) => {
    const code = char.charCodeAt(0);
    const index = units++;
    if (screen) {
      if (!screen.shown[index]) return;
    } else {
      if (isTerminal(code)) marked = true;
      record.push(char);
    }
    // A control character, or SEPARATOR, as it stands or decoded, is nothing: dropped before anything is flushed, so
    // the characters either side of it compose as they would with it gone (as squeeze drops it before NFKD). A
    // terminal control is one too.
    if (isControl(code) || char === SEPARATOR) return;
    if (code >= 128) {
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
    // The characters copied as they are, and the special one that stopped the search.
    scanned.chars += (hit ? stop + 1 : stop) - at;
    if (stop > at) {
      const index = units;
      units += stop - at;
      if (!screen) record.push(text.slice(at, stop));
      if (screen && screen.hiddenBefore[units] !== screen.hiddenBefore[index]) {
        // Some of the run a terminal does not show: each character of it read alone, the ones it hides skipped.
        scanned.chars += stop - at;
        for (let k = at; k < stop; k++) {
          if (!screen.shown[index + k - at]) continue;
          flushGroup();
          flushHeld();
          held = { char: text[k]!, from: k, to: k + 1 };
        }
      } else {
        flushGroup();
        flushHeld();
        emitSlice(at, stop - 1);
        held = { char: text[stop - 1]!, from: stop - 1, to: stop };
      }
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
      scanned.chars += BLANKS.lastIndex - stop;
      flushGroup();
      flushHeld();
      held = { char: text[BLANKS.lastIndex - 1]!, from: BLANKS.lastIndex - 1, to: BLANKS.lastIndex };
      at = BLANKS.lastIndex;
    } else if (separates && char === SEPARATOR) {
      // A separator as it stands is copied, never squeezed, and nothing composes across it.
      flushGroup();
      flushHeld();
      emit(char, stop, stop + 1);
      at = stop + 1;
    } else {
      unit(char, stop, stop + 1);
      at = stop + 1;
    }
  }
  flushGroup();
  flushHeld();
  if (!marked) return { text: out.join(""), covered };
  const recorded = record.join("");
  scanned.chars += recorded.length;
  return { text: out.join(""), covered, marked: recorded };
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
/** One character IGNORABLE matches. */
const IGNORABLE_ONE = new RegExp(`^${IGNORABLE.source.slice(0, -1)}$`, "u");
/** Whether a unit takes no place on screen, as the views drop it: a control character, whitespace from tab to
 *  carriage return, or a character IGNORABLE holds (not half of a surrogate pair, which stays). A backspace after it
 *  strikes out the character before it. */
const placeless = (code: number, char: string): boolean =>
  (isControl(code) && !isTerminal(code)) || (code >= 0x09 && code <= 0x0d) || code === 0x20 || (code >= 0xa0 && !isHigh(code) && !isLow(code) && IGNORABLE_ONE.test(char));
/** Whether a terminal passes over a unit inside a sequence without ending it: a NUL or a DEL (ignored), any other C0
 *  control but ESC, CAN and SUB (run: a backspace moves back), a BEL but where it ends an OSC, a C1 control but the
 *  8-bit CSI, ST and OSC, and a character that shows as nothing, a box or a blank (placeless). */
const passedIn = (code: number, char: string, osc: boolean): boolean =>
  code === 0x18 || code === 0x1a || code === 0x1b || code === 0x9b || code === 0x9c || code === 0x9d || code === 0x20 || (osc && code === 0x07)
    ? false
    : code < 0x20 || placeless(code, char);

/** The readings of a text through `spec`: its view, or, where a terminal control is in it (`marked`), that view (the
 *  terminal controls dropped, as any control is: an ESC and the letter after it read as text) and the view of the text
 *  as a terminal shows it: each CSI (ESC "[" or U+009B, its parameters, intermediates and final byte), each OSC (ESC
 *  "]" or U+009D to a BEL, ESC and a backslash, or U+009C) and each other escape (ESC, any intermediate bytes, and a
 *  final byte from 0x30 to 0x7E) gone whole; a backspace gone with the character before it (a whole character: both
 *  halves of one past U+FFFF; the next one takes its place on screen); and an ESC that opens none of them, a BEL and a
 *  U+009C gone alone. Inside a sequence a terminal ignores a NUL or a DEL and runs any other C0 control without ending
 *  it (a backspace there still strikes out the character before the sequence), and CAN or SUB aborts it (gone whole);
 *  each control or character the views drop is passed over there, and takes no place a backspace strikes out
 *  (placeless). That view is built again from the text with the units a terminal hides skipped, so the squeeze
 *  reads the characters either side of what it hides as one stretch, as a reader does. A held value either reading
 *  shows is held. Each read is linear: a sequence read stops at the first unit it cannot hold, and one not ended is read
 *  again once, from the unit after its opener. */
function readingsOf(text: string, spec: ViewSpec, cuts: readonly Span[] | undefined, separates: boolean): View[] {
  const view = viewOf(text, spec, cuts, separates);
  if (!view.marked) return [view];
  const recorded = view.marked;
  const units = recorded.length;
  const shown = new Uint8Array(units);
  // The shown units a backspace can strike out, in order.
  const stack: number[] = [];
  // A backspace strikes out a whole character: one past U+FFFF goes with both its halves.
  const strike = () => {
    const last = stack.pop();
    if (last === undefined) return;
    shown[last] = 0;
    if (isLow(recorded.charCodeAt(last)) && stack.at(-1) === last - 1 && isHigh(recorded.charCodeAt(last - 1))) shown[stack.pop()!] = 0;
  };
  // A sequence's reader: `k` is where it is, `byte` the next unit at k or after it that the terminal does not pass over
  // inside a sequence (passedIn), k moved to it, or -1 at the end.
  let k = 0;
  const byte = (osc: boolean): number => {
    while (k < units && passedIn(recorded.charCodeAt(k), recorded[k]!, osc)) k++;
    return k < units ? recorded.charCodeAt(k) : -1;
  };
  const aborts = (code: number): boolean => code === 0x18 || code === 0x1a;
  // Where a CSI whose parameters start at k ends (its final byte, or the CAN or SUB that aborts it), or -1: parameter
  // bytes (0x30-0x3F), then intermediate bytes (0x20-0x2F), then a final byte (0x40-0x7E).
  const csi = (): number => {
    let code = byte(false);
    while (code >= 0x30 && code <= 0x3f) (k++, (code = byte(false)));
    while (code >= 0x20 && code <= 0x2f) (k++, (code = byte(false)));
    return (code >= 0x40 && code <= 0x7e) || aborts(code) ? k : -1;
  };
  // Where an OSC whose body starts at k ends (its BEL, its U+009C, the backslash of its ESC and backslash, or the CAN or
  // SUB that aborts it), or -1 where an 8-bit CSI or OSC, an ESC and no backslash, or the end comes first: an OSC never
  // ended there is no OSC.
  const osc = (): number => {
    for (let code = byte(true); code >= 0; code = byte(true)) {
      if (code === 0x07 || code === 0x9c || aborts(code)) return k;
      if (code === 0x9b || code === 0x9d) return -1;
      k++;
      if (code === 0x1b) return byte(true) === 0x5c ? k : -1;
    }
    return -1;
  };
  for (let i = 0; i < units; ) {
    const code = recorded.charCodeAt(i);
    if (!isTerminal(code)) {
      shown[i] = 1;
      if (!placeless(code, recorded[i]!)) stack.push(i);
      i++;
      continue;
    }
    let end = -1;
    k = i + 1;
    if (code === 0x08) strike();
    else if (code === 0x9b) end = csi();
    else if (code === 0x9d) end = osc();
    else if (code === 0x1b) {
      const next = byte(false);
      if (next === 0x5b) (k++, (end = csi()));
      else if (next === 0x5d) (k++, (end = osc()));
      else {
        let unit = next;
        while (unit >= 0x20 && unit <= 0x2f) (k++, (unit = byte(false)));
        if ((unit >= 0x30 && unit <= 0x7e) || aborts(unit)) end = k;
      }
    }
    // Each sequence read stops at the first unit it cannot hold; one not ended is read again from i + 1.
    scanned.chars += Math.min(k, units) - i + 1;
    if (end < 0) {
      i++;
      continue;
    }
    // A backspace inside the sequence still moves back: the character before the sequence is struck out.
    for (let at = i + 1; at <= end; at++) if (recorded.charCodeAt(at) === 0x08) strike();
    i = end + 1;
  }
  const hiddenBefore = new Int32Array(units + 1);
  for (let k = 0; k < units; k++) hiddenBefore[k + 1] = hiddenBefore[k]! + (shown[k] ? 0 : 1);
  scanned.chars += 2 * units;
  return [view, viewOf(text, spec, cuts, separates, { shown, hiddenBefore })];
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
  // The run read three times: its hex parsed, decoded whole, and decoded one sequence at a time.
  scanned.chars += 3 * (to - from);
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
  scanned.chars += view.text.length + view.covered.length;
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

/** Whether [start, end) of a view lies in one of its covered stretches: a binary search, each stretch it visits
 *  counted. */
function inside(covered: readonly Span[], start: number, end: number): boolean {
  let lo = 0;
  let hi = covered.length - 1;
  while (lo <= hi) {
    scanned.chars++;
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
      if (find(view, needle, 0) >= 0) return true;
      continue;
    }
    for (let at = find(view, needle, 0); at >= 0; at = find(view, needle, at + 1)) if (!inside(covered, at, at + needle.length)) return true;
  }
  return false;
}

/** Whether `text` holds a held value in a form the cut does not find as it stands: split by whitespace, percent or
 *  form encoded, an NFKC variant, its hex in any case, a hex identifier folded (`fold`), split across two strings of a
 *  JSON text (joinOf; a "+" after its head or a quote of its own in it too), or split there at its own "," or ":"
 *  (`joined`). With `cuts`, a value whose every character the view read comes from inside the cuts is not held: it is
 *  cut in place. A U+FFFF in `text` is nothing to the views (SEPARATOR); with `separated`, each one is the caller's
 *  mark and separates there in every view. */
export function holds(text: string, needles: Needles, { fold = true, cuts, separated = false }: { fold?: boolean; cuts?: readonly Span[]; separated?: boolean } = {}): boolean {
  const folds = fold ? needles.folds : [];
  if (!needles.plain.length && !needles.hexes.length && !folds.length) return false;
  const has = familiesOf(text);
  // What the joins read: the text with each U+FFFF it brought read as a NUL (SEPARATOR), so the only one in a join is
  // the one joinOf puts after each pass; with `separated`, the text as it is. Read once, on the first join.
  let source: string | undefined;
  const joinText = (): string => {
    if (source === undefined) {
      scanned.chars += text.length;
      source = !separated && text.includes(SEPARATOR) ? text.replaceAll(SEPARATOR, "\u0000") : text;
    }
    return source;
  };
  const joins = new Map<JoinKind, { text: string; cuts?: Span[] }>();
  const joinFor = (kind: JoinKind): { text: string; cuts?: Span[] } => {
    let join = joins.get(kind);
    if (!join) joins.set(kind, (join = kind === "both" ? bothOf(joinFor("quoted"), joinFor("again")) : joinOf(joinText(), kind, cuts)));
    return join;
  };
  for (const spec of VIEWS) {
    if (!spec.when(has)) continue;
    const join = spec.join ? joinFor(spec.join) : undefined;
    for (const view of join ? readingsOf(join.text, spec, join.cuts, true) : readingsOf(text, spec, cuts, separated)) {
      const covered = cuts ? view.covered : undefined;
      if (holdsIn(view.text, covered, needles.plain)) return true;
      if (spec.join && needles.joined?.length && holdsIn(view.text, covered, needles.joined)) return true;
      if (!needles.hexes.length && !folds.length) continue;
      scanned.chars += view.text.length;
      const lower = { text: asciiLower(view.text), covered: view.covered };
      if (holdsIn(lower.text, covered, needles.hexes)) return true;
      if (!folds.length) continue;
      const flat = flatOf(lower);
      if (holdsIn(flat.text, cuts ? flat.covered : undefined, folds)) return true;
    }
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
