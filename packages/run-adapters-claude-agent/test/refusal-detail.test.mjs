// The words a refused key's 401 gives the run (host/machine.ts refusalDetail): the provider's message, decoded as JSON
// decodes it, whether its body came whole or was cut short (the refusal reads at most 4 KB, for at most 2 s).
import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalDetail } from "../dist/host/machine.js";

const MESSAGE = 'The key "sk-…" was refused: café\nretry later';
const whole = JSON.stringify({ type: "error", error: { type: "authentication_error", message: MESSAGE } });

test("a whole 401 body: its message, decoded, first line", () => {
  assert.equal(refusalDetail(whole), 'The key "sk-…" was refused: café');
});

test("a 401 body cut after its message: the message decoded as the whole body's is, never its escapes", () => {
  const cut = whole.slice(0, whole.indexOf('"}') + 1);
  assert.ok(cut.includes('\\"') && cut.includes("\\n"), cut);
  assert.equal(refusalDetail(cut), 'The key "sk-…" was refused: café');
});

test("a 401 body cut inside its message, even mid-escape: the words that came, decoded", () => {
  const escaped = JSON.stringify({ error: { message: 'Key "x" refused: café' } }).replace("é", "\\u00e9");
  const at = escaped.indexOf("\\u00e9") + 3; // inside é
  assert.equal(refusalDetail(escaped.slice(0, at)), 'Key "x" refused: caf');
  assert.equal(refusalDetail(escaped.slice(0, escaped.indexOf('\\"') + 1)), "Key");
});

test("an escaped backslash before u00 is whole text, not a cut escape", () => {
  assert.equal(refusalDetail('{"error":{"message":"path C:\\\\u00'), "path C:\\u00");
});

test("a body that is no JSON: its text; one that is cut JSON with no message: nothing", () => {
  assert.equal(refusalDetail("User not found."), "User not found.");
  assert.equal(refusalDetail('{"type":"error","error":{"type":"authenti'), "");
});

test("a whole body with no string message (error null, or a message that is no string): no detail, never the raw JSON", () => {
  assert.equal(refusalDetail('{"error":null}'), "");
  assert.equal(refusalDetail('{"error":null,"code":401}'), "");
  assert.equal(refusalDetail('{"error":{"type":"authentication_error","message":42}}'), "");
  assert.equal(refusalDetail('{"error":{"message":{"text":"nested"}}}'), "");
});

test("control characters in the provider's words (ESC, CR, NUL, other C0 and C1) never reach the run's error", () => {
  assert.equal(refusalDetail(JSON.stringify({ error: { message: "bad\u001b key\r\u0000 here\u0085!" } })), "bad key here!");
  const cut = JSON.stringify({ error: { message: "cut\u0007 short\u009b" } });
  assert.equal(refusalDetail(cut.slice(0, cut.length - 3)), "cut short");
});
