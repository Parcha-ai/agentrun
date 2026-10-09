// The ceiling on one command's time: an agent's longer timeout is cut to it, a shorter one is kept, none gets the ceiling, and every
// other method of the environment still works.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { capTimeouts } from "../capped-env.ts";

const fake = () => {
  const seen: (number | undefined)[] = [];
  const env = {
    marker: "kept",
    async exec(_command: unknown, options: { timeout?: number } | undefined) {
      seen.push(options?.timeout);
      return { ok: true };
    },
    async cleanup() {
      return "cleaned";
    },
  } as unknown as ExecutionEnv;
  return { env, seen };
};

test("a longer timeout is cut to the ceiling, a shorter one kept, none gets the ceiling", async () => {
  const { env, seen } = fake();
  const capped = capTimeouts(env, 150);
  await capped.exec("sleep 1", { timeout: 300 }, {} as never);
  await capped.exec("sleep 1", { timeout: 20 }, {} as never);
  await capped.exec("sleep 1", undefined, {} as never);
  assert.deepEqual(seen, [150, 20, 150]);
});

test("other methods and properties pass through; a ceiling of 0 or NaN leaves the environment alone", async () => {
  const { env } = fake();
  const capped = capTimeouts(env, 150) as unknown as { marker: string; cleanup(): Promise<string> };
  assert.equal(capped.marker, "kept");
  assert.equal(await capped.cleanup(), "cleaned");
  assert.equal(capTimeouts(env, 0), env);
  assert.equal(capTimeouts(env, Number.NaN), env);
});
