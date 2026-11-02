// The catalog name <-> wire name mapping: a wire name a CLI adapter accepts, reversible back to the catalog name by a
// lookup, and a collision caught so a catalog never shadows a name. The served catalog is mostly bare names (the mapping
// is the identity for them) plus monid's dotted ones; the mapping's full range is checked against a synthetic catalog.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collisions, reverseOf, WIRE_NAME, wireName } from "../dist/catalog.js";
import { TOOLS } from "../dist/tools.js";

// A test-only catalog that exercises the mapping past the identity: a dotted name, a path name, a name of each other
// shape a kind of tool brings, and a name past 64 characters that must take the hash suffix.
const SYNTHETIC = [
  "read",
  "monid.discover",
  "mcp:github/create_issue",
  "mcp:a-very-long-server-name-that-keeps-going/an-equally-long-tool-name-past-the-limit",
  "weird name/with spaces.and:punctuation",
];

test("a wire name is always one a CLI adapter accepts", () => {
  for (const name of [...Object.keys(TOOLS), ...SYNTHETIC]) assert.match(wireName(name), WIRE_NAME, name);
});

test("the mapping is the identity for a name that already is a wire name", () => {
  for (const name of Object.keys(TOOLS).filter((name) => WIRE_NAME.test(name))) assert.equal(wireName(name), name, `the served tool ${name} keeps its name`);
  assert.equal(wireName("read"), "read");
});

test("the served catalog's dotted names, monid's, map to wire names", () => {
  for (const kind of ["discover", "inspect", "run"]) {
    assert.ok(Object.keys(TOOLS).includes(`monid.${kind}`), `monid.${kind} is served`);
    assert.equal(wireName(`monid.${kind}`), `monid_${kind}`);
  }
});

test("the reverse of the forward mapping is the identity for every catalog name", () => {
  const reverse = reverseOf(SYNTHETIC);
  for (const name of SYNTHETIC) assert.equal(reverse.get(wireName(name)), name, name);
});

test("a dotted name maps away from the identity, so the mapping is doing something", () => {
  assert.equal(wireName("monid.discover"), "monid_discover");
  assert.equal(wireName("mcp:github/create_issue"), "mcp__github__create_issue");
});

test("a name over 52 characters takes the hash suffix and fits, whatever characters it is made of", () => {
  // A plain name of valid characters that is 53-64 long must NOT skip the mapping and come out over 52.
  const plain = "a".repeat(60);
  const wirePlain = wireName(plain);
  assert.notEqual(wirePlain, plain, "a 60-character valid name is not kept as itself");
  assert.ok(wirePlain.length <= 52, `the wire name is ${wirePlain.length} characters`);
  assert.match(wirePlain, /-[0-9a-f]{8}$/, "it takes the hash suffix");
  const dotted = "mcp:a-very-long-server-name-that-keeps-going/an-equally-long-tool-name";
  const wireDotted = wireName(dotted);
  assert.ok(wireDotted.length <= 52, `the wire name is ${wireDotted.length} characters`);
  assert.match(wireDotted, /-[0-9a-f]{8}$/);
  // Either one round-trips through the catalog's reverse.
  const reverse = reverseOf([plain, dotted]);
  assert.equal(reverse.get(wirePlain), plain);
  assert.equal(reverse.get(wireDotted), dotted);
});

test("two names with one wire name are a collision, reported against the second", () => {
  const clashing = ["foo.bar", "foo/bar"]; // both map to foo__bar? no: . -> _, / -> __ ; check the real pair
  // "foo.bar" -> "foo_bar"; a name that also yields "foo_bar":
  const pair = ["foo.bar", "foo_bar"]; // the second already is "foo_bar"; the first maps to it
  assert.equal(wireName(pair[0]), wireName(pair[1]));
  const found = collisions(pair);
  assert.deepEqual(found, [{ name: "foo_bar", clashesWith: "foo.bar" }]);
  assert.deepEqual(collisions([...Object.keys(TOOLS)]), [], "the served tools never collide");
  assert.deepEqual(collisions(clashing), [], "foo.bar and foo/bar are foo_bar and foo__bar, not a collision");
});

test("reverseOf throws on a collision, so a shadowing catalog never loads", () => {
  assert.throws(() => reverseOf(["foo.bar", "foo_bar"]), /both map to the wire name foo_bar/);
});
