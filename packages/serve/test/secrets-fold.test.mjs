// learning's matcher (learn/secrets.ts valueMatcher, and redactSecrets, which cuts what it finds) finds a sign-in
// pointer however its hex identifier is written: a Browserbase context `ctx/<uuid>` or a Kernel profile
// `agentrun-<hex>`, uppercased, its dashes dropped, both at once, or split by dashes where it had none. Each maximal run
// of a value's hex digits and separators ([-_:.]) holding at least 16 hex digits is folded (lowercased, separators
// gone), and looked for so in a text folded the same way. A shorter hex run is not folded, an unrelated UUID is not
// matched, and a value with no such run (a key in mixed case) is found as written only. A run that is only a key's tail
// (under half of it) is not folded: another value sharing it is not cut. The fold only adds cutting: a held key split by
// a line break is still seen whole and the text redacted whole, as before the fold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets, valueMatcher } from "../dist/learn/secrets.js";

/** Test values, never real ones: a Browserbase context and a Kernel profile, as a sign-in holds them. */
const CONTEXT = "ctx/c2e85e3f-ae11-4df6-aae7-2930a7ba4f19";
const UUID = "c2e85e3f-ae11-4df6-aae7-2930a7ba4f19";
const PROFILE = "agentrun-3f9a0c1e7b2d4a6f8e1c";
const PROFILE_HEX = "3f9a0c1e7b2d4a6f8e1c";

/** Each way a note may write `value`'s identifier that the matcher did not find before: by name, the text. */
const FORMS = {
  context: {
    uppercased: `Open ${UUID.toUpperCase()} first.`,
    "dash-stripped": `Open ${UUID.replaceAll("-", "")} first.`,
    "uppercased and dash-stripped": `Open ${UUID.replaceAll("-", "").toUpperCase()} first.`,
    "the whole pointer uppercased": `Open ctx/${UUID.toUpperCase()} first.`,
    "dashes moved": `Open ${UUID.replaceAll("-", "").replace(/(.{4})/g, "$1-").slice(0, -1)} first.`,
    "underscores and colons for dashes": `Open ${UUID.replaceAll("-", "_").replace("_", ":")} first.`,
  },
  profile: {
    uppercased: `Use profile ${PROFILE.toUpperCase()}.`,
    "its hex uppercased": `Use profile ${PROFILE_HEX.toUpperCase()}.`,
    "dash-split": `Use profile ${PROFILE_HEX.replace(/(.{4})/g, "$1-").slice(0, -1)}.`,
    "dash-split and uppercased": `Use profile ${PROFILE_HEX.replace(/(.{5})/g, "$1-").slice(0, -1).toUpperCase()}.`,
  },
};

for (const [kind, value] of [["context", CONTEXT], ["profile", PROFILE]]) {
  for (const [how, text] of Object.entries(FORMS[kind])) {
    test(`a ${kind} pointer written ${how} is found, and cut`, () => {
      assert.equal(valueMatcher([value])(text), true, `found in ${JSON.stringify(text)}`);
      const cut = redactSecrets(text, [value]);
      assert.equal(valueMatcher([value])(cut), false, `cut of it: ${JSON.stringify(cut)}`);
      assert.match(cut, /\[redacted\]/);
    });
  }
}

test("a folded find is cut in place: the words around it stay", () => {
  assert.equal(redactSecrets(`Open ${UUID.replaceAll("-", "").toUpperCase()} first.`, [CONTEXT]), "Open [redacted] first.");
  assert.equal(redactSecrets(`Use profile ${PROFILE.toUpperCase()}.`, [PROFILE]), "Use profile AGENTRUN-[redacted].");
});

test("a hex run of 15 digits is not folded: its uppercased form is not found", () => {
  const value = "tok/0123456789abcde";
  assert.equal(valueMatcher([value])("tok/0123456789ABCDE"), false);
  assert.equal(valueMatcher([value])("0123456789ABCDE"), false);
  assert.equal(valueMatcher([value])(value), true, "as written it still is");
});

test("an unrelated UUID is not matched, however it is written", () => {
  const other = "9b1f0d2e-5c3a-4e7b-8f6d-1a2b3c4d5e6f";
  for (const text of [other, other.toUpperCase(), other.replaceAll("-", "")]) {
    assert.equal(valueMatcher([CONTEXT])(text), false, text);
    assert.equal(redactSecrets(`Open ${text} first.`, [CONTEXT]), `Open ${text} first.`);
  }
});

test("a key in mixed case is found as written, never folded: its uppercased form is not the key", () => {
  const key = "Zq8xKpLmNvBw3RtYuIoPwQ";
  assert.equal(valueMatcher([key])(`use ${key}`), true);
  assert.equal(valueMatcher([key])(`use ${key.toUpperCase()}`), false);
});

test("a key whose hex run is only its tail is not folded: another value ending in the same hex is not cut", () => {
  const held = ["not-a-secret", "cut-key-0123456789abcdef"].join("-");
  const other = ["not-a-secret", "later-key-0123456789abcdef"].join("-");
  assert.equal(valueMatcher([held])(`Later: ${other} ends here.`), false);
  assert.equal(redactSecrets(`Later: ${other} ends here.`, [held]), `Later: ${other} ends here.`);
  assert.equal(redactSecrets(`Now: ${held} ends here.`, [held]), "Now: [redacted] ends here.", "as written it still is cut");
});

test("the fold never stops the whole-text check: a held pointer split by a line break before its hex redacts the text whole", () => {
  // Its hex alone, cut in place, would leave the rest unseen as the pointer: the whole-text check runs first.
  const text = `Use ${PROFILE.slice(0, 8)}\n${PROFILE.slice(8)} now.`;
  assert.equal(redactSecrets(text, [PROFILE]), "[redacted]");
});
