import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";

test("the toolchain runs TypeScript tests and reaches pi's conformance suite", () => {
  assert.equal(typeof createStorageConformance, "function");
});
