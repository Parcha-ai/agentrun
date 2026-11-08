// A server whose public address is https sends Strict-Transport-Security on its pages, so a browser that saw it once
// never opens the address over http again; over http, or on loopback with no public address, it sends none (a browser
// would pin the loopback address to https and lose the console).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as page from "../dist/page.js";
import { builtConsole, call, serve } from "./support.mjs";

const HSTS = "max-age=31536000";

test("the HSTS header: only for an https public address", () => {
  assert.deepEqual(page.hstsHeaders("https://agents.example.com"), { "strict-transport-security": HSTS });
  assert.deepEqual(page.hstsHeaders("https://agentrun-example.onrender.com/"), { "strict-transport-security": HSTS });
  assert.deepEqual(page.hstsHeaders("http://agents.example.com"), {});
  assert.deepEqual(page.hstsHeaders(undefined), {});
  assert.deepEqual(page.hstsHeaders("not a url"), {});
});

test("the console page and its assets carry HSTS at an https public address, and none on loopback with no public address", async (t) => {
  const console = await builtConsole(t);
  const https = await serve(t, { accounts: true, publicUrl: "https://agents.example.com", console });
  const index = await call(https.port, { path: "/" });
  assert.equal(index.status, 200);
  assert.equal(index.headers["strict-transport-security"], HSTS);
  const moved = await call(https.port, { path: "/setup" });
  assert.equal(moved.headers["strict-transport-security"], HSTS, "the moved setup address's redirect too");
  const plain = await serve(t, { accounts: true, openSetup: true, console });
  const local = await call(plain.port, { path: "/" });
  assert.equal(local.status, 200);
  assert.equal(local.headers["strict-transport-security"], undefined);
});
