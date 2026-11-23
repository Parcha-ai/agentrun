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
  ["headers, each with an escaped body line and no END", fill(`${line("BEGIN", "")}\\n${"A".repeat(64)}\\n`)],
  ["a header, then escaped base64 lines with no END", headed(`${line("BEGIN", "")}\\n`, `${"A".repeat(64)}\\n`)],
  ["a header, then one run of backslashes", headed(`${line("BEGIN", "")}\\n`, "\\")],
  ["a body of backslash runs, each one too long for an escape", headed(`${line("BEGIN", "")}\\n`, `${"\\".repeat(9)}n`)],
  ["base64 lines of escaped slashes, each one backslash too many", headed(`${line("BEGIN", "")}\\n`, `${`${"\\".repeat(9)}/`.repeat(12)}\\n`)],
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
