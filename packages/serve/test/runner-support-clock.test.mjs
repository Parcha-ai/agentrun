import assert from "node:assert/strict";
import { test } from "node:test";
import { stores, until } from "./runner-support.mjs";

test("stores defaults to the advancing wall clock plus skew on both server and runner handles", async () => {
  const { server, runners: [runner], clock } = await stores();
  const between = async (store) => {
    const before = Date.now() + clock.skewMs;
    const value = await store.sealedKeys.clock();
    assert.ok(value >= before && value <= Date.now() + clock.skewMs, `store clock ${value} follows wall time plus skew`);
    return value;
  };
  const first = await between(server);
  await until(() => Date.now() > first, "the real wall clock advanced");
  assert.ok(await between(runner) > first, "the default clock was not frozen at open");
  clock.skewMs += 12_345;
  await between(server);
  await between(runner);
});

test("an explicit time source moves both store handles without changing the real wall clock", async () => {
  let at = 1_000_000;
  const { server, runners: [runner], clock } = await stores({ time: () => at });
  assert.equal(await server.sealedKeys.clock(), at);
  assert.equal(await runner.sealedKeys.clock(), at);
  assert.ok(Date.now() > at, "the fixture's past clock did not change wall-clock deadlines");
  at += 10_000;
  clock.skewMs += 5_000;
  assert.equal(await server.sealedKeys.clock(), at + 5_000);
  assert.equal(await runner.sealedKeys.clock(), at + 5_000);
  assert.ok(Date.now() > at, "no global Date or timer was replaced");
});
