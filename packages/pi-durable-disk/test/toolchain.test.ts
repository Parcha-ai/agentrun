import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { CHORD_VERSION, PI_DURABLE_LOADS, PI_DURABLE_VERSION } from "./_conformance.ts";

test("the toolchain runs TypeScript tests and reaches pi's conformance suite", () => {
  assert.equal(typeof createStorageConformance, "function");
});

// The pi version a run asks for: this package's floor job sets PDA_EXPECT_PI_DURABLE, the repository's pi version legs
// (scripts/pi-leg.mjs, and `verify` on the dev line) PI_EXPECT_VERSION.
const asked = process.env.PDA_EXPECT_PI_DURABLE ?? process.env.PI_EXPECT_VERSION;

// A run that asks for a pi-durable version (a CI leg on the lowest one the peers accept, or on 1.2) runs on exactly that one.
test("the suites run on the pi-durable version they were asked to run on", { skip: asked ? false : "no version asked for" }, () => {
  assert.equal(PI_DURABLE_VERSION, asked);
});

// chord, the other peer, is released in lockstep with pi-durable: the same run resolves the same chord version.
test("the suites run on the chord version of the pi-durable version they were asked to run on", { skip: asked ? false : "no version asked for" }, () => {
  assert.equal(CHORD_VERSION, asked);
});

// What the installed pi-durable itself loads, from its own location: an install that leaves pi-durable at the root beside
// another family version loads that version's chord and pi-ai, whatever this package resolves.
test("the pi-durable the suites run on loads the chord and pi-ai of the version they were asked to run on", { skip: asked ? false : "no version asked for" }, () => {
  assert.deepEqual(PI_DURABLE_LOADS, { chord: asked, piAi: asked });
});
