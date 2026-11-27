// key-refusal's read past a call's stop over random padding: each pad is a terminal sequence (a CSI, an ESC "(", an
// OSC title ended by BEL or by ST, an 8-bit OSC or CSI) whose every character is written in a random encoding (as it
// stands, as JSON's "\u" escape once or written twice, as Python's "\x" once or twice, percent-encoded, as an HTML
// reference, or a short escape: "\\", "\"", "\n", "\'"), with up to three random units inside and sometimes a letter of
// an escape, a quote or a string's end after it. The pad corpus (key-refusal-pad-corpus.test.mjs) writes a sequence's
// parts in one encoding each, in a fixed list; here the parts of one sequence mix encodings, so the views each read the
// padding their own way. Where the matcher withholds a short text with the padding between a held value's halves (in a
// JSON string, a Python repr's string, as it stands, or in a JSON string written in a JSON string), the same padding 300
// times over must withhold the text past the read after a call's stop (kr-9) and after a run too long to read (kr-10).
//
// CI reads the first 260 withheld (padding, wrap) rows of seed 18 (about 25 seconds). KEY_REFUSAL_PAD_FUZZ=all reads
// every row of seeds 2 to 5, 40,000 draws each (an hour or more); KEY_REFUSAL_PAD_FUZZ_SEEDS=2,3 picks the seeds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactedAnswer, redactedCall } from "../dist/key-refusal.js";
import { coverTally } from "./fixtures/marks-cover.mjs";

const B = "\\";
const WRAPS = { json: (s) => `{"a": "${s}"}`, py: (s) => `{'a': '${s}'}`, plain: (s) => s, jj: (s) => `{"a": "[\\"${s}\\"]"}` };
const [HEAD, REST] = [["Wc3M", "hT8q", "Lz5N", "rB1v"].join(""), ["Xe6K", "pJ4d", "Ys9G", "fA2u"].join("")];
const VALUE = `${HEAD}${REST}`;

/** mulberry32 over `seed`: the same draws on every run. */
function seeded(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A function that draws one random pad from `random`. */
function pads(random) {
  const pick = (items) => items[Math.floor(random() * items.length)];
  const hex = (char) => char.charCodeAt(0).toString(16).padStart(2, "0");
  const encodings = [
    (char) => char,
    (char) => `${B}u${hex(char).padStart(4, "0")}`,
    (char) => `${B}${B}u${hex(char).padStart(4, "0")}`,
    (char) => `${B}x${hex(char)}`,
    (char) => `${B}${B}x${hex(char)}`,
    (char) => `%${hex(char).toUpperCase()}`,
    (char) => `&#${char.charCodeAt(0)};`,
  ];
  const short = { "\\": [B + B, B.repeat(4)], '"': [`${B}"`, `${B}${B}${B}"`, `${B}${B}"`], "\n": [`${B}n`, `${B}${B}n`], "'": [`${B}'`, `${B}${B}'`] };
  const encode = (char) => pick([...encodings.map((write) => write(char)), ...(short[char] ?? [])]);
  const ESC = "\u001b";
  const units = ["0", ";", "m", "B", "t", "n", "x", "u", "a", "1", ":", ",", " ", " ", '"', "'", "\\", "[", "]", "(", ESC, "\u0007", "\u0018", "\u009c", "/", "f", "r", "b", "%", "&", "#", "\u0000", "\b"];
  return () => {
    const kind = pick(["csi", "esc(", "osc-bel", "osc-st", "c1osc", "c1csi"]);
    const parts = [encode(kind === "c1osc" ? "\u009d" : kind === "c1csi" ? "\u009b" : ESC)];
    if (kind === "csi") parts.push(encode("["));
    if (kind === "esc(") parts.push(encode("("));
    if (kind.startsWith("osc")) parts.push(encode("]"));
    const inside = Math.floor(random() * 4);
    for (let i = 0; i < inside; i++) parts.push(random() < 0.5 ? pick(units) : encode(pick(units)));
    if (kind === "csi" || kind === "c1csi") parts.push(random() < 0.7 ? encode("m") : pick(["m", "@"]));
    if (kind === "esc(") parts.push(encode("B"));
    if (kind === "osc-bel" || kind === "c1osc") parts.push(encode("\u0007"));
    if (kind === "osc-st") parts.push(encode(ESC), encode("\\"));
    if (random() < 0.3) parts.push(pick(["n", "r", "t", "u0041", "x41", "/", '"', "'", '", "', "B"]));
    return parts.join("");
  };
}

const ALL = process.env.KEY_REFUSAL_PAD_FUZZ === "all";
const SEEDS = process.env.KEY_REFUSAL_PAD_FUZZ_SEEDS ? process.env.KEY_REFUSAL_PAD_FUZZ_SEEDS.split(",").map(Number) : ALL ? [2, 3, 4, 5] : [18];
const DRAWS = 40_000;
// The seed and the size were picked so that the sample holds rows the read past a call's stop showed when it took one
// end per sequence: four (one padding, in each of the four wraps) of seed 18's first 260.
const SAMPLE = 260;

for (const seed of SEEDS)
  test(`random padding of mixed encodings (seed ${seed}) that the matcher withholds between a held value's halves is withheld past the read after a call's stop and after a run too long to read`, () => {
    const draw = pads(seeded(seed));
    let body = "";
    while (body.length < 8092) body += "word ";
    const seen = new Set();
    const failed = [];
    let read = 0;
    for (let i = 0; i < DRAWS && (ALL || process.env.KEY_REFUSAL_PAD_FUZZ_SEEDS || read < SAMPLE); i++) {
      const pad = draw();
      if (seen.has(pad)) continue;
      seen.add(pad);
      for (const [name, wrap] of Object.entries(WRAPS)) {
        if (!ALL && !process.env.KEY_REFUSAL_PAD_FUZZ_SEEDS && read === SAMPLE) break;
        if (redactedAnswer(wrap(`see ${HEAD}${pad.repeat(3)} ${REST} more`), [VALUE]).includes(REST)) continue;
        read++;
        const long = `${pad.repeat(300)} `;
        const kr9 = redactedCall(wrap(`${body}see ${HEAD} ${long}${REST} more`), [VALUE], 200) === "[redacted]";
        const run = wrap(`${"a".repeat(9000)}${HEAD}${long}${REST} more`);
        const kr10 = !redactedAnswer(run, [VALUE]).includes(REST) && !redactedCall(run, [VALUE], 100_000).includes(REST);
        if (!kr9 || !kr10) failed.push(`${JSON.stringify(pad)} ${name}:${kr9 ? "" : " kr-9"}${kr10 ? "" : " kr-10"}`);
      }
    }
    if (!ALL && !process.env.KEY_REFUSAL_PAD_FUZZ_SEEDS) assert.equal(read, SAMPLE);
    console.log(`# seed ${seed}: ${seen.size} pads, ${read} withheld (padding, wrap) rows, ${failed.length} shown`);
    assert.deepEqual(failed, []);
  });

// The marks a read is cut with cover what every view hides (fixtures/marks-cover.mjs), over the same rows: each padding
// three times between a held value's halves, in each wrap, where the matcher withholds it. One padding of seed 4 is
// left out: the check counts a place hidden there that no read holds (key-refusal.test.mjs pins it).
const CHECK_PINNED = new Set(["%9D\b&#160;\u0007"]);
for (const seed of SEEDS)
  test(`random padding of mixed encodings (seed ${seed}): where a view hides a character as a terminal does, a read that starts there is told a sequence may be open or a backspace follows`, () => {
    const draw = pads(seeded(seed));
    const seen = new Set();
    const { tally, add } = coverTally();
    let read = 0;
    for (let i = 0; i < DRAWS && (ALL || process.env.KEY_REFUSAL_PAD_FUZZ_SEEDS || read < SAMPLE); i++) {
      const pad = draw();
      if (seen.has(pad) || CHECK_PINNED.has(pad)) continue;
      seen.add(pad);
      for (const wrap of Object.values(WRAPS)) {
        if (!ALL && !process.env.KEY_REFUSAL_PAD_FUZZ_SEEDS && read === SAMPLE) break;
        const short = wrap(`see ${HEAD}${pad.repeat(3)} ${REST} more`);
        if (redactedAnswer(short, [VALUE]).includes(REST)) continue;
        read++;
        add(short);
      }
    }
    console.log(`# seed ${seed}: ${tally.texts} texts, ${tally.checked} hidden places checked, ${tally.misses} missed`);
    assert.ok(tally.checked > 0);
    assert.deepEqual(tally.missed, []);
  });
