// key-refusal's read past a call's stop over padding built from every encoding a terminal sequence's parts can be
// written in: each opener (CSI, ESC "(", an OSC title ended by BEL or by ST), its ESC, BEL and the backslash of its ST
// each as it stands, as JSON's escape (once or written twice), as Python's (once or twice), percent-encoded or as an
// HTML reference, with units inside that other encodings read as an ESC, a quote, a backslash or a letter, in a JSON
// or Python string or as it stands. Long titles are also followed right away by a letter of an escape. Where the
// matcher withholds a short text with the padding between a held value's halves, the same padding repeated past what
// the read takes (kr-9), or after a run too long to read (kr-10), must withhold it too.
//
// The whole corpus (30,800 shapes) takes minutes; CI reads a seeded sample of the shapes the matcher withholds.
// KEY_REFUSAL_PAD_CORPUS=all reads every shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactedAnswer, redactedCall } from "../dist/key-refusal.js";

const B = "\\";
const ESCS = { raw: "\u001b", u: `${B}u001b`, uu: `${B}${B}u001b`, x: `${B}x1b`, xx: `${B}${B}x1b`, pct: "%1B", ent: "&#27;" };
const BSL = { raw: B, j: B + B, jj: B.repeat(4), u: `${B}u005c`, uu: `${B}${B}u005c`, x: `${B}x5c`, pct: "%5C", ent: "&#92;" };
const BELS = { raw: "\u0007", u: `${B}u0007`, uu: `${B}${B}u0007`, x: `${B}x07`, pct: "%07", ent: "&#7;" };
const INNERS = ["", "%1B", "%41", "&#27;", `${B}"`, `${B}${B}"`, `${B}${B}`, `${B}n`, `${B}${B}n`, `${B}${B}u0041`, "+", ":", '"', "'", "\u001b", `${B}u001b`, " 0", "%5C", `${B}x41`];
const WRAPS = { json: (s) => `{"a": "${s}"}`, py: (s) => `{'a': '${s}'}`, plain: (s) => s };
const [HEAD, REST] = [["Wc3M", "hT8q", "Lz5N", "rB1v"].join(""), ["Xe6K", "pJ4d", "Ys9G", "fA2u"].join("")];

function shapes() {
  const sequences = [];
  for (const [en, e] of Object.entries(ESCS)) {
    for (const inner of INNERS) {
      const name = `esc=${en} in=${JSON.stringify(inner)}`;
      sequences.push([`CSI ${name}`, `${e}[0${inner}m`]);
      sequences.push([`ESC( ${name}`, `${e}(${inner}B`]);
      for (const [bn, b] of Object.entries(BELS)) sequences.push([`OSC-BEL ${name} bel=${bn}`, `${e}]0;t${inner}${b}`]);
      if (["", "%1B", `${B}${B}"`, `${B}n`].includes(inner)) {
        for (const [sn, s] of Object.entries(ESCS)) for (const [bn, b] of Object.entries(BSL)) sequences.push([`OSC-ST ${name} st=${sn}+${bn}`, `${e}]0;t${inner}${s}${b}`]);
      }
    }
  }
  const out = [];
  for (const [name, sequence] of sequences) {
    for (const wrap of Object.keys(WRAPS)) {
      out.push({ id: `${name} wrap=${wrap}`, wrap, piece: sequence, head: HEAD, rest: REST, title: false });
      if (wrap !== "plain") out.push({ id: `${name} wrap=${wrap} ending a string`, wrap, piece: sequence + (wrap === "py" ? "', '" : '", "'), head: HEAD, rest: REST, title: false });
    }
  }
  for (const [en, e] of Object.entries(ESCS)) for (const [sn, s] of Object.entries(ESCS)) for (const [bn, b] of Object.entries(BSL)) {
    for (const inner of ["", "%1B", `${B}${B}"`]) for (const letter of ["n", "r", "uface", "xab", "/"]) for (const wrap of Object.keys(WRAPS)) {
      out.push({ id: `title esc=${en} st=${sn}+${bn} in=${JSON.stringify(inner)} then ${letter} wrap=${wrap}`, wrap, piece: `${e}]0;${"x".repeat(250)}${inner}${s}${b}`, head: HEAD.slice(0, 12), rest: `${letter}B1v${REST}`, title: true });
    }
  }
  return out;
}

// mulberry32: a fixed seed, so the sample is the same on every run.
function seeded(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seed was picked so that the sample holds shapes that fail where a sequence's end is not moved back to the start
// of the unit it falls in (moved to the unit's end, or not moved): three of the 17 and 20 such in the whole corpus.
const SAMPLE = 240;
const SEED = 17;

test("padding of every encoding of a terminal sequence's parts that the matcher withholds between a held value's halves is withheld past the read after a call's stop and after a run too long to read", () => {
  const all = shapes();
  assert.equal(all.length, 30_800);
  const every = process.env.KEY_REFUSAL_PAD_CORPUS === "all";
  const order = all.map((_, i) => i);
  const random = seeded(SEED);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let body = "";
  while (body.length < 8092) body += "word ";
  const failed = [];
  let read = 0;
  for (const i of order) {
    if (!every && read === SAMPLE) break;
    const shape = all[i];
    const wrap = WRAPS[shape.wrap];
    const value = shape.head + shape.rest;
    const tail = shape.rest.slice(-16);
    const short = shape.title ? wrap(`see ${shape.head} ${shape.piece}${shape.rest} more`) : wrap(`see ${shape.head}${shape.piece.repeat(3)} ${shape.rest} more`);
    if (redactedAnswer(short, [value]).includes(tail)) continue;
    read++;
    const long = shape.title ? shape.piece : `${shape.piece.repeat(300)} `;
    const kr9 = redactedCall(wrap(`${body}see ${shape.head} ${long}${shape.rest} more`), [value], 200) === "[redacted]";
    const run = wrap(`${"a".repeat(9000)}${shape.head}${long}${shape.rest} more`);
    const kr10 = !redactedAnswer(run, [value]).includes(tail) && !redactedCall(run, [value], 100_000).includes(tail);
    if (!kr9 || !kr10) failed.push(`${shape.id}:${kr9 ? "" : " kr-9"}${kr10 ? "" : " kr-10"}`);
  }
  assert.equal(read, every ? 8486 : SAMPLE);
  assert.deepEqual(failed, []);
});
