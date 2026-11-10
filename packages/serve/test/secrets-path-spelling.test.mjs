// A held value that holds "/" can come back as a path names it: a tool that resolves a path the model wrote (pi's read,
// with the value inside it) collapses each run of "/" to one and drops a leading one, and its error names that path. The
// cut finds a held value in that spelling too, so no piece of it is left: the value as written found too, as before.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const { redactSecrets } = await import("../dist/learn/secrets.js");

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

test("a held value with \"//\" is still cut as written, and a value with no \"/\" is cut as before", () => {
  const slashed = `not-a-secret-path-key//${randomBytes(8).toString("hex")}`;
  const plain = `not-a-secret-plain-key-${randomBytes(8).toString("hex")}`;
  const shown = redactSecrets(`one ${slashed} two ${plain} three`, [slashed, plain]);
  assert.equal(shown, "one [redacted] two [redacted] three");
});
