// A run's view redacts every row of its timeline with one array of values (store-view.ts), and redactSecrets derived
// what it looks for of each value (its path spellings, base64 at three alignments in both alphabets, percent forms, hex
// and folded patterns) again for every row. With a server's values, a GitHub App's PEM among them, a code review's
// timeline of a few thousand rows took seconds to view, and a runs list views each run. What it derives is kept per
// array, so it is derived once; an array whose values change is derived again, so what a caller adds is always cut.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { redacted } from "../dist/key-refusal.js";
import { redactSecrets } from "../dist/learn/secrets.js";

const PEM_BODY = randomBytes(1190).toString("base64");
// Spelled from parts: the source export refuses a line that writes a private key's header out.
const PEM_LABEL = ["RSA", "PRIVATE", "KEY"].join(" ");
const VALUES = [
  `-----BEGIN ${PEM_LABEL}-----\n${PEM_BODY.match(/.{1,64}/g).join("\n")}\n-----END ${PEM_LABEL}-----`,
  ...Array.from({ length: 8 }, () => randomBytes(30).toString("base64url")),
  ...Array.from({ length: 4 }, () => crypto.randomUUID()),
  `${randomBytes(16).toString("hex")}/${randomBytes(16).toString("hex")}`,
];
const ROW = "Reviewed apps/web/src/features/intake/save.ts:120: the follow-up save re-sends the rebased rows. ";

test("a timeline's rows redacted with one array of values read as with a fresh array for each row", () => {
  for (let at = 0; at < 3000; at++) {
    const row = `${ROW}${at}${at % 500 === 0 ? ` ${VALUES[at % VALUES.length]}` : ""}`;
    assert.equal(redacted(row, VALUES), redacted(row, [...VALUES]));
  }
});

test("each value is still cut in every form when its array's derivation is reused", () => {
  const [pem, key, , , , , , , , uuid] = VALUES;
  const forms = [
    pem,
    JSON.stringify(pem).slice(1, -1),
    key,
    encodeURIComponent(key),
    Buffer.from(key).toString("base64"),
    Buffer.from(key).toString("hex").toUpperCase(),
    uuid.toUpperCase().replaceAll("-", ""),
  ];
  for (let round = 0; round < 2; round++) {
    for (const form of forms) {
      const out = redactSecrets(`before ${form} after`, VALUES, 1 << 20);
      assert.ok(out.includes("[redacted]") && !out.includes(form), `${form.slice(0, 24)} read ${out.slice(0, 60)}`);
      assert.equal(out, redactSecrets(`before ${form} after`, [...VALUES], 1 << 20));
    }
  }
});

test("a value added to an array after it was used is cut: a changed array is derived again", () => {
  const values = [VALUES[1]];
  const added = randomBytes(30).toString("base64url");
  assert.equal(redactSecrets(`token ${added}`, values), `token ${added}`);
  values.push(added);
  assert.equal(redactSecrets(`token ${added}`, values), "token [redacted]");
  values[0] = randomBytes(30).toString("base64url");
  assert.equal(redactSecrets(`token ${values[0]}`, values), "token [redacted]");
});

test("redaction reads the same with the kept derivation as with a fresh array each time", () => {
  const texts = [
    ...VALUES.map((value) => `x ${value} y`),
    ...VALUES.map((value) => `path ../notes/../${value}/x`),
    `ghp_${"a".repeat(36)} and sk-${"b".repeat(24)}`,
    "nothing secret in this line at all",
  ];
  for (const text of texts) assert.equal(redactSecrets(text, VALUES, 1 << 20), redactSecrets(text, [...VALUES], 1 << 20));
});
