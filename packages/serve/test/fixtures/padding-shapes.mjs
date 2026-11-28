// The padding shapes of key-refusal-sequence-parity.test.mjs (its head says what they are and what each test holds of
// them), the layouts they are read in, and the check that the read past a call's stop and a run's tail read pass over
// each shape the matcher reads past. That check runs in parts, each its own test file
// (key-refusal-sequence-parity-<k>.test.mjs, the shapes of one opener each), so the parts run at once;
// key-refusal-sequence-parity.test.mjs checks that the matcher reads past more than half of each layout's shapes, and
// that the parts take each shape exactly once.
import assert from "node:assert/strict";
import { redactedAnswer, redactedCall } from "../../dist/key-refusal.js";

export const [HEAD, REST] = [["Wc3M", "hT8q", "Lz5N", "rB1v"].join(""), ["Xe6K", "pJ4d", "Ys9G", "fA2u"].join("")];
export const VALUE = `${HEAD}${REST}`;

const OPENERS = [
  ["ESC [", "\u001b[", (inner) => `0${inner}m`],
  ["U+009B", "\u009b", (inner) => `1${inner}m`],
  ["ESC ]", "\u001b]", (inner) => `0;t${inner}\u0007`],
  ["ESC ] ended by ST", "\u001b]", (inner) => `0;t${inner}\u001b\\`],
  ["U+009D", "\u009d", (inner) => `0;t${inner}\u009c`],
  ["ESC (", "\u001b(", (inner) => `${inner}B`],
];
// The units inside, drawn from the classes the matcher's reader decides by (match.ts passedIn, placeless), each class
// enumerated from Unicode rather than picked by hand: every C0 and C1 control and DEL (passed over, aborting, or an
// opener), every whitespace character (a space takes a cell; a BOM is both whitespace and default-ignorable), the
// first and last of each run of default-ignorable code points (a zero-width space, a word joiner, a BOM, variation
// selectors, tags past U+FFFF among them), spread samples of the combining marks, and characters past ASCII that take a
// cell (one past U+FFFF, U+FFFD, a box or a blank, a Hangul filler), and a parameter, an intermediate and a final out
// of place.
const codePoints = (pattern) => {
  const found = [];
  for (let code = 0; code <= 0x10ffff; code++) if ((code < 0xd800 || code > 0xdfff) && pattern.test(String.fromCodePoint(code))) found.push(code);
  return found;
};
const runEnds = (codes) => codes.filter((code, i) => codes[i - 1] !== code - 1 || codes[i + 1] !== code + 1);
const spread = (codes, count) => Array.from({ length: count }, (_, i) => codes[Math.floor((i * (codes.length - 1)) / (count - 1))]);
const named = (code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
// Each unit once, under the first class it is drawn for (a BOM is whitespace first).
const unique = (inners) => inners.filter(([, inner], i) => inners.findIndex(([, other]) => other === inner) === i);
const INNERS = unique([
  ["nothing", ""],
  ...codePoints(/^\p{Cc}$/u).map((code) => [`${named(code)}, a control`, String.fromCodePoint(code)]),
  ...codePoints(/^\s$/u).filter((code) => !/^\p{Cc}$/u.test(String.fromCodePoint(code))).map((code) => [`${named(code)}, whitespace`, String.fromCodePoint(code)]),
  ...runEnds(codePoints(/^\p{Default_Ignorable_Code_Point}$/u)).map((code) => [`${named(code)}, default-ignorable`, String.fromCodePoint(code)]),
  ...spread(codePoints(/^\p{Mn}$/u), 8).map((code) => [`${named(code)}, a combining mark`, String.fromCodePoint(code)]),
  ...spread(codePoints(/^\p{Me}$/u), 3).map((code) => [`${named(code)}, an enclosing mark`, String.fromCodePoint(code)]),
  ...[0xe9, 0xfffd, 0xfffe, 0xe000, 0x2800, 0x3164, 0x1f600].map((code) => [`${named(code)}, taking a cell`, String.fromCodePoint(code)]),
  ["a colon", ":"],
  ["a quote", '"'],
  ["two quotes then a colon", '"":'],
  ["two quotes then a space", '"" '],
  ["two quotes then a no-break space", '""\u00a0'],
  ["an apostrophe", "'"],
  ["a backslash", "\\"],
  ["a private marker out of place", "?"],
  ["an intermediate then a parameter", " 0"],
]);
// JSON's escapes: each character past printable ASCII, a backslash and a quote as a "\u" escape; as a JSON writer
// writes them (a quote as "\""); and written once more as a JSON string's text (JSON in JSON).
const toUnicode = (text) => [...text].map((char) => (/^[\x20-\x7e]$/.test(char) && char !== '"' && char !== "\\" ? char : char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""))).join("");
const toJson = (text) => toUnicode(text).replaceAll("\\u0022", '\\"').replaceAll("\\u005c", "\\\\");
const toJsonTwice = (text) => toJson(text).replace(/[\\"]/g, (char) => `\\${char}`);
// Python's: "\x" and two hex digits to U+00FF, an apostrophe as "\'", a backslash as "\\", past U+00FF as JSON's
// "\u" (the views read those as JSON's).
const toPython = (text) => [...text].map((char) => (char === "'" ? "\\'" : char === "\\" ? "\\\\" : /^[\x20-\x7e]$/.test(char) ? char : char.length === 1 && char.charCodeAt(0) < 0x100 ? `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}` : toUnicode(char))).join("");
const toEntities = (text) => [...text].map((char) => (/^[\x20-\x7e]$/.test(char) && char !== "&" && char !== '"' && char !== "\\" ? char : `&#x${char.codePointAt(0).toString(16)};`)).join("");
const percent = (text) => Buffer.from(text, "utf8").toString("hex").replace(/../g, (byte) => `%${byte.toUpperCase()}`);

export const ENCODINGS = [
  ["as it stands", (text) => text, "json"],
  ["as JSON's escapes", toJson, "json"],
  ["as JSON's \\u escapes", toUnicode, "json"],
  ["as JSON's escapes twice", toJsonTwice, "json"],
  ["as Python's escapes", toPython, "python"],
  ["as HTML references", toEntities, "json"],
  ["percent-encoded", percent, "json"],
];

const SHAPES = [];
for (const [opener, intro, body] of OPENERS) {
  for (const [what, inner] of INNERS) {
    const sequence = `${intro}${body(inner)}`;
    for (const [how, encode, kind] of ENCODINGS) SHAPES.push([`${opener}, ${what} inside, ${how}`, encode(sequence), kind, inner]);
  }
  // Percent-encoded bytes that are no UTF-8: the percent views decode each to U+FFFD.
  for (const [what, bytes] of [["a lone byte FF", "%FF"], ["a truncated sequence", "%E2%82"], ["a stray continuation byte", "%80"]])
    SHAPES.push([`${opener}, ${what} inside, percent-encoded`, `${percent(intro)}${percent(body("\u0000")).replace("%00", bytes)}`, "json", bytes]);
}

// Each padding once (an encoding that writes a shape as another does adds nothing).
const seen = new Set();
const UNIQUE_SHAPES = SHAPES.filter(([, pad, kind]) => !seen.has(`${kind} ${pad}`) && seen.add(`${kind} ${pad}`));

export const wrapped = (body, kind = "json") => (kind === "python" ? `{'a': '${body}'}` : `{"a": "${body}"}`);
// The padding inside one string, every shape; or each padding the end of a string (a list of strings, as a writer
// writes one: a sequence that ends a string ends right before its closing quote, and an escape at its end reads with
// that quote), each shape with nothing inside it or a unit a string's quoting reads (a quote, an apostrophe, a
// backslash): what follows a sequence there is the string's end, whatever else is inside it.
const QUOTING = new Set(["", '"', "'", "\\"]);
export const LAYOUTS = [
  ["inside one string", UNIQUE_SHAPES, (pad) => pad, (body, kind) => wrapped(body, kind)],
  [
    "each ending a string",
    UNIQUE_SHAPES.filter(([, , , inner]) => [...inner].some((char) => QUOTING.has(char)) || inner === ""),
    (pad, kind) => (kind === "python" ? `${pad}', '` : `${pad}", "`),
    (body, kind) => (kind === "python" ? `['${body}']` : `["${body}"]`),
  ],
];

/** The check's name for a layout, as key-refusal-sequence-parity.test.mjs and its parts name it. */
export const readPastName = (layout) => `every padding shape the matcher reads past whole, ${layout}, is read past by the read after a call's stop and by a run's tail read`;

/** The check's name for part `k` of a layout, its opener named. */
export const readPastPartName = (layout, k) => `${readPastName(layout)} (part ${k} of ${READ_PAST_PARTS.length}: ${READ_PAST_PARTS[k - 1]})`;

/** The parts the check runs in: part k (key-refusal-sequence-parity-<k>.test.mjs) takes the shapes of the k-th opener. */
export const READ_PAST_PARTS = OPENERS.map(([opener]) => opener);
/** The part of a shape, by its name's opener ("ESC ]" and "ESC ] ended by ST" are told apart by the comma after). */
export const partOf = (name) => READ_PAST_PARTS.findIndex((opener) => name.startsWith(`${opener}, `)) + 1;

/** The matcher's reading of a shape in a layout: a short text, the padding three times between the value's halves. True
 *  where the matcher withholds it, so it reads the padding past. */
export const matcherReadsPast = (pad, kind, piece, text) => !redactedAnswer(text(`see ${HEAD}${piece(pad, kind).repeat(3)} ${REST} more`, kind), [VALUE]).includes(REST);

/** The check over part `k`'s shapes in `layout`: each the matcher reads past is read past by the read after a call's stop
 *  and by a run's tail read, its padding repeated past what the read takes. */
export function readPastPart(layout, k) {
  const [, shapes, piece, text] = LAYOUTS.find(([name]) => name === layout);
  const under = [];
  for (const [name, pad, kind] of shapes) {
    if (partOf(name) !== k) continue;
    // The matcher's reading: a short text, the padding three times between the value's halves.
    if (!matcherReadsPast(pad, kind, piece, text)) continue;
    const long = piece(pad, kind).repeat(300);
    let body = "";
    while (body.length < 8192 - 100) body += "word ";
    if (redactedCall(text(`${body}see ${HEAD} ${long}${REST} more`, kind), [VALUE], 200) !== "[redacted]") under.push(`kr-9 ${name}`);
    const tail = text(`${"a".repeat(9000)}${HEAD}${long} ${REST} more`, kind);
    if (redactedCall(tail, [VALUE], 100_000).includes(REST)) under.push(`kr-10 call ${name}`);
    if (redactedAnswer(tail, [VALUE]).includes(REST)) under.push(`kr-10 answer ${name}`);
  }
  assert.deepEqual(under, []);
}
