// Throwaway: fails only inside a pi leg (PI_EXPECT_VERSION is set there), so only pi-1-2 (<pi>, rest) goes red.
import assert from "node:assert/strict";
import { test } from "node:test";
test("throwaway: the rest half fails on purpose", () => assert.equal(process.env.PI_EXPECT_VERSION, undefined));
