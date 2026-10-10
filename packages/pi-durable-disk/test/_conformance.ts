// pi's storage conformance suite driven by node:test. The suite is runner-independent: it needs assertions with
// Vitest's semantics (toEqual ignores undefined-valued keys, toMatchObject is a recursive subset match), which
// `registerStorageConformance` would take from Vitest's `expect`. These are the same semantics on node:assert.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import type { StorageConformanceAssertions, StorageConformanceProvider } from "@earendil-works/pi-durable/testing";

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = stripUndefined(item);
    return out;
  }
  return value;
}

function subsetMatches(actual: unknown, expected: unknown, where = "$"): void {
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") assert.fail(`${where}: expected object, got ${JSON.stringify(actual)}`);
    if (Array.isArray(expected)) {
      assert.ok(Array.isArray(actual) && actual.length === expected.length, `${where}: array length ${(actual as unknown[]).length} != ${expected.length}`);
      expected.forEach((item, i) => subsetMatches((actual as unknown[])[i], item, `${where}[${i}]`));
    } else {
      for (const [key, item] of Object.entries(expected)) subsetMatches((actual as Record<string, unknown>)[key], item, `${where}.${key}`);
    }
    return;
  }
  assert.strictEqual(actual, expected, where);
}

export const assertions: StorageConformanceAssertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
  deepEqual: (actual, expected) => assert.deepStrictEqual(stripUndefined(actual), stripUndefined(expected)),
  partialDeepEqual: (actual, expected) => subsetMatches(actual, expected),
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} is not greater than ${expected}`),
  async rejects(operation, messageIncludes) {
    let error: unknown;
    try {
      await operation;
    } catch (caught) {
      error = caught;
    }
    assert.ok(error !== undefined, `expected a rejection containing "${messageIncludes}", got a resolution`);
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(message.includes(messageIncludes), `rejection "${message}" does not include "${messageIncludes}"`);
  },
};

/** The installed pi-durable's version: the package accepts 1.0.4 and the 1.1 line, and its suites run on either. */
export const PI_DURABLE_VERSION: string = installedVersion("@earendil-works/pi-durable");

/** Whether the installed pi-durable's `Storage` contract has `order` on its scans, which 1.1.0 added. */
export const SCANS_HAVE_ORDER = atLeast(PI_DURABLE_VERSION, [1, 1]);

/** pi-durable 1.0.4 ships 23 cases and 1.1.0 ships 24, the scans in either order among them. A smaller number means the
 *  suite shrank and a green run proves less. */
export const MIN_CASES = SCANS_HAVE_ORDER ? 24 : 23;

/** The version in the package.json of the package `name` resolves to from here. */
function installedVersion(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const read = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
      if (read.name === name && typeof read.version === "string") return read.version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json of ${name} above its entry point`);
    dir = parent;
  }
}

/** Whether `version` (major.minor.patch) is at least `floor` (major, minor). */
function atLeast(version: string, [major, minor]: [number, number]): boolean {
  const [vMajor = 0, vMinor = 0] = version.split(".").map(Number);
  return vMajor > major || (vMajor === major && vMinor >= minor);
}

/** One node:test `it` per conformance case, under `describe(name)`. */
export function registerConformance(name: string, withStorage: StorageConformanceProvider): void {
  const cases = createStorageConformance({ assertions, withStorage });
  describe(name, () => {
    it(`has at least ${MIN_CASES} cases`, () => assert.ok(cases.length >= MIN_CASES, `only ${cases.length} cases`));
    for (const testCase of cases) it(testCase.name, () => testCase.run());
  });
}

/** Run every case without a runner; returns the failures (used to prove the suite catches a broken storage). */
export async function runConformance(withStorage: StorageConformanceProvider): Promise<{ total: number; failed: string[] }> {
  const cases = createStorageConformance({ assertions, withStorage });
  const failed: string[] = [];
  for (const testCase of cases) {
    try {
      await testCase.run();
    } catch {
      failed.push(testCase.name);
    }
  }
  return { total: cases.length, failed };
}
