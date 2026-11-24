// The three JWT shapes this repository reads text with, each its own spec: serve's (learn/secrets.ts through
// redact/match.ts: three parts of 8 characters or more), the console's credential gate (apps/console/credential-gate.mjs
// credentialKind: 10, 10 and 16) and the computer's phone words (packages/computer screen-watch.ts redactWords: a first
// part and a dot, then anything of a part's characters, so a token cut short is cut too). Each starts at the first
// "eyJ" of a run of a part's characters, wherever the run starts, so a token glued to a word is found and a dotless run
// of "eyJ" is read once. One corpus drives all three. Every token here is put together at run time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactWords } from "@parcha/agentrun-computer";
import { credentialKind } from "../../../apps/console/credential-gate.mjs";
import { redactSecrets, secretShapes } from "../dist/learn/secrets.js";

const header = ["ey", "JhbGciOiJIUzI1NiJ9"].join("");
const payload = ["ey", "JzdWIiOiJzeW50aGV0aWMifQ"].join("");
const signature = "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const TOKEN = [header, payload, signature].join(".");

/** What each site makes of `text`: whether it finds a JWT there, and whether any of `part` still shows. */
const SITES = {
  serve: (text, part) => ({ found: secretShapes(text).includes("JWT"), shows: redactSecrets(text, [], 1 << 20).includes(part) }),
  // The gate fails a build naming the kind; it shows no text.
  console: (text) => ({ found: credentialKind(text) === "signed token (JWT)", shows: false }),
  computer: (text, part) => {
    const out = redactWords(text);
    return { found: out.includes("[a secret]"), shows: out.includes(part) };
  },
};

test("a whole token is found at every site: alone, after \"=\", a space or a quote, and at the start of a line", () => {
  for (const [before, after] of [["", ""], ["x=", ""], ["see ", " now"], ['"', '"'], ["first line\n", "\nnext"]]) {
    for (const [site, read] of Object.entries(SITES)) {
      const { found, shows } = read(`${before}${TOKEN}${after}`, signature.slice(0, 12));
      assert.ok(found && !shows, `${site}: ${JSON.stringify(before)}`);
    }
  }
});

test("a token glued to what comes before it is found at every site: after a dash, a letter or digit, and an underscore", () => {
  for (const glue of ["x-", "x9", "x_", "token-", "id_"]) {
    for (const [site, read] of Object.entries(SITES)) {
      const { found, shows } = read(`${glue}${TOKEN} end`, signature.slice(0, 12));
      assert.ok(found && !shows, `${site}: ${glue}`);
    }
  }
});

test("a token after an earlier eyJ fragment in the same run is found from the first eyJ", () => {
  const text = `before eyJab-${TOKEN} after`;
  assert.equal(redactSecrets(text, []), "before [redacted] after");
  assert.equal(credentialKind(text), "signed token (JWT)");
  assert.equal(redactWords(text), "before [a secret] after");
});

test("the computer's two-part token, cut short, is still cut; the three-part specs leave it", () => {
  const short = `adb said ${header}.${payload} done`;
  assert.equal(redactWords(short), "adb said [a secret] done");
  assert.ok(!secretShapes(short).includes("JWT"));
  assert.equal(credentialKind(short), undefined);
});

test("eyJ and eyJ- repeated with no dot are no JWT at any site; serve's scanners read them in work linear in their length", async () => {
  const { scanned } = await import("../dist/redact/match.js");
  const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  for (const unit of ["eyJ", "eyJ-", "x9eyJ", "eyJ_"]) {
    const big = fill(unit, 256 * 1024);
    scanned.chars = 0;
    assert.ok(!secretShapes(big).includes("JWT"), unit);
    assert.equal(redactSecrets(big, [], 1 << 20), big);
    assert.ok(scanned.chars <= 64 * big.length, `${unit}: ${scanned.chars} for ${big.length}`);
    assert.equal(credentialKind(fill(unit, 64 * 1024)), undefined, unit);
    // redactWords also reads every word run with its login and parameter shapes, whose cost grows with the square of a
    // run's length whatever its JWT start: it is driven at a size those shapes read in good time.
    const small = fill(unit, 4 * 1024);
    assert.equal(redactWords(small), small, unit);
  }
});
