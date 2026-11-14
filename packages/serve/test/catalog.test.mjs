// The catalog name -> wire name mapping: a wire name a CLI adapter accepts. The served catalog is bare names (the mapping
// is the identity for them); a catalog tool's name (monid:<provider>/<endpoint>, mcp:<server>/<tool>) maps away from
// it, and the mapping's full range is checked against a synthetic catalog.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WIRE_NAME, wireName } from "../dist/catalog.js";
import { TOOLS } from "../dist/tools.js";

// A test-only catalog that exercises the mapping past the identity: a dotted name, a path name, a name of each other
// shape a kind of tool brings, and a name past 64 characters that must take the hash suffix.
const SYNTHETIC = [
  "read",
  "monid:faux/person/enrich",
  "monid:tiktok/api/v1/{id}/x",
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

test("every served tool has its own wire name", () => {
  const names = Object.keys(TOOLS);
  assert.equal(new Set(names.map(wireName)).size, names.length, "two served tools would share a wire name");
});

test("a monid endpoint's name maps to a wire name of its own: its separators doubled, any other character an underscore", () => {
  assert.ok(!Object.keys(TOOLS).some((name) => name.startsWith("monid")), "no monid tool is served by itself: each endpoint is granted by name");
  assert.equal(wireName("monid:faux/person/enrich"), "monid__faux__person__enrich");
  assert.equal(wireName("monid:apollo/news_articles/search"), "monid__apollo__news_articles__search");
});

test("a catalog name maps away from the identity, so the mapping is doing something", () => {
  assert.equal(wireName("monid:faux/person/enrich"), "monid__faux__person__enrich");
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
});
