// The work count of the adversarial texts (redact-contract.test.mjs): the entry points and readers, the texts and the
// held values they are read with, the bounds, and the count over a part of the texts. The count runs in parts, each its
// own test file (redact-contract-work-<k>.test.mjs, the texts whose index is k - 1 modulo WORK_PARTS), so the parts run
// at once; each part reads its texts at every size, so a text's growth is checked against the same text.
// redact-contract.test.mjs checks that the parts take each text exactly once, and reads what it shares with the count
// from here.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import * as refusal from "../../dist/key-refusal.js";
import { redactLearned, redactSecrets } from "../../dist/learn/secrets.js";
import { CALL_RESULT_CHARS, scrubUrls } from "../../dist/timeline/index.js";
import { cut } from "../../dist/timeline/util.js";

/** The entry points redact-contract.test.mjs runs its table through (its head says what each is). */
export const ENTRIES = {
  redacted: (text, values) => refusal.redacted(text, values),
  redactedAnswer: (text, values) => refusal.redactedAnswer(text, values),
  redactedCall: (text, values) => cut(refusal.redactedCall(text, values, CALL_RESULT_CHARS, scrubUrls), CALL_RESULT_CHARS),
  redactSecrets: (text, values) => redactSecrets(text, values),
  runFile: (text, values) => redactSecrets(text, values, Buffer.byteLength(text)),
};

export const CUT_KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;
export const SIZE = 256 * 1024;
export const fill = (unit, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** Characters that render as nothing, by code point: a zero-width space, a soft hyphen, a byte order mark. */
export const [ZWSP, SHY, BOM] = [0x200b, 0xad, 0xfeff].map((code) => String.fromCharCode(code));
export const short = (text) => (text.length > 60 ? `${JSON.stringify(text.slice(0, 40))}…(${text.length})` : JSON.stringify(text));

/** A held value of MIN_SECRET (8) characters in no secret's shape, for a text that holds it every few characters. */
export const DENSE = ["q8Vx", "R2mT"].join("");
export const BACKSLASH = String.fromCharCode(92);

/** A held value of two lines of 40 characters or more: three parts (each line, and both joined), each a needle. */
const TWO_LINES = [`made-up-first-line-${"q8VxR2mT".repeat(3)}`, `made-up-second-line-${"R2mTq8Vx".repeat(3)}`];
/** A held value whose longest form needs the most a run's tail read takes (8,192 characters). */
const LONG = `${CUT_KEY}-${"q8VxR2mT7kPz".repeat(120)}`;
/** A held key as one is held in practice: a 4096-bit RSA key's PKCS #8 PEM, made here (about 3,270 characters, 50 body
 *  lines of 64 and a short last one): 51 parts, each a form and a plain needle, beside its whole forms. */
const RSA_PEM = generateKeyPairSync("rsa", { modulusLength: 4096, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey.trim();

/** The adversarial texts of `size` characters, each with the held values it is read with, each text stressing a stage:
 *  - the shapes' prefixes and runs;
 *  - each view's decoders over a text of nothing but what they decode: percent-encoded bytes, ASCII and not, "+",
 *    JSON's escapes at one level and two (each kind, back to back), a second level that starts and fails, Python's
 *    escapes ("\'", "\x41") and a single-quoted dict opened and never closed, named and numeric references (a name
 *    never closed, zeros as long as the text, no ";"), non-ASCII
 *    stretches for NFKC, characters that render as nothing (zero-width spaces, soft hyphens, both between letters),
 *    control characters (as they stand, escaped, percent-encoded, as references);
 *  - the join view over JSON, well formed and malformed: strings never closed, nesting as deep as the text, strings of
 *    nothing but backslashes;
 *  - a held value found every 9 characters, each find cut in place, and one in every string of a JSON text; and every
 *    11, a character between each two finds that no cut covers, so each find is checked against its own covered stretch
 *    of the view;
 *  - a held value of two lines, its lines over and over: its parts found at every line, each cut in place;
 *  - a held 4096-bit RSA key, over and over, and its body's lines in reverse order (never the key whole, every line a
 *    part cut in place): its 51 parts searched in each view;
 *  - runs too long to read, each with a held value's head glued to its end: each run's tail read again, 8,192
 *    characters of it, for the held value. */
export const adversarial = (size) => {
  const f = (unit) => fill(unit, size);
  const shapes = [
    f("eyJ"), f("eyJ-"), `-----BEGIN ${fill("A", size - 11)}`, `-----BEGIN ${fill("PRIVATE KEY ", size - 11)}`, `://a:${fill("a", size - 5)}`, f("://a:"),
    f("sk-"), f("github_pat_"), f("ghp_"), f("xoxb-"), f("whsec_"), f("Bearer "), `Bearer ${fill("a", size - 7)}`, f("?token="),
    `?token=${fill("a", size - 7)}`, f(`${"a".repeat(1021)}eyJ`), f("eyJaaaaaaaa."), `account ${fill("1 ", size - 8)}`, f("routing number "), f("sort code "),
    `IBAN GB00${fill("A ", size - 9)}`, f("AKIA"), f("AIza"), f("-----BEGIN "), f("a-sk-"), f("Bearer a-Bearer "),
    f("xapp-"), `eyJaaaaaaaa.${fill("eyJ", size - 12)}`, f(`${"a".repeat(1020)}eyJ `),
  ];
  const B = BACKSLASH;
  const views = [
    f("%41"), f("%e9"), f("a+"), f(`${B}n`), f(`${B}${B}n`), f(`${B}u0041`), f(`${B}${B}u0041`), f(`${B}${B}u004`),
    f(`${B}t${B}"${B}/${B}${B}${B}r${B}b${B}f`), f(`${B}${B}${B}"${B}${B}t${B}${B}${B}${B}`),
    f(String.fromCharCode(0xe9)), f(`a${String.fromCharCode(0x301)}`), f(ZWSP), f(SHY), f(`a${SHY}b${ZWSP}`),
    // The stacked decoders, each kind back to back and mixed; character references, whole and cut short; precomposed
    // letters and letters each with a combining mark, for the decomposing squeeze.
    f(`%41${B}u0041&#65;+`), f(`&#65;`), f(`&#x1F600;`), f(`&#`), f(`&#1234567`), f(String.fromCharCode(0x179)), f(`Z${String.fromCharCode(0x301, 0x327)}`),
    // The join view: strings, names and values, empty strings, a lone quote, escaped quotes, JSON written in a string,
    // a name with no value, and runs between JSON's punctuation.
    f('"a",'), f('{"k":"v"},'), f('"",'), f('"'), f(`${B}"`), `"${fill(`[${B}"a${B}",${B}"b${B}"],`, size - 1)}`, f('":'), f('"a"   '), f("a,"),
    // Malformed JSON: a string never closed (with words, and one run of the text's whole length), nesting as deep as
    // the text (arrays, objects, both, opened and closed), strings of nothing but backslashes (closed, never closed, a
    // lone one escaping the quote after it), and a text that builds every view at once.
    `{"k":"${fill("ab ", size - 6)}`, `"${fill("a", size - 1)}`, f("["), f('{"a":'), f('[{"a":['), `${fill("[", size / 2)}${fill("]", size / 2)}`,
    `"${fill(B, size - 2)}"`, `"${fill(B, size - 1)}`, f(`"${B}${B}${B}"`), f(`"${B}`), f(`"%41+${B}u0041&#65;",`),
    // The strings join's four views at once: a quote, percent, "+", an escaped quote and an escaped backslash.
    f(`"%41+${B}"${B}${B}n&#65;",`), f(`"a+${B}${B}",`),
    // The quoted joins (a single-quoted dict's, read once as JSON's escapes and once as Python's): a lone apostrophe, a
    // name and its value opened and never closed, an apostrophe escaped, and Python's escapes back to back.
    f('"a" + '), f("'a'+\\\n"), f("it's 'a' + '"), f("'a\n"), f("'"), f("'a': '"), f(`'${B}`), f(`'a${B}'b${B}x41${B}${B}',`), f(`${B}x4`),
    // Named and numeric references: whole, a name never closed, a zero, one with no ";", zeros as long as the text, and
    // "+" in a quoted JSON text with a reference.
    f("&amp;"), f("&ampx"), f("&#0"), f("&#65"), `&#${fill("0", size - 2)}`, f('"a&#65;+",'),
    // A single-quoted dict written in a JSON string (a call's arguments, read one level down): many strings each holding
    // one, one string holding a dict opened and never closed, and Python's escapes at both levels, back to back.
    f(`"{'a': 'b'}",`), `"{'a': '${fill("ab ", size - 9)}`, `"${fill(`${B}${B}x41${B}${B}'`, size - 1)}"`, f(`"'${B}${B}x4${B}${B}'",`),
    f(`'${B}${B}${B}${B}x41`),
    // Control characters the views drop, as they stand, between letters, escaped (JSON's, twice, Python's in a
    // single-quoted dict), percent-encoded, as character references, and inside JSON strings.
    f("\u0000"), f("a\u0001"), f("\u007f\u0085"), f(`${B}u0000`), f(`${B}${B}u001f`), f(`'a${B}x01`), f("%00%C2%85"), f("&#1;&#x7f;"), f('"a\u0000",'),
    // U+FFFF, which the views drop in the text and keep only as a join's separator: as it stands, between letters and
    // inside JSON strings, escaped, percent-encoded, as a reference.
    // Terminal sequences: CSIs back to back, opened and never closed, OSCs never ended, ESCs alone, backspaces.
    f("\u001b[0m"), f("a\u001b[1;31m"), f("\u001b["), f("\u001b[1;"), f("\u001b]0;t"), f("\u001b]0;t\u0007"), f("\u001b"), f("a\b"), f("\b"), f("\u009b1"), f("\u009d0;"), f(`${B}u001b[0m`), f("%1B[0m"), f("&#27;[0m"),
    // Characters that show as a box or a blank, as they stand, escaped (a lone surrogate too), and a pair whole.
    f("\ufffe"), f("a\ufff9"), f("\ufdd0\ue000"), f("\u2800"), f("\ud800"), f("a\udc00"), f(`${B}ud800`), f("\u{1F600}"),
    f("\uffff"), f("a\uffff"), f('"a\uffff",'), f(`${B}uffff`), f("%EF%BF%BF"), f("&#xffff;"),
  ];
  return [
    ...[...shapes, ...views].map((text) => ({ text, values: [CUT_KEY] })),
    { text: f(`${DENSE} `), values: [DENSE] },
    // A held value found in every string of a JSON text, each find cut in place: the join view moves each cut to where
    // its string stands in the join, its cursor passing each cut once a pass.
    { text: f(`"${DENSE}",`), values: [DENSE] },
    // Every view at once, each over the text at nearly its whole length: one closed JSON string holding each family (a
    // percent byte, "+", a reference, an escaped quote, Python's "\x41" and an apostrophe one level down) turns on all
    // sixteen, and the held value's strings after it decode to themselves in each. It heads each block of about 4 KiB, so
    // each answer piece holds it too.
    { text: f(`"%41+&#65;${B}"${B}${B}x41${B}${B}'",${`"${DENSE}",`.repeat(370)}`), values: [DENSE] },
    // The same with the held value's strings joined by "+" (and "+\\" and a line break), operators all, and single-quoted
    // after prose with an apostrophe: the join's values read without the operators, and as main's reading reads them.
    { text: f(`"%41+&#65;${B}"${B}${B}x41${B}${B}'",${`"${DENSE}" + `.repeat(370)}`), values: [DENSE] },
    { text: f(`"%41+&#65;${B}"${B}${B}x41${B}${B}'",${`"${DENSE}"+${B}\n`.repeat(370)}`), values: [DENSE] },
    { text: f(`"%41+&#65;${B}"${B}${B}x41${B}${B}'",${`it's '${DENSE}' + '+${DENSE}'\n`.repeat(180)}`), values: [DENSE] },
    // And both readings at once: prose's apostrophe on each line, so main's reading pairs the quotes otherwise, and the
    // strings joined by operators after it.
    { text: f(`"%41+&#65;${B}"${B}${B}x41${B}${B}'",${`x's${`"${DENSE}"+`.repeat(10)}${B}\n`.repeat(40)}`), values: [DENSE] },
    // And on each such line a JSON string holding a single-quoted dict's strings joined by "+", a hundred of them: the
    // JSON strings joined by an operator (the nested and strings joins read a fourth pass), the dict's strings paired
    // otherwise by main's reading (the quoted joins read again as main's), and the held value cut in place in each.
    { text: f(`"%41+&#65;${B}"${B}${B}x41${B}${B}'",${`x's "{${`'${DENSE}'+`.repeat(100)}}"+${B}\n`.repeat(4)}`), values: [DENSE] },
    // The same in a string never closed, and in one escaped quote after another (JSON written in a string).
    { text: `{"k":"${fill(`${DENSE} `, size - 6)}`, values: [DENSE] },
    { text: f(`${BACKSLASH}"${DENSE}${BACKSLASH}",`), values: [DENSE] },
    { text: f(`${DENSE} x `), values: [DENSE] },
    // A held value found every 9 characters with a control between each two finds: the views drop it, so they read the
    // finds glued together, each still cut in place.
    { text: f(`${DENSE}\u0000`), values: [DENSE] },
    { text: f(`${DENSE}\uffff`), values: [DENSE] },
    { text: f(`${DENSE}\ud800`), values: [DENSE] },
    { text: f(`${DENSE}\u001b[0m`), values: [DENSE] },
    { text: f(`${DENSE}Z\b`), values: [DENSE] },
    { text: f(`"${DENSE}\uffff",`), values: [DENSE] },
    { text: f(`${TWO_LINES.join("\n")}\n`), values: [TWO_LINES.join("\n")] },
    { text: f(`${RSA_PEM}\n`), values: [RSA_PEM] },
    { text: f(`${RSA_PEM.split("\n").slice(1, -1).reverse().join("\n")}\n`), values: [RSA_PEM] },
    { text: f(`${"z".repeat(9000)}${LONG.slice(0, 16)} `), values: [LONG] },
  ];
};

/** Each entry point that reads a text whole or in pieces, as the work count drives it: redactSecrets and redactLearned
 *  with no byte bound, an answer, a call's result and a row's head. */
const READERS = {
  redactSecrets: (text, values) => redactSecrets(text, values, Buffer.byteLength(text)),
  redactLearned: (text, values) => redactLearned(text, values, Buffer.byteLength(text)),
  redactedAnswer: ENTRIES.redactedAnswer,
  redactedCall: ENTRIES.redactedCall,
  redacted: ENTRIES.redacted,
};

// The whole pipeline reads a text in work linear in its length: every character a stage visits, counted by match.ts
// (the shapes' prefixes and runs, each form, hex and folded search, each view built, its decoders and its cover, each
// needle searched in it, the cut) and by key-refusal.ts (each piece's end found, each peek, the pass's join), is at most
// WORK per character of the text, at 32 KiB, 128 KiB and 512 KiB, through each reader, for one held value.
//
// WORK, from the code's structure, per character of the text, one held value (at most 7 forms and 7 plain needles: as
// written, and its base64 at three alignments in two alphabets; one hex; at most one folded):
// - the shapes, sought over the text and over its cut, and each run read: 128, the shapes' own bound (the shape test in
//   redact-contract.test.mjs);
// - planCut's finds: the text lowered (1), each form and the hex searched (2 each, a find and the text before it: 16),
//   the folded search (4), the finds merged (1): about 21;
// - one whole-text check: what the text holds that a view decodes (9); sixteen views at most: the squeezed one and the
//   percent-decoded two (one with "+") built in 9 reads each (its special characters found, its blanks, its non-ASCII
//   stretches squeezed twice, its cover), the views of JSON's escapes alone (two levels, and one where the text has an
//   escaped backslash) and the two stacked ones (one with "+") in 23 each (two levels of escapes read per character
//   decoded); the nested join, which reads the text as JSON first (3: at level 0, again at level 1 inside a string, and
//   the whitespace after a string), writes its join (2: each character in it at most twice, values then all, or names
//   then all), and two decoding views over that join (one with "+": 46 each, 92); the strings join, read at level 0
//   alone (2) and written (2), and four decoding views over it (one level of JSON's escapes alone, with percent, with
//   percent and "+", and two levels: 46 each, 184); the quoted join (a single-quoted dict's), read at level 0 (2) and
//   written (2), and the again join (each JSON string's text read one level down for a dict written in it), the text
//   read at level 0 for its strings and they at level 1 (3) and written (2), and the two written once more one after the
//   other (4); three decoding views over them (JSON's escapes over both: 92; Python's over the quoted join where the
//   text holds one, and both levels of them over the again join where it holds a quote: 46 each; 184); then each
//   searched for 7 plain needles, the hex and the fold, lowered and flattened, each find checked against the covered
//   stretches (21 each, 42 over a join, 84 over the two joins one after the other): about 1,082; planCut runs two (the
//   text with its cuts, then the cut text, at most 10/8 as long): about 2,435;
// - so planCut is about 2,584; an answer adds its pieces' ends and joins (10), heldIn's check of what it returns (10/8
//   of a check: 1,353), of the pieces as they came (1,082), and its shape pass (64): about 5,093.
// That sum takes each stage at its most at once, and its views are all reachable together: familiesOf reads each family
// as present or absent, so one closed JSON string holding each of them turns on all sixteen views, and the rest of the
// text decodes to itself at nearly its whole length in each (the text of DENSE's strings, each block of about 4 KiB
// headed by one such string). It is the most measured here where the two readings of the quotes agree (below): 943.6
// per character at 128 KiB and at 512 KiB, through redactedAnswer; every other such text measures under 450 (a held
// RSA key's, made anew each run, moves by a few).
// A held value of two lines adds its three parts as forms and plain needles (about 30 more). A held value of k long
// lines adds k + 1 of each: its work grows with k, linear in the text all the same.
// The quoted joins are also read as main's reading reads them (every apostrophe opening a string, closed by the next,
// no operator left out) wherever the two readings differ, so what main withheld is withheld still: where they differ
// in an operator only, a fourth pass of the join's values; where an apostrophe pairs otherwise, main's joins over again.
// That union is why WORK is 1,536 and no longer 1,024, the bound from before the stacked and join views: the text that
// reads the most is a JSON string on each line after prose's apostrophe, holding a hundred single-quoted strings joined
// by "+", the JSON strings joined by "+" and "\", which both readings read whole: 1,453.7 per character at 32 KiB,
// 1,465.6 at 128 KiB, 1,465.2 at 512 KiB and 1,465.3 at 2 MiB. The
// most measured, and each text's most, are in the parts' diagnostics; a text that passes 1,536 is a finding, not a
// reason to raise the bound. Nor may a text's work per character grow with its length: each find in a view was once
// checked by a search from the first covered stretch, about log2 of their count each, so that text read 1,513.3 at
// 32 KiB, 1,539.5 at 512 KiB and 1,546.7 at 2 MiB; it is searched forward from the find before now (coveringFrom).
// A stage that read again from the start at each find passes the text once per find:
// a held value found every 9 characters is found 14,563 times in 128 KiB, and one in every string of a JSON text (every
// 11 characters) 47,662 times in 512 KiB, which a join that passed the cuts from the first at each string reads about
// 2.3 billion times over.
const WORK = 1536;

// So that work per character does not grow with the text's length (counted, not timed), each adversarial text read at
// 512 KiB visits at most GROWTH more characters per character than the same text at 32 KiB, through the readers that
// read a text whole (redactSecrets and redactLearned): 0.9 at most now (the text of a hundred single-quoted strings);
// each find searched for from the first covered stretch read 2.2 to 14.9 more on seven of these texts. The readers that
// read in pieces of 8,192 characters are left out: a piece's work depends on where in the text's repeating unit it
// starts, and 32 KiB is four or five pieces, so their work per character there is a sample of a few starts (the prose
// text's pieces at 32 KiB all start where a piece reads least: 939.3 per character, then 955.9 at 128 KiB and 957.2 at
// 2 MiB). So are a held RSA key's texts: the key is made anew each run, and with some keys its lines in reverse order
// read about 10 more per character at one length than at the others, in no order of length (one key 256.5, 266.9 and
// 256.4 at 32, 128 and 512 KiB, another 267.2, 267.0 and 256.3).
const GROWTH = 2;
const WHOLE = new Set(["redactSecrets", "redactLearned"]);

/** The parts the work count runs in: part k (redact-contract-work-<k>.test.mjs) reads the texts whose index in
 *  adversarial(size) is k - 1 modulo WORK_PARTS. */
export const WORK_PARTS = 6;

/** The work count's test name for part `k`, its texts named. */
export const workPartName = (k) =>
  `adversarial texts: the characters the whole pipeline visits are at most WORK per character, at 32 KiB, 128 KiB and 512 KiB, and at most GROWTH more at 512 KiB than at 32 KiB (part ${k} of ${WORK_PARTS}: the texts whose index is ${k - 1} modulo ${WORK_PARTS})`;

/** The work count over part `k`'s texts, each at 32 KiB, 128 KiB and 512 KiB through every reader. */
export async function adversarialWork(t, k) {
  const { scanned } = await import("../../dist/redact/match.js");
  const over = [];
  const grown = [];
  const sizes = [32 * 1024, 128 * 1024, 512 * 1024];
  const first = new Map();
  let growth = { rise: -Infinity, where: "" };
  for (const size of sizes) {
    let most = 0;
    let where = "";
    for (const [i, { text, values }] of adversarial(size).entries()) {
      if (i % WORK_PARTS !== k - 1) continue;
      let its = 0;
      let by = "";
      for (const [name, read] of Object.entries(READERS)) {
        scanned.chars = 0;
        read(text, values);
        const per = scanned.chars / text.length;
        if (per > its) [its, by] = [per, name];
        if (per > most) [most, where] = [per, `${name} ${short(text)}`];
        if (scanned.chars > WORK * text.length) over.push(`${size}: ${name} ${short(text)}: ${scanned.chars} for ${text.length}`);
        if (!WHOLE.has(name) || values.includes(RSA_PEM)) continue;
        if (size === sizes[0]) first.set(`${i} ${name}`, per);
        else if (size === sizes.at(-1)) {
          const rise = per - first.get(`${i} ${name}`);
          if (rise > growth.rise) growth = { rise, where: `${name} ${short(text)}` };
          if (rise > GROWTH) grown.push(`${name} ${short(text)}: ${first.get(`${i} ${name}`).toFixed(1)} at 32 KiB, ${per.toFixed(1)} at 512 KiB`);
        }
      }
      // Each text's most, so a change that moves one text shows up here.
      t.diagnostic(`${size / 1024} KiB: ${its.toFixed(1)} per character, ${by}, ${short(text)}`);
    }
    t.diagnostic(`${size / 1024} KiB: the most characters visited per character of a text: ${most.toFixed(1)}, ${where}`);
  }
  t.diagnostic(`the most a text read whole grew per character from 32 KiB to 512 KiB: ${growth.rise.toFixed(2)}, ${growth.where}`);
  assert.deepEqual({ over, grown }, { over: [], grown: [] });
}
