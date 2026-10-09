// pi's env conformance suite as node:test cases, shared by the local-disk and the live (Archil mount) suites.
import { it } from "node:test";
import assert from "node:assert/strict";
import {
  createEnvConformance,
  type EnvConformanceAssertions,
  type EnvConformanceProvider,
} from "@earendil-works/pi-durable/testing";

const assertions: EnvConformanceAssertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
  deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
  partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} is not greater than ${expected}`),
  rejects: async (operation, messageIncludes) => {
    await assert.rejects(operation, (error: unknown) => error instanceof Error && error.message.includes(messageIncludes));
  },
};

/** Registers every case of the suite; call it at the top level of a test file or inside a `describe`. */
export function registerEnvCases(label: string, withEnv: EnvConformanceProvider): number {
  const cases = createEnvConformance({ assertions, withEnv });
  for (const conformance of cases) {
    it(`${label}: ${conformance.name}`, { timeout: conformance.timeoutMs }, () => conformance.run());
  }
  return cases.length;
}
