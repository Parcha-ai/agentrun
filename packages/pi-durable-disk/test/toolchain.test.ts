import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { PI_DURABLE_VERSION } from "./_conformance.ts";

test("the toolchain runs TypeScript tests and reaches pi's conformance suite", () => {
  assert.equal(typeof createStorageConformance, "function");
});

// A run that asks for a pi-durable version (the CI leg on the lowest one the peers accept) runs on exactly that one.
test("the suites run on the pi-durable version they were asked to run on", { skip: process.env.PDA_EXPECT_PI_DURABLE ? false : "no version asked for" }, () => {
  assert.equal(PI_DURABLE_VERSION, process.env.PDA_EXPECT_PI_DURABLE);
});
