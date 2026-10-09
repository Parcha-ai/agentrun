// pi-durable's environment conformance suite against the tab's Wasmer environment, on the Node SDK: which of pi's
// ExecutionEnv contracts the in-tab computer meets. Each case gets a fresh sandbox (a fresh /workspace).
//   WASMER_CACHE=<dir> node scripts/env-conformance.ts
import assert from "node:assert/strict";
import { Wasmer } from "@wasmer/sdk/node";
import { createEnvConformance, type EnvConformanceAssertions } from "@earendil-works/pi-durable/testing";
import { WasmerEnv } from "../tab/wasmer-env.ts";

const assertions: EnvConformanceAssertions = {
  ok: (value, message) => assert.ok(value, message ?? "expected a truthy value"),
  strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
  deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
  partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} is not greater than ${expected}`),
  rejects: async (operation, messageIncludes) => {
    await assert.rejects(operation, (error: unknown) => error instanceof Error && error.message.includes(messageIncludes));
  },
};

const wasmer = new Wasmer({ cache: { directory: process.env.WASMER_CACHE ?? ".wasmer-cache" } });
await wasmer.ready();
const [edge] = await wasmer.packages.loadMany(["wasmer/edgejs"]);
let n = 0;
const cases = createEnvConformance({
  assertions,
  withEnv: async (use) => {
    const sandbox = await wasmer.sandboxes.create({ packages: [edge!], shell: edge!.command("bash"), env: { LANG: "C.UTF-8" } });
    const env = new WasmerEnv(sandbox as never, { id: `wasmer:conformance-${++n}` });
    try {
      await use(env);
    } finally {
      await env.cleanup();
      await sandbox.close();
    }
  },
});
const failed: { name: string; error: string }[] = [];
for (const c of cases) {
  try {
    await Promise.race([c.run(), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), c.timeoutMs ?? 60_000))]);
  } catch (error) {
    failed.push({ name: c.name, error: String((error as Error)?.message ?? error).split("\n")[0]!.slice(0, 200) });
  }
}
console.log(JSON.stringify({ total: cases.length, passed: cases.length - failed.length, failed }, null, 1));
await wasmer.close();
