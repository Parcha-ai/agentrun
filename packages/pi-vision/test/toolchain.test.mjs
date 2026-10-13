// A run that asks for a pi-durable version (the CI leg on the 1.0.4 peer floor) runs on exactly that one, and on the chord and
// pi-ai of the same release: the package resolves its peers the way a host's install would.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** The version of the copy of `name` this package resolves: its entry, then the nearest manifest of that name above it. */
const version = (name) => {
  for (let dir = dirname(fileURLToPath(import.meta.resolve(name))); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return JSON.parse(readFileSync(manifest, "utf8")).version;
  }
  throw new Error(`no manifest for ${name}`);
};
const expected = process.env.PI_VISION_EXPECT_PI_DURABLE;

test("the suites run on the pi-durable, chord and pi-ai version they were asked to run on", { skip: expected ? false : "no version asked for" }, () => {
  assert.deepEqual(["@earendil-works/pi-durable", "@earendil-works/chord", "@earendil-works/pi-ai"].map(version), [expected, expected, expected]);
});
