// key-refusal's read past a call's stop (and the tail of a run too long to read) counts what the matcher's views show.
// It may count less than they show (it reads further), never more: a terminal sequence the matcher's screen reading
// hides whole must count as nothing there too, or padding of it pushes a held value's rest out of the read and its
// head shows. Each padding shape below is a terminal sequence (each opener, with a unit of each class inside: a
// control passed over, one that aborts, a character past ASCII, U+FFFD, a blank, a zero-width character, a parameter
// out of place), written as it stands, as JSON's \u escapes, or percent-encoded as UTF-8 (and with bytes that are no
// UTF-8). Where the matcher withholds a short text with the padding between a held value's halves, the same padding
// repeated past what the read takes must withhold it too.
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
const INNERS = [
  ["nothing", ""],
  ["a NUL", "\u0000"],
  ["U+0001", "\u0001"],
  ["a DEL", "\u007f"],
  ["a line feed", "\n"],
  ["a CAN", "\u0018"],
  ["a SUB", "\u001a"],
  ["a backspace", "\b"],
  ["U+0085", "\u0085"],
  ["a space", " "],
  ["a no-break space", " "],
  ["e acute", "é"],
  ["U+FFFD", "�"],
  ["a braille blank", "⠀"],
  ["a zero-width space", "​"],
  ["a combining acute", "́"],
  ["a character past U+FFFF", "\u{1f600}"],
  ["a colon", ":"],
  ["a private marker out of place", "?"],
];
const toJson = (text) => [...text].map((char) => (/^[\x20-\x7e]$/.test(char) && char !== '"' && char !== "\\" ? char : char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""))).join("");
const percent = (text) => Buffer.from(text, "utf8").toString("hex").replace(/../g, (byte) => `%${byte.toUpperCase()}`);

const SHAPES = [];
for (const [opener, intro, body] of OPENERS) {
  for (const [what, inner] of INNERS) {
    const sequence = `${intro}${body(inner)}`;
    SHAPES.push([`${opener}, ${what} inside, as it stands`, sequence]);
    SHAPES.push([`${opener}, ${what} inside, as JSON's escapes`, toJson(sequence)]);
    SHAPES.push([`${opener}, ${what} inside, percent-encoded`, percent(sequence)]);
  }
  // Percent-encoded bytes that are no UTF-8: the percent views decode each to U+FFFD.
  for (const [what, bytes] of [["a lone byte FF", "%FF"], ["a truncated sequence", "%E2%82"], ["a stray continuation byte", "%80"]])
    SHAPES.push([`${opener}, ${what} inside, percent-encoded`, `${percent(intro)}${percent(body("\u0000")).replace("%00", bytes)}`]);
}

const wrapped = (body) => `{"a": "${body}"}`;

test("every padding shape the matcher reads past whole is read past by the read after a call's stop and by a run's tail read", () => {
  const under = [];
  let checked = 0;
  for (const [name, pad] of SHAPES) {
    // The matcher's reading: a short text, the padding three times between the value's halves.
    const short = wrapped(`see ${HEAD}${pad.repeat(3)} ${REST} more`);
    if (redactedAnswer(short, [VALUE]).includes(REST)) continue;
    checked++;
    const long = pad.repeat(300);
    let body = "";
    while (body.length < 8192 - 100) body += "word ";
    if (redactedCall(wrapped(`${body}see ${HEAD} ${long}${REST} more`), [VALUE], 200) !== "[redacted]") under.push(`kr-9 ${name}`);
    const tail = wrapped(`${"a".repeat(9000)}${HEAD}${long} ${REST} more`);
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
