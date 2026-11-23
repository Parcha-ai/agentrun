// A private key block is cut whole, its header through its base64 body to its END line, not its BEGIN line alone: a cut
// read serves a run's whole file, so a key file's body, the key itself, must not survive the cut. The body is bounded
// (16 KiB), and a block with no END within it (a key cut short) is cut through the base64 lines after its header. Every
// block is made at runtime, so the source holds no key-shaped literal.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { redactLearned, redactSecrets } from "../dist/learn/secrets.js";

const dashes = "-".repeat(5);
const line = (kind, type) => `${dashes}${kind} ${type}${["PRIVATE", "KEY"].join(" ")}${dashes}`;
/** `n` base64 lines of 64 characters, as PEM writes a body. */
const body = (n) => randomBytes(48 * n).toString("base64").match(/.{1,64}/g).join("\n");
const block = (type, inner) => `${line("BEGIN", type)}\n${inner}\n${line("END", type)}`;

test("a private key block is cut from its BEGIN line through its body to its END line, whatever its key type", () => {
  const cases = [
    ["PKCS#8", block("", body(26))],
    ["RSA", block("RSA ", body(25))],
    ["EC", block("EC ", body(3))],
    ["OPENSSH", block("OPENSSH ", body(6))],
    ["encrypted PKCS#8", block("ENCRYPTED ", body(28))],
    // A legacy encrypted PEM: its Proc-Type and DEK-Info headers and a blank line before the body.
    ["legacy encrypted RSA", block("RSA ", `Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,${randomBytes(16).toString("hex").toUpperCase()}\n\n${body(25)}`)],
    ["CRLF line ends", block("", body(10)).replaceAll("\n", "\r\n")],
  ];
  for (const [name, key] of cases) {
    const text = `config:\n${key}\nthe rest stays.\n`;
    const cut = redactSecrets(text, [], Buffer.byteLength(text));
    assert.equal(cut, "config:\n[redacted]\nthe rest stays.\n", name);
  }
  // Two blocks, each cut alone, and the text between them stays.
  const two = `a\n${block("RSA ", body(4))}\nbetween\n${block("EC ", body(2))}\nz`;
  assert.equal(redactSecrets(two, [], Buffer.byteLength(two)), "a\n[redacted]\nbetween\n[redacted]\nz");
});

test("a private key block with no END line (cut short) is cut through the base64 lines after its header, and the prose after them stays", () => {
  const text = `key:\n${line("BEGIN", "RSA ")}\n${body(8)}\nthe file was cut short here.\n`;
  assert.equal(redactSecrets(text, [], Buffer.byteLength(text)), "key:\n[redacted]\nthe file was cut short here.\n");
  // A key cut short right before a whole one: the reading from the first BEGIN stops at the next "-----", so each is
  // its own block, and the first never runs on to the second's END line.
  const two = `${line("BEGIN", "RSA ")}\n${body(2)}\n${block("EC ", body(2))}\nz`;
  assert.equal(redactSecrets(two, [], Buffer.byteLength(two)), "[redacted]\n[redacted]\nz");
});

test("a private key body is bounded: an END line past 16 KiB is not reached, and the base64 lines after the header are cut all the same", () => {
  // 300 lines of 65 bytes: about 19 KiB, past the bound. The END line is never reached, so it stays, after the cut lines.
  const text = `${line("BEGIN", "")}\n${body(300)}\n${line("END", "")}\nafter\n`;
  assert.equal(redactSecrets(text, [], Buffer.byteLength(text)), `[redacted]\n${line("END", "")}\nafter\n`);
  // Within the bound, the END line is reached and cut with the block.
  const within = `${line("BEGIN", "")}\n${body(240)}\n${line("END", "")}\nafter\n`;
  assert.equal(redactSecrets(within, [], Buffer.byteLength(within)), "[redacted]\nafter\n");
});

// A key kept in a quoted string writes its line breaks as escapes: JSON.stringify writes "\n" (and "\r\n" for CRLF), a
// JSON string within a JSON string "\\n", and some encoders write "/" as "\/". The block is cut whole all the same, with
// no held value to cut it by.
test("a private key block kept in a JSON string, its line breaks escaped, is cut whole", () => {
  // Every case has slashes in its body: a fixed line of them, not left to the random bytes.
  const slashes = "A/+B".repeat(16);
  const pems = [["PKCS#8", block("", `${slashes}\n${body(26)}`)], ["RSA", block("RSA ", `${slashes}\n${body(25)}`)], ["OPENSSH", block("OPENSSH ", `${slashes}\n${body(6)}`)], ["CRLF line ends", block("", `${slashes}\n${body(10)}`).replaceAll("\n", "\r\n")]];
  for (const [name, pem] of pems) {
    const text = JSON.stringify({ type: "service_account", private_key: pem, client_email: "bot@example.test" });
    assert.equal(redactSecrets(text, [], Buffer.byteLength(text)), JSON.stringify({ type: "service_account", private_key: "[redacted]", client_email: "bot@example.test" }), name);
    // A JSON string within a JSON string: each escape doubled.
    const nested = JSON.stringify({ config: JSON.stringify({ private_key: pem }) });
    assert.equal(redactSecrets(nested, [], Buffer.byteLength(nested)), JSON.stringify({ config: JSON.stringify({ private_key: "[redacted]" }) }), `${name}, nested`);
    // Its slashes escaped too.
    const slashed = text.replaceAll("/", "\\/");
    assert.equal(redactSecrets(slashed, [], Buffer.byteLength(slashed)), JSON.stringify({ type: "service_account", private_key: "[redacted]", client_email: "bot@example.test" }), `${name}, slashes escaped`);
  }
});

test("a private key block in a JSON string with no END line is cut through its escaped base64 lines, and the text after them stays", () => {
  const text = JSON.stringify({ private_key: `${line("BEGIN", "RSA ")}\n${body(8)}`, after: "kept" });
  assert.equal(redactSecrets(text, [], Buffer.byteLength(text)), JSON.stringify({ private_key: "[redacted]", after: "kept" }));
  // CRLF line ends ("\r\n" escaped), and slashes escaped ("\/"), a fixed line of them.
  const crlf = JSON.stringify({ private_key: `${line("BEGIN", "")}\n${body(8)}`.replaceAll("\n", "\r\n"), after: "kept" });
  assert.equal(redactSecrets(crlf, [], Buffer.byteLength(crlf)), JSON.stringify({ private_key: "[redacted]", after: "kept" }), "CRLF");
  const slashed = JSON.stringify({ private_key: `${line("BEGIN", "")}\n${"A/+B".repeat(16)}\n${body(8)}`, after: "kept" }).replaceAll("/", "\\/");
  assert.equal(redactSecrets(slashed, [], Buffer.byteLength(slashed)), JSON.stringify({ private_key: "[redacted]", after: "kept" }), "slashes escaped");
  const prose = JSON.stringify({ private_key: `${line("BEGIN", "")}\n${body(8)}\nthe file was cut short here.` });
  assert.equal(redactSecrets(prose, [], Buffer.byteLength(prose)), JSON.stringify({ private_key: "[redacted]\nthe file was cut short here." }));
  // A key cut short right before a whole one, both escaped: each is its own block.
  const two = JSON.stringify({ a: `${line("BEGIN", "RSA ")}\n${body(2)}\n${block("EC ", body(2))}` });
  assert.equal(redactSecrets(two, [], Buffer.byteLength(two)), JSON.stringify({ a: "[redacted]\n[redacted]" }));
});

test("a private key block with no END line is cut through at most 1,024 base64 lines after its header", () => {
  const lines = body(1100).split("\n");
  const text = `${line("BEGIN", "")}\n${lines.join("\n")}\n`;
  assert.equal(redactSecrets(text, [], Buffer.byteLength(text)), `[redacted]\n${lines.slice(1024).join("\n")}\n`);
});

// Wrapping outside base64 around a block's lines: a code string literal on each line, a comment or quote prefix, an
// escaped tab, an XML or HTML line break, an armored key's headers, an escaped "+". With its END line in reach, the block
// is cut from its BEGIN line to its END line whatever lies between (but a run of five dashes), so none of it shows.
const PK = ["PRIVATE", "KEY"].join(" ");
const pgp = (kind) => `${dashes}${kind} PGP ${PK} BLOCK${dashes}`;
/** 20 base64 lines of 64 characters, the first a fixed one with "/" and "+" in it, as an array. */
const lines20 = () => [`${"A/+B".repeat(16)}`, ...body(19).split("\n")];
const armor = (rest) => `Version: OpenPGP.js v4.10.10\nComment: https://openpgpjs.org\n\n${rest.join("\n")}\n=${randomBytes(3).toString("base64")}`;

test("a private key block with its END line is cut whole whatever wraps its lines: code string literals, comment and quote prefixes, indents, escaped tabs, XML and HTML line breaks, an armored key's headers, an escaped +", async (t) => {
  const B = line("BEGIN", "RSA "), E = line("END", "RSA ");
  const cases = [
    ["code string literals", (l) => [`const k = "${B}\\n" +`, ...l.map((x) => `  "${x}\\n" +`), `  "${E}";`, "after"].join("\n"), 'const k = "[redacted]";\nafter'],
    ["# comment prefix", (l) => [`# ${B}`, ...l.map((x) => `# ${x}`), `# ${E}`, "after"].join("\n"), "# [redacted]\nafter"],
    ["> quote prefix", (l) => [`> ${B}`, ...l.map((x) => `> ${x}`), `> ${E}`, "after"].join("\n"), "> [redacted]\nafter"],
    ["tab indents", (l) => ["key: |", `\t${B}`, ...l.map((x) => `\t${x}`), `\t${E}`, "next: 1"].join("\n"), "key: |\n\t[redacted]\nnext: 1"],
    ["escaped tabs in JSON", (l) => JSON.stringify({ k: `${B}\n${l.map((x) => `\t${x}`).join("\n")}\n${E}\n`, n: 1 }), JSON.stringify({ k: "[redacted]\n", n: 1 })],
    ["XML &#13; line ends", (l) => `<k>${B}&#13;\n${l.join("&#13;\n")}&#13;\n${E}</k>`, "<k>[redacted]</k>"],
    ["HTML <br> line breaks", (l) => `<p>${B}<br>${l.join("<br>")}<br>${E}</p>`, "<p>[redacted]</p>"],
    ["an armored key's Version and Comment headers", (l) => `${pgp("BEGIN")}\n${armor(l)}\n${pgp("END")}\nafter`, "[redacted]\nafter"],
    ['"+" escaped as \\u002b in JSON', (l) => JSON.stringify({ k: `${B}\n${l.join("\n")}\n${E}` }).replaceAll("+", "\\u002b"), JSON.stringify({ k: "[redacted]" })],
  ];
  for (const [name, make, want] of cases) {
    await t.test(name, () => {
      const text = make(lines20());
      assert.equal(redactSecrets(text, [], Buffer.byteLength(text)), want);
    });
  }
});

// With no END line in reach (a key cut short, or one a window of a text crosses at its edge: key-refusal.ts reads a
// window before it redacts), the block is cut through its body's lines, however they are laid out. Text after the body
// that isn't a line of it stays.
test("a private key block with no END line is cut through its body's lines however they are laid out, and the text after them stays", async (t) => {
  const B = line("BEGIN", "");
  const rest = "the rest stays.";
  const cases = [
    ["one base64 line of 1,600 characters", (l) => `k:\n${B}\n${randomBytes(1200).toString("base64")}\n${rest}\n`, `k:\n[redacted]\n${rest}\n`],
    ["a body glued to its header", (l) => `${B}${l.join("\n")}\n${rest}\n`, `[redacted]\n${rest}\n`],
    ["a blank line first", (l) => `${B}\n\n${l.join("\n")}\n${rest}\n`, `[redacted]\n${rest}\n`],
    ["a legacy PEM's Proc-Type and DEK-Info lines and the blank line after", (l) => `${line("BEGIN", "RSA ")}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,${randomBytes(16).toString("hex").toUpperCase()}\n\n${l.join("\n")}\n${rest}\n`, `[redacted]\n${rest}\n`],
    ["an armored key's headers", (l) => `${pgp("BEGIN")}\n${armor(l)}\n${rest}\n`, `[redacted]\n${rest}\n`],
    ["lines indented by spaces (YAML)", (l) => `key: |\n  ${B}\n${l.map((x) => `  ${x}`).join("\n")}\nnext: ${rest}\n`, `key: |\n  [redacted]\nnext: ${rest}\n`],
    ["lines indented by tabs", (l) => `key: |\n\t${B}\n${l.map((x) => `\t${x}`).join("\n")}\nnext: ${rest}\n`, `key: |\n\t[redacted]\nnext: ${rest}\n`],
    ["lines indented by escaped tabs (JSON)", (l) => JSON.stringify({ k: `${B}\n${l.map((x) => `\t${x}`).join("\n")}`, n: 1 }), JSON.stringify({ k: "[redacted]", n: 1 })],
    ["a blank after each line", (l) => `${B}\n${l.map((x) => `${x} `).join("\n")}\n${rest}\n`, `[redacted]\n${rest}\n`],
    ["CR-only line ends", (l) => `${B}\r${l.join("\r")}\r${rest}\r`, `[redacted]\r${rest}\r`],
    ["the text's end right after its last line", (l) => `${B}\n${l.join("\n")}`, "[redacted]"],
    ["a single-quoted string's end", (l) => `k='${B}\\n${l.join("\\n")}'`, "k='[redacted]'"],
    ["an XML element's end", (l) => `<k>${B}\n${l.join("\n")}</k>`, "<k>[redacted]</k>"],
    ["an OpenSSH key's 70-character lines", () => `${line("BEGIN", "OPENSSH ")}\n${randomBytes(52 * 27).toString("base64").match(/.{1,70}/g).join("\n")}\n${rest}\n`, `[redacted]\n${rest}\n`],
  ];
  for (const [name, make, want] of cases) {
    await t.test(name, () => {
      const text = make(lines20());
      assert.equal(redactSecrets(text, [], Buffer.byteLength(text)), want);
    });
  }
});

test("a private key block with no END line, kept in a JSON string three and four strings deep (each escape 4 and 8 backslashes), is cut through its lines", () => {
  // Its lines tab-indented, so each line break and each tab is escaped; its slashes escaped too ("\/") in one string
  // three deep, so a slash takes 8 backslashes before it.
  const pem = (slash) => `${line("BEGIN", "")}\n${lines20().map((x) => `\t${slash ? x.replaceAll("/", "\\/") : x}`).join("\n")}`;
  const nest = (inner, depth) => (depth === 0 ? inner : JSON.stringify({ k: nest(inner, depth - 1) }));
  for (const [depth, slash] of [[3, false], [4, false], [3, true]]) {
    const text = nest(pem(slash), depth);
    assert.equal(redactSecrets(text, [], Buffer.byteLength(text)), nest("[redacted]", depth), `${depth} deep${slash ? ", slashes escaped" : ""}`);
  }
});

test("a body line is at most 16,384 characters: one that long is cut, one longer is not read as a line", () => {
  const long = (n) => "A".repeat(n - 1) + "B";
  const at = `${line("BEGIN", "")}\n${long(16384)}\nafter it`;
  assert.equal(redactSecrets(at, [], Buffer.byteLength(at)), "[redacted]\nafter it");
  const past = `${line("BEGIN", "")}\n${long(16385)}\nafter it`;
  assert.equal(redactSecrets(past, [], Buffer.byteLength(past)), `[redacted]\n${long(16385)}\nafter it`);
});

// The block's adversarial inputs, each at 256 KiB (a cut read's cap) and at 4 MiB: through redactSecrets and redactLearned
// each finishes in under 1 s at 256 KiB and under 5 s at 4 MiB, so the reading stays linear (a quadratic one takes 256
// times as long at 16 times the size).
const fillTo = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const headedTo = (prefix, rest, size) => prefix + fillTo(rest, size).slice(prefix.length);
const bs = (n) => "\\".repeat(n);
const ADVERSARIAL = [
  ["headers, each with a body line and no END", (S) => fillTo(`${line("BEGIN", "")}\n${"A".repeat(64)}\n`, S)],
  ["a header, then one run with no line end", (S) => headedTo(`${line("BEGIN", "RSA ")}\n`, "A", S)],
  ["a header, then base64 lines with no END", (S) => headedTo(`${line("BEGIN", "")}\n`, `${"A".repeat(64)}\n`, S)],
  ["headers glued by their dashes", (S) => fillTo(line("BEGIN", ""), S)],
  ["a body of dashes short of an END", (S) => headedTo(`${line("BEGIN", "")}\n`, "----A", S)],
  ["a body of END lines of another kind", (S) => headedTo(`${line("BEGIN", "")}\n`, `${dashes}END CERTIFICATE${dashes}\n`, S)],
  ["headers, each with an escaped body line and no END", (S) => fillTo(`${line("BEGIN", "")}\\n${"A".repeat(64)}\\n`, S)],
  ["a header, then escaped base64 lines with no END", (S) => headedTo(`${line("BEGIN", "")}\\n`, `${"A".repeat(64)}\\n`, S)],
  ["a header, then one run of backslashes", (S) => headedTo(`${line("BEGIN", "")}\\n`, "\\", S)],
  ["a body of backslash runs, each one too long for an escape", (S) => headedTo(`${line("BEGIN", "")}\\n`, `${bs(9)}n`, S)],
  ["base64 lines of escaped slashes, each one backslash too many", (S) => headedTo(`${line("BEGIN", "")}\\n`, `${`${bs(9)}/`.repeat(12)}\\n`, S)],
  ["headers, each with a 16,383-character body run", (S) => fillTo(`${line("BEGIN", "")}${"A".repeat(16383)}\n`, S)],
  ["headers, each with a body of words that ends in four dashes", (S) => fillTo(`${line("BEGIN", "")}\n${"A ".repeat(8000)}----\n`, S)],
  ["a header, then 8-backslash escapes forever", (S) => headedTo(`${line("BEGIN", "")}\\n`, `${bs(8)}n`, S)],
  ["headers of repeated words with four dashes", (S) => fillTo(`${dashes}BEGIN ${`${PK} `.repeat(5)}----`, S)],
  ["headers with 64 blanks each side and no dashes", (S) => fillTo(`${dashes}BEGIN${" ".repeat(64)}${PK}${" ".repeat(64)}X`, S)],
  ["a header, then lines one character past the line cap", (S) => fillTo(`${line("BEGIN", "")}\n${"A".repeat(16385)}\n`, S)],
  ["a header, then lines of blanks with no line end", (S) => headedTo(`${line("BEGIN", "")}\n`, `${" \t".repeat(4096)}x`, S)],
  ["a header, then blank lines forever", (S) => headedTo(`${line("BEGIN", "")}\n`, " \n", S)],
  ["a header, then Comment lines forever", (S) => headedTo(`${line("BEGIN", "")}\n`, `Comment: ${"x".repeat(300)}\n`, S)],
  ["a header, then escaped CR and LF chains", (S) => headedTo(line("BEGIN", ""), `${bs(8)}r${bs(8)}n${"A".repeat(64)}`, S)],
  ["a body of dash runs, one and four", (S) => headedTo(`${line("BEGIN", "")}\n`, "-A----A", S)],
];
for (const [size, label, limit] of [[256 * 1024, "256 KiB", 1000], [4 * 1024 * 1024, "4 MiB", 5000]]) {
  for (const [name, make] of ADVERSARIAL) {
    test(`private key block: ${name}, ${label}, is redacted in under ${limit / 1000} s`, () => {
      const text = make(size);
      for (const redact of [redactSecrets, redactLearned]) {
        const began = performance.now();
        redact(text, [], Number.POSITIVE_INFINITY);
        const took = performance.now() - began;
        assert.ok(took < limit, `${redact.name}: took ${Math.round(took)} ms`);
      }
    });
  }
}
