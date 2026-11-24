// learning's redactSecrets (serve's copy) finds each secret shape by its spans: every place a shape matches, overlapping
// places included, merged. A shape a long text repeats ("github_pat_github_pat_…", a JWT whose first part is
// "eyJeyJeyJ…") starts again inside its own match at every repeat; read from each, a 1 MB answer took seconds. The spans
// it skips are the ones that end where the match they start in ends, so what is redacted is the same, as a reference
// that reads from every character shows over random texts made of the shapes' own pieces.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactedAnswer } from "../dist/key-refusal.js";
import { redactLearned, redactSecrets, secretShapes } from "../dist/learn/secrets.js";
import { scanned } from "../dist/redact/match.js";

const KEY = ["not-a-secret", "x-0123456789abcdef"].join("-");
/** The whole pipeline's bound with a held value (redact-contract.test.mjs WORK): characters visited per character. */
const WORK = 1024;
/** An answer redacted with one held value, and the characters its redaction visited (redact/match.ts `scanned`) per
 *  character of it. Counted, not timed: read again from every repeat, a run is passed once per repeat. */
const counted = (text) => {
  scanned.chars = 0;
  const out = redactedAnswer(text, [KEY]);
  return { out, per: scanned.chars / text.length };
};

test("an answer of about 1 MB made of github_pat_ runs is redacted in linear time, every run whole", () => {
  const { out, per } = counted(`${"github_pat_".repeat(744)} `.repeat(128));
  assert.equal(out, "[redacted] ".repeat(128));
  // Read again from every repeat, each run of 744 is passed 744 times over.
  assert.ok(per <= WORK, `${per.toFixed(1)} characters visited per character`);
});

test("an answer of about 1 MB of JWT-shaped runs whose first part repeats eyJ is redacted in linear time, every run whole", () => {
  const { out, per } = counted(`${"eyJ".repeat(2715)}.eyJabcdefgh.abcdefgh `.repeat(128));
  assert.equal(out, "[redacted] ".repeat(128));
  assert.ok(per <= WORK, `${per.toFixed(1)} characters visited per character`);
});

// The shapes as secrets.ts had them before its JWT and private key header were bounded, read the way it did before:
// from every character after each match. The texts hold no private key header, so its old shape is never slow here.
const SHAPES = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/, /AIza[0-9A-Za-z_-]{35}/, /-----BEGIN[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/,
  /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/, /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /xox[abposre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}/, /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /:\/\/[^\s/?#@:]+:[^\s/?#@]*@/,
  /(?<=\bBearer\s{1,3})(?=[A-Za-z._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}={0,2}/i,
  /(?<=[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|id[_-]?token|refresh[_-]?token|client[_-]?secret|x-amz-signature|x-amz-security-token|x-goog-signature|token|secret|password|passwd|signature|sig)=)[^\s&#"'`<>\\[\]]{16,}/i,
];
function reference(text) {
  const found = SHAPES.flatMap((pattern) => {
    const re = new RegExp(pattern.source, `${pattern.flags}g`);
    const out = [];
    for (let m = re.exec(text); m; m = re.exec(text)) {
      out.push([m.index, m.index + m[0].length]);
      re.lastIndex = m.index + 1;
    }
    return out;
  }).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of found) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = "";
  let from = 0;
  for (const [start, end] of merged) {
    out += `${text.slice(from, start)}[redacted]`;
    from = end;
  }
  out += text.slice(from);
  return secretShapes(out).length > 0 ? "[redacted]" : out;
}

test("over 3,000 random texts of the shapes' own pieces, what is redacted is what reading from every character redacts", () => {
  const PIECES = ["github_pat_", "ghp_", "gh", "eyJ", "sk-", "xoxb-", "xapp-", ".", "_", "-", "a", "Z", "0", "7", " ", "github", "_pat_", "abcdefgh", "Bearer ", "bearer  ", "?token=", "&sig=", "=", "abcdefgh01234567"];
  let seed = 20261104;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 3011; i++) {
    const text = Array.from({ length: 4 + Math.floor(random() * 60) }, () => PIECES[Math.floor(random() * PIECES.length)]).join("");
    assert.equal(redactSecrets(text, [], 1 << 20), reference(text), JSON.stringify(text));
  }
});

test("over 3,000 random texts of a JWT's pieces, glued to a word's characters, what is redacted is what reading from every character redacts", () => {
  const PIECES = ["eyJ", "eyJ", "eyJabcdefgh", "abcdefgh", ".", ".", "-", "_", "x9", "a", " ", "=", "token-"];
  let seed = 20261123;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 3011; i++) {
    const text = Array.from({ length: 4 + Math.floor(random() * 40) }, () => PIECES[Math.floor(random() * PIECES.length)]).join("");
    assert.equal(redactSecrets(text, [], 1 << 20), reference(text), JSON.stringify(text));
  }
});

test("the cases that cut across a match still redact what they did: a github_pat_ after a ghp_ run, a JWT chain of four parts", () => {
  const alnum = "a".repeat(24);
  const crossed = `x ghp_${alnum}github_pat_${"b".repeat(20)} y`;
  assert.equal(redactSecrets(crossed, [], 1 << 20), reference(crossed));
  const chain = "eyJaaaaaaaa.eyJbbbbbbbb.eyJcccccccc.dddddddd";
  assert.equal(redactSecrets(`p ${chain} q`, [], 1 << 20), reference(`p ${chain} q`));
});

test("two whsec_ secrets back to back are both redacted whole: the first's run takes the second's whsec, and the second is still found from inside it", () => {
  // Unpadded (a key whose length is a multiple of 3 bytes): nothing ends the first's run before the second's prefix.
  const first = `whsec_${"A".repeat(40)}`;
  const second = `whsec_${"B".repeat(40)}`;
  const out = redactSecrets(`keys: ${first}${second} end`, []);
  assert.equal(out, "keys: [redacted] end");
  assert.doesNotMatch(out, /AAAA|BBBB/);
});

// Each shape's adversarial input (its prefix repeated with no terminator, its prefix then its body's class with none) is
// counted in redact-contract.test.mjs: "adversarial texts: the characters the shape scanners visit…" (at most 128 per
// character, no held value) and "…the whole pipeline visits…" (at most WORK, one held value).

test("a JWT is still found wherever it starts, glued to a word's characters too, and a private key's header with any key type", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(".");
  for (const around of [[" ", " "], ["token=", "&"], ['"', '"'], ["Bearer ", ""], [".", "."], ["", ""], ["x9", ""], ["a-", ""], ["token-", " "], ["id_", ""]]) {
    assert.equal(redactSecrets(`${around[0]}${jwt}${around[1]}`, []), `${around[0]}[redacted]${around[1]}`, JSON.stringify(around));
  }
  // An "eyJ" earlier in the same run starts the match, as reading from every character did.
  assert.equal(redactSecrets(`a eyJeyJ${jwt} b`, []), "a [redacted] b");
  assert.equal(redactLearned(`x9${jwt}`, []), "x9[redacted]");
  // Each header made at runtime, so the source holds no key-shaped literal.
  const dashes = "-".repeat(5);
  for (const type of ["", "RSA ", "OPENSSH ", "ENCRYPTED "]) {
    const header = `${dashes}BEGIN ${type}${["PRIVATE", "KEY"].join(" ")}${dashes}`;
    assert.deepEqual(secretShapes(`key:\n${header}\nMIIB\n`), ["private key block"], header);
  }
});
