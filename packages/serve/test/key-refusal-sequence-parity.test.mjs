// key-refusal's read past a call's stop (and the tail of a run too long to read) counts what the matcher's views show:
// it reads the stretch through each of them (match.ts shownIn), each with its own decoding, join and terminal reading,
// and stops where the view that shows least has shown enough. A terminal sequence the matcher's screen reading hides
// whole must count as nothing there too, or padding of it pushes a held value's rest out of the read and its head
// shows. Each padding shape (fixtures/padding-shapes.mjs) is a terminal sequence (each opener, with a unit of each class
// there inside), written as it stands, as JSON's escapes (as a writer writes them, as "\u" escapes throughout, and
// twice), as Python's escapes in a single-quoted dict, as HTML character references, or percent-encoded as UTF-8 (and
// with bytes that are no UTF-8). Where the matcher withholds a short text with the padding between a held value's
// halves, the same padding repeated past what the read takes must withhold it too. And the read walks every view the
// matcher has.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { redactedAnswer, redactedCall } from "../dist/key-refusal.js";
import { shownIn, VIEW_COUNT } from "../dist/redact/match.js";
import { coverTally } from "./fixtures/marks-cover.mjs";
import { ENCODINGS, HEAD, LAYOUTS, matcherReadsPast, partOf, READ_PAST_PARTS, readPastName, REST, VALUE, wrapped } from "./fixtures/padding-shapes.mjs";

// The check of every padding shape the matcher reads past (fixtures/padding-shapes.mjs) runs in parts, one test file
// each (key-refusal-sequence-parity-<k>.test.mjs, the shapes of one opener): here, over every shape of each layout, the
// matcher reads past more than half of them, so the parts check most shapes.
for (const [layout, shapes, piece, text] of LAYOUTS)
  test(`${readPastName(layout)} (the matcher's reading of every shape: more than half read past)`, () => {
    let checked = 0;
    for (const [, pad, kind] of shapes) if (matcherReadsPast(pad, kind, piece, text)) checked++;
    assert.ok(checked > shapes.length / 2, `the matcher read past ${checked} of ${shapes.length} shapes`);
  });

test("every padding shape, in each layout: the parts of the read-past check take each shape exactly once, each part file its own part", () => {
  const files = readdirSync(new URL(".", import.meta.url)).filter((file) => /^key-refusal-sequence-parity-\d+\.test\.mjs$/.test(file));
  assert.deepEqual(files.sort(), Array.from({ length: READ_PAST_PARTS.length }, (_, i) => `key-refusal-sequence-parity-${i + 1}.test.mjs`).sort());
  for (const file of files) {
    const k = Number(file.match(/\d+/)[0]);
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.deepEqual([...text.matchAll(/readPastPart(?:Name)?\(layout, (\d+)\)/g)].map((m) => Number(m[1])), [k, k], file);
  }
  for (const [layout, shapes] of LAYOUTS) {
    const owned = shapes.map(([name]) => [name, READ_PAST_PARTS.filter((opener) => name.startsWith(`${opener}, `)).length]);
    assert.deepEqual(owned.filter(([, owners]) => owners !== 1), [], layout);
    assert.ok(READ_PAST_PARTS.every((_, i) => shapes.some(([name]) => partOf(name) === i + 1)), layout);
  }
});

// The marks a read is cut with cover what every view hides (fixtures/marks-cover.mjs), over every shape's short text in
// each layout, whether or not the matcher withholds it.
test("every padding shape, in each layout: where a view hides a character as a terminal does, a read that starts there is told a sequence may be open or a backspace follows", () => {
  const { tally, add } = coverTally();
  for (const [, shapes, piece, text] of LAYOUTS) for (const [, pad, kind] of shapes) add(text(`see ${HEAD}${piece(pad, kind).repeat(3)} ${REST} more`, kind));
  console.log(`# ${tally.texts} texts, ${tally.checked} hidden places checked, ${tally.misses} missed`);
  assert.ok(tally.checked > 0);
  assert.deepEqual(tally.missed, []);
});

// Each title ended by ST, past the read, followed right away by a held value's rest that starts with what a second
// level of escapes reads with the ST's backslash as one escape (a letter of JSON's escapes, "u" and four hex digits,
// "x" and two hex digits), in every encoding: the views that read the text as it stands, or one level of escapes, end
// the title at the ST and read the letter as the held value's own.
const TITLES = [
  ["ESC ] ended by ST", `\u001b]0;${"x".repeat(250)}\u001b\\`],
  ["U+009D", `\u009d0;${"x".repeat(250)}\u009c`],
];
const FOLLOWERS = ["n", "t", "r", "b", "f", "/", "uface", "xab"];
test("every OSC title ended by ST the matcher reads past whole, followed right away by a held value's rest that a second level of escapes reads with the ST, is read past by the read after a call's stop and by a run's tail read", () => {
  const head = HEAD.slice(0, 12);
  const under = [];
  let [checked, count] = [0, 0];
  let body = "";
  while (body.length < 8192 - 100) body += "word ";
  for (const [opener, title] of TITLES)
    for (const [how, encode, kind] of ENCODINGS)
      for (const follower of FOLLOWERS) {
        count++;
        const [rest, pad, name] = [`${follower}B1v${REST}`, encode(title), `${opener} ${how}, then ${follower}`];
        if (redactedAnswer(wrapped(`see ${head} ${pad}${rest} more`, kind), [`${head}${rest}`]).includes(REST)) continue;
        checked++;
        if (redactedCall(wrapped(`${body}see ${head} ${pad}${rest} more`, kind), [`${head}${rest}`], 200) !== "[redacted]") under.push(`kr-9 ${name}`);
        const tail = wrapped(`${"a".repeat(9000)}${head}${pad}${rest} more`, kind);
        if (redactedCall(tail, [`${head}${rest}`], 100_000).includes(REST)) under.push(`kr-10 call ${name}`);
        if (redactedAnswer(tail, [`${head}${rest}`]).includes(REST)) under.push(`kr-10 answer ${name}`);
      }
  assert.ok(checked > count / 2, `the matcher read past ${checked} of ${count} titles`);
  assert.deepEqual(under, []);
});

// The read past a call's stop walks every view of the matcher, a view added to it too: over text that holds what each
// decoder decodes, property names, both quotes and a terminal sequence, with and without the fold view's separators.
test("the read after a call's stop walks every view of the matcher", () => {
  const text = String.raw`{"k": "v %41+\n \\x41 &#65; \x41 it's", 'n': 'w'} ` + "\u001b[31mred\u001b[0m";
  for (const fold of [false, true]) {
    const walked = new Set();
    Array.from(shownIn(text, fold, walked));
    assert.ok(VIEW_COUNT >= 16, `${VIEW_COUNT} views`);
    assert.deepEqual([...walked].sort((a, b) => a - b), Array.from({ length: VIEW_COUNT }, (_, index) => index), `fold ${fold}`);
  }
});

test("kr-10 (percent-encoded CSI colours with U+FFFD inside): a held value whose head ends a run too long to read, the padding after it, and whose rest follows is withheld", () => {
  const text = wrapped(`${"a".repeat(9000)}${HEAD}${"%1B%5B0%EF%BF%BDm".repeat(300)} ${REST} more`);
  for (const out of [redactedCall(text, [VALUE], 100_000), redactedAnswer(text, [VALUE])]) assert.equal(out.includes(REST), false);
});

test("kr-10 (percent-encoded CSI colours with a byte order mark inside): a held value whose head ends a run too long to read, the padding after it, and whose rest follows is withheld", () => {
  const text = wrapped(`${"a".repeat(9000)}${HEAD}${"%1B%5B0%EF%BB%BFm".repeat(300)} ${REST} more`);
  for (const out of [redactedCall(text, [VALUE], 100_000), redactedAnswer(text, [VALUE])]) assert.equal(out.includes(REST), false);
});
