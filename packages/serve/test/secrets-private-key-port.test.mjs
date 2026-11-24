// The private key Shape in redact/match.ts is a port, read by hand, of one regex: #3617's final rule. This test holds
// the port to that regex over a corpus: every text secrets-private-key.test.mjs's behaviour tests build (rebuilt here
// with fixed bodies), and generated layouts crossing an END line present, absent or past 16 KiB; seven line breaks;
// four kinds of blanks; three kinds of headers; five line ends; a body glued to its header; 1 and 3 lines, and 1,024
// and 1,025; a trailing prose line. Each text holds only PEM material and plain filler, so no other shape fires (checked
// on every text), and the Shape's spans must be the regex's matches: same starts, same ends. The one difference by
// design: a header with no line after it is cut alone by the Shape, and the regex matches nothing.
//
// The Shape's spans are read from cutSecrets(text, [], Infinity).spans, the spans redactSecrets cuts (merged over the
// secret shapes, which here are this one alone). match.ts has no export of one shape's spans, and none is added for
// this test. The regex's matches are merged the same way (redact/match.ts merged), so two blocks that touch compare as
// one span on both sides. Every body is fixed text, no random bytes, so every run reads the same corpus. No adversarial
// or long texts: secrets-private-key.test.mjs's work guards cover those.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cutSecrets, secretShapes } from "../dist/learn/secrets.js";
import { merged } from "../dist/redact/match.js";

// ---- The oracle: #3617's final rule, copied from its source at 1150c41eaf (packages/serve/src/learn/secrets.ts),
// the String.raw escapes byte for byte. Only the TypeScript return type of privateKeyLines is dropped (this is a .mjs).

/** A private key block, whole: its BEGIN line through its body to its END line, the key itself, not its header alone (a
 *  cut read serves a run's whole file). The header's key type (RSA, EC, OPENSSH, ENCRYPTED, an armored key's "PGP ...
 *  BLOCK") is at most 64 characters each side: two unbounded runs read a long header of repeated words in quadratic time
 *  (24 s over 256 KiB of "PRIVATE KEY "). With its END line within 16 KiB, all between is cut, whatever wraps the body's
 *  lines (a code string literal on each, a "#" or ">" before each, an XML or HTML line break, an escape, an armored key's
 *  headers): the body is any character but a "-" followed by "----", so a reading from one BEGIN stops at the next
 *  "-----", and a text of repeated headers reads in linear time. With no END line in reach (a key cut short, one past the
 *  bound, or one the edge of a window key-refusal.ts reads crosses), it is cut through its body's lines
 *  (PRIVATE_KEY_LINES). */
const PRIVATE_KEY = new RegExp(String.raw`-----BEGIN[ A-Z0-9]{0,64}PRIVATE KEY[ A-Z0-9]{0,64}-----(?:(?:[^-]|-(?!----)){0,16384}?-----END[ A-Z0-9]{0,64}PRIVATE KEY[ A-Z0-9]{0,64}-----|${privateKeyLines()})`);

/** A key's body lines when no END line is in reach: the first maybe glued to its header, at most 1,024 lines in all. A
 *  line break is LF, CRLF or CR, or one escaped in a quoted string ("\n", "\r\n", "\\n" in a string within a string: at
 *  most 8 backslashes, four strings deep). A line is blanks (a space, a tab, or an escaped tab), then base64 of at most
 *  16,384 characters (its slashes maybe escaped, "\/"), or a legacy PEM's or armored key's header (Proc-Type, DEK-Info,
 *  Version, Comment) of at most 256 after its colon, or nothing (a blank line), then blanks; it ends at a line break or
 *  a closing quote (either maybe escaped), an XML or HTML tag's "<", or the text's end. Text after the body that is no
 *  such line (prose, a field) stays. Each part is bounded and no two of a line's parts take the same character but the
 *  header's blanks, at most 256: the reading stays linear. */
function privateKeyLines() {
  const lineBreak = String.raw`(?:\r\n?|\n|\\{1,8}r(?:\\{1,8}n)?|\\{1,8}n)`;
  const blank = String.raw`(?:[ \t]|\\{1,8}t)`;
  const line = String.raw`${blank}*(?:(?:(?:[A-Za-z0-9+=]|\\{0,8}\/){1,16384}|(?:Proc-Type|DEK-Info|Version|Comment):[^\r\n\\"'<]{0,256})${blank}*)?(?=[\r\n"'<]|\\{1,8}[rn"']|$)`;
  return `${lineBreak}?${line}(?:${lineBreak}${line}){0,1023}`;
}

/** Every match of the oracle in `text`, each read on from the last one's end, merged as the Shape's spans are. */
const oracle = (text) => merged([...text.matchAll(new RegExp(PRIVATE_KEY.source, "g"))].map((m) => [m.index, m.index + m[0].length]));
/** The Shape's spans: what redactSecrets cuts in place, with no held value. */
const shaped = (text) => {
  const cut = cutSecrets(text, [], Number.POSITIVE_INFINITY);
  return cut === "whole" ? "whole" : cut.spans;
};

// ---- Fixed PEM material. No key-shaped literal in the source; every block is made at runtime.
const dashes = "-".repeat(5);
const PK = ["PRIVATE", "KEY"].join(" ");
const line = (kind, type) => `${dashes}${kind} ${type}${PK}${dashes}`;
const pgp = (kind) => `${dashes}${kind} PGP ${PK} BLOCK${dashes}`;
/** Base64 characters with no other secret's prefix in any run of them (no "A", "e", "J", "o", "-" or "_"). */
const ALPHABET = "Q2Fz/b3+Lm9pWx7Rk4Td";
/** Body line `i`, `n` characters: a fixed run of ALPHABET, then `i` in base 36 (3 characters). */
const bodyLine = (i, n = 64) => {
  const from = i % ALPHABET.length;
  return ALPHABET.repeat(Math.ceil(n / ALPHABET.length) + 2).slice(from, from + n - 3) + i.toString(36).padStart(3, "0");
};
const lines = (count, n = 64) => Array.from({ length: count }, (_, i) => bodyLine(i, n));
const body = (count) => lines(count).join("\n");
const block = (type, inner) => `${line("BEGIN", type)}\n${inner}\n${line("END", type)}`;
const lines20 = () => ["A/+B".repeat(16), ...lines(19)];
const armor = (rest) => `Version: OpenPGP v4.10.10\nComment: made for a test\n\n${rest.join("\n")}\n=Q2Fz`;
const DEK = "DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF";

/** The texts secrets-private-key.test.mjs's behaviour tests build, each as [name, text], with fixed bodies. */
function behaviourTexts() {
  const out = [];
  const rest = "the rest stays.";
  for (const [name, key] of [
    ["PKCS#8", block("", body(26))],
    ["RSA", block("RSA ", body(25))],
    ["EC", block("EC ", body(3))],
    ["OPENSSH", block("OPENSSH ", body(6))],
    ["encrypted PKCS#8", block("ENCRYPTED ", body(28))],
    ["legacy encrypted RSA", block("RSA ", `Proc-Type: 4,ENCRYPTED\n${DEK}\n\n${body(25)}`)],
    ["CRLF line ends", block("", body(10)).replaceAll("\n", "\r\n")],
  ]) out.push([`whole block: ${name}`, `config:\n${key}\nthe rest stays.\n`]);
  out.push(["two whole blocks", `a\n${block("RSA ", body(4))}\nbetween\n${block("EC ", body(2))}\nz`]);
  out.push(["no END, prose after", `key:\n${line("BEGIN", "RSA ")}\n${body(8)}\nthe file was cut short here.\n`]);
  out.push(["no END, then a whole block", `${line("BEGIN", "RSA ")}\n${body(2)}\n${block("EC ", body(2))}\nz`]);
  out.push(["END past 16 KiB", `${line("BEGIN", "")}\n${body(300)}\n${line("END", "")}\nafter\n`]);
  out.push(["END within 16 KiB", `${line("BEGIN", "")}\n${body(240)}\n${line("END", "")}\nafter\n`]);
  const slashes = "A/+B".repeat(16);
  for (const [name, pem] of [["PKCS#8", block("", `${slashes}\n${body(26)}`)], ["RSA", block("RSA ", `${slashes}\n${body(25)}`)], ["OPENSSH", block("OPENSSH ", `${slashes}\n${body(6)}`)], ["CRLF line ends", block("", `${slashes}\n${body(10)}`).replaceAll("\n", "\r\n")]]) {
    const text = JSON.stringify({ type: "service_account", private_key: pem, client_email: "bot@example.test" });
    out.push([`JSON string: ${name}`, text]);
    out.push([`JSON string: ${name}, nested`, JSON.stringify({ config: JSON.stringify({ private_key: pem }) })]);
    out.push([`JSON string: ${name}, slashes escaped`, text.replaceAll("/", "\\/")]);
  }
  out.push(["JSON, no END", JSON.stringify({ private_key: `${line("BEGIN", "RSA ")}\n${body(8)}`, after: "kept" })]);
  out.push(["JSON, no END, CRLF", JSON.stringify({ private_key: `${line("BEGIN", "")}\n${body(8)}`.replaceAll("\n", "\r\n"), after: "kept" })]);
  out.push(["JSON, no END, slashes escaped", JSON.stringify({ private_key: `${line("BEGIN", "")}\n${slashes}\n${body(8)}`, after: "kept" }).replaceAll("/", "\\/")]);
  out.push(["JSON, no END, prose after", JSON.stringify({ private_key: `${line("BEGIN", "")}\n${body(8)}\nthe file was cut short here.` })]);
  out.push(["JSON, no END, then a whole block", JSON.stringify({ a: `${line("BEGIN", "RSA ")}\n${body(2)}\n${block("EC ", body(2))}` })]);
  const many = lines(1100);
  out.push(["no END, 1,100 lines", `${line("BEGIN", "")}\n${many.join("\n")}\n`]);
  const B = line("BEGIN", "RSA "), E = line("END", "RSA ");
  for (const [name, make] of [
    ["code string literals", (l) => [`const k = "${B}\\n" +`, ...l.map((x) => `  "${x}\\n" +`), `  "${E}";`, "after"].join("\n")],
    ["# comment prefix", (l) => [`# ${B}`, ...l.map((x) => `# ${x}`), `# ${E}`, "after"].join("\n")],
    ["> quote prefix", (l) => [`> ${B}`, ...l.map((x) => `> ${x}`), `> ${E}`, "after"].join("\n")],
    ["tab indents", (l) => ["key: |", `\t${B}`, ...l.map((x) => `\t${x}`), `\t${E}`, "next: 1"].join("\n")],
    ["escaped tabs in JSON", (l) => JSON.stringify({ k: `${B}\n${l.map((x) => `\t${x}`).join("\n")}\n${E}\n`, n: 1 })],
    ["XML &#13; line ends", (l) => `<k>${B}&#13;\n${l.join("&#13;\n")}&#13;\n${E}</k>`],
    ["HTML <br> line breaks", (l) => `<p>${B}<br>${l.join("<br>")}<br>${E}</p>`],
    ["an armored key's Version and Comment headers", (l) => `${pgp("BEGIN")}\n${armor(l)}\n${pgp("END")}\nafter`],
    ['"+" escaped as \\u002b in JSON', (l) => JSON.stringify({ k: `${B}\n${l.join("\n")}\n${E}` }).replaceAll("+", "\\u002b")],
  ]) out.push([`wrapped, END: ${name}`, make(lines20())]);
  const A = line("BEGIN", "");
  for (const [name, make] of [
    ["one base64 line of 1,600 characters", () => `k:\n${A}\n${bodyLine(0, 1600)}\n${rest}\n`],
    ["a body glued to its header", (l) => `${A}${l.join("\n")}\n${rest}\n`],
    ["a blank line first", (l) => `${A}\n\n${l.join("\n")}\n${rest}\n`],
    ["a legacy PEM's Proc-Type and DEK-Info lines", (l) => `${line("BEGIN", "RSA ")}\nProc-Type: 4,ENCRYPTED\n${DEK}\n\n${l.join("\n")}\n${rest}\n`],
    ["an armored key's headers", (l) => `${pgp("BEGIN")}\n${armor(l)}\n${rest}\n`],
    ["lines indented by spaces (YAML)", (l) => `key: |\n  ${A}\n${l.map((x) => `  ${x}`).join("\n")}\nnext: ${rest}\n`],
    ["lines indented by tabs", (l) => `key: |\n\t${A}\n${l.map((x) => `\t${x}`).join("\n")}\nnext: ${rest}\n`],
    ["lines indented by escaped tabs (JSON)", (l) => JSON.stringify({ k: `${A}\n${l.map((x) => `\t${x}`).join("\n")}`, n: 1 })],
    ["a blank after each line", (l) => `${A}\n${l.map((x) => `${x} `).join("\n")}\n${rest}\n`],
    ["CR-only line ends", (l) => `${A}\r${l.join("\r")}\r${rest}\r`],
    ["the text's end right after its last line", (l) => `${A}\n${l.join("\n")}`],
    ["a single-quoted string's end", (l) => `k='${A}\\n${l.join("\\n")}'`],
    ["an XML element's end", (l) => `<k>${A}\n${l.join("\n")}</k>`],
    ["an OpenSSH key's 70-character lines", () => `${line("BEGIN", "OPENSSH ")}\n${lines(20, 70).join("\n")}\n${rest}\n`],
  ]) out.push([`no END: ${name}`, make(lines20())]);
  const nest = (inner, depth) => (depth === 0 ? inner : JSON.stringify({ k: nest(inner, depth - 1) }));
  const deep = (slash) => `${A}\n${lines20().map((x) => `\t${slash ? x.replaceAll("/", "\\/") : x}`).join("\n")}`;
  for (const [depth, slash] of [[3, false], [4, false], [3, true]]) out.push([`no END, ${depth} strings deep${slash ? ", slashes escaped" : ""}`, nest(deep(slash), depth)]);
  const long = (n) => "Q".repeat(n - 1) + "R";
  out.push(["a body line of 16,384 characters", `${A}\n${long(16384)}\nafter it`]);
  out.push(["a body line of 16,385 characters", `${A}\n${long(16385)}\nafter it`]);
  return out;
}

/** Generated layouts, each as [name, text]: a fixed cross, the line count, glue, prose and line end cycled by index. */
function generatedTexts() {
  const BREAKS = [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"], ["\\n", "\\n"], ["\\r\\n", "\\r\\n"], ["\\\\n", "\\\\n"], ["\\\\\\\\n", "\\\\\\\\n"]];
  const BLANKS = [["no blanks", ""], ["spaces", "  "], ["tabs", "\t"], ["escaped tabs", "\\t"]];
  const HEADERS = ["no header", "Proc-Type and DEK-Info", "Version and Comment"];
  const ENDS = [["the text's end", ""], ['"', '"}'], ["'", "'"], ["<", "</k>"], ['\\"', '\\"}']];
  const TYPES = ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "];
  const out = [];
  /** One block: `end` "present", "absent" or "past" (an END line past 16 KiB of body). */
  const make = ({ end, br, bl, header, count, glued, prose, close, type }) => {
    const pgpKey = header === "Version and Comment";
    const [begin, finish] = pgpKey ? [pgp("BEGIN"), pgp("END")] : [line("BEGIN", type), line("END", type)];
    const head = header === "Proc-Type and DEK-Info" ? ["Proc-Type: 4,ENCRYPTED", DEK, ""] : pgpKey ? ["Version: v1 test", "Comment: made for a test", ""] : [];
    const rows = [...head, ...lines(count).map((x) => `${bl}${x}`)];
    const inner = `${glued ? "" : br}${rows.join(br)}`;
    const after = `${prose ? `${br}the rest stays.` : ""}${close}`;
    return `config: ${begin}${inner}${end === "absent" ? "" : `${br}${finish}`}${after}`;
  };
  let index = 0;
  for (const end of ["present", "absent"]) {
    for (const [brName, br] of BREAKS) {
      for (const [blName, bl] of BLANKS) {
        for (const header of HEADERS) {
          const [closeName, close] = ENDS[index % ENDS.length];
          const count = index % 2 === 0 ? 1 : 3;
          const glued = Math.floor(index / 2) % 2 === 1;
          const prose = Math.floor(index / 3) % 2 === 1;
          const type = TYPES[index % TYPES.length];
          index++;
          const text = make({ end, br, bl, header, count, glued, prose, close, type });
          out.push([`END ${end}, ${brName}, ${blName}, ${header}, ${count} line(s)${glued ? ", glued" : ""}${prose ? ", prose after" : ""}, ends at ${closeName}`, text]);
        }
      }
    }
  }
  // An END line past 16 KiB of body: 260 lines of 64 characters, each line break included.
  for (const [brName, br] of BREAKS) {
    for (const header of HEADERS) {
      out.push([`END past 16 KiB, ${brName}, ${header}`, make({ end: "past", br, bl: "", header, count: 260, glued: false, prose: true, close: "", type: "RSA " })]);
    }
  }
  // The line cap: 1,024 lines are all cut; of 1,025, the last stays.
  for (const count of [1024, 1025]) {
    out.push([`no END, ${count} lines`, `${line("BEGIN", "")}\n${body(count)}\nthe rest stays.\n`]);
  }
  return out;
}

const CORPUS = [...behaviourTexts(), ...generatedTexts()];

const shown = (text) => JSON.stringify(text.length <= 2000 ? text : `${text.slice(0, 1000)} ... ${text.slice(-200)}`);

test(`the private key Shape cuts what #3617's regex matches, over ${CORPUS.length} texts: same starts, same ends`, () => {
  const differ = [];
  for (const [name, text] of CORPUS) {
    const kinds = secretShapes(text);
    if (kinds.length !== 1 || kinds[0] !== "private key block") differ.push(`${name}: shapes ${JSON.stringify(kinds)} (only the private key block should fire)`);
    const [want, got] = [oracle(text), shaped(text)];
    if (want.length === 0) differ.push(`${name}: the regex matches nothing (no text in the corpus should be a header alone)`);
    if (JSON.stringify(got) !== JSON.stringify(want)) differ.push(`${name}: regex ${JSON.stringify(want)}, Shape ${JSON.stringify(got)}, text ${shown(text)}`);
  }
  assert.deepEqual(differ, []);
});

// The one difference by design: a header with no line after it, not even an empty one (prose on its line, another
// header glued to it). The regex matches nothing there; the Shape cuts the header alone, as the header shape before it
// did (secrets-private-key.test.mjs's control).
test("a private key header with no line after it: the regex matches nothing, the Shape cuts the header alone (the one difference by design)", () => {
  const header = line("BEGIN", "RSA ");
  const prose = `${header} and more words\n`;
  assert.deepEqual(oracle(prose), []);
  assert.deepEqual(shaped(prose), [[0, header.length]]);
  const one = line("BEGIN", "");
  const glued = `${one}${one} end.`;
  assert.deepEqual(oracle(glued), []);
  assert.deepEqual(shaped(glued), [[0, 2 * one.length]]);
});
