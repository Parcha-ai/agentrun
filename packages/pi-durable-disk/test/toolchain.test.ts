import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { CHORD_VERSION, PI_DURABLE_LOADS, PI_DURABLE_VERSION } from "./_conformance.ts";

test("the toolchain runs TypeScript tests and reaches pi's conformance suite", () => {
  assert.equal(typeof createStorageConformance, "function");
});

// The pi version this package pins (one whole family): the suites run on exactly that one.
const pinned = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { devDependencies: Record<string, string> }).devDependencies["@earendil-works/pi-durable"];

test("the suites run on the pi-durable version the package pins", () => {
  assert.equal(PI_DURABLE_VERSION, pinned);
});

// chord, the other peer, is released in lockstep with pi-durable: the same run resolves the same chord version.
test("the suites run on the chord version of that pi-durable", () => {
  assert.equal(CHORD_VERSION, pinned);
});

// What the installed pi-durable itself loads, from its own location: an install that leaves pi-durable at the root beside
// another family version loads that version's chord and pi-ai, whatever this package resolves.
test("the pi-durable the suites run on loads the chord and pi-ai of the same version", () => {
  assert.deepEqual(PI_DURABLE_LOADS, { chord: pinned, piAi: pinned });
});
