// Stopping the server removes the cloud's machines whatever else fails.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeServerAndCloud } from "../shutdown.ts";

const logs: string[] = [];
const log = (event: string) => void logs.push(event);

test("the cloud host is closed although closing the server throws, and the exit code says it failed", async () => {
  let cloudClosed = 0;
  const code = await closeServerAndCloud({ close: async () => Promise.reject(new Error("a socket would not close")) }, { close: async () => void cloudClosed++ }, log);
  assert.equal(cloudClosed, 1);
  assert.equal(code, 1);
  assert.ok(logs.includes("close.failed"));
});

test("a failing cloud close is reported, not thrown; a clean stop is code 0; a server without a cloud is fine", async () => {
  assert.equal(await closeServerAndCloud({ close: async () => undefined }, { close: async () => Promise.reject(new Error("modal said no")) }, log), 1);
  assert.ok(logs.includes("cloud.close-failed"));
  let closed = 0;
  assert.equal(await closeServerAndCloud({ close: async () => void closed++ }, { close: async () => void closed++ }, log), 0);
  assert.equal(closed, 2);
  assert.equal(await closeServerAndCloud({ close: async () => undefined }, undefined, log), 0);
});
