// redact/match.ts against the redactor it replaced (fixtures/secrets-before.mjs, learn/secrets.ts as built before it),
// over random texts made of held values in each form the matcher finds (as written, split, JSON-escaped, base64, hex,
// percent-encoded, a pointer's hex folded), secret shapes' own pieces, whitespace, separators and a few characters NFKC
// changes. Seeded, so a failure names a text that fails again. Both must cut the same, but for one difference the new
// matcher makes on purpose: its whole-text check reads the text as it came, so a held value only part of which a cut
// covers (P2-4: a credential parameter's value cut in place, the rest of the held value past a line break) withholds the
// text whole, where the old check read the text after its cut and showed the rest. Each such text holds a held value
// as the old matcher itself reads it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { learnedSecretShapes, redactLearned, redactSecrets, secretShapes, valueMatcher } from "../dist/learn/secrets.js";
import * as before from "./fixtures/secrets-before.mjs";

const random = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (next, list) => list[Math.floor(next() * list.length)];

/** Three held values: a random key, a sign-in pointer (its hex is folded), and a key with "/", "+" and "=" (its
 *  percent and path forms differ from it). */
function valuesOf(next) {
  const alnum = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";
  const key = Array.from({ length: 24 + Math.floor(next() * 9) }, () => pick(next, [...alnum])).join("");
  const hex = Array.from({ length: 32 }, () => pick(next, [..."0123456789abcdef"])).join("");
  const pointer = `ctx/${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const slashed = `${key.slice(0, 6)}/${key.slice(6, 12)}+${key.slice(12, 18)}==`;
  return [key, pointer, slashed];
}

/** The pieces a text is made of: each value's forms and halves, shapes' pieces, and filler. */
function piecesOf(values) {
  const [key, pointer, slashed] = values;
  const forms = values.flatMap((value) => [
    value, value.slice(0, Math.floor(value.length / 2)), value.slice(Math.floor(value.length / 2)), JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString("base64"), Buffer.from(`x${value}`).toString("base64"), Buffer.from(value).toString("hex"), Buffer.from(value).toString("hex").toUpperCase(),
    encodeURIComponent(value), encodeURIComponent(value).toLowerCase(),
  ]);
  const hex = pointer.slice(4).replaceAll("-", "");
  return [
    ...forms, key, key, pointer.toUpperCase(), hex, hex.toUpperCase(), `${hex.slice(0, 16)}:${hex.slice(16)}`, `./${slashed}`, `x//${slashed}`,
    "sk-", "?token=", "&sig=", "Bearer ", "bearer  ", "://u:", "@", "eyJ", "eyJabcdefgh", ".", "-", "_", ":", "/", "=", "+", "%20", "%0A", "%E3%80%80",
    " ", " ", "\n", "\t", "a", "Z", "0", "7", "abcdefgh01234567", "github_pat_", "ghp_", "xoxb-", "whsec_", "AKIA", "account ", "123456", "IBAN ",
    "ﬁ", " ", "é", "Ａ", "%C3%A9", "%", "%4", "words ",
  ];
}

test("over 4,000 random texts of held values' forms and shapes' pieces, redactSecrets and redactLearned cut as before, or withhold a text that holds a value part of which a cut covered", (t) => {
  const next = random(20261123);
  let withheld = 0;
  for (let i = 0; i < 4013; i++) {
    const values = valuesOf(next);
    const pieces = piecesOf(values);
    const text = Array.from({ length: 2 + Math.floor(next() * 24) }, () => pick(next, pieces)).join("");
    for (const [now, then] of [[redactSecrets, before.redactSecrets], [redactLearned, before.redactLearned]]) {
      const got = now(text, values, 1 << 20);
      const was = then(text, values, 1 << 20);
      if (got === was) continue;
      assert.ok(got === "[redacted]" && before.valueMatcher(values)(text), `${now.name}(${JSON.stringify(text)}, ${JSON.stringify(values)}): ${JSON.stringify(got)}, before ${JSON.stringify(was)}`);
      withheld++;
    }
    assert.equal(valueMatcher(values)(text), before.valueMatcher(values)(text), JSON.stringify(text));
    assert.equal(valueMatcher(values, { fold: false })(text), before.valueMatcher(values, { fold: false })(text), JSON.stringify(text));
  }
  t.diagnostic(`withheld where the old redactor showed part of a held value: ${withheld}`);
});

test("over 4,000 random texts of the shapes' pieces, the kinds of secret and bank shapes found are the old ones", () => {
  const next = random(20261124);
  const pieces = ["github_pat_", "ghp_", "gh", "eyJ", "sk-", "xoxb-", "xapp-", ".", "_", "-", "a", "Z", "0", "7", " ", "\n", "github", "_pat_", "abcdefgh",
    "Bearer ", "bearer  ", "?token=", "&sig=", "?x-amz-signature=", "=", "abcdefgh01234567", "://", "u:", "p@", "@", "/", "whsec_", "AKIA", "AIza",
    "-----BEGIN ", "PRIVATE KEY", "-----", "RSA ", "account ", "acct: ", "a/c is ", "bank ", "123456", "1 ", "2024-01-02", "IBAN ", "GB00", "routing ",
    "number ", "123456789", "sort code ", "12-34-56", "sed -n 's|https://", "[^:]*", ":\\(\\[^@]*\\)@", "host", "|\\1|p'", "x9", ";", "("];
  for (let i = 0; i < 4013; i++) {
    const text = Array.from({ length: 2 + Math.floor(next() * 40) }, () => pick(next, pieces)).join("");
    assert.deepEqual(secretShapes(text), before.secretShapes(text), JSON.stringify(text));
    assert.deepEqual(learnedSecretShapes(text), before.learnedSecretShapes(text), JSON.stringify(text));
    assert.equal(redactLearned(text, [], 1 << 20), before.redactLearned(text, [], 1 << 20), JSON.stringify(text));
  }
});
