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
});

test("a private key body is bounded: an END line past 16 KiB is not reached, and the base64 lines after the header are cut all the same", () => {
  const text = `${line("BEGIN", "")}\n${body(300)}\n${line("END", "")}\nafter\n`;
  const cut = redactSecrets(text, [], Buffer.byteLength(text));
  assert.ok(!/[A-Za-z0-9+/]{64}/.test(cut), "no body line survives");
  assert.ok(cut.endsWith("\nafter\n"), cut.slice(-80));
});

// The block's adversarial inputs of 256 KiB (a cut read's cap): headers repeated with a body line and no END, a header
// then one endless run, a header then endless base64 lines, headers glued by dashes, and a body of near-END dashes. Each,
// through redactSecrets and redactLearned, finishes in under 1 s.
const SIZE = 256 * 1024;
const fill = (unit) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
const headed = (prefix, rest) => prefix + fill(rest).slice(prefix.length);
const ADVERSARIAL = [
  ["headers, each with a body line and no END", fill(`${line("BEGIN", "")}\n${"A".repeat(64)}\n`)],
  ["a header, then one run with no line end", headed(`${line("BEGIN", "RSA ")}\n`, "A")],
  ["a header, then base64 lines with no END", headed(`${line("BEGIN", "")}\n`, `${"A".repeat(64)}\n`)],
  ["headers glued by their dashes", fill(line("BEGIN", ""))],
  ["a body of dashes short of an END", headed(`${line("BEGIN", "")}\n`, "----A")],
  ["a body of END lines of another kind", headed(`${line("BEGIN", "")}\n`, `${dashes}END CERTIFICATE${dashes}\n`)],
];
for (const [name, text] of ADVERSARIAL) {
  test(`private key block: ${name}, 256 KiB, is redacted in under 1 s`, () => {
    for (const redact of [redactSecrets, redactLearned]) {
      const began = performance.now();
      redact(text, [], Buffer.byteLength(text));
      const took = performance.now() - began;
      assert.ok(took < 1000, `${redact.name}: took ${Math.round(took)} ms`);
    }
  });
}
