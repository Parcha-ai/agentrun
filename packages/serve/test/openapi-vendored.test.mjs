// The vendored agentrun.v2/0 contract (src/openapi/agentrun-v2.openapi.json) is its source YAML converted to JSON, with
// description text edited for publication and nothing else: every path, schema, key and enum value is the conversion's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const VENDORED = JSON.parse(await readFile(new URL("../src/openapi/agentrun-v2.openapi.json", import.meta.url), "utf8"));
// The conversion as it came from the source YAML (x-agentrun-source.sha256), with every string `description` and the
// `converted` note taken out. Vendoring the contract again from its source replaces this hash.
const AS_CONVERTED = "2e87eb41be0377bb9bd23019c9c23366d5bd68d7505abaaaabea9f1b62cb3a9d";

/** `value` without any `description` whose value is text; a property or parameter named `description` (an object) stays. */
const withoutDescriptions = (value) =>
  Array.isArray(value) ? value.map(withoutDescriptions)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key, inner]) => !(key === "description" && typeof inner === "string")).map(([key, inner]) => [key, withoutDescriptions(inner)]))
  : value;

test("the vendored contract differs from its source's conversion in description text only, and says so", () => {
  const { converted, ...source } = VENDORED.info["x-agentrun-source"];
  assert.equal(converted, "YAML 1.2 to JSON; descriptions edited for publication");
  assert.match(source.sha256, /^[0-9a-f]{64}$/, "the source YAML's own hash is kept");
  const bare = withoutDescriptions({ ...VENDORED, info: { ...VENDORED.info, "x-agentrun-source": source } });
  assert.equal(createHash("sha256").update(JSON.stringify(bare)).digest("hex"), AS_CONVERTED, "paths, schemas, keys and enum values are the conversion's; only description text may differ");
});

test("a change outside description text is caught: an enum value, a key, or a description that is a schema", () => {
  const hash = (doc) => {
    const { converted, ...source } = doc.info["x-agentrun-source"];
    return createHash("sha256").update(JSON.stringify(withoutDescriptions({ ...doc, info: { ...doc.info, "x-agentrun-source": source } }))).digest("hex");
  };
  const copy = () => structuredClone(VENDORED);
  const enumEdited = copy();
  enumEdited.components.schemas.RunStatus.enum[0] = "pending";
  assert.notEqual(hash(enumEdited), AS_CONVERTED);
  const keyAdded = copy();
  keyAdded.components.schemas.RunStatus["x-note"] = "added";
  assert.notEqual(hash(keyAdded), AS_CONVERTED);
  const describedEdited = copy();
  describedEdited.components.schemas.RunStatus.description = "Any text.";
  assert.equal(hash(describedEdited), AS_CONVERTED, "description text alone is free");
  const schemaNamedDescription = copy();
  schemaNamedDescription.components.schemas.RunStatus.description = { type: "string" };
  assert.notEqual(hash(schemaNamedDescription), AS_CONVERTED, "a description that is not text is part of the shape");
});
