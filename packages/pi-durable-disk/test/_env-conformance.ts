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

/**
 * How the local-disk conformance cases watch. pi's watch cases wait a fixed 3 s for a report, and each step resumes right
 * after a poll delivered, so the next report needs a whole poll period (the interval plus the scan) inside those 3 s. The
 * product's 1 s interval leaves 2 s of slack, which a starved CI runner takes away (a period of about 2.7 s was seen). A
 * 100 ms interval keeps seconds of slack; the cases and their assertions are pi's, unchanged.
 */
export const LOCAL_WATCH = { mode: "polling", pollIntervalMs: 100 } as const;

/** One case of the suite by name, run once. */
export async function runEnvCase(name: string, withEnv: EnvConformanceProvider): Promise<void> {
  const found = createEnvConformance({ assertions, withEnv }).find((conformance) => conformance.name === name);
  if (found === undefined) throw new Error(`pi's env conformance has no case named ${JSON.stringify(name)}`);
  await found.run();
}
