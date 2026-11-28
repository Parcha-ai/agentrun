// The work count of the texts the reads cost most on (key-refusal.test.mjs): the texts, the reads and the bounds, and
// the count over a part of the texts. The count runs in parts, each its own test file (key-refusal-work-<k>.test.mjs, a
// fixed list of COSTLY's texts each), so the parts run at once; key-refusal.test.mjs checks that the parts take each
// text exactly once, and reads the bounds and helpers it shares with the count from here.
import assert from "node:assert/strict";
import { readCost, redactedAnswer, redactedCall } from "../../dist/key-refusal.js";
import { marksOf, OPEN_OSC, scanned } from "../../dist/redact/match.js";
import { CALL_RESULT_CHARS, scrubUrls } from "../../dist/timeline/index.js";
import { cut } from "../../dist/timeline/util.js";

/** A held value's two halves, padding put between them in key-refusal.test.mjs's cases. */
export const [PY_HEAD, PY_REST] = [["Wc3M", "hT8q", "Lz5N", "rB1v"].join(""), ["Xe6K", "pJ4d", "Ys9G", "fA2u"].join("")];
export const wrapped = (kind, body) => (kind === "python" ? `{'a': '${body}'}` : kind === "json in json" ? `{"a": "[\\"${body}\\"]"}` : `{"a": "${body}"}`);

// What the reads cost. A read for the head or the tail of a run too long to read, or past a call's stop (key-refusal.ts
// peek, tailOf), reads its stretch through every view from every place its join can start, so padding every view reads
// apart and shows little of costs it hundreds of characters per character. It gives up, and the text is withheld, once
// it has visited its budget (READ_BUDGET, 356 pieces), checked after each reading: one view's reading of one stretch of
// at most a piece, which visits at most READING per character of it. So one read visits at most its budget and one
// reading more, READ_MOST, and as a run is read only where it is longer than a piece, at most twice, the reads of a text
// visit at most READS_PER_CHARACTER per character of it: 2 x (356 + 175) x 8,192 / 8,193, about 1,061.9. That is over
// the matcher's bound (WORK, redact-work.mjs) by construction, so the bound on a text's whole cost, the reads
// and the matcher's own work together, is measured below, on the texts the reads cost most on. READING is measured, not
// built in: key-refusal.test.mjs holds it.
export const PIECE = 8192;
const BUDGET = 356;
export const READING = 175;
export const READ_MOST = (BUDGET + READING) * PIECE;
const READS_PER_CHARACTER = (2 * READ_MOST) / (PIECE + 1);
export const WORK = 1024;
const ZWSP = "\u200b";
// Every decoder's family, so every view reads what follows.
const FAMILIES = String.raw`%41+\n\\xA&#65;'"\x41` + "\u001b[m";
export const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** A run of `length` characters that every view reads apart and shows one character of in 39: `pad` between letters. */
export const sparse = (length, pad = ZWSP) => {
  let text = FAMILIES;
  while (text.length < length) text += `${pad.repeat(Math.max(1, Math.floor(38 / pad.length)))}a`;
  return text.slice(0, length);
};
/** Runs of 8,300 such characters, one after another, about `size` characters in all. */
const runs = (size, pad) => Array.from({ length: Math.max(1, Math.round(size / 8301)) }, () => sparse(8300, pad)).join(" ");
export const VALUE = `${PY_HEAD}${PY_REST}`;

// The texts the reads cost most on, 32 KiB to 512 KiB, each read through an answer and a call's result: runs of padding
// every view reads apart (zero-width spaces, and the same as JSON's escapes written twice, as HTML references and
// percent-encoded, which the marks walk reads most), and a call's stop inside an OSC title never ended, so the read past
// it reads each view also as the title's own (shownIn's `open`). Runs of apostrophes between Hangul fillers read
// main's join of each stretch too (its quotes paired otherwise), and runs of empty literals joined by "+" read the
// values' pass with the operators left out. Each is withheld whole; each visits at most WORK per character in all,
// each of its reads at most READ_MOST, and its reads at most READS_PER_CHARACTER per character.
// The matcher's own worst texts read no run and stop no read: DENSE (redact-work.mjs) is in for its total, and
// k100 for its reads alone. k100 (prose's apostrophe, then JSON strings each holding 100 single-quoted strings joined by
// "+") visits 1,453.7, 1,465.6 and 1,465.2 per character of an answer here, with no read, over WORK by the matcher's own
// work: main (120f072308) visits the same. DENSE past a call's stop (after 200 characters of prose, so a call's stop
// falls in it) puts the read past the stop on the characters the matcher costs most on: that read visits 31,180
// characters, at 356 pieces as at 92. Written in a JSON string, an answer visits 972.1, 1,008.6 and 1,009.4 per
// character, with no read, as main does.
const DENSE = ["q8Vx", "R2mT"].join("");
const ALL_FAMILIES_STRING = String.raw`"%41+&#65;\"\\x41\\'",`;
const K100 = `${ALL_FAMILIES_STRING}${`x's "{${"'q8VxR2mT'+".repeat(100)}}"+\\\n`.repeat(4)}`;
export const COSTLY = [
  ["runs of zero-width spaces", (size) => runs(size)],
  ["runs of zero-width spaces in a JSON string", (size) => wrapped("json", runs(size))],
  ["runs of JSON's \\u200b written twice", (size) => runs(size, String.raw`\\u200b`)],
  ["runs of HTML's &#8203;", (size) => runs(size, "&#8203;")],
  ["runs of percent-encoded zero-width spaces", (size) => runs(size, "%E2%80%8B")],
  ["a call's stop inside an OSC title never ended", (size) => wrapped("json", `${"word ".repeat(1000)}${FAMILIES} \u001b]0;${fill(`${ZWSP.repeat(37)}a `, size - 5040)}`), true],
  ["DENSE", (size) => fill(`${ALL_FAMILIES_STRING}${`"${DENSE}",`.repeat(370)}`, size), false, [DENSE]],
  ["k100", (size) => fill(K100, size), false, [DENSE], "reads only"],
  ["DENSE past a call's stop", (size) => `${"word ".repeat(40)}${fill(`${ALL_FAMILIES_STRING}${`"${DENSE}",`.repeat(370)}`, size - 200)}`, false, [DENSE]],
  ["DENSE in a JSON string past a call's stop", (size) => `{"a": "${"word ".repeat(40)}${fill(`${ALL_FAMILIES_STRING}${`\\"${DENSE}\\",`.repeat(370)}`, size - 210)}"}`, false, [DENSE]],
  ["runs of apostrophes between Hangul fillers", (size) => runs(size, "\u3164'\u3164")],
  ["runs of empty literals joined by +", (size) => runs(size, "''+")],
];
const READS = {
  "an answer": (text, values) => redactedAnswer(text, values),
  "a call's result": (text, values) => cut(redactedCall(text, values, CALL_RESULT_CHARS, scrubUrls), CALL_RESULT_CHARS),
  "a call's result shown to 200": (text, values) => redactedCall(text, values, 200),
};

/** The parts the work count runs in, COSTLY's texts by name: part k is key-refusal-work-<k>.test.mjs. Each part reads
 *  about a quarter of the count's work, as measured (the Hangul fillers' runs read the most, the zero-width spaces' runs
 *  and the OSC title next). */
export const COSTLY_PARTS = [
  ["DENSE", "runs of apostrophes between Hangul fillers"],
  ["runs of zero-width spaces", "runs of JSON's \\u200b written twice", "DENSE in a JSON string past a call's stop"],
  ["runs of zero-width spaces in a JSON string", "k100", "DENSE past a call's stop"],
  ["runs of HTML's &#8203;", "runs of percent-encoded zero-width spaces", "a call's stop inside an OSC title never ended", "runs of empty literals joined by +"],
];

/** The work count's test name for part `k`, the texts it reads named. */
export const costlyPartName = (k) =>
  `the texts the reads cost most on visit at most WORK characters per character, each read at most READ_MOST, 32 KiB to 512 KiB (part ${k} of ${COSTLY_PARTS.length}: ${COSTLY_PARTS[k - 1].join("; ")})`;

/** The work count over part `k`'s texts, each at 32 KiB, 128 KiB and 512 KiB through every read. */
export function costlyWork(t, k) {
  const part = COSTLY.filter(([what]) => COSTLY_PARTS[k - 1].includes(what));
  assert.equal(part.length, COSTLY_PARTS[k - 1].length, `part ${k} names a text COSTLY does not hold`);
  const over = [];
  for (const size of [32 * 1024, 128 * 1024, 512 * 1024])
    for (const [what, make, stop, values = [VALUE], readsOnly] of part) {
      const text = make(size);
      // The prefixed reading runs: the read past the stop starts inside the title.
      if (stop) assert.ok(marksOf(text).openAt(PIECE) & OPEN_OSC, what);
      for (const [reader, read] of Object.entries(READS)) {
        scanned.chars = 0;
        readCost.chars = 0;
        readCost.most = 0;
        const out = read(text, values);
        const [total, reads] = [scanned.chars / text.length, readCost.chars / text.length];
        t.diagnostic(`${size / 1024} KiB, ${what}, ${reader}: ${total.toFixed(1)} per character, reads ${reads.toFixed(1)}, most one read ${readCost.most.toFixed(0)}`);
        if (!readsOnly && total > WORK) over.push(`${size}, ${what}, ${reader}: ${total.toFixed(1)} per character`);
        if (reads > READS_PER_CHARACTER || readCost.most > READ_MOST) over.push(`${size}, ${what}, ${reader}: reads ${reads.toFixed(1)}, one ${readCost.most}`);
        // Withheld whole where the read gives up: every read of the runs, and the read past the stop in the title.
        const gives = values[0] === VALUE && (!stop || reader === "a call's result shown to 200");
        if (gives && out !== "[redacted]") over.push(`${size}, ${what}, ${reader}: shown`);
      }
    }
  assert.deepEqual(over, []);
}
