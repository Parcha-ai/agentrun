// A held value that holds "/" can come back as a path names it: a tool that resolves a path the model wrote (pi's read,
// with the value inside it) collapses each run of "/" to one and drops a leading one, and its error names that path. The
// cut finds a held value in that spelling too, so no piece of it is left: the value as written found too, as before.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const { redactSecrets, valueMatcher } = await import("../dist/learn/secrets.js");
const { checkNote } = await import("../dist/learn/check.js");

/** Whether `text` holds any 8 characters of `value` in a row. */
const holdsPiece = (text, value) => [...Array(Math.max(0, value.length - 7)).keys()].some((i) => text.includes(value.slice(i, i + 8)));

test("a held value with \"//\" in it, named by a path that collapses the run of slashes, is cut: no piece of it is left", () => {
  const value = `not-a-secret-path-key//${randomBytes(8).toString("hex")}`;
  const said = `ENOENT: no such file or directory, open 'notes/${value.replace("//", "/")}.txt'`;
  const shown = redactSecrets(said, [value]);
  assert.equal(holdsPiece(shown, value), false, shown);
  assert.match(shown, /^ENOENT: no such file or directory, open 'notes\/\[redacted\]\.txt'$/, "the rest of the error still reads");
});

test("a held value starting with \"/\", named by a path that drops it, is cut: no piece of it is left", () => {
  const value = `/not-a-secret-path-key-${randomBytes(8).toString("hex")}`;
  const said = `ENOENT: no such file or directory, open 'notes/${value.slice(1)}.txt'`;
  const shown = redactSecrets(said, [value]);
  assert.equal(holdsPiece(shown, value), false, shown);
});

test("a held value ending with \"/\", named by a path that drops it, is cut: no piece of it is left", () => {
  const value = `not-a-secret-path-key-${randomBytes(8).toString("hex")}/`;
  const said = `ENOENT: no such file or directory, open 'notes/${value.slice(0, -1)}'`;
  const shown = redactSecrets(said, [value]);
  assert.equal(holdsPiece(shown, value), false, shown);
});

test("learning's guard sees a held value as a path names it: the matcher holds the collapsed, the leading-cut and the trailing-cut spellings", () => {
  const core = `not-a-secret-path-key${randomBytes(8).toString("hex")}`;
  const value = `/${core.slice(0, 20)}//${core.slice(20)}/`;
  const holds = valueMatcher([value]);
  assert.equal(holds(`open 'notes/${core.slice(0, 20)}/${core.slice(20)}'`), true, "collapsed, the slashes at both ends dropped");
  assert.equal(holds("nothing held here"), false);
});

test("a learning note quoting a held value as a path names it is refused, as one quoting it as written is: never laid into a later run", () => {
  const value = `not-a-secret-path-key//${randomBytes(8).toString("hex")}/`;
  const spelled = value.replace("//", "/").slice(0, -1);
  const note = (text) => new TextEncoder().encode(`---\nname: where-it-failed\ndescription: The read that failed.\n---\n\n${text}\n`);
  for (const [what, text] of [["as a path names it", `The read failed: open 'notes/${spelled}.txt'.`], ["as written", `The key is ${value}.`]]) {
    const { problems, note: kept } = checkNote("where-it-failed.md", note(text), [value]);
    assert.ok(problems.some((problem) => problem.rule === "secret_value"), `${what}: refused as the host's value: ${JSON.stringify(problems)}`);
    assert.equal(kept, undefined, `${what}: no note kept`);
    assert.equal(holdsPiece(JSON.stringify(problems), value), false, `${what}: its problems print no piece of it`);
  }
  const clean = checkNote("where-it-failed.md", note("The read failed: the file was not there."), [value]);
  assert.equal(clean.problems.some((problem) => problem.rule === "secret_value"), false, "a note holding no part of it is not refused for it");
});

// A path or a URL writer can also percent-encode a held value (encodeURIComponent: "/" is %2F, "+" is %2B, "=" is %3D;
// encodeURI keeps those and encodes "^" and "|"), and a resolver rewrites its dot segments ("a/./b" and "a/x/../b" are "a/b"). Each such
// spelling is cut where it stands, the text around it left as it reads.
// A value with characters both encoders change: "+", "/" and "=" encodeURIComponent alone; "^" and "|" both.
const encodable = () => `not-a-secret+path/key=${randomBytes(8).toString("hex")}^tail|end`;
const dotted = () => [`not-a-secret/./path-key-${randomBytes(8).toString("hex")}`, `not-a-secret/sub/../path-key-${randomBytes(8).toString("hex")}`];
const normalized = (value) => value.replace("/./", "/").replace("/sub/../", "/");

for (const [name, encode] of [["encodeURIComponent", encodeURIComponent], ["encodeURI", encodeURI]]) {
  test(`a held value percent-encoded as ${name} writes it is cut where it stands, the text around it left as it reads`, () => {
    const value = encodable();
    const said = `fetch failed: https://api.example/v1?key=${encode(value)} answered 401`;
    assert.notEqual(encode(value), value, "the value has characters it encodes");
    assert.equal(redactSecrets(said, [value]), "fetch failed: https://api.example/v1?key=[redacted] answered 401");
  });
}

test("a held value with a dot segment, named as a resolver normalizes it (\"a/./b\", \"a/x/../b\"), is cut: no piece of it is left", () => {
  for (const value of dotted()) {
    const said = `ENOENT: no such file or directory, open 'notes/${normalized(value)}.txt'`;
    const shown = redactSecrets(said, [value]);
    assert.equal(holdsPiece(shown, normalized(value)), false, shown);
    assert.match(shown, /^ENOENT: no such file or directory, open 'notes\/\[redacted\]\.txt'$/, "the rest of the error still reads");
  }
});

test("a learning note quoting a held value percent-encoded or dot-normalized is refused as the host's value", () => {
  const note = (text) => new TextEncoder().encode(`---\nname: where-it-failed\ndescription: The call that failed.\n---\n\n${text}\n`);
  const encodedValue = encodable();
  const [dotValue] = dotted();
  for (const [what, value, text] of [
    ["encodeURIComponent", encodedValue, `It called ?key=${encodeURIComponent(encodedValue)}.`],
    ["encodeURI", encodedValue, `It called ${encodeURI(encodedValue)}.`],
    ["dot-normalized", dotValue, `It read notes/${normalized(dotValue)}.txt.`],
  ]) {
    const { problems, note: kept } = checkNote("where-it-failed.md", note(text), [value]);
    assert.ok(problems.some((problem) => problem.rule === "secret_value"), `${what}: refused as the host's value: ${JSON.stringify(problems)}`);
    assert.equal(kept, undefined, `${what}: no note kept`);
  }
});

test("a held value with \"//\" is still cut as written, and a value with no \"/\" is cut as before", () => {
  const slashed = `not-a-secret-path-key//${randomBytes(8).toString("hex")}`;
  const plain = `not-a-secret-plain-key-${randomBytes(8).toString("hex")}`;
  const shown = redactSecrets(`one ${slashed} two ${plain} three`, [slashed, plain]);
  assert.equal(shown, "one [redacted] two [redacted] three");
});
