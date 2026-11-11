// A held value as a path tool's error names it (#2154, after #2126's path spelling): its "//" collapsed, its "/./"
// dropped, and either written percent-encoded (a URL's path, a file:// error). Each spelling is found (valueMatcher)
// and cut in place (redactSecrets), the error's own words kept, never the value in any of its spellings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets, valueMatcher } from "../dist/learn/secrets.js";

/** Held values, plainly test values: one whose base64 has a "//", one holding a "/./" segment. */
const SLASHES = "Zm9vYmFy//cXV4YmF6cXV4Zm9v";
const DOT = "tok/./Zq8xKpLmNvBwQrTy";
const error = (path) => `ENOENT: no such file or directory, open '/work/${path}'`;
/** Every spelling of `value` the text must not hold after a cut. */
const spellings = (value) => [value, value.replace(/\/{2,}/g, "/"), value.replaceAll("/./", "/"), encodeURIComponent(value), encodeURIComponent(value.replace(/\/{2,}/g, "/")), encodeURIComponent(value.replaceAll("/./", "/"))];

const ROWS = [
  ["its \"//\" percent-encoded", SLASHES, encodeURIComponent(SLASHES)],
  ["its \"//\" collapsed, then percent-encoded", SLASHES, encodeURIComponent(SLASHES.replace(/\/{2,}/g, "/"))],
  ["its \"/./\" dropped", DOT, DOT.replaceAll("/./", "/")],
  ["its \"/./\" dropped, then percent-encoded", DOT, encodeURIComponent(DOT.replaceAll("/./", "/"))],
  ["its \"/./\" percent-encoded", DOT, encodeURIComponent(DOT)],
];

for (const [how, value, written] of ROWS) {
  test(`a held value written in a path error ${how} is found, and cut in place`, () => {
    const text = error(written);
    assert.equal(valueMatcher([value])(text), true, `found: ${text}`);
    const cut = redactSecrets(text, [value]);
    assert.equal(cut, "ENOENT: no such file or directory, open '/work/[redacted]'", `cut in place: ${cut}`);
    for (const spelling of spellings(value)) assert.equal(cut.includes(spelling), false, spelling);
  });
}
