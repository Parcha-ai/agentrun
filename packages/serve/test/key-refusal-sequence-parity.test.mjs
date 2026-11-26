// key-refusal's read past a call's stop (and the tail of a run too long to read) counts what the matcher's views show.
// It may count less than they show (it reads further), never more: a terminal sequence the matcher's screen reading
// hides whole must count as nothing there too, or padding of it pushes a held value's rest out of the read and its
// head shows. The two share the sequence rules (match.ts sequenceAt) but not the decoding: the views decode one layer
// each, key-refusal decodes the units itself, so this test reads each shape through every decoding. Each padding shape
// below is a terminal sequence (each opener, with a unit of each class below inside), written as it stands, as JSON's
// \u escapes, as Python's \x escapes in a single-quoted dict, as HTML character references, or percent-encoded as
// UTF-8 (and with bytes that are no UTF-8). Where the matcher withholds a short text with the padding between a held
// value's halves, the same padding repeated past what the read takes must withhold it too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactedAnswer, redactedCall } from "../dist/key-refusal.js";

const [HEAD, REST] = [["Wc3M", "hT8q", "Lz5N", "rB1v"].join(""), ["Xe6K", "pJ4d", "Ys9G", "fA2u"].join("")];
const VALUE = `${HEAD}${REST}`;

const OPENERS = [
  ["ESC [", "\u001b[", (inner) => `0${inner}m`],
  ["U+009B", "\u009b", (inner) => `1${inner}m`],
  ["ESC ]", "\u001b]", (inner) => `0;t${inner}\u0007`],
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
  ["a private marker out of place", "?"],
  ["an intermediate then a parameter", " 0"],
]);
const toJson = (text) => [...text].map((char) => (/^[\x20-\x7e]$/.test(char) && char !== '"' && char !== "\\" ? char : char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""))).join("");
const toPython = (text) => [...text].map((char) => (/^[\x20-\x7e]$/.test(char) && char !== "'" && char !== "\\" ? char : char.length === 1 && char.charCodeAt(0) < 0x100 ? `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}` : toJson(char))).join("");
const toEntities = (text) => [...text].map((char) => (/^[\x20-\x7e]$/.test(char) && char !== "&" && char !== '"' && char !== "\\" ? char : `&#x${char.codePointAt(0).toString(16)};`)).join("");
const percent = (text) => Buffer.from(text, "utf8").toString("hex").replace(/../g, (byte) => `%${byte.toUpperCase()}`);

const SHAPES = [];
for (const [opener, intro, body] of OPENERS) {
  for (const [what, inner] of INNERS) {
    const sequence = `${intro}${body(inner)}`;
    SHAPES.push([`${opener}, ${what} inside, as it stands`, sequence, "json"]);
    SHAPES.push([`${opener}, ${what} inside, as JSON's escapes`, toJson(sequence), "json"]);
    SHAPES.push([`${opener}, ${what} inside, as Python's escapes`, toPython(sequence), "python"]);
    SHAPES.push([`${opener}, ${what} inside, as HTML references`, toEntities(sequence), "json"]);
    SHAPES.push([`${opener}, ${what} inside, percent-encoded`, percent(sequence), "json"]);
  }
  // Percent-encoded bytes that are no UTF-8: the percent views decode each to U+FFFD.
  for (const [what, bytes] of [["a lone byte FF", "%FF"], ["a truncated sequence", "%E2%82"], ["a stray continuation byte", "%80"]])
    SHAPES.push([`${opener}, ${what} inside, percent-encoded`, `${percent(intro)}${percent(body("\u0000")).replace("%00", bytes)}`, "json"]);
}

const wrapped = (body, kind = "json") => (kind === "python" ? `{'a': '${body}'}` : `{"a": "${body}"}`);

test("every padding shape the matcher reads past whole is read past by the read after a call's stop and by a run's tail read", () => {
  const under = [];
  let checked = 0;
  for (const [name, pad, kind] of SHAPES) {
    // The matcher's reading: a short text, the padding three times between the value's halves.
    const short = wrapped(`see ${HEAD}${pad.repeat(3)} ${REST} more`, kind);
    if (redactedAnswer(short, [VALUE]).includes(REST)) continue;
    checked++;
    const long = pad.repeat(300);
    let body = "";
    while (body.length < 8192 - 100) body += "word ";
    if (redactedCall(wrapped(`${body}see ${HEAD} ${long}${REST} more`, kind), [VALUE], 200) !== "[redacted]") under.push(`kr-9 ${name}`);
    const tail = wrapped(`${"a".repeat(9000)}${HEAD}${long} ${REST} more`, kind);
    if (redactedCall(tail, [VALUE], 100_000).includes(REST)) under.push(`kr-10 call ${name}`);
    if (redactedAnswer(tail, [VALUE]).includes(REST)) under.push(`kr-10 answer ${name}`);
  }
  assert.ok(checked > SHAPES.length / 2, `the matcher read past ${checked} of ${SHAPES.length} shapes`);
  assert.deepEqual(under, []);
});

test("kr-10 (percent-encoded CSI colours with U+FFFD inside): a held value whose head ends a run too long to read, the padding after it, and whose rest follows is withheld", () => {
  const text = wrapped(`${"a".repeat(9000)}${HEAD}${"%1B%5B0%EF%BF%BDm".repeat(300)} ${REST} more`);
  for (const out of [redactedCall(text, [VALUE], 100_000), redactedAnswer(text, [VALUE])]) assert.equal(out.includes(REST), false);
});

test("kr-10 (percent-encoded CSI colours with a byte order mark inside): a held value whose head ends a run too long to read, the padding after it, and whose rest follows is withheld", () => {
  const text = wrapped(`${"a".repeat(9000)}${HEAD}${"%1B%5B0%EF%BB%BFm".repeat(300)} ${REST} more`);
  for (const out of [redactedCall(text, [VALUE], 100_000), redactedAnswer(text, [VALUE])]) assert.equal(out.includes(REST), false);
});
