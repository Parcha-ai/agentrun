// learning's redactSecrets (serve's copy) finds each secret shape by its spans: every place a shape matches, overlapping
// places included, merged. A shape a long text repeats ("github_pat_github_pat_…", a JWT whose first part is
// "eyJeyJeyJ…") starts again inside its own match at every repeat; read from each, a 1 MB answer took seconds. The spans
// it skips are the ones that end where the match they start in ends, so what is redacted is the same, as a reference
// that reads from every character shows over random texts made of the shapes' own pieces.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactedAnswer } from "../dist/key-refusal.js";
import { redactSecrets, secretShapes } from "../dist/learn/secrets.js";

const KEY = ["not-a-secret", "x-0123456789abcdef"].join("-");
const timed = (text) => {
  const began = performance.now();
  const out = redactedAnswer(text, [KEY]);
  return { out, took: performance.now() - began };
};

test("an answer of about 1 MB made of github_pat_ runs is redacted in linear time, every run whole", () => {
  const { out, took } = timed(`${"github_pat_".repeat(744)} `.repeat(128));
  assert.equal(out, "[redacted] ".repeat(128));
  // Read again from every repeat it took about 1.3 s here; once, well under a tenth of that.
  assert.ok(took < 500, `took ${Math.round(took)} ms`);
});

test("an answer of about 1 MB of JWT-shaped runs whose first part repeats eyJ is redacted in linear time, every run whole", () => {
  const { out, took } = timed(`${"eyJ".repeat(2715)}.eyJabcdefgh.abcdefgh `.repeat(128));
  assert.equal(out, "[redacted] ".repeat(128));
  // About 4.7 s here before.
  assert.ok(took < 500, `took ${Math.round(took)} ms`);
});

// The shapes as secrets.ts has them, read the way it did before: from every character after each match.
const SHAPES = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/, /AIza[0-9A-Za-z_-]{35}/, /-----BEGIN[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/,
  /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/, /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /xox[abposre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}/, /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /:\/\/[^\s/?#@:]+:[^\s/?#@]*@/,
];
function reference(text) {
  const found = SHAPES.flatMap((pattern) => {
    const re = new RegExp(pattern.source, "g");
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
  const PIECES = ["github_pat_", "ghp_", "gh", "eyJ", "sk-", "xoxb-", "xapp-", ".", "_", "-", "a", "Z", "0", "7", " ", "github", "_pat_", "abcdefgh"];
  let seed = 20261104;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 3011; i++) {
    const text = Array.from({ length: 4 + Math.floor(random() * 60) }, () => PIECES[Math.floor(random() * PIECES.length)]).join("");
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
