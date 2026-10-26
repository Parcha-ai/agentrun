// With AGENTRUN_ACCOUNTS unset, serve is the server it was before accounts: no accounts file in the data directory, the
// accounts paths are the 404s every unknown path is, and the answers carry nothing new.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { call, follow, SHAPES, serve, shapesOf, startRun } from "./support.mjs";

test("with accounts off: the data directory holds only what it held, the accounts paths are 404s, and no answer carries anything new", async (t) => {
  const { api, data, port, token } = await serve(t);
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  await follow(api, run_id, ["completed"]);
  const bearer = { authorization: `Bearer ${token}` };
  for (const [method, path] of [
    ["GET", "/v2/me"], ["GET", "/v2/people"], ["PATCH", "/v2/people/someone"], ["GET", "/v2/activity"], ["GET", `/v2/runs/${run_id}/activity`],
    ["POST", "/v2/setup"], ["GET", "/v2/auth/get-session"], ["POST", "/v2/auth/sign-in/email"], ["POST", "/v2/auth/sign-up/email"],
  ]) {
    const res = await call(port, { method, path, headers: { ...bearer, "content-type": "application/json" }, body: method === "GET" ? undefined : {} });
    assert.deepEqual([res.status, res.json?.error?.code], [404, "not_found"], `${method} ${path}`);
    assert.equal(res.headers["set-cookie"], undefined, `${method} ${path}`);
  }
  for (const path of ["/setup", "/sign-in", "/setup.js", "/sign-in.js"]) {
    const res = await call(port, { path });
    assert.deepEqual([res.status, res.json?.error?.code], [404, "not_found"], path);
  }
  const page = await call(port, { path: "/" });
  assert.equal(page.status, 401);
  assert.match(page.text, /Open the link agentrun-serve printed/);
  const listed = await call(port, { path: "/v2/agents", headers: bearer });
  assert.deepEqual(Object.keys(listed.headers).sort(), ["cache-control", "connection", "content-type", "date", "keep-alive", "transfer-encoding", "x-content-type-options", "x-request-id"]);
  assert.deepEqual(await shapesOf(api, "calc", run_id), SHAPES);
  assert.deepEqual((await readdir(data)).sort(), [".door-token", ".token", "runs", "store.sqlite"]);
});
