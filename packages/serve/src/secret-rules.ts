// The scrubber's rules (secret-cut.ts scrub): what a shared transcript is cut of, each rule anchored on something a reader
// can name: a known format, a value the server holds, a whole dump (env output, a .env file, ~/.ssh, a credentials file),
// a label typed beside a value, or a personal detail. No rule reads randomness alone. Each rule's kind is what anchors
// its match, never the file its pattern comes from: a value that names its own format (a prefix, a checksum, secretlint's
// finds) is "format"; one found by what stands beside it (a variable's name, a flag, a header, a URL's userinfo or
// parameter, a scheme word) is "label". The kind alone says whether a preview may put the text back (RESTORABLE).
//
// Every rule reads each of a text's views (viewsOf): the raw text, and the text decoded as a JSON string once, twice and
// three times, an escape a boundary in each; the engine takes the union of what every view finds. Every pattern is a
// named module-level constant (RULE_PATTERNS) and every run it reads is bounded, so each rule reads a text in time linear
// in its length (secret-scrub.test.mjs walks them).
import { heldSpans, SHAPES, spans } from "./learn/secrets.js";

export type CutKind =
  | "format" // a known format: prefix or checksum (sk-, ghp_, AKIA, JWT, PEM block, secretlint hits)
  | "held" // a value the server holds (serverSecrets, handed refs, env key-shaped values)
  | "dump" // a whole dump dropped: env/printenv output, a .env* file, ~/.ssh contents, a credentials file
  | "label" // a value next to a label: PGPASSWORD=, sshpass -p, mysql -p, Authorization:, --password ...
  | "personal" // home paths, emails, private IPs
  | "jev"; // beta 3 only (gray zone)

/** Whether a cut of each kind may be put back by a preview: fixed per kind, never per rule or per cut. */
export const RESTORABLE: Readonly<Record<CutKind, boolean>> = Object.freeze({ format: false, held: false, dump: false, label: true, personal: true, jev: true });

/** A place a rule matched, by offsets into the text it read; a label rule names its label (`name`: a variable's name, a
 *  flag, a header) so the placeholder check can tell a metavar (`--token TOKEN`) from a value. `code: false` marks a slot
 *  code does not fill (an UPPER_NAME=, a YAML key at a line's start, a flag's value): there a code shape is a value
 *  (ruling XII). `typed` marks a slot a type annotation reads the same as (`name: Type`, a YAML key or a Python
 *  annotation), where a type's name stays no value. */
export type Hit = { readonly start: number; readonly end: number; readonly name?: string; readonly quoted?: boolean; readonly code?: boolean; readonly typed?: boolean };

/** One of secretlint's finds: the message it reports (its anchor: `AWSSecretAccessKey`, `NPM_ACCESS_TOKEN`, ...) and the
 *  value, as it names it and as each JSON string holding it would read it. */
export type LintFind = { readonly id: string; readonly value: string };

/** What a rule may read beside the view's text: the held values (8 characters or more), the view's text before its
 *  escapes were blanked (`source`: the held rule reads a held value holding a backslash there), the home folders the
 *  caller holds, the path the text is the content of and the command it is the output of when the caller knows them, and secretlint's finds in the view (read
 *  once a view, on first ask). */
export type ScrubContext = {
  readonly held: readonly string[];
  readonly source: string;
  readonly homes: readonly string[];
  readonly path?: string;
  /** The shell command whose output the text is, when the caller knows it (ruling LVI): an env command's output is a
   *  dump though the command stands in no line of the text. */
  readonly command?: string;
  readonly lint: () => Promise<readonly LintFind[]>;
  /** Where the line holding an offset starts and ends: a line break, or a JSON string's own quote the view decoded
   *  (ruling XXVIII). Absent: line breaks alone. */
  readonly lines?: LineBounds;
};

/** A view's lines: the start of the line holding `at` (after a line break, or after the opening quote of the decoded
 *  string holding it) and that line's end (a line break, or the string's closing quote). */
export type LineBounds = { readonly start: (at: number) => number; readonly end: (at: number) => number };

/** The index of the last of `places` (sorted) before `at`, or -1. */
function placeBefore(places: readonly number[], at: number): number {
  let low = 0;
  let high = places.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (places[mid]! < at) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

/** A text's strings: its quotes (sorted, none an escape's) paired the way JSON reads them, an opening quote then the
 *  next as its closing one, where `source` (the text the quotes stand in as written) holds no line break between them.
 *  A line break inside resets: the quote before it opened nothing, and the next quote opens (rulings XXXIX, XLVI). Each
 *  pair is the indices of its two quotes. */
function pairQuotes(source: string, quotes: readonly number[]): [number, number][] {
  const pairs: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < quotes.length; i++) {
    if (open < 0) {
      open = i;
      continue;
    }
    const newline = source.indexOf("\n", quotes[open]!);
    if (newline >= 0 && newline < quotes[i]!) {
      open = i;
      continue;
    }
    pairs.push([open, i]);
    open = -1;
  }
  return pairs;
}

/** A string's span, [its opening quote, its closing quote]. */
export type StringSpan = readonly [number, number];

/** `text`'s line bounds. Inside a string (one of `strings`, sorted and disjoint per list: the strings the view was
 *  decoded from, and its own), a line starts after the string's opening quote and ends at its closing quote, or at a
 *  line break in between. A position outside every string is bounded by line breaks alone (ruling XLVI): a value that
 *  starts outside every string never ends at a string's start (`os.environ["X"]`). */
export function lineBounds(text: string, ...lists: readonly (readonly StringSpan[])[]): LineBounds {
  const indexed = lists.map((spans) => ({ spans, opens: spans.map(([open]) => open) }));
  // Each list's string holding `at` (after its opening quote, up to and with its closing one).
  const holding = (at: number): StringSpan[] =>
    indexed.flatMap(({ spans, opens }) => {
      const i = placeBefore(opens, at);
      return i >= 0 && spans[i]![1] >= at ? [spans[i]!] : [];
    });
  return {
    start: (at) => Math.max(text.lastIndexOf("\n", at - 1) + 1, ...holding(at).map(([open]) => open + 1)),
    end: (at) => {
      const line = text.indexOf("\n", at);
      return Math.min(line < 0 ? text.length : line, ...holding(at).map(([, close]) => close));
    },
  };
}
const linesOfContext = (text: string, ctx?: ScrubContext): LineBounds => ctx?.lines ?? lineBounds(text);

export type ScrubRule = {
  readonly id: string;
  readonly kind: CutKind;
  readonly restorable: boolean;
  /** The class a cut's shape names in place of a prefix (personal rules: "email", "ip", "home"). */
  readonly shapeClass?: string;
  /** The text a cut puts in the value's place, when not `[redacted:<id>]` (a home folder's: `~`). */
  readonly replacement?: string;
  readonly find: (text: string, ctx: ScrubContext) => readonly Hit[] | Promise<readonly Hit[]>;
};

/** One cut: its rule, kind, whether a preview may restore it, its span in the INPUT text, and its shape (a public prefix
 *  or a character class, and a length), never its value. In cut mode, `outStart`/`outEnd` are its replacement's span in
 *  the output (the input's own text there when `kept`: a restorable cut the caller's `keep` chose to leave). */
export type Cut = { rule: string; kind: CutKind; restorable: boolean; start: number; end: number; shape: string; outStart?: number; outEnd?: number; kept?: true };

const rule = (id: string, kind: CutKind, find: ScrubRule["find"], extra: Pick<ScrubRule, "shapeClass" | "replacement"> = {}): ScrubRule => Object.freeze({ id, kind, restorable: RESTORABLE[kind], find, ...extra });

// ---------- the views (ruling A): the raw text and each JSON decoding of it, up to three, each mapped to the input

/** A JSON string's escape: \n \t \r \b \f \" \\ \/ or \uXXXX. Read left to right, so `\\n` is an escaped backslash
 *  and a letter. */
const ESCAPE = /\\(?:(["\\/bfnrt])|u([0-9A-Fa-f]{4}))/g;
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/** A Windows path from its drive, written as typed (one backslash a separator, never `C:\\`: that is a path a JSON
 *  string holds, its backslashes escapes the next view decodes), through every character a path holds. */
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:\\(?!\\)[^\s"'\x60<>|]{0,4096}/g;
const DECODED: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** One reading of a text: `text` is what every rule reads (the decoded text with each escape still in it blanked, and
 *  each control character but a tab or a line break read as a blank); `source` is the same before that blanking (the
 *  held rule's); `depth` how many times the input was decoded to make it; `escapes` the spans of the escapes it blanked
 *  (a backslash it left as a typed path's separator is no escape: a hit is never widened over it, ruling XIII); `at`
 *  maps an offset in it to the input's (`at(text.length)` is the input's length). */
export type View = {
  readonly text: string;
  readonly source: string;
  readonly depth: number;
  readonly escapes: readonly (readonly [number, number])[];
  readonly at: (offset: number) => number;
  /** The quotes of the JSON strings it was decoded from, as written there (blanked in `text`). */
  readonly delimiters: readonly number[];
  /** The strings it was decoded from (their quotes `delimiters`), one list per view above it, each paired in the view
   *  that held it as its own (a string inside a string is its own level's). */
  readonly decodedStrings: readonly (readonly StringSpan[])[];
  /** Its own JSON strings (ruling XXXIX: whether or not there is anything to decode): its quotes, no escape's and none
   *  of `delimiters`, paired the JSON way (pairQuotes). Sorted. */
  readonly strings: readonly StringSpan[];
};

/** `text` decoded once as a JSON string's body: each escape read as the character it stands for (no exception: a
 *  backslash in a Windows path is a JSON escape here like any other, and the raw view reads the path as written). An
 *  escape JSON does not have (`\U`, `\d`) is left as written. `escapes` are the decoded escapes' spans in `text`; `at`
 *  maps an offset in the decoded text back to `text`'s, an offset at an escape's character to that escape's start. */
function decodeOnce(text: string): { out: string; escapes: [number, number][]; at: (offset: number) => number; delimiters: number[] } {
  const escapes: [number, number][] = [];
  if (!text.includes("\\")) return { out: text, escapes, at: (offset) => offset, delimiters: [] };
  const parts: string[] = [];
  const viewAt: number[] = [];
  let from = 0;
  let length = 0;
  for (const m of text.matchAll(ESCAPE)) {
    parts.push(text.slice(from, m.index));
    length += m.index - from;
    viewAt.push(length);
    escapes.push([m.index, m.index + m[0].length]);
    parts.push(m[1] !== undefined ? DECODED[m[1]]! : String.fromCharCode(Number.parseInt(m[2]!, 16)));
    length += 1;
    from = m.index + m[0].length;
  }
  parts.push(text.slice(from));
  const out = parts.join("");
  // The quotes `text` holds as written (no escape's): its JSON strings' delimiters, structure to the decoded text.
  const delimiters: number[] = [];
  for (let at = out.indexOf('"'), escape = 0; at >= 0; at = out.indexOf('"', at + 1)) {
    while (escape < viewAt.length && viewAt[escape]! < at) escape++;
    if (viewAt[escape] !== at) delimiters.push(at);
  }
  const at = (offset: number): number => {
    // The last escape read at or before `offset`.
    let low = 0;
    let high = viewAt.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (viewAt[mid]! <= offset) (found = mid), (low = mid + 1);
      else high = mid - 1;
    }
    if (found < 0) return offset;
    if (viewAt[found] === offset) return escapes[found]![0];
    return escapes[found]![1] + (offset - viewAt[found]! - 1);
  };
  return { out, escapes, at, delimiters };
}

/** `text` as the rules read it: each of `delimiters` blanked (the quotes the text it was decoded from held as written:
 *  that text's JSON strings' delimiters, which would otherwise close a quoted value that was never one), each escape in
 *  it blanked (a blank for each of its characters, so offsets hold), but one
 *  that stands whole inside a Windows path (`C:\Users\nina`: there a backslash is the path's separator, read as
 *  written: the next view decodes it), and each control character a blank. So no value starts on an escape's letter
 *  (`\tgit@...` reads a blank and `git@...`) and none runs through one. */
function blanked(text: string, escapes: readonly (readonly [number, number])[], delimiters: readonly number[] = []): { text: string; escapes: (readonly [number, number])[] } {
  let plain = text.replace(CONTROLS, " ");
  if (delimiters.length) {
    const chars = plain.split("");
    for (const at of delimiters) chars[at] = " ";
    plain = chars.join("");
  }
  if (!escapes.length) return { text: plain, escapes: [] };
  const drives = [...text.matchAll(DRIVE_PATH)].map((m) => [m.index, m.index + m[0].length] as const);
  const parts: string[] = [];
  const cut: (readonly [number, number])[] = [];
  let from = 0;
  let drive = 0;
  for (const [start, end] of escapes) {
    while (drive < drives.length && drives[drive]![1] < end) drive++;
    if (drive < drives.length && drives[drive]![0] < start) continue;
    parts.push(plain.slice(from, start), " ".repeat(end - start));
    cut.push([start, end]);
    from = end;
  }
  parts.push(plain.slice(from));
  return { text: parts.join(""), escapes: cut };
}

/** The most times a text is decoded: a JSON string inside a JSON string inside one (a tool's output kept in a record). */
export const VIEW_DEPTH = 3;

/** The quotes `source` holds that no escape writes (no odd run of backslashes before one): its JSON strings' bounds
 *  as it stands (ruling XXXIX: a view with no escape left has strings too). */
function quotesOf(source: string): number[] {
  const out: number[] = [];
  for (let at = source.indexOf('"'); at >= 0; at = source.indexOf('"', at + 1)) {
    let run = 0;
    while (at - run - 1 >= 0 && source.charCodeAt(at - run - 1) === 92) run++;
    if (run % 2 === 0) out.push(at);
  }
  return out;
}

/** `text`'s views: the raw text, then each JSON decoding of it up to VIEW_DEPTH times, while a decoding changes it. */
export function viewsOf(text: string): View[] {
  const views: View[] = [];
  let source = text;
  let at = (offset: number): number => offset;
  let delimiters: number[] = [];
  let decodedStrings: (readonly StringSpan[])[] = [];
  for (let depth = 0; depth <= VIEW_DEPTH; depth++) {
    const next = decodeOnce(source);
    const read = blanked(source, next.escapes, delimiters);
    const inherited = new Set(delimiters);
    const quotes = quotesOf(source).filter((quote) => !inherited.has(quote));
    const strings = pairQuotes(source, quotes).map(([open, close]): StringSpan => [quotes[open]!, quotes[close]!]);
    views.push({ text: read.text, source, depth, escapes: read.escapes, at, delimiters, decodedStrings, strings });
    if (!next.escapes.length || depth === VIEW_DEPTH) break;
    const outer = at;
    at = (offset) => outer(next.at(offset));
    source = next.out;
    delimiters = next.delimiters;
    // Each level's strings, to the decoded text's offsets: a quote as written stands in both (next.delimiters).
    const toNext = new Map(next.delimiters.map((quote) => [next.at(quote), quote]));
    decodedStrings = [...decodedStrings, strings].map((list) =>
      list.flatMap(([open, close]): StringSpan[] => {
        const [from, to] = [toNext.get(open), toNext.get(close)];
        return from === undefined || to === undefined ? [] : [[from, to]];
      }),
    );
  }
  return views;
}

/** A view's span widened to hold each escape it starts or ends inside, mapped to the input: a cut never splits an
 *  escape, so a cut JSON string stays one. */
export function inputSpan(view: View, start: number, end: number): [number, number] {
  let from = start;
  let to = end;
  for (const [a, b] of view.escapes) {
    if (a >= to) break;
    if (a < from && from < b) from = a;
    if (a < to && to < b) to = b;
  }
  return [view.at(from), view.at(to)];
}

/** `text` decoded `times` times (a cut's text as the view that found it reads it: its shape and its line count). */
export function decodedTimes(text: string, times: number): string {
  let out = text;
  for (let i = 0; i < times; i++) out = decodeOnce(out).out;
  return out;
}

// ---------- shapes

/** Public prefixes a format's shape may name: each a fixed literal of a published format, never read from the value. */
const PREFIXES = ["pypi-AgEIcHlwaS5vcmc", "github_pat_", "-----BEGIN", "AGE-SECRET-KEY-", "dop_v1_", "doo_v1_", "dor_v1_", "sk-ant-", "sk-proj-", "glpat-", "whsec_", "xoxb-", "xoxp-", "xoxa-", "xoxo-", "xoxs-", "xoxr-", "xoxe-", "xapp-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "npm_", "hf_", "sk-", "SG.", "AKIA", "ASIA", "AIza", "eyJ"];

const NOT_DIGIT = /[^0-9]/;
const NOT_HEX = /[^0-9a-f]/i;
const NOT_ALNUM = /[^A-Za-z0-9]/;
const NOT_BASE64 = /[^A-Za-z0-9+/_=-]/;
const classOf = (value: string): string =>
  !NOT_DIGIT.test(value) ? "digits" : !NOT_HEX.test(value) ? "hex" : !NOT_ALNUM.test(value) ? "alnum" : !NOT_BASE64.test(value) ? "base64" : "text";

/** A cut's shape: a dump's line count, a personal rule's class, or a public prefix (else a character class), and the
 *  cut's length in characters. */
export function shapeOf(of: Pick<ScrubRule, "kind" | "shapeClass">, value: string): string {
  if (of.kind === "dump") return `lines:${lineCount(value)}[${value.length}]`;
  if (of.shapeClass) return `${of.shapeClass}[${value.length}]`;
  const prefix = PREFIXES.find((each) => value.startsWith(each) && value.length > each.length);
  return prefix ? `${prefix}…[${value.length}]` : `${classOf(value)}[${value.length}]`;
}

export const lineCount = (value: string): number => value.split("\n").length;

// ---------- placeholders (ruling D): a marker for a value, never one, by its whole shape

/** A value's text in a typed command: inside escaped double quotes (a JSON string's), double or single quotes, or bare
 *  to the next blank, quote or shell operator. Four groups, one defined; the cut is the group alone, the quotes kept. */
const VALUE = String.raw`(?:\\"((?:[^"\\\n]|\\[^"\n]){1,1024})\\"|"([^"\n]{1,1024})"|'([^'\n]{1,1024})'|([^\s'"\x60;&|()<>]{1,1024}))`;

/** The whole-value shapes of a marker: a variable ($VAR, ${VAR}, ${{ expr }}, %VAR%), a <slot>, a {{template}}, YOUR_...
 *  (your-..., your_...), the upper-case markers REPLACE_ME, CHANGEME, CHANGE_ME and TODO, x-runs (xxx, XXXX-XXXX), ***
 *  and a cut already made ([redacted...]). The markers are upper case only: lower-case `changeme` is a weak password
 *  many images ship as their live default, and a literal test password beside a label is cut (GRAY.md item 4,
 *  amendment 2). */
const PLACEHOLDER = new RegExp(
  `^(?:${[
    String.raw`\$[A-Za-z_][A-Za-z0-9_]{0,127}`,
    String.raw`\$\{[^}\n]{1,256}\}{1,2}`,
    String.raw`\$\{\{[^\n]{0,256}`,
    String.raw`%[A-Za-z_][A-Za-z0-9_]{0,127}%`,
    String.raw`<[^<>\n]{1,256}>`,
    String.raw`\{\{[^{}\n]{1,256}\}\}`,
    String.raw`(?:YOUR|[Yy]our)[-_][A-Za-z0-9_-]{1,128}`,
    String.raw`REPLACE_ME|CHANGEME|CHANGE_ME|TODO`,
    String.raw`[xX]{3,64}(?:-[xX]{3,64}){0,16}`,
    String.raw`\*{3,64}`,
    String.raw`\[(?:redacted|REDACTED)[^\]\n]{0,128}\]`,
  ].join("|")})$`,
);
/** A value cut short for display: a trailing ... or …, stripped before the rest is judged. */
const ELLIPSIS = /(?:\.\.\.|…)$/;
/** The fewest characters a value shown cut short must keep, a public prefix aside, to still be one: `abc...`,
 *  `sk-proj-...` and `<token>…` are markers; a whole value with an ellipsis after it is still that value. */
const SHOWN_MIN = 8;
/** A type's name where a value would stand: an annotation (`token: string`, `password: str`, `api_key: SecretStr`), a
 *  literal no secret is (null, None, true), or a generic (`Optional[str]`, `Array<string>`). */
const TYPE_WORD = /^(?:string|String|str|int|Int|integer|bool|boolean|Boolean|number|Number|float|double|bytes|any|unknown|object|Object|void|null|NULL|nil|None|undefined|true|false|True|False|required|optional)$/;
const GENERIC = /^[A-Za-z_][A-Za-z0-9_.]{0,63}(?:\[[^\]\n]{1,128}\]|<[^>\n]{1,128}>)$/;
const PASCAL_TYPE = /^(?:[A-Z][a-z]{1,32}){2,8}$/;
/** An all-capitals metavar a help text writes where its flag's value goes (`--token TOKEN`, `--api-key KEY`). */
const METAVAR = /^[A-Z][A-Z0-9_]{0,63}$/;
const NAME_PARTS = /[-_]{1,8}/;
const LEADING_DASHES = /^-{1,2}/;
/** Code where a value would stand (only when bare, never quoted): a call or an index (`getAuthHeader()`,
 *  `os.environ[...]`), a member chain with no digit (`process.env.TOKEN`, `config.secret`), or an identifier in a
 *  code's casing with no digit (`authHeader`, `hf_token`, `GITHUB_TOKEN`). */
const CODE_CALL = /^[A-Za-z_$][\w$]{0,127}(?:\.[A-Za-z_$][\w$]{0,127}){0,16}[([]/;
const IDENT_CHAIN = /^[A-Za-z_$][\w$]{0,127}(?:\.[A-Za-z_$][\w$]{0,127}){0,16}$/;
const MEMBER_CHAIN = /^[A-Za-z_$][A-Za-z_$]{0,127}(?:\.[A-Za-z_$][A-Za-z_$]{0,127}){1,16}$/;
const CODE_CASE = /^[A-Za-z_$]{1,128}$/;
const CAMEL_OR_SNAKE = /[a-z][A-Z]|[A-Za-z]_[A-Za-z]/;
const CALL_AFTER = /^[ \t]{0,3}[([]/;
/** A reference to a value, never one (ruling II): a shell expansion opening it (`$(...)`, `${...}`, `$NAME`, a
 *  backtick; escaped too, `\$NAME`, ruling XXXVIII), a secret manager's address (`op://`, `vault:`, `${{ secrets.X }}`, an AWS Secrets Manager ARN, a GCP
 *  secret's resource name), a template's slot (`{self.password}`, `{password}`) standing whole, or a member chain rooted
 *  at the environment (`process.env.`, `import.meta.env.`, `os.environ[`/`.get(`, `ENV[`, `System.getenv(`, ruling
 *  XLVII), in every slot. */
const REFERENCE = /^(?:\\?\$[({A-Za-z_]|\x60|process\.env\.|import\.meta\.env\.|os\.environ(?:\[|\.get\()|ENV\[|System\.getenv\(|op:\/\/|vault:|arn:aws:secretsmanager:|projects\/[^/\s]{1,128}\/secrets\/|\{[^{}\n]{1,256}\}$)/;
/** A value elided for display anywhere in it (ruling II): a <slot>, a bullet, ***, a cut already made, or an ellipsis
 *  inside it (a trailing one is ELLIPSIS's: the rest is judged). */
const ELIDED = /<[^<>\n]{1,256}>|•|\*\*\*|\[redacted|…(?!$)/i;
/** Punctuation a value's end may carry from the sentence or the syntax around it, stripped before it is judged. */
const TRAILING_PUNCTUATION = /[,;:!?)\]}'"]{1,8}$/;
const SENTENCE_END = /\.$/;
/** A bare value opens with a letter, a digit or `_` (ruling II): `,`, `-`, `(` or `/` after a label is a list, a flag,
 *  a call or a path, never a password; a quoted value is a literal however it opens. In a slot code does not fill
 *  (ruling XII) a value opens with anything but a blank, a quote or `$` (a reference, read before). */
const BARE_START = /^[A-Za-z0-9_]/;
const LITERAL_START = /^[^\s'"$]/;
/** YAML's own nodes where a value would stand (ruling XII): a tag (`!Ref`, `!Sub`, `!vault`, `!!binary`: letters, no
 *  digit), an alias (`*db_pw`), an anchor (`&db_pw`), a block indicator (`|`, `>-`), `~`. */
const YAML_NODE = /^(?:!{1,2}[A-Za-z][A-Za-z_.:/-]{0,63}|[*&][A-Za-z0-9_.-]{1,64}|[|>][+-]?[1-9]?|~)$/;
/** The fewest characters a bare value holds (ruling II): `-p and`, `--api-key and kin` are prose. */
const BARE_MIN = 4;
const EDGE_BLANK = /^\s|\s$/;
/** Blank-edged quoted contents whose first or last blank-separated token is punctuation alone (no letter, digit or `_`):
 *  the quotes are one string's close and the next one's open, an operator between (`" + pw + "`, `" . $pw . "`,
 *  `", pw, "`, `" || pw || "`), no value's bound (ruling LVII). Read on the trimmed contents; an edge token that mixes
 *  punctuation with word characters (`" !Copper8 "`) is a value's. Bounded at 64 (ruling B). */
const EDGE_TOKEN_PUNCT = /^[^\w\s]{1,64}(?:\s|$)|\s[^\w\s]{1,64}$/;
/** The fewest characters quoted contents hold once trimmed (valueHit's least, ruling LVII). */
const INNER_MIN = 3;
/** A value that runs straight into an angle-bracket placeholder (`wk_live_<redacted>`) is a kept prefix, the rest
 *  elided; read in the 8 characters after the value. */
const ELIDED_AFTER = /^<[A-Za-z][\w -]{0,6}(?:>|$)/;

/** Where a value stands, as the placeholder check reads it: its label's name, whether it is bare (no quote before
 *  it), the text right after it, `code: false` for a slot code does not fill and `typed` for one a type annotation fills
 *  (Hit.code, Hit.typed). */
export type Slot = { readonly name?: string; readonly bare?: boolean; readonly after?: string; readonly code?: boolean; readonly typed?: boolean };

/** Whether a label rule's value is a marker for one, never one, by its whole shape (no guess at randomness). The engine
 *  (secret-cut.ts) drops every label rule's hit whose value this holds, so no label rule can skip it. */
/** A name or a value as XIX compares them: lower case, no separator (`SESSION_TOKEN` and "session-token" are one). */
const nameKey = (name: string): string => name.toLowerCase().replace(NAME_KEY_OFF, "");
const NAME_KEY_OFF = /[-_. ]/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,127}$/;
/** A value that ends with, or is followed by, what ends an argument or an entry in code: `,`, `)`, `}`. */
const ENDS_ENTRY = /[,)}]$/;
const ENTRY_END_AFTER = /^[ \t]{0,3}[,)}]/;
/** A type's name in a YAML key's slot, which a Python annotation shares (ruling XVI): PascalCase with a type's suffix, or
 *  a subscript, a union, a default or a call after it. Any other PascalCase word there is a value. */
const TYPE_SUFFIX = /(?:Str|String|Bytes|Int|Float|Bool|Dict|List|Type|Field|Model|Settings|Config|Optional|Any|Token)$/;
const TYPE_AFTER = /^[ \t]{0,3}[[|=(]/;
const typeName = (whole: string, after: string): boolean => PASCAL_TYPE.test(whole) && (TYPE_SUFFIX.test(whole) || TYPE_AFTER.test(after));

export function isPlaceholder(value: string, slot: Slot = {}): boolean {
  // Inside quotes the quotes are the bound (rulings LV, LVII): the inner value is judged without its edge blanks, and a
  // cut takes the whole quoted contents. Only an unquoted value with an edge blank is no value.
  if (slot.bare === false && EDGE_BLANK.test(value)) {
    const inner = value.trim();
    return inner.length < INNER_MIN || EDGE_TOKEN_PUNCT.test(inner) || isPlaceholder(inner, slot);
  }
  if (EDGE_BLANK.test(value)) return true;
  if (REFERENCE.test(value) || ELIDED.test(value) || PLACEHOLDER.test(value)) return true;
  const trimmed = value.replace(TRAILING_PUNCTUATION, "");
  if (trimmed === "" || REFERENCE.test(trimmed)) return true;
  if (ELLIPSIS.test(trimmed)) {
    const rest = trimmed.replace(ELLIPSIS, "");
    if (rest === "" || isPlaceholder(rest, { ...slot, after: "" })) return true;
    const prefix = PREFIXES.find((each) => rest.startsWith(each)) ?? "";
    return rest.length - prefix.length < SHOWN_MIN;
  }
  const whole = trimmed.replace(SENTENCE_END, "");
  if (whole === "" || PLACEHOLDER.test(whole) || TYPE_WORD.test(whole) || GENERIC.test(whole)) return true;
  if (slot.name !== undefined && METAVAR.test(whole)) {
    const parts = slot.name.replace(LEADING_DASHES, "").toUpperCase().split(NAME_PARTS);
    if (parts.includes(whole) || parts.join("_") === whole) return true;
  }
  if (ELIDED_AFTER.test(slot.after ?? "")) return true;
  // In code a value equal to its own name is a name (an enum's member, a constant naming its key; ruling XIX).
  if (slot.code !== false && slot.name !== undefined && nameKey(whole) !== "" && nameKey(whole) === nameKey(slot.name)) return true;
  if (slot.bare === false) return false;
  // The code shapes are no value in code alone (ruling XII): a call's opening after the value makes any slot code's.
  if (slot.code === false && !CALL_AFTER.test(slot.after ?? "")) {
    return !LITERAL_START.test(whole) || whole.length < BARE_MIN || YAML_NODE.test(whole) || (slot.typed === true && typeName(whole, slot.after ?? ""));
  }
  // In code an unquoted identifier that ends an argument, an element or an object's entry is a variable (ruling XXI).
  if (IDENTIFIER.test(whole) && (ENDS_ENTRY.test(value) || ENTRY_END_AFTER.test(slot.after ?? ""))) return true;
  if (!BARE_START.test(whole) || whole.length < BARE_MIN) return true;
  if (PASCAL_TYPE.test(whole) || CODE_CALL.test(whole)) return true;
  if (IDENT_CHAIN.test(whole) && CALL_AFTER.test(slot.after ?? "")) return true;
  return MEMBER_CHAIN.test(whole) || (CODE_CASE.test(whole) && CAMEL_OR_SNAKE.test(whole));
}

/** The defined one of VALUE's four groups at `first`, as a hit, when at least `min` characters long. */
function valueHit(m: RegExpExecArray, first: number, min = 3, name?: string): Hit | undefined {
  for (let group = first; group < first + 4; group++) {
    const value = m[group];
    if (value === undefined) continue;
    if (value.length < min) return undefined;
    const [start, end] = m.indices![group]!;
    return name === undefined ? { start, end } : { start, end, name };
  }
  return undefined;
}

/** Each match of `pattern` (flags g and d) in `text`, mapped to a hit or none. A match mapped to none is read again
 *  from where `resume` says, when it says (a rejected `content : password: x` leaves `password: x`). */
function each(text: string, pattern: RegExp, hit: (m: RegExpExecArray) => Hit | undefined, resume?: (m: RegExpExecArray) => number | undefined): Hit[] {
  const re = new RegExp(pattern.source, pattern.flags.includes("d") ? pattern.flags : `${pattern.flags}d`);
  const out: Hit[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const found = hit(m);
    if (found) out.push(found);
    else {
      const at = resume?.(m);
      if (at !== undefined) re.lastIndex = Math.max(m.index + 1, at);
    }
    if (m[0] === "") re.lastIndex = Math.max(re.lastIndex, m.index + 1);
  }
  return out;
}

/** Every place `form` stands in `text`, overlapping places included. */
function placesOf(text: string, form: string): Hit[] {
  const out: Hit[] = [];
  if (!form) return out;
  for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) out.push({ start: at, end: at + form.length });
  return out;
}

/** The hits `pattern` finds inside each match of `command` (a command line read whole first), mapped to the text. */
function inside(text: string, command: RegExp, pattern: RegExp, hit: (m: RegExpExecArray) => Hit | undefined): Hit[] {
  const out: Hit[] = [];
  for (const m of text.matchAll(command)) {
    for (const found of each(m[0], pattern, hit)) out.push({ ...found, start: m.index + found.start, end: m.index + found.end });
  }
  return out;
}

// ---------- format: learn/secrets.ts SHAPES, the PEM block whole, secretlint

const SHAPE_IDS = new Map([
  ["AWS access key id", "aws-access-key"],
  ["Google API key", "google-api-key"],
  ["private key block", "private-key-block"],
  ["GitHub token", "github-token"],
  ["sk- key", "sk-key"],
  ["Slack token", "slack-token"],
  ["JWT", "jwt"],
  ["webhook signing secret", "webhook-secret"],
  ["URL with a password", "url-password"],
  ["bearer token", "bearer-token"],
  ["URL parameter named like a credential", "url-credential"],
]);
/** The shapes found by what stands beside the value, not by the value itself: a URL's `user:` before its `@`, a
 *  parameter's name, the `Bearer` scheme. Every other shape names its own format (a prefix, a checksum). */
const SHAPE_LABELS: ReadonlySet<string> = new Set(["url-password", "url-credential", "bearer-token"]);
const SLUG_OFF = /[^a-z0-9]{1,64}/g;
const SLUG_ENDS = /^-|-$/g;
const slug = (name: string) => name.toLowerCase().replace(SLUG_OFF, "-").replace(SLUG_ENDS, "");

/** A PEM block's end, and the characters a block holds between its header and its end (base64, its own headers, line
 *  breaks as written or as a JSON string escapes them). */
const PEM_END = /-----END[ A-Z0-9]{0,40}PRIVATE KEY[ A-Z0-9]{0,40}-----/g;
const PEM_OFF = /[^A-Za-z0-9+/=:,. \t\r\n\\-]/g;
const PEM_GAP = 16384;
/** The fewest base64 characters a block's body holds to be a key (ruling V): a BEGIN line alone, or one a few
 *  characters on (a header in code, a string repeated), is none. */
const PEM_BODY_MIN = 64;
const BASE64_CHARS = /[A-Za-z0-9+/=]/g;
/** A block's base64 run when no end is found (a key cut short): base64 words of 16 characters or more (or a padded
 *  last one), blanks or escaped line breaks between, so it stops at the next header and before a line of prose. */
const PEM_TAIL = /(?:(?:[ \t\r\n]|\\[nr]){1,16}(?:[A-Za-z0-9+/]{16,4096}={0,2}|[A-Za-z0-9+/]{1,15}={1,2})){0,1024}/y;

/** `run` without its trailing blanks and escaped line breaks (`\n`, `\r` as a JSON string writes them). */
function trimmedTail(run: string): string {
  let end = run.length;
  for (;;) {
    if (end > 0 && " \t\r\n".includes(run.charAt(end - 1))) end--;
    else if (end > 1 && run.charAt(end - 2) === "\\" && "nr".includes(run.charAt(end - 1))) end -= 2;
    else return run.slice(0, end);
  }
}

/** The private-key headers SHAPES finds, each stretched to its block's end: the next END line, when only a block's
 *  characters stand between; else the base64 run after it. A header inside a block already cut is skipped, so a text
 *  of repeated headers is read once. */
function pemBlocks(text: string, headers: readonly [number, number][], lines: LineBounds): Hit[] {
  const ends = [...text.matchAll(PEM_END)].map((m) => [m.index, m.index + m[0].length] as const);
  const out: Hit[] = [];
  let next = 0;
  let last = -1;
  // The first character no block holds at or after the header's end, kept while headers come before it: each found once.
  let off = -1;
  for (const [start, headerEnd] of headers) {
    if (start < last) continue;
    while (next < ends.length && ends[next]![0] < headerEnd) next++;
    const end = ends[next];
    let stop: number | undefined;
    if (end && end[0] - headerEnd <= PEM_GAP) {
      if (off < headerEnd) {
        PEM_OFF.lastIndex = headerEnd;
        off = PEM_OFF.exec(text)?.index ?? text.length;
      }
      if (off >= end[0]) stop = end[1];
    }
    let body: string;
    if (stop === undefined) {
      PEM_TAIL.lastIndex = headerEnd;
      body = trimmedTail(PEM_TAIL.exec(text)![0]);
      stop = headerEnd + body.length;
    } else body = text.slice(headerEnd, end![0]);
    // Escaped line breaks (`\n` in a JSON string's raw text) are no body.
    if ((body.replaceAll("\\n", "").replaceAll("\\r", "").match(BASE64_CHARS)?.length ?? 0) < PEM_BODY_MIN) {
      // Else a block read line by line (ruling XXV): each line under the BEGIN line's own prefix (a Read tool's
      // `     2→`, `cat -n`, `grep -n`, a diff's `+`), one base64 line at least, to its END or its body's end.
      const lineStop = pemLines(text, start, headerEnd, lines);
      if (lineStop === undefined) continue;
      stop = lineStop;
    }
    out.push({ start, end: stop });
    last = stop;
  }
  return out;
}

/** A body line of a key read line by line: base64 alone, at least 16 characters (a line cut short counts); its last
 *  line may be shorter, when its END line follows (ruling XXXIII). */
const PEM_BODY_LINE = /^[A-Za-z0-9+/=]{16,4096}$/;
const PEM_LAST_LINE = /^[A-Za-z0-9+/]{1,15}={0,2}$/;
const PEM_END_LINE = /^-----END[ A-Z0-9]{0,40}PRIVATE KEY[ A-Z0-9]{0,40}-----/;
/** A line lead's tokens: a run of digits (any line number), a run of blanks (a number's padding narrows as it grows),
 *  grep -n's `:` or `-` (a match line's or a context line's), else the character itself. */
const LEAD_TOKEN = /\d{1,7}|[ \t]{1,256}|[:-]|[^]/gu;
const DIGIT_START = /^\d/;
const leadToken = (token: string): string => (DIGIT_START.test(token) ? "\uE000" : token.trim() === "" ? "\uE001" : token === ":" || token === "-" ? "\uE002" : token);
const leadTokens = (text: string): string[] => [...text.matchAll(LEAD_TOKEN)].map(([token]) => leadToken(token));
const PEM_LEAD_MAX = 128;
/** The longest run of `prefix` (a BEGIN line's text before its header, as tokens) that each of `heads` (the first
 *  two lines after the BEGIN line, or the one there is) opens with, token for token (rulings XXVIII, XLI): a Read
 *  tool's `     1→`, cat -n's, grep -n's `path:41:`, a diff's `-`, or nothing. Its end when the BEGIN line has more
 *  before its lead (a decoded string's field), its start when the BEGIN line has more after it
 *  (`     1→key = """-----BEGIN`), any run of it in general. Two lines must hold it, and it never ends on a token a
 *  body opens with (ruling XLI): a base64 character, or a digit run a base64 character follows. One line's chance
 *  match (a body opening with the prefix's last character, one in 64) would eat a body character. */
function sharedLead(prefix: readonly string[], heads: readonly string[]): readonly string[] {
  const tokens = heads.map((line) => leadTokens(line.slice(0, PEM_LEAD_MAX * 2)).slice(0, prefix.length));
  let best: readonly string[] = [];
  for (let from = 0; from < prefix.length; from++) {
    let k = 0;
    while (from + k < prefix.length && tokens.every((head) => k < head.length && prefix[from + k] === head[k])) k++;
    while (k > best.length && !leadEnds(prefix.slice(from, from + k), heads)) k--;
    if (k > best.length) best = prefix.slice(from, from + k);
  }
  return best;
}
const BASE64_CHAR = /^[A-Za-z0-9+/=]$/;
/** Whether a lead may end where `lead` does on each of `heads` (ruling XLI): not on a base64 character, and on a
 *  digit run only when no base64 character follows it (a separator: `→`, a tab, `:`). */
function leadEnds(lead: readonly string[], heads: readonly string[]): boolean {
  const last = lead[lead.length - 1]!;
  if (last === "\uE000") return heads.every((line) => !BASE64_CHAR.test(line.charAt(leadLength(lead, line) ?? 0)));
  return !BASE64_CHAR.test(last);
}
/** The length of `lead` (tokens) at the start of `line`, or undefined when `line` does not open with it. */
function leadLength(lead: readonly string[], line: string): number | undefined {
  if (lead.length === 0) return 0;
  const re = new RegExp(LEAD_TOKEN.source, "gu");
  for (const token of lead) {
    const at = re.lastIndex;
    const m = re.exec(line);
    if (!m || m.index !== at) return undefined;
    if (leadToken(m[0]) !== token) return undefined;
  }
  return re.lastIndex;
}
/** The end of a key read line by line from its BEGIN line at `start` (rulings XXV, XXVIII), or undefined when no base64
 *  line follows it. A line starts after a line break or where its decoded string starts (`lines`), so a JSON string's
 *  first line has its own lead; the lead is the longest run of the BEGIN line's prefix the next two lines open with, and
 *  every line after opens with it too. Then its PEM headers (Proc-Type, DEK-Info) and a blank after them, base64 lines,
 *  and its END line or the last base64 line (output cut short, `head`). */
function pemLines(text: string, start: number, headerEnd: number, lines: LineBounds): number | undefined {
  const prefix = leadTokens(text.slice(Math.max(lines.start(start), start - PEM_LEAD_MAX), start));
  let eol = lines.end(headerEnd);
  if (text.charAt(eol) !== "\n" || text.slice(headerEnd, eol).trim() !== "") return undefined;
  // The lead holds on the first two lines after the BEGIN line (a body line and the next, or its END), ruling XLI.
  const firstEnd = lines.end(eol + 1);
  const heads = [text.slice(eol + 1, firstEnd)];
  if (text.charAt(firstEnd) === "\n") heads.push(text.slice(firstEnd + 1, lines.end(firstEnd + 1)));
  const lead = sharedLead(prefix, heads);
  let stop: number | undefined;
  let short: number | undefined;
  let headed = false;
  for (let at = eol + 1; at < text.length && at - headerEnd <= PEM_GAP; at = eol + 1) {
    eol = lines.end(at);
    const line = text.slice(at, eol);
    const length = leadLength(lead, line);
    if (length === undefined) break;
    const rest = line.slice(length).trimEnd();
    const endLine = PEM_END_LINE.exec(rest);
    if (endLine) return stop === undefined ? undefined : at + length + endLine[0].length;
    if (short !== undefined) break;
    if (PEM_BODY_LINE.test(rest)) stop = at + length + rest.length;
    else if (stop !== undefined && PEM_LAST_LINE.test(rest)) short = at + length + rest.length;
    else if (stop === undefined && PEM_HEADER_LINE.test(rest)) headed = true;
    else if (!(stop === undefined && headed && rest === "")) break;
    if (text.charAt(eol) !== "\n") break;
  }
  return stop;
}

/** A URL's password as a URL holds one (ruling XXIX), which SHAPES' URL shape (a user first, no `/` in the password)
 *  misses: a scheme, `://`, a user (none: `redis://:pw@`), `:`, then the password to the last `@` before a blank or a
 *  quote that a host follows (a name or a bracketed IPv6 address, then a port, a path, a query or the URL's end). `/`,
 *  `+`, `=` and `@` are a password's characters; a user is never bracketed or braced (`http://[::1]:8080/a@b`, a
 *  template's `{user}:{password}@`). */
const URL_USERINFO = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[A-Za-z0-9._~%!$&*+,;=-]{0,256}:([^\s"'\x60]{1,1024})@(?:[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63}){0,16}|\[[0-9A-Fa-f:.]{2,45}\])(?=[:/?#\s"'\x60),;>\]]|$)/dg;

/** A "password" that is a port (ruling XLII): `\d{1,5}` then a `/`, after a host-shaped "user" (`localhost`, an IPv4
 *  address, a dotted name; a bracketed IPv6 address is never read as a user). A Vite path (`localhost:5173/@vite`), an
 *  npm `pkg@ver` path, docker's `@sha256` and `ws://host:3000/x@v2` put an `@` after a host's port. Digits alone before
 *  the `@` (`root:1234@`), or after a user that names no host (`bob:12/25/1990@`, a dotless compose service's
 *  `api:8080/@vite` too), are a password. */
const PORT_PASSWORD = /^\d{1,5}\//;
const HOST_SHAPED = /^(?:localhost|[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,16})$/i;
/** The URL userinfos URL_USERINFO reads, ports none: each its password's span, and the userinfo it stands in, from after
 *  `://` to the `@` the match accepted. url-password cuts the passwords; the email rule reads no address inside a
 *  userinfo (ruling XLIII). */
function urlUserinfos(text: string): { password: [number, number]; userinfo: [number, number] }[] {
  const out: { password: [number, number]; userinfo: [number, number] }[] = [];
  URL_USERINFO.lastIndex = 0;
  for (let m = URL_USERINFO.exec(text); m; m = URL_USERINFO.exec(text)) {
    const [from, to] = m.indices![1]!;
    const userinfo = text.indexOf("://", m.index) + 3;
    if (PORT_PASSWORD.test(m[1]!) && HOST_SHAPED.test(text.slice(userinfo, from - 1))) continue;
    out.push({ password: [from, to], userinfo: [userinfo, to] });
  }
  return out;
}

/** A URL's password alone, of SHAPES' `://user:password@` match: the user and the host stay. */
function urlPassword(text: string, [start, end]: readonly [number, number]): Hit | undefined {
  // `scheme://[::1]:8443;x@host`: a bracketed IPv6 host, never a user (ruling XXXV).
  if (text.charAt(start + 3) === "[") return undefined;
  const colon = text.indexOf(":", start + 3);
  const from = colon + 1;
  const to = end - 1;
  return to > from ? { start: from, end: to, quoted: true } : undefined;
}

/** secretlint's messages that name a URL with its password (a connection string, basic auth in a URL): url-password
 *  cuts the password alone of each, the user and the host kept. A second reading only: URL_USERINFO is what reads a
 *  password holding `/`, `+` or `@` (secretlint's rules do not, ruling XXIX). Every other message is a format's
 *  (secretlint rule, ruling C). */
const LINT_URLS: ReadonlySet<string> = new Set(["BasicAuth", "MongoDBConnection", "MySQLConnection", "PostgreSQLConnection"]);
/** A URL secretlint names, to its password: scheme, `://`, a user, `:`, the password (to the last `@`), the host. */
const LINT_URL = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^:@/\s]{0,256}:([^\s]{1,1024})@[^@\s]{1,512}$/d;
async function lintUrlPasswords(text: string, ctx: ScrubContext): Promise<Hit[]> {
  const out: Hit[] = [];
  for (const find of await ctx.lint()) {
    if (!LINT_URLS.has(find.id)) continue;
    const m = LINT_URL.exec(find.value);
    if (!m) continue;
    const [from, to] = m.indices![1]!;
    for (const place of placesOf(text, find.value)) out.push({ start: place.start + from, end: place.start + to, name: "url", quoted: true });
  }
  return out;
}

/** The shapes that open with a public prefix, each with the characters of the run (a blob) its prefix could sit inside
 *  (ruling X). A prefix holding `-` or `_` (sk-, ghp_, github_pat_, xoxb-, whsec_) and a JWT can only sit inside a
 *  base64url run, so `/`, `+`, `.`, `:` and `=` stand outside one: a key in a URL's or a file's path is a key. AKIA and
 *  AIza sit inside standard base64 too: `+` is of the run, `/` is a path's separator (s3://bucket/AKIA...), and a run
 *  ends on `=`'s padding. */
const URL_SAFE_RUN = /[A-Za-z0-9_-]/;
const BASE64_RUN_BEFORE = /[A-Za-z0-9+_-]/;
const BASE64_RUN_AFTER = /[A-Za-z0-9+=_-]/;
const URL_SAFE = { before: URL_SAFE_RUN, after: URL_SAFE_RUN };
const BASE64 = { before: BASE64_RUN_BEFORE, after: BASE64_RUN_AFTER };
const RUNS: Readonly<Record<string, { readonly before: RegExp; readonly after: RegExp }>> = {
  "aws-access-key": BASE64,
  "google-api-key": BASE64,
  "github-token": URL_SAFE,
  "sk-key": URL_SAFE,
  "slack-token": URL_SAFE,
  "webhook-secret": URL_SAFE,
  jwt: URL_SAFE,
};
const LETTER_OR_DIGIT = /[A-Za-z0-9]/;
/** An environment variable's name and its separator glued before a key (`SLACK_xoxb-...`): a name, not a blob. */
const ENV_NAME_RUN = /^[A-Z][A-Z0-9]{0,31}(?:_[A-Z0-9]{1,32}){0,8}_$/;
/** How far back a run before a prefix is read: a longer one is a blob's. */
const RUN_LOOKBACK = 256;
/** How far a key's run is read past its shape's match (ruling XI): a longer run fails the scrub closed. Below
 *  SCRUB_OVERLAP, so a chunk's overlap still holds every cut whole. */
export const KEY_RUN_MAX = 65_536;

/** Whether a prefix's match at `start` opens a key (ruling X): the run of its blob's characters right before it is
 *  empty, holds no letter or digit (`"+AKIA...`, `-sk-...`), or is an environment variable's name and its `_`. */
function opensKey(text: string, start: number, before: RegExp): boolean {
  let from = start;
  while (from > 0 && start - from < RUN_LOOKBACK && before.test(text.charAt(from - 1))) from--;
  if (from === start) return true;
  if (start - from >= RUN_LOOKBACK) return false;
  const run = text.slice(from, start);
  return !LETTER_OR_DIGIT.test(run) || ENV_NAME_RUN.test(run);
}

/** A key's end (ruling XI): a match that opens a key runs on through its blob's characters past the shape's own bound,
 *  so a longer run is cut whole, never skipped nor cut short; a run longer than KEY_RUN_MAX from its start throws (fails closed). */
function keyEnd(text: string, start: number, end: number, after: RegExp): number {
  let to = end;
  const limit = Math.min(text.length, start + KEY_RUN_MAX);
  while (to < limit && after.test(text.charAt(to))) to++;
  if (to === start + KEY_RUN_MAX && after.test(text.charAt(to))) throw new Error("scrub: a key's run is past the scan's bound");
  return to;
}

/** A view's text with each escape's letter a level further down blanked too (ruling XXXIII): a JSON string nested past
 *  the views' depth leaves `\\n` before a key, its `\\` blanked and its `n` a letter a shape's own lookbehind and
 *  opensKey would glue onto the key. Same length, so a hit's offsets hold. */
const BACKSLASH_RUN = /\\{2,64}/g;
let nestedMemo: { text: string; source: string; out: string } | undefined;
function nestedBlanked(text: string, source: string | undefined): string {
  if (source === undefined || source.length !== text.length) return text;
  if (nestedMemo?.text === text && nestedMemo.source === source) return nestedMemo.out;
  let out = "";
  let from = 0;
  for (const m of source.matchAll(BACKSLASH_RUN)) {
    const at = m.index + m[0].length;
    const letter = nestedEscape(source, at);
    if (letter === 0 || text.slice(m.index, at).trim() !== "") continue;
    out += text.slice(from, at) + " ".repeat(letter);
    from = at + letter;
  }
  out = from === 0 ? text : out + text.slice(from);
  nestedMemo = { text, source, out };
  return out;
}

const SHAPE_RULES: readonly ScrubRule[] = SHAPES.map(([name, pattern]) => {
  const id = SHAPE_IDS.get(name) ?? slug(name);
  const kind: CutKind = SHAPE_LABELS.has(id) ? "label" : "format";
  if (id === "private-key-block") return rule(id, kind, (text, ctx) => pemBlocks(text, spans(text, pattern), linesOfContext(text, ctx)));
  if (id === "url-password") {
    return rule(id, kind, async (text, ctx) => [
      ...spans(text, pattern).flatMap((span) => urlPassword(text, span) ?? []),
      ...urlUserinfos(text).map(({ password: [start, end] }) => ({ start, end, name: "url", quoted: true })),
      ...(await lintUrlPasswords(text, ctx)),
    ]);
  }
  const quoted = id === "url-credential";
  const run = RUNS[id];
  if (run) {
    return rule(id, kind, (text, ctx) => {
      const read = nestedBlanked(text, ctx?.source);
      return spans(read, pattern).flatMap(([start, end]) => (opensKey(read, start, run.before) ? [{ start, end: keyEnd(read, start, end, run.after) }] : []));
    });
  }
  return rule(id, kind, (text) => spans(text, pattern).map(([start, end]) => ({ start, end, ...(quoted ? { quoted } : {}) })));
});

/** Vendor keys with a public prefix the learning guard's SHAPES do not hold (ruling L), the scrubber's alone: each a
 *  format, bounded like X's prefixes (a prefix holding `_`, `-` or `.` sits only inside a base64url run). Hugging
 *  Face `hf_`, DigitalOcean `dop_v1_`/`doo_v1_`/`dor_v1_` (64 hex), PyPI's `pypi-` macaroon (its fixed
 *  `AgEIcHlwaS5vcmc` header: "pypi.org"), SendGrid `SG.<22>.<43>`. */
const HF_TOKEN = /hf_[A-Za-z0-9]{30,64}/g;
const DIGITALOCEAN_TOKEN = /do[opr]_v1_[a-f0-9]{64}/g;
const PYPI_TOKEN = /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{32,4096}/g;
const SENDGRID_KEY = /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g;
const VENDOR_RULES: readonly ScrubRule[] = (
  [
    ["huggingface-token", HF_TOKEN],
    ["digitalocean-token", DIGITALOCEAN_TOKEN],
    ["pypi-token", PYPI_TOKEN],
    ["sendgrid-key", SENDGRID_KEY],
  ] as const
).map(([id, pattern]) =>
  rule(id, "format", (text, ctx) => {
    const read = nestedBlanked(text, ctx?.source);
    return [...read.matchAll(pattern)].flatMap((m) => (opensKey(read, m.index, URL_SAFE_RUN) ? [{ start: m.index, end: keyEnd(read, m.index, m.index + m[0].length, URL_SAFE_RUN) }] : []));
  }),
);

/** secretlint's recommended rules (secret-cut.ts lintFinds), each key it names found where it stands: kind format all
 *  (ruling C), an AWS secret access key after its name too, so no keep restores one. */
const SECRETLINT = rule("secretlint", "format", async (text, ctx) => (await ctx.lint()).filter((find) => !LINT_URLS.has(find.id)).flatMap((find) => placesOf(text, find.value)));

// ---------- held

/** Held values are read in the view's text before its escapes were blanked: a held value may hold a backslash. */
const HELD = rule("held-value", "held", (_text, ctx) => (ctx.held.length ? heldSpans(ctx.source, ctx.held).map(([start, end]) => ({ start, end })) : []));

// ---------- label

/** The scrubber's own name test (ruling I), apart from secret-name.ts keyShaped (the run environment's cut, which reads
 *  any segment): a name labels a secret when its LAST segment (`_`, `-`, `.` or a camel hump apart, a trailing number
 *  aside) is a credential word, or is KEY after a qualifier that makes it one (`API_KEY`, `SECRET_KEY`; never `cache_key`,
 *  `foreign_key`, `GIT_CONFIG_KEY_0`, `KEY`), or the name is one of PASSWORD_NAMES. So a name about a secret
 *  (`token_type`, `PASSWORD_FILE`, `SECRET_NAME`, `KEY_PREFIX`) is none. */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set(["TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASS", "PAT", "CREDENTIAL", "CREDENTIALS", "DSN", "APIKEY", "PASSPHRASE"]);
const KEY_QUALIFIERS: ReadonlySet<string> = new Set(["API", "SECRET", "ACCESS", "PRIVATE", "AUTH", "SIGNING", "MASTER", "ENCRYPTION"]);
/** Credential words that name a credential only after another segment: `DB_PASS`, `AWS_CREDENTIALS`, `MYSQL_PWD`, `GH_PAT`. */
const QUALIFIED_WORDS: ReadonlySet<string> = new Set(["PASS", "CREDENTIAL", "CREDENTIALS", "PWD", "PAT"]);
/** Names whose value is a password though no segment says so. */
const PASSWORD_NAMES: ReadonlySet<string> = new Set(["PGPASSWORD", "SSHPASS", "REDISCLI_AUTH", "MYSQL_PWD"]);
const CAMEL_HUMP = /([a-z0-9])([A-Z])/g;
const NAME_SEPARATORS = /[-_.]{1,8}/;
const DIGITS_ONLY = /^\d{1,8}$/;
/** `camel`: a camel hump separates segments too (`apiKey`, `clientSecret`), for a quoted value alone: a bare value
 *  after a camel-cased key is a config's reference more often than not (Helm's `existingSecret: app-credentials`). */
const secretName = (name: string, camel = false): boolean => {
  const segments = (camel ? name.replace(CAMEL_HUMP, "$1_$2") : name).toUpperCase().split(NAME_SEPARATORS).filter(Boolean);
  if (PASSWORD_NAMES.has(segments.join("_"))) return true;
  while (segments.length > 1 && DIGITS_ONLY.test(segments.at(-1)!)) segments.pop();
  const last = segments.at(-1) ?? "";
  // Bare PASS (a verdict), CREDENTIALS (fetch's option), PWD (a directory) and PAT (a pattern) need a segment before
  // them (XX, XXII, XXXVII): DB_PASS, GITHUB_PAT.
  if (QUALIFIED_WORDS.has(last)) return segments.length > 1;
  if (CREDENTIAL_WORDS.has(last)) return true;
  return last === "KEY" && segments.length > 1 && KEY_QUALIFIERS.has(segments.at(-2)!);
};
const UPPER_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** A line's lead a tool or a diff puts before what it shows (ruling XXVII): a Read tool's `    12→`, `cat -n`'s
 *  `    12\t`, grep -n's `path:12:` (`path-12-` on a context line) or `12:`, a diff's `+` or `-` (its ` ` is indentation).
 *  One grammar for every rule anchored at a line's start: the config slot, pemLines, a dump's lines. */
const NUMBER_LEAD = String.raw`[ \t]{0,8}\d{1,7}(?:\t|→)|(?=[^\s:=]{0,255}[./])[^\s:=]{1,256}[:-]\d{1,7}[:-]`;
const LINE_LEAD = String.raw`(?:${NUMBER_LEAD}|\d{1,7}:|[+-])`;
const LEAD_AT_START = new RegExp(`^${LINE_LEAD}`);
/** What may stand between a line's start and a config key: a lead, indentation, a YAML list's `- `, an `export `, a
 *  quote. */
const LINE_PREFIX = new RegExp(String.raw`^${LINE_LEAD}?[ \t]{0,32}(?:-[ \t]{1,3}|export[ \t]{1,3})?["']?$`);
/** What may follow a bare value to its line's end: blanks, a comment. */
const LINE_REST = /^[ \t\r]{0,64}(?:[ \t]#[^\n]{0,1024})?$/;
const lineStartAt = (text: string, at: number, lines: LineBounds): boolean => {
  const from = lines.start(at);
  return at - from <= 320 && LINE_PREFIX.test(text.slice(from, at));
};
const lineEndAt = (text: string, at: number, lines: LineBounds): boolean => {
  const to = lines.end(at);
  return to - at <= 1100 && LINE_REST.test(text.slice(at, to));
};

/** Code's evidence for a config-shaped slot (ruling XXVII; without it the slot is config's): a `{` or `(` left open
 *  before the name on its line, a declaration's keyword or `self.`/`this.` before it, an entry's `,` after the value,
 *  or a lower-case name, a spaced `=` and a code expression for its value. */
const CODE_KEYWORD = /(?:^|[\s;{(])(?:const|let|var|def)[ \t][^\n]{0,256}$|(?:self|this)\.$/;
const CODE_EXPRESSION = /^[A-Za-z_$][\w$]{0,127}(?:\.[A-Za-z_$][\w$]{0,127}){1,16}$/;
const OPENERS = /[{(]/g;
const CLOSERS = /[})]/g;
function codeEvidence(before: string, name: string, value: string, spaced: boolean): boolean {
  if (ENDS_ENTRY.test(value)) return true; // ruling XLV: `,`, `)`, `}`
  if ((before.match(OPENERS)?.length ?? 0) > (before.match(CLOSERS)?.length ?? 0)) return true;
  if (CODE_KEYWORD.test(before)) return true;
  return spaced && !UPPER_NAME.test(name) && CODE_EXPRESSION.test(value);
}

/** An INI or TOML section's header, and a line a section holds (a key and its value, a comment, a blank). */
const INI_HEADER = /^[ \t]{0,8}\[[A-Za-z0-9_. :"'-]{1,64}\][ \t\r]{0,8}$/;
const INI_LINE = /^[ \t]{0,8}(?:[;#][^\n]{0,1024}|[A-Za-z0-9_.-]{1,64}[ \t]{0,3}[=:][^\n]{0,1024})?[ \t\r]{0,8}$/;
/** Whether the line starting at `from` sits in an INI section (ruling XXX): above it only a section's lines, up to its
 *  `[section]` header, at most 64 lines up. */
function iniSection(text: string, from: number): boolean {
  let end = from;
  for (let n = 0; n < 64 && end > 0 && from - end <= 16_384; n++) {
    const start = text.lastIndexOf("\n", end - 2) + 1;
    const line = text.slice(start, end - 1).replace(LEAD_AT_START, "");
    if (INI_HEADER.test(line)) return true;
    if (!INI_LINE.test(line)) return false;
    end = start;
  }
  return false;
}

/** npm's registry credentials in an .npmrc: `//registry/:_authToken=`, `:_password=`, `:_auth=`, and a bare `_auth=`
 *  (ruling XXX). The key opens after a blank or a quote, or after a LINE_LEAD at its line's start (ruling LII: a Read
 *  tool's `12→`, grep's `path:12:`, a diff's `+`), as every line-anchored rule reads it. */
const NPMRC_AUTH = new RegExp(String.raw`(?:(?<![^\s"'])|(?<=(?:^|[\r\n"'])${LINE_LEAD}))(?://[^\s/:]{1,253}(?:/[^\s:]{0,256})?/?:)?(_authToken|_password|_auth)=${VALUE}`, "gd");

/** NAME=value, as a shell or .env writes it: a key-shaped name or one of PASSWORD_NAMES. An upper-case name (an
 *  environment variable's) is cut whatever its value; any other (a keyword argument, `token=tok`) when its value is a
 *  quoted literal, or as its line's whole (`.properties`, `my.cnf`, ruling XXX). Never after `?` or `&` (a URL's parameter: url-credential reads those) or `-` (a flag). */
const ASSIGN = new RegExp(String.raw`(?<![A-Za-z0-9_$?&])([A-Za-z_][A-Za-z0-9_]{0,63})=(?!=)${VALUE}`, "gd");
/** name = value, name: value, "name": "value" (TOML, INI, YAML, JSON, an object literal): the name may be quoted and
 *  hold a `-`. A quoted value is cut wherever it stands; a bare one runs to its line's end, and its slot is config's
 *  unless code's evidence stands (ruling XXVII). */
const ASSIGN_SPACED = new RegExp(String.raw`(?<![A-Za-z0-9_$?&])([A-Za-z_][A-Za-z0-9_]{0,63})(?:[ \t]{1,3}=(?!=)[ \t]{0,3}|=[ \t]{1,3})${VALUE}`, "gd");
const ASSIGN_COLON = new RegExp(String.raw`(?<![A-Za-z0-9_$.])(["']?)([A-Za-z_][A-Za-z0-9_-]{0,63})\1[ \t]{0,3}:(?![:=/])[ \t]{0,3}${VALUE}`, "gd");
/** A bare value in code's casing with no digit: a name (`password`, `secret_key`, `apiToken`) or a member chain
 *  (`cfg.apiToken`), an entry's `,`, `)` or `}` after it dropped. Where the left side is code's beyond doubt (ruling
 *  LIII: an environment write, a member write) it is a variable's, never a value; a quoted literal still is one. */
const CODE_END = /[,)}]{1,4}$/;
const codeName = (value: string): boolean => {
  const name = value.replace(CODE_END, "");
  return CODE_CASE.test(name) || MEMBER_CHAIN.test(name);
};
/** An object's member chain right before a name (`self.`, `this.`, `settings.`, `app.config.`): a member write's. */
const MEMBER_OBJECT_BEFORE = /(?:^|[^\w$.])([A-Za-z_$][\w$]{0,127}(?:\.[A-Za-z_$][\w$]{0,127}){0,16}\.)$/;
/** A member write's root that is code's beyond doubt: a language's own (`self.`, `this.`, `cls.`) or the environment's
 *  (`process.env.`, `import.meta.env.`, XLVII/LI). */
const CODE_ROOT_BEFORE = /(?:^|[^\w$.])(?:self|this|cls|process\.env|import\.meta\.env)\.$/;
/** A statement's `;` right after a value, on its line. */
const STATEMENT_END_AFTER = /^[ \t]{0,3};/;
/** Whether the name at `at`, its value ending at `end`, is written as an object's member beyond doubt (rulings LIII,
 *  LIX): after a language's root (`self.`, `this.`, `cls.`) or the environment's always; after any other object only when a `;` ends the
 *  statement. A dotted name alone (`service.DB_PASSWORD=`, `spring.datasource.password=`) is a `.properties` or INI
 *  key's as much as an object's: undecidable, so config's, cut. */
const memberWrite = (text: string, at: number, end: number, lines: LineBounds): boolean => {
  const before = text.slice(Math.max(0, at - 320), at);
  if (CODE_ROOT_BEFORE.test(before)) return true;
  if (!MEMBER_OBJECT_BEFORE.test(before)) return false;
  return STATEMENT_END_AFTER.test(text.slice(end, Math.min(end + 8, lines.end(end))));
};
/** A bare value that is an identifier with `[`, `(` or `.` and a name right after it (the character after the value
 *  included: VALUE stops at a quote or `(`): an index, a call or a member read starts there (`config["password"]`,
 *  `get_secret("db")`, `settings.db.password`), a reference where the left side is code's (ruling LX). */
const REFERENCE_START = /^[A-Za-z_$][\w$]{0,127}(?:[[(]|\.[A-Za-z_$])/;
const referenceStart = (text: string, value: string, end: number): boolean => REFERENCE_START.test(value + text.slice(end, end + 2));
/** A write to the environment under a credential's name (ruling LI, XLVII's write side): `os.environ["X"] = v`,
 *  `ENV["X"]=v`, `process.env.X = v`, `import.meta.env.X = v`. The value is a label's. */
const ENV_ASSIGN = new RegExp(String.raw`(?<![A-Za-z0-9_$.])(?:os\.environ|ENV|process\.env|import\.meta\.env)(?:\[(["'])([A-Za-z_][A-Za-z0-9_]{0,63})\1\]|\.([A-Za-z_][A-Za-z0-9_]{0,63}))[ \t]{0,3}=(?!=)[ \t]{0,3}${VALUE}`, "gd");
const envAssign = (m: RegExpExecArray): Hit | undefined => {
  const name = m[2] ?? m[3]!;
  if (!secretName(name, m[7] === undefined)) return undefined;
  // Ruling LIII: a bare name is a variable's (`os.environ["PGPASSWORD"] = password`). Any other value is the
  // environment's, as NAME=value's is (code: false): the code-shape guesses are read here, never after the value (a
  // JSON string's end and its object's `}` after it read as an entry's end).
  if (m[7] !== undefined && (codeName(m[7]) || referenceStart(m.input, m[7], m.indices![7]![1]))) return undefined; // rulings LIII, LX
  const hit = valueHit(m, 4, 3, name);
  return hit && { ...hit, code: false };
};
/** Whether the `-` before a name at `at` makes it a flag's (`--db-password=`, `-Dkey=`, `cmd -PGPASSWORD=`): it does
 *  unless a line start or a digit stands before the `-` (ruling XL): a diff's `-` line and grep -C's `path-N-` lead
 *  open a line. A line start is `lines`', so a decoded string's start counts where its quote is blanked. */
const flagDash = (text: string, at: number, lines: LineBounds): boolean => {
  if (text.charAt(at - 1) !== "-") return false;
  const dash = at - 1;
  if (lines.start(dash) === dash) return false;
  const before = text.charCodeAt(dash - 1);
  return !(before >= 48 && before <= 57);
};
/** A name's match, unless a flag's `-` stands before it. */
const notFlag = <T>(text: string, lines: LineBounds, read: (m: RegExpExecArray) => T | undefined) => (m: RegExpExecArray): T | undefined =>
  flagDash(text, m.index, lines) ? undefined : read(m);
/** Where a rejected `name: value` is read again: at its value, when a blank or a quote stands before the value (the
 *  value may be the next key: `content : password: x` in a decoded JSON string, or a quoted value that is a line,
 *  `"stdout":"password: x"`, ruling XXXIX), never inside a glued chain (an ARN's `:secret:`). */
const afterBlank = (m: RegExpExecArray): number | undefined => {
  const start = m.indices!.slice(3).find((span) => span !== undefined)?.[0];
  if (start === undefined) return undefined;
  const before = m.input.charAt(start - 1);
  return before === " " || before === "\t" || before === '"' || before === "'" ? start : undefined;
};
/** Whether a bare value sits between escaped quotes (`\"value\"` in a JSON string's raw view, whose escapes are
 *  blanked): it is a quoted value, read as one in the view that decodes the string, never bare. */
const ESCAPED_QUOTE_BEFORE = /\\["']$/;
const ESCAPED_QUOTE_AFTER = /^\\["']/;
const escapeQuoted = (source: string | undefined, m: RegExpExecArray, group: number): boolean => {
  const span = m.indices![group];
  return source !== undefined && span !== undefined && ESCAPED_QUOTE_BEFORE.test(source.slice(Math.max(0, span[0] - 2), span[0])) && ESCAPED_QUOTE_AFTER.test(source.slice(span[1], span[1] + 2));
};

/** A `.properties` key's segments before its last (`spring.datasource.` of `spring.datasource.password=`). */
const DOTTED_KEY_BEFORE = /(?:[A-Za-z0-9_-]{1,64}\.){1,8}$/;
const assign = (text: string, lines: LineBounds, source?: string) => (m: RegExpExecArray): Hit | undefined => {
  const name = m[1]!;
  const bare = m[5] !== undefined && !escapeQuoted(source, m, 5); // group 5: the bare value
  if (!secretName(name, !bare)) return undefined;
  const hit = valueHit(m, 2, 3, name);
  if (!hit) return undefined;
  // A bare value ending with `,`, `)` or `}` ends an argument or an entry: code's evidence (ruling XLV), so the code
  // checks (XIX name==value, XXI identifier, a member chain) read it, the ending stripped.
  const entry = bare && ENDS_ENTRY.test(m[5]!);
  const end = m.indices![5]?.[1] ?? hit.end;
  if (bare && (codeName(m[5]!) || referenceStart(text, m[5]!, end)) && memberWrite(text, m.index, end, lines)) return undefined; // rulings LIII, LIX, LX
  // NAME=value with an upper-case name is the environment's slot, quoted or not (rulings XII, XIX).
  if (UPPER_NAME.test(name)) return entry ? hit : { ...hit, code: false };
  if (!bare) return hit;
  // A lower-case name=value is a config's line (.properties, my.cnf) when it is its line's whole (ruling XXX); else
  // it is a keyword argument's, never cut bare.
  const key = m.index - (DOTTED_KEY_BEFORE.exec(text.slice(Math.max(0, m.index - 320), m.index))?.[0].length ?? 0);
  if (CODE_KEYWORD.test(text.slice(key, m.index))) return undefined; // `self.token=token`: an attribute's, code's
  if (!keyStartAt(text, key, m.index, lines) || !lineEndAt(text, hit.end, lines)) return undefined;
  return entry ? hit : { ...hit, code: false };
};
/** Whether a dotted key in [key, name) starts its line. The key's grammar takes a `-` (`max-pool-size`), so a grep -C
 *  lead (`app.yml-41-`) reads as its first segments: the line may start at any of the key's `.` or `-` (ruling XL). */
const keyStartAt = (text: string, key: number, name: number, lines: LineBounds): boolean => {
  for (let at = key; at <= name; at++) {
    if (at > key && text.charAt(at - 1) !== "." && text.charAt(at - 1) !== "-") continue;
    if (lineStartAt(text, at, lines)) return true;
  }
  return false;
};
const configAssign = (text: string, nameGroup: number, lines: LineBounds, source?: string) => (m: RegExpExecArray): Hit | undefined => {
  const name = m[nameGroup]!;
  const value = escapeQuoted(source, m, nameGroup + 4) ? undefined : m[nameGroup + 4];
  if (!secretName(name, value === undefined)) return undefined;
  const hit = valueHit(m, nameGroup + 1, 3, name);
  if (!hit || value === undefined) return hit;
  // A bare value is its line's whole value (a flow map, `{password: x}`, is beta 2's backlog: it reads as code's).
  if (!lineEndAt(text, hit.end, lines)) return undefined;
  if (nameGroup === 1 && (codeName(value) || referenceStart(text, value, hit.end)) && memberWrite(text, m.indices![1]![0], hit.end, lines)) return undefined; // rulings LIII, LIX, LX
  // The slot is config's unless code's evidence stands (ruling XXVII: what can't be decided is config's, cut); a
  // section's lines are config's whatever their value's shape (ruling XXX). A YAML key's slot (the name unquoted)
  // is one a type annotation fills too (`typed`, ruling XVI).
  const nameStart = m.indices![nameGroup]![0] - (nameGroup === 2 ? m[1]!.length : 0);
  const from = lines.start(nameStart);
  const before = nameStart - from <= 320 ? text.slice(from, nameStart) : "";
  const spaced = nameGroup === 1;
  const lineFrom = text.lastIndexOf("\n", nameStart - 1) + 1;
  if (codeEvidence(before, name, value, spaced) && !(spaced && lineStartAt(text, nameStart, lines) && !CODE_KEYWORD.test(before) && iniSection(text, lineFrom))) return hit;
  return { ...hit, code: false, ...(nameGroup === 2 && m[1] === "" ? { typed: true } : {}) };
};

const SSHPASS = new RegExp(String.raw`\bsshpass[ \t]{1,3}-p[ \t]{0,3}${VALUE}`, "gd");

/** A mysql-family command to the end of its line or the next shell operator; its `-p<pw>` read inside (no blank after
 *  `-p`: `-p word` prompts for the password and names a database, ruling D). */
const MYSQL_COMMAND = /\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mysqlsh|mariadb|mariadb-dump|mariadb-admin)(?=[ \t])[^\n;|&]{0,1024}/g;
const MYSQL_P = new RegExp(String.raw`(?<=[ \t])-p${VALUE}`, "gd");

/** --password=<pw> or --password <pw>, and the same of --*-password, --passwd, --token, --api-key and kin. */
const PASSWORD_FLAG = new RegExp(String.raw`(?<![A-Za-z0-9-])(--(?:[a-z0-9]{1,20}-){0,3}(?:password|passwd|pass|token|api-key|apikey|auth-token|secret-key|access-key))(?:=|[ \t]{1,3}(?!-))${VALUE}`, "gdi");
/** A registry login (`docker login -p <pw>`), redis-cli's `-a <pw>`: each command read to its line's end, its short
 *  password flag inside. */
const LOGIN_COMMAND = /\b(?:docker|podman|nerdctl|buildah|skopeo)[ \t]{1,3}login\b[^\n;|&]{0,1024}/g;
const LOGIN_P = new RegExp(String.raw`(?<=[ \t])(-p)(?:=|[ \t]{1,3})${VALUE}`, "gd");
const REDIS_COMMAND = /\bredis-cli\b[^\n;|&]{0,1024}/g;
const REDIS_A = new RegExp(String.raw`(?<=[ \t])(-a)[ \t]{1,3}${VALUE}`, "gd");
/** openssl's `-passin pass:<pw>` (and -passout, -pass, -k pass:): the password after `pass:`. */
const OPENSSL_PASS = /(?<![A-Za-z0-9-])(-(?:passin|passout|pass|k))[ \t]{1,3}(["']?)pass:([^\s"']{1,1024})\2/dg;
/** A .netrc line: `machine <host>` (or `default`), maybe `login`/`account`, then `password <pw>`. */
const NETRC = /(?:\bmachine[ \t]{1,3}[^\s]{1,256}|\bdefault)(?:[ \t]{1,3}(?:login|account)[ \t]{1,3}[^\s]{1,256}){0,2}[ \t]{1,3}(password)[ \t]{1,3}([^\s]{1,1024})/dg;
/** A flag's value: a slot code does not fill (ruling XII). */
const flagValue = (hit: Hit | undefined): Hit | undefined => (hit ? { ...hit, code: false } : undefined);
function passwordFlags(text: string): Hit[] {
  return [
    ...each(text, PASSWORD_FLAG, (m) => flagValue(valueHit(m, 2, 3, m[1]))),
    ...inside(text, LOGIN_COMMAND, LOGIN_P, (m) => flagValue(valueHit(m, 2, 1, m[1]))),
    ...inside(text, REDIS_COMMAND, REDIS_A, (m) => flagValue(valueHit(m, 2, 1, m[1]))),
    ...each(text, OPENSSL_PASS, (m) => ({ start: m.indices![3]![0], end: m.indices![3]![1], name: m[1]!, quoted: true })),
    ...each(text, NETRC, (m) => ({ start: m.indices![2]![0], end: m.indices![2]![1], name: m[1]!, quoted: true })),
  ];
}

/** The schemes a credential header names before its credential: a scheme alone (`Authorization: Bearer` and nothing
 *  after it) is a header named, no value. */
const SCHEMES = String.raw`(?:Bearer|Basic|Token|Bot|ApiKey|Digest|Negotiate|NTLM|AWS4-HMAC-SHA256)`;
/** A credential header's value (curl -H, a request dump, a JSON headers object): the scheme kept, the credential cut.
 *  The value is the scheme's credential, or with no scheme a token's characters (ruling D): never a type annotation,
 *  a call, a word of prose. */
const AUTH_HEADER = new RegExp(
  String.raw`(?<![A-Za-z0-9-])((?:Proxy-)?Authorization|X-Api-Key|Api-Key|X-Auth-[A-Za-z0-9-]{1,32}|X-Access-Token|Private-Token|X-Goog-Api-Key)(["']?)[ \t]{0,3}:[ \t]{0,3}(["'\x60]?)(?:(${SCHEMES})[ \t]{1,3})?(?!${SCHEMES}(?![^\s"'\x60\\,]))([A-Za-z0-9._~+/=:-][^\s"'\x60\\,;(){}<>[\]]{0,4095})`,
  "gdi",
);
const TOKEN_RUN = /^[A-Za-z0-9._~+/=:-]{8,4096}$/;
/** What before a header's name makes it a code object's key or a call's argument (ruling III): `{`, `,` or `(`, an
 *  opening quote maybe between. */
const CODE_KEY_BEFORE = /[{,(][ \t]{0,4}["']?$/;
/** Whether a header name stands as a code key (quoted and followed by its colon, `"Authorization":`, or after `{`, `,`,
 *  `(`) with no string literal after it: then its value is an expression, never cut (ruling III). */
const codeKeyWithoutLiteral = (text: string, m: RegExpExecArray, nameQuote: string, valueQuote: string): boolean =>
  !valueQuote && (nameQuote !== "" || CODE_KEY_BEFORE.test(text.slice(Math.max(0, m.index - 8), m.index)));
const authHeader = (text: string) => (m: RegExpExecArray): Hit | undefined => {
  const value = m[5]!;
  if (codeKeyWithoutLiteral(text, m, m[2]!, m[3]!)) return undefined;
  if (m[4] !== undefined ? value.length < 4 : !TOKEN_RUN.test(value)) return undefined;
  const [start, end] = m.indices![5]!;
  return { start, end, name: m[1]! };
};
/** A Cookie or Set-Cookie header's value whole (its name=value pairs, a Set-Cookie's attributes), to the quote or the
 *  line's end: it needs a `=` to be one. */
const COOKIE_HEADER = /(?<![A-Za-z0-9-])((?:Set-)?Cookie)(["']?)[ \t]{0,3}:[ \t]{0,3}(["']?)([^\r\n"'\x60\\]{8,4096})/dgi;
const COOKIE_PAIR = /[A-Za-z0-9_.-]=[^\s;]/;
/** A Set-Cookie's attributes: no cookie's value. */
const COOKIE_ATTRIBUTES: ReadonlySet<string> = new Set(["path", "domain", "expires", "max-age", "samesite", "secure", "httponly", "priority", "partitioned"]);
const COOKIE_SPLIT = /;[ \t]{0,8}/;
/** Whether every cookie's value in a header is an expansion or a placeholder (`sid=$SID; csrf=${CSRF}`; ruling XXIII). */
const cookiesUnset = (value: string): boolean =>
  value
    .split(COOKIE_SPLIT)
    .map((pair) => [pair.slice(0, pair.indexOf("=")).trim().toLowerCase(), pair.slice(pair.indexOf("=") + 1)] as const)
    .filter(([name]) => name !== "" && !COOKIE_ATTRIBUTES.has(name))
    .every(([, each]) => isPlaceholder(each.trim(), { bare: false }));
const cookieHeader = (text: string) => (m: RegExpExecArray): Hit | undefined => {
  const value = m[4]!.trimEnd();
  if (codeKeyWithoutLiteral(text, m, m[2]!, m[3]!)) return undefined;
  if (value.length < 8 || !COOKIE_PAIR.test(value) || cookiesUnset(value)) return undefined;
  const start = m.indices![4]![0];
  return { start, end: start + value.length, name: m[1]! };
};

/** A curl command, its continuation lines included, to the shell's end of it (`;`, `|`, `&&`, `||`, `$(`, a backtick,
 *  a line's end; ruling XXIV); its `-u user:pass` / `--user user:pass` password read inside. */
const CURL_COMMAND = /\bcurl\b(?:[^\n\\;|&$\x60]|\\[^\n]|\\\r?\n|&(?!&)|\$(?!\()){0,4096}/g;
const CURL_USER = /(?<=\s)(?:-u[ \t]{0,3}|--user(?:=|[ \t]{1,3}))(?:(["'])[^\s:"']{0,256}:([^"'\n]{1,512})\1|[^\s:"']{0,256}:([^\s"']{1,512}))/gd;
const curlUser = (m: RegExpExecArray): Hit => {
  const [start, end] = m.indices![m[2] !== undefined ? 2 : 3]!;
  return { start, end, name: "user", quoted: true };
};

// ---------- dump

type Line = { readonly start: number; readonly end: number; readonly body: string };

/** A line-numbered read's prefix (cat -n, a Read tool's "  12→", grep -n's `path:12:`: LINE_LEAD's numbered leads,
 *  ruling XXVII; a diff's `+`/`-` is not dropped, a PEM line opens with `-`), dropped before a line's shape is read. A JSON
 *  string's quotes are not of its lines either (a text kept as one JSON string reads `"$ env` on its first line and
 *  `$ ls"` on its last): linesOf leaves the quotes of a text that opens and closes with one out of its lines, so a dump
 *  never takes them. */
const NUMBERED = new RegExp(`^(?:${NUMBER_LEAD})`);
/** A JSON object's field opening a line (`{"stdout":"$ env`: a record decoded whole, its string's escaped line breaks
 *  read as lines): up to the last `":"` of a line that opens with `{`, `[` or `,` (its quotes blanks where a decoded view
 *  blanked its string's delimiters), not of the line's own text. */
const JSON_FIELD_OPEN = /^[ \t]{0,8}[{[,][^\n]{0,4096}[" \t]{1,4}:[" \t]{1,4}/;
let linesCache: { text: string; lines: Line[] } | undefined;
/** `text`'s lines, each with its span (no line break, no quote opening or closing the text) and its body (a numbered
 *  prefix and a CR dropped too). */
function linesOf(text: string): Line[] {
  if (linesCache?.text === text) return linesCache.lines;
  const lines: Line[] = [];
  // A text that opens and closes with a quote is read as one JSON string: its quotes are not of its first and last line.
  const quoted = text.length >= 2 && text.charAt(0) === '"' && text.charAt(text.length - 1) === '"' ? 1 : 0;
  for (let start = 0; start <= text.length; ) {
    const at = text.indexOf("\n", start);
    const stop = at < 0 ? text.length : at;
    let end = stop;
    // A line's span ends at its last character that is not a blank or a CR: a dump never takes the blank a decoded
    // view reads in place of its string's closing quote.
    while (end > start && " \t\r".includes(text.charAt(end - 1))) end--;
    let from = start;
    if (from === 0) from += quoted;
    if (stop === text.length) end = Math.max(from, end - quoted);
    const field = JSON_FIELD_OPEN.exec(text.slice(from, end));
    if (field) from += field[0].length;
    lines.push({ start: from, end: Math.max(from, end), body: text.slice(from, end).replace(NUMBERED, "") });
    start = stop + 1;
  }
  linesCache = { text, lines };
  return lines;
}
const blank = (line: Line) => line.body.trim() === "";
const block = (lines: readonly Line[], from: number, to: number): Hit => ({ start: lines[from]!.start, end: lines[to]!.end });

/** The lines after `at` while `fits` holds, trailing blank lines left out; undefined when none is left. */
function after(lines: readonly Line[], at: number, fits: (body: string) => boolean): Hit | undefined {
  let to = at;
  while (to + 1 < lines.length && fits(lines[to + 1]!.body)) to++;
  while (to > at && blank(lines[to]!)) to--;
  return to > at ? block(lines, at + 1, to) : undefined;
}

/** A shell's prompt opening a line: the next command, where a file's printed contents end. */
const PROMPT_LINE = /^\s{0,8}(?:[$#%❯]|>>?)\s{1,3}\S/;
const notPrompt = (body: string): boolean => !PROMPT_LINE.test(body);
/** A line that is a dump's cut already made: no file's content (ruling VIII: a cut text read again is cut no more). */
const DUMP_MARKER_LINE = /^\s{0,8}\[redacted:[a-z0-9-]{1,64}(?: \d{1,9} lines)?\]\s{0,8}$/;
const notMarker = (body: string): boolean => !DUMP_MARKER_LINE.test(body);

/** A line of env, printenv, set or export -p output: NAME=value, maybe after `declare -x ` or `export `. */
const ENV_LINE = /^(declare -x |export )?([A-Za-z_][A-Za-z0-9_]{0,127})=/;
/** The command that prints one, alone on its line (a prompt before it, a pipe after it). */
const ENV_COMMAND = /^\s{0,8}(?:(?:[$#%>❯]|[A-Za-z]:\\[^>\n]{0,256}>)\s{0,3})?(?:sudo\s{1,3})?(?:env|printenv|set|export\s{1,3}-p|declare\s{1,3}-p?x|compgen\s{1,3}-v)(?:\s{0,3}\|[^\n]{0,200})?\s{0,8}$/;
/** printenv of named variables, or an echo of one key-shaped variable: the lines after it are their values. */
const PRINTENV_NAMES = /^\s{0,8}(?:[$#%>❯]\s{0,3})?(?:sudo\s{1,3})?printenv((?:[ \t]{1,3}[A-Za-z_][A-Za-z0-9_]{0,127}){1,16})\s{0,8}$/;
const ECHO_VARIABLE = /^\s{0,8}(?:[$#%>❯]\s{0,3})?echo[ \t]{1,3}(["']?)\$\{?([A-Za-z_][A-Za-z0-9_]{0,127})\}?\1\s{0,8}$/;
const NAME_RUN = /[A-Za-z_][A-Za-z0-9_]{0,127}/g;
/** Names every login environment has: two among a block of eight lines or more (not `export` lines, which a script
 *  writes) make it a dump with no command before it (ruling G). */
const ENV_NAMES = new Set(["PATH", "HOME", "SHELL", "USER", "PWD", "LANG"]);
const ENV_UNCOMMANDED_LINES = 8;

/** NAME=value lines in a row printed by an env command on the line before (a blank between allowed), any number of
 *  them; eight or more holding two login names; or all `declare -x` lines (export -p's own output, its command's mark).
 *  And the values printenv NAME... or echo $KEY prints, one line a name. */
function envDumps(text: string): Hit[] {
  const lines = linesOf(text);
  const out: Hit[] = [];
  for (let at = 0; at < lines.length; ) {
    const body = lines[at]!.body;
    const named = PRINTENV_NAMES.exec(body);
    const echoed = ECHO_VARIABLE.exec(body);
    if (named || (echoed && secretName(echoed[2]!))) {
      const count = named ? named[1]!.match(NAME_RUN)!.length : 1;
      let to = at;
      while (to + 1 < lines.length && to - at < count && !blank(lines[to + 1]!) && notPrompt(lines[to + 1]!.body) && notMarker(lines[to + 1]!.body)) to++;
      if (to > at) out.push(block(lines, at + 1, to));
      at = to + 1;
      continue;
    }
    if (!ENV_LINE.test(body)) {
      at++;
      continue;
    }
    let to = at;
    while (to + 1 < lines.length && ENV_LINE.test(lines[to + 1]!.body)) to++;
    const shapes = lines.slice(at, to + 1).map((line) => ENV_LINE.exec(line.body)!);
    const before = at > 1 && blank(lines[at - 1]!) ? lines[at - 2] : lines[at - 1];
    const commanded = before !== undefined && ENV_COMMAND.test(before.body);
    const login = to - at + 1 >= ENV_UNCOMMANDED_LINES && new Set(shapes.filter((m) => m[1] !== "export ").map((m) => m[2]!).filter((name) => ENV_NAMES.has(name))).size >= 2;
    const declared = to - at + 1 >= 3 && shapes.every((m) => m[1] === "declare -x ");
    if (commanded || login || declared) out.push(block(lines, at, to));
    at = to + 1;
  }
  return out;
}

/** A command (or a Read tool's line) that prints one file, alone on its line: the path is group 2 (group 1 of the tool). */
const READ_COMMAND = /^\s{0,8}(?:[$#%>❯]\s{0,3})?(?:sudo\s{1,3})?(?:cat|less|more|head|tail|bat|batcat|nl|type|Get-Content|gc)(?:\s{1,3}-{1,2}[A-Za-z0-9=-]{1,24}(?:\s{1,3}\d{1,6})?){0,4}\s{1,3}(["']?)([^\s"']{1,512})\1\s{0,8}$/;
const READ_TOOL = /^\s{0,8}(?:⏺\s{0,2})?Read\(([^()\s]{1,512})\)\s{0,8}$/;
const readPath = (body: string): string | undefined => READ_COMMAND.exec(body)?.[2] ?? READ_TOOL.exec(body)?.[1];
/** The file a command prints whole, when it is one read alone (`cat ~/.pgpass`): its output is that file's content
 *  (ruling LVI). */
export const commandReadPath = (command: string | undefined): string | undefined => (command === undefined ? undefined : readPath(command));

/** envDumps with `command` as the line before the text (ruling LVI): the output of `env`, `printenv NAME` or
 *  `echo $KEY`, given apart from its command, is cut as it is when the command stands in the text. */
function commandDumps(text: string, command: string | undefined): Hit[] {
  if (command === undefined || command.trim() === "") return [];
  const shift = command.length + 1;
  return envDumps(`${command}\n${text}`).filter((hit) => hit.end > shift).map((hit) => ({ ...hit, start: Math.max(hit.start - shift, 0), end: hit.end - shift }));
}

const PATH_SEPARATOR = /[\\/]/;
const ENV_FILE_NAME = /^(?:\.env(?:rc)?|\.env\.[A-Za-z0-9_.-]{1,64}|[A-Za-z0-9_.-]{1,64}\.env)$/;
const ENV_TEMPLATE = /\.(?:example|sample|template|tmpl|dist|defaults?|schema)$/i;
/** A .env file's path: .env, .envrc, .env.<name>, <name>.env; never a template (.env.example, .sample, ...). */
export const envFilePath = (path: string): boolean => {
  const base = path.split(PATH_SEPARATOR).pop() ?? "";
  return ENV_FILE_NAME.test(base) && !ENV_TEMPLATE.test(base);
};
const SSH_FILE = /(?:^|[\\/])\.ssh[\\/][^\\/]{1,512}$/;
/** A path under a .ssh folder. */
export const sshFilePath = (path: string): boolean => SSH_FILE.test(path);
/** A file of credentials, path-anchored like ~/.ssh's: .netrc (_netrc), .pgpass, .git-credentials, .pypirc, a docker
 *  config (~/.docker/config.json), a kubeconfig (~/.kube/config, kubeconfig, *.kubeconfig). */
const CREDENTIAL_FILE = /(?:^|[\\/])(?:[._]netrc|\.pgpass|\.git-credentials|\.pypirc|\.docker[\\/]config\.json|\.kube[\\/]config|[A-Za-z0-9_.-]{0,64}kubeconfig(?:\.ya?ml)?)$/i;
export const credentialFilePath = (path: string): boolean => CREDENTIAL_FILE.test(path);

/** A .env file's line: blank, a comment, or NAME=value (maybe after `export `). */
const ENV_FILE_LINE = /^\s{0,8}(?:#.*|(?:export\s{1,3})?[A-Za-z_][A-Za-z0-9_.-]{0,127}\s{0,3}=.*|)$/;

/** A key line of authorized_keys, known_hosts or a .pub file: up to two fields before (options, host names), the key
 *  type, its base64 (group 1), a comment. */
const KEY_LINE =
  /^(?:\S{1,1024}[ \t]{1,3}){0,2}(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)(?:-cert-v01@openssh\.com)?[ \t]{1,3}(AAAA[A-Za-z0-9+/]{1,16384}={0,3})(?:[ \t].{0,1024})?$/;
const SSH_CONFIG = /^\s{0,8}(?:Host|Match|HostName|User|Port|IdentityFile|IdentitiesOnly|IdentityAgent|ProxyCommand|ProxyJump|ForwardAgent|AddKeysToAgent|UseKeychain|StrictHostKeyChecking|UserKnownHostsFile|GlobalKnownHostsFile|ServerAliveInterval|ServerAliveCountMax|LocalForward|RemoteForward|DynamicForward|Include|PreferredAuthentications|PubkeyAuthentication|PasswordAuthentication|LogLevel|ControlMaster|ControlPath|ControlPersist|Compression|HostKeyAlias|HostKeyAlgorithms|SendEnv|SetEnv|CertificateFile|KexAlgorithms|Ciphers|MACs|ConnectTimeout|RequestTTY|RemoteCommand|CanonicalizeHostname|VisualHostKey|HashKnownHosts|ExitOnForwardFailure|BatchMode|TCPKeepAlive)(?:\s|=)/i;
const COMMENT_LINE = /^\s{0,8}#/;
const PEM_LINE = /^-----(?:BEGIN|END) [A-Z0-9 ]{1,48}-----\s{0,8}$/;
const BASE64_LINE = /^[A-Za-z0-9+/=]{1,128}\s{0,8}$/;
const PEM_HEADER_LINE = /^(?:Proc-Type|DEK-Info|Comment):/;
const sshLine = (body: string): boolean =>
  body.trim() === "" || COMMENT_LINE.test(body) || SSH_CONFIG.test(body) || (body.length <= 20_000 && KEY_LINE.test(body)) || PEM_LINE.test(body) || BASE64_LINE.test(body) || PEM_HEADER_LINE.test(body);

/** The text whole, its trailing blanks left out, when the caller says it is the content of a file `fits` names. */
const wholeText = (text: string, path: string | undefined, fits: (path: string) => boolean): Hit[] => {
  if (path === undefined || !fits(path) || DUMP_MARKER_LINE.test(text)) return [];
  const end = text.trimEnd().length;
  return end > 0 ? [{ start: 0, end }] : [];
};

/** What a read of a file `fits` names printed after it, while each line `line` holds. */
function fileReads(text: string, fits: (path: string) => boolean, line: (body: string) => boolean): Hit[] {
  const lines = linesOf(text);
  const out: Hit[] = [];
  for (let at = 0; at < lines.length; at++) {
    const path = readPath(lines[at]!.body);
    if (path === undefined || !fits(path)) continue;
    const hit = after(lines, at, line);
    if (hit) out.push(hit);
  }
  return out;
}

// ---------- personal

/** A home folder's user (ruling VII): the user segment alone of /home/<user>, /Users/<user> and <drive>:\\Users\\<user>,
 *  for every user (the default cloud user and the CI runner's too), is cut, and a cut writes `<user>` in its place, so
 *  a path keeps its shape (only the user segment changes). /root names no one and is never cut. /home/<user> is cut only with a
 *  further path segment after the user or when it is a home the caller holds (ruling E): an app's route
 *  (`/home/settings`, `navigate("/home/feed")`) names no user. Bare /home and /home/ name no user; the folders every
 *  user shares (macOS's /Users/Shared, Windows' Public and Default) are no one's home. A Claude project's folder name
 *  (`-home-<user>-proj`, `-Users-<user>-proj`) holds a home too: its user is cut when the caller holds that home or the
 *  name stands under `.claude/projects/`. */
const HOME_UNIX = /(?<![A-Za-z0-9._~-])\/(home|Users)\/([^\s/\\"'`:;,()<>[\]{}|*?$&=%]{1,64})(?=[/\\\s"'`:;,()<>[\]{}|]|$)/dg;
const HOME_WINDOWS = /\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([^\s/\\"'`:;,()<>[\]{}|*?$&=%]{1,64})(?=[/\\\s"'`:;,()<>[\]{}|]|$)/dgi;
/** A path segment after a folder: a separator, then a character a segment holds. */
const SEGMENT_AFTER = /^(?:\/|\\\\?)[^\s/\\"'`:;,()<>[\]{}|]/;
const SHARED_HOMES: ReadonlySet<string> = new Set(["Users/Shared", "win/public", "win/default", "win/all users", "win/default user"]);
const TRAILING_SLASHES = /[\\/]{1,64}$/;
/** A home's user, of a home the caller holds: /home/<user>, /Users/<user>, <drive>:\\Users\\<user>. */
const HOME_USER = /^(?:\/(?:home|Users)|[A-Za-z]:[\\/]{1,2}Users)[\\/]{1,2}([^\\/]{1,64})$/;
/** A Claude project's folder name holding a home: `-home-` or `-Users-` opening a path segment, then the rest of it. */
const CLAUDE_SLUG = /(?<![A-Za-z0-9._-])-(home|Users)-([A-Za-z0-9._-]{1,256})/dg;
const CLAUDE_PROJECTS_BEFORE = /\.claude[\\/]{1,2}projects[\\/]{1,2}$/;
const SLUG_OFF_CHARS = /[^A-Za-z0-9-]/g;
const SLUG_USER = /^[A-Za-z0-9._]{1,64}/;
const userHit = (m: RegExpExecArray, group: number): Hit => {
  const [start, end] = m.indices![group]!;
  return { start, end };
};
const homeUnix = (text: string, homes: ReadonlySet<string>) => (m: RegExpExecArray): Hit | undefined => {
  if (SHARED_HOMES.has(`${m[1]}/${m[2]}`)) return undefined;
  const end = m.index + m[0].length;
  if (m[1] !== "Users" && !SEGMENT_AFTER.test(text.slice(end, end + 3)) && !homes.has(m[0])) return undefined;
  return userHit(m, 2);
};
const homeWindows = (m: RegExpExecArray): Hit | undefined => (SHARED_HOMES.has(`win/${m[1]!.toLowerCase()}`) ? undefined : userHit(m, 1));
const claudeSlug = (text: string, users: readonly string[]) => (m: RegExpExecArray): Hit | undefined => {
  const rest = m[2]!;
  let user = users.find((each) => rest === each || rest.startsWith(`${each}-`));
  if (user === undefined && CLAUDE_PROJECTS_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index))) user = SLUG_USER.exec(rest)?.[0];
  if (!user) return undefined;
  const start = m.indices![2]![0];
  return { start, end: start + user.length };
};
const homeFolders = (text: string, ctx: ScrubContext): Hit[] => {
  const homes = new Set(ctx.homes.map((home) => home.replace(TRAILING_SLASHES, "")));
  // Each held home's user as a Claude project's folder name writes it (every character but a letter, a digit or `-` a
  // `-`), the longest first.
  const users = [...homes].flatMap((home) => HOME_USER.exec(home)?.[1] ?? []).map((user) => user.replace(SLUG_OFF_CHARS, "-")).sort((a, b) => b.length - a.length);
  return [...each(text, HOME_UNIX, homeUnix(text, homes)), ...each(text, HOME_WINDOWS, homeWindows), ...each(text, CLAUDE_SLUG, claudeSlug(text, users))];
};

/** An address: a local part, then one to eight labels and a letter TLD. */
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}([A-Za-z]{2,24}))(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g;
/** TLDs that are a file's extension in practice (logo@2x.png, a scoped import's file). */
const FILE_TLDS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "jsx", "css", "scss", "less", "json", "md", "mdx", "txt", "py", "rb", "go", "rs", "html", "htm", "xml", "yml", "yaml", "toml", "lock", "map", "wasm", "zip", "gz", "tgz", "tar", "pdf", "mp4", "mov", "mp3", "wav", "sh", "ps1", "exe", "dll", "so", "java", "kt", "swift", "vue", "svelte"]);
/** The names reserved for examples and tests (RFC 2606, RFC 6761) alone: .local and .internal are names people's own
 *  machines and companies use (item 1). */
const RESERVED_TLDS = new Set(["example", "test", "invalid", "localhost"]);
const EXAMPLE_DOMAIN = /(?:^|\.)example\.(?:com|org|net)$/;
const NO_REPLY_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster)$/;
const NO_REPLY_DOMAIN = /(?:^|\.)noreply\./;
const FORGE_NO_REPLY = /^users\.noreply\./;
/** A URL's user with no password (`ssh://deploy@build-01.corp.io`): `://` right before the address. URL_USERINFO reads a
 *  user and a password; a user alone is no address either. */
const USER_ONLY_BEFORE = /:\/\/$/;
/** A commit trailer's line naming a bot identity before the address (ruling VI): `Signed-off-by: lintbot[bot] <...>`. */
const BOT_TRAILER = /(?:^|[\s"'{,])[A-Za-z][A-Za-z-]{1,40}:[ \t][^\n]{0,512}\[bot\]/;
/** A local part's grammar (ruling XVII): it starts and ends with a letter or a digit (`+@router.post`, `4021-@pytest`,
 *  `%@domain` are none). Leading punctuation is dropped before it is read, so `<-jane@...` still finds jane. */
const LOCAL_LEAD = /^[._%+-]{1,64}/;
const LOCAL_END = /[A-Za-z0-9]$/;
/** systemd unit types: `getty@tty1.service`, `user@1001.service` name a unit's instance, not an address. */
const UNIT_TYPES: ReadonlySet<string> = new Set(["service", "socket", "timer", "target", "mount", "path", "slice", "device", "scope"]);
/** The letter of an escape one level down that a blanked `\\` leaves right before an address (`\\tgit@` read raw: the
 *  `t` is the escape's): its length, 0 when none (ruling XVIII). */
const NESTED_ESCAPE = /^(?:[bfnrt/]|u[0-9A-Fa-f]{4})/;
function nestedEscape(source: string, at: number): number {
  let run = 0;
  while (run < 64 && at - run - 1 >= 0 && source.charCodeAt(at - run - 1) === 92) run++;
  if (run < 2 || run % 2) return 0;
  return NESTED_ESCAPE.exec(source.slice(at, at + 5))?.[0].length ?? 0;
}
/** The address rule: `userinfos` (from urlUserinfos, sorted) are the URL userinfos url-password reads; an address that
 *  starts inside one is a user's or a password's tail (ruling XLIII), and is none. */
const email = (text: string, source: string, userinfos: readonly { userinfo: [number, number] }[]) => {
  const froms = userinfos.map(({ userinfo }) => userinfo[0]);
  return (m: RegExpExecArray): Hit | undefined => emailAt(text, source, m, froms, userinfos);
};
function emailAt(text: string, source: string, m: RegExpExecArray, froms: readonly number[], userinfos: readonly { userinfo: [number, number] }[]): Hit | undefined {
  const skip = nestedEscape(source, m.index);
  const raw = m[1]!.slice(skip);
  const lead = LOCAL_LEAD.exec(raw)?.[0].length ?? 0;
  const local = raw.slice(lead).toLowerCase();
  const domain = m[2]!.toLowerCase();
  const tld = m[3]!.toLowerCase();
  if (local === "" || !LOCAL_END.test(local)) return undefined;
  // A domain a `(` follows is a call's callee (`@pytest.mark.parametrize(`); a unit type's TLD names a systemd unit.
  if (text.charAt(m.index + m[0].length) === "(" || UNIT_TYPES.has(tld)) return undefined;
  if (local === "git" || local === "hg") return undefined; // an SSH remote's user (git@github.com:org/repo)
  if (NO_REPLY_LOCAL.test(local)) return undefined;
  // A forge's no-reply address for a person (`12345+login@users.noreply.github.com`) names that person's account, so it
  // is personal (amendment 2); a bot's (`...+dependabot[bot]@...`) holds a bracket no address here reads, and stays.
  // Every other no-reply domain is a service's own.
  if (NO_REPLY_DOMAIN.test(domain) && !FORGE_NO_REPLY.test(domain)) return undefined;
  if (FILE_TLDS.has(tld) || RESERVED_TLDS.has(tld) || EXAMPLE_DOMAIN.test(domain)) return undefined;
  const inside = placeBefore(froms, m.index + 1);
  if (inside >= 0 && m.index < userinfos[inside]!.userinfo[1]) return undefined;
  if (USER_ONLY_BEFORE.test(text.slice(Math.max(0, m.index - 3), m.index))) return undefined;
  // The line before the address (its last 600 characters): a bot's trailer keeps its address.
  const before = text.slice(Math.max(0, m.index - 600), m.index);
  if (BOT_TRAILER.test(before.slice(before.lastIndexOf("\n") + 1))) return undefined;
  return { start: m.index + skip + lead, end: m.index + m[0].length };
}

const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\w|\.\d)/g;
/** What before an address makes it a version: v, version, release, a pin's operator. */
const VERSION_BEFORE = /(?:\bv|\bversion|\bver|\brelease|\brev|@|==|>=|<=|~=|\^|~)\s{0,2}[:=]?\s{0,2}$/i;
const PRE_RELEASE_AFTER = /^-(?:alpha|beta|rc|dev|pre|snapshot)/i;
const BUILD_AFTER = /^\+[0-9A-Za-z]/;
const RANGE_AFTER = /^\/\d/;
const privateV4 = (a: number, b: number) => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
function ipv4(text: string, m: RegExpExecArray): Hit | undefined {
  const octets = [1, 2, 3, 4].map((group) => Number(m[group]));
  if (octets.some((octet) => octet > 255) || !privateV4(octets[0]!, octets[1]!)) return undefined;
  const end = m.index + m[0].length;
  if (VERSION_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index))) return undefined;
  const rest = text.slice(end, end + 12);
  if (PRE_RELEASE_AFTER.test(rest) || BUILD_AFTER.test(rest)) return undefined;
  if (octets[3] === 0 && RANGE_AFTER.test(rest)) return undefined; // a range (10.0.0.0/8), no host
  return { start: m.index, end };
}

/** fc00::/7 (unique local) and fe80::/10 (link local), a zone after it allowed. */
const IPV6 = /(?<![0-9A-Fa-f:.])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]{1,39}(?:%[A-Za-z0-9._-]{1,16})?(?![0-9a-f:])/gi;
const IPV6_GROUPS = /::?/;
function ipv6(text: string, m: RegExpExecArray): Hit | undefined {
  const address = m[0].split("%")[0]!;
  const doubles = address.split("::").length - 1;
  const groups = address.split(IPV6_GROUPS).filter(Boolean);
  if (doubles > 1 || groups.length > 8 || groups.some((group) => group.length > 4)) return undefined;
  if (doubles === 0 && groups.length !== 8) return undefined;
  if (address.endsWith(":") && !address.endsWith("::")) return undefined;
  const end = m.index + m[0].length;
  if (address.endsWith("::") && text.charAt(end) === "/") return undefined; // a range (fe80::/10)
  return { start: m.index, end };
}

// ---------- the table

export const SCRUB_RULES: readonly ScrubRule[] = Object.freeze([
  ...SHAPE_RULES,
  ...VENDOR_RULES,
  SECRETLINT,
  HELD,
  rule("env-dump", "dump", (text, ctx) => [...envDumps(text), ...commandDumps(text, ctx.command)]),
  rule("env-file", "dump", (text, ctx) => [...wholeText(text, ctx.path, envFilePath), ...fileReads(text, envFilePath, (body) => ENV_FILE_LINE.test(body))]),
  rule("credential-file", "dump", (text, ctx) => [...wholeText(text, ctx.path, credentialFilePath), ...fileReads(text, credentialFilePath, (body) => notPrompt(body) && notMarker(body))]),
  // A key file read (authorized_keys, known_hosts, a key) or a config read is a dump; key lines printed with no read
  // naming their file (ssh-keyscan's public host keys) are not cut (ruling G).
  rule("ssh-file", "dump", (text, ctx) => [...wholeText(text, ctx.path, sshFilePath), ...fileReads(text, sshFilePath, sshLine)]),
  rule("sshpass", "label", (text) => each(text, SSHPASS, (m) => flagValue(valueHit(m, 1, 1, "sshpass -p")))),
  rule("mysql-password", "label", (text) => inside(text, MYSQL_COMMAND, MYSQL_P, (m) => flagValue(valueHit(m, 1, 1, "-p")))),
  rule("password-flag", "label", passwordFlags),
  rule("auth-header", "label", (text) => [...each(text, AUTH_HEADER, authHeader(text)), ...each(text, COOKIE_HEADER, cookieHeader(text))]),
  rule("curl-user", "label", (text) => inside(text, CURL_COMMAND, CURL_USER, curlUser)),
  // The generic label comes after the labels a command or a header names, so where both read one value (a header
  // in a string, ruling XXXIX), the cut is named for the narrower label.
  rule("secret-assign", "label", (text, ctx) => {
    const lines = linesOfContext(text, ctx);
    return [
      ...each(text, ASSIGN, notFlag(text, lines, assign(text, lines, ctx?.source))),
      ...each(text, ASSIGN_SPACED, notFlag(text, lines, configAssign(text, 1, lines, ctx?.source))),
      ...each(text, ASSIGN_COLON, notFlag(text, lines, configAssign(text, 2, lines, ctx?.source)), afterBlank),
      ...each(text, ENV_ASSIGN, envAssign),
      ...each(text, NPMRC_AUTH, (m) => {
        const hit = valueHit(m, 2, 3, m[1]!);
        return hit && { ...hit, code: false };
      }),
    ];
  }),
  rule("home-path", "personal", homeFolders, { shapeClass: "home", replacement: "<user>" }),
  rule("email", "personal", (text, ctx) => each(text, EMAIL, email(text, ctx.source, urlUserinfos(text))), { shapeClass: "email" }),
  rule("private-ip", "personal", (text) => [...each(text, IPV4, (m) => ipv4(text, m)), ...each(text, IPV6, (m) => ipv6(text, m))], { shapeClass: "ip" }),
]);

/** Every module-level pattern the rules read, by name: secret-scrub.test.mjs walks each (and learn/secrets.ts SHAPES)
 *  and fails on an unbounded quantifier outside its allowlist, and fails on a module-level pattern missing here. */
export const RULE_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  ESCAPE, CONTROLS, DRIVE_PATH, NOT_DIGIT, NOT_HEX, NOT_ALNUM, NOT_BASE64, PLACEHOLDER, ELLIPSIS, TYPE_WORD, GENERIC, PASCAL_TYPE, METAVAR, NAME_PARTS, LEADING_DASHES,
  CODE_CALL, IDENT_CHAIN, MEMBER_CHAIN, CODE_CASE, CAMEL_OR_SNAKE, CALL_AFTER, LITERAL_START, YAML_NODE, ELIDED_AFTER, REFERENCE, ELIDED, TRAILING_PUNCTUATION, SENTENCE_END, BARE_START, EDGE_BLANK, EDGE_TOKEN_PUNCT, SLUG_OFF, SLUG_ENDS, PEM_END, PEM_OFF, PEM_TAIL, PEM_BODY_LINE, PEM_LAST_LINE, PEM_END_LINE, LEAD_TOKEN, DIGIT_START, BASE64_CHAR, BACKSLASH_RUN, URL_USERINFO, NAME_KEY_OFF, IDENTIFIER, ENDS_ENTRY, ENTRY_END_AFTER, TYPE_SUFFIX, TYPE_AFTER, LOCAL_LEAD, LOCAL_END, NESTED_ESCAPE, COOKIE_SPLIT, LINT_URL, CAMEL_HUMP, NAME_SEPARATORS, DIGITS_ONLY,
  UPPER_NAME, LEAD_AT_START, LINE_PREFIX, LINE_REST, CODE_KEYWORD, CODE_EXPRESSION, OPENERS, CLOSERS, INI_HEADER, INI_LINE, NPMRC_AUTH, ESCAPED_QUOTE_BEFORE, ESCAPED_QUOTE_AFTER, DOTTED_KEY_BEFORE, CODE_END, MEMBER_OBJECT_BEFORE, CODE_ROOT_BEFORE, STATEMENT_END_AFTER, REFERENCE_START, ENV_ASSIGN, HF_TOKEN, DIGITALOCEAN_TOKEN, PYPI_TOKEN, SENDGRID_KEY, ASSIGN, ASSIGN_SPACED, ASSIGN_COLON, SSHPASS, MYSQL_COMMAND, MYSQL_P, PASSWORD_FLAG, LOGIN_COMMAND, LOGIN_P,
  REDIS_COMMAND, REDIS_A, OPENSSL_PASS, NETRC, AUTH_HEADER, TOKEN_RUN, CODE_KEY_BEFORE, URL_SAFE_RUN, BASE64_RUN_BEFORE, BASE64_RUN_AFTER, LETTER_OR_DIGIT, ENV_NAME_RUN, BASE64_CHARS, COOKIE_HEADER, COOKIE_PAIR, CURL_COMMAND, CURL_USER, NUMBERED, JSON_FIELD_OPEN, PROMPT_LINE,
  ENV_LINE, ENV_COMMAND, PRINTENV_NAMES, ECHO_VARIABLE, NAME_RUN, READ_COMMAND, READ_TOOL, PATH_SEPARATOR, ENV_FILE_NAME, ENV_TEMPLATE, SSH_FILE,
  CREDENTIAL_FILE, ENV_FILE_LINE, KEY_LINE, SSH_CONFIG, COMMENT_LINE, PEM_LINE, BASE64_LINE, PEM_HEADER_LINE, HOME_UNIX, HOME_WINDOWS, SEGMENT_AFTER,
  TRAILING_SLASHES, HOME_USER, CLAUDE_SLUG, CLAUDE_PROJECTS_BEFORE, SLUG_OFF_CHARS, SLUG_USER, BOT_TRAILER, DUMP_MARKER_LINE, EMAIL, EXAMPLE_DOMAIN, NO_REPLY_LOCAL, NO_REPLY_DOMAIN, FORGE_NO_REPLY, USER_ONLY_BEFORE, PORT_PASSWORD, HOST_SHAPED, IPV4, VERSION_BEFORE, PRE_RELEASE_AFTER,
  BUILD_AFTER, RANGE_AFTER, IPV6, IPV6_GROUPS,
});
