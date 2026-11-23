// learning's redactSecrets (serve's copy) finds each secret shape by its spans: every place a shape matches, overlapping
// places included, merged. A shape a long text repeats ("github_pat_github_pat_…", a JWT whose first part is
// "eyJeyJeyJ…") starts again inside its own match at every repeat; read from each, a 1 MB answer took seconds. The spans
// it skips are the ones that end where the match they start in ends, so what is redacted is the same, as a reference
// that reads from every character shows over random texts made of the shapes' own pieces.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactedAnswer } from "../dist/key-refusal.js";
import { redactLearned, redactSecrets, secretShapes } from "../dist/learn/secrets.js";

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
  /(?:AKIA|ASIA)[0-9A-Z]{16}/, /AIza[0-9A-Za-z_-]{35}/, /-----BEGIN[ A-Z0-9]{0,64}PRIVATE KEY[ A-Z0-9]{0,64}-----/,
  /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/, /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /xox[abposre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}/, /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
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

// Each shape's adversarial input of 256 KiB (the cut read's cap, run-files.ts RUN_FILE_CUT_MAX): its prefix repeated with
// no terminator, and its prefix then its body's class with none. A shape whose match can start anew inside a long run
// (a JWT's "eyJ" in a dotless run) or that has two unbounded runs (a private key's header) read each in time quadratic in
// its length: 180 s for "eyJ" x 87k, 24 s for a header of repeated "PRIVATE KEY ", the server's event loop held all
// that time. Every case, through redactSecrets and redactLearned (which adds the bank shapes), finishes in under 1 s.
const SIZE = 256 * 1024;
const fill = (unit) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
const headed = (prefix, body) => prefix + fill(body).slice(prefix.length);
const ADVERSARIAL = [
  ["AWS access key id", fill("AKIA")], ["Google API key", fill("AIza")],
  ["private key block", fill("-----BEGIN ")], ["private key block", headed("-----BEGIN ", "PRIVATE KEY ")], ["private key block", headed("-----BEGIN ", "A")],
  ["GitHub token", fill("ghp_")], ["GitHub token", fill("github_pat_")], ["sk- key", fill("sk-")],
  ["Slack token", fill("xoxb-")], ["Slack token", fill("xapp-")],
  ["JWT", fill("eyJ")], ["JWT", fill("eyJ-")], ["JWT", headed("eyJaaaaaaaa.", "eyJ")], ["JWT", fill("eyJaaaaaaaa.")],
  ["webhook signing secret", fill("whsec_")], ["URL with a password", fill("://a:")], ["URL with a password", headed("://a:", "a")],
  ["bearer token", fill("Bearer ")], ["bearer token", headed("Bearer ", "a")],
  ["URL parameter named like a credential", fill("?token=")], ["URL parameter named like a credential", headed("?token=", "a")],
  ["bank account number", headed("account ", "1 ")], ["IBAN", headed("IBAN GB00", "A ")], ["routing number", fill("routing number ")], ["sort code", fill("sort code ")],
];

for (const [shape, text] of ADVERSARIAL) {
  test(`${shape}: an adversarial 256 KiB input (${JSON.stringify(text.slice(0, 14))}...) is redacted in under 1 s`, () => {
    for (const redact of [redactSecrets, redactLearned]) {
      const began = performance.now();
      redact(text, [KEY], Buffer.byteLength(text));
      const took = performance.now() - began;
      assert.ok(took < 1000, `${redact.name}: took ${Math.round(took)} ms`);
    }
  });
}

test("a JWT and a private key's header are still found where a word, a quote or a blank starts them, with any key type", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(".");
  for (const around of [[" ", " "], ["token=", "&"], ['"', '"'], ["Bearer ", ""], [".", "."], ["", ""]]) {
    assert.equal(redactSecrets(`${around[0]}${jwt}${around[1]}`, []), `${around[0]}[redacted]${around[1]}`, JSON.stringify(around));
  }
  // Each header made at runtime, so the source holds no key-shaped literal.
  const dashes = "-".repeat(5);
  for (const type of ["", "RSA ", "OPENSSH ", "ENCRYPTED "]) {
    const header = `${dashes}BEGIN ${type}${["PRIVATE", "KEY"].join(" ")}${dashes}`;
    assert.deepEqual(secretShapes(`key:\n${header}\nMIIB\n`), ["private key block"], header);
  }
});
