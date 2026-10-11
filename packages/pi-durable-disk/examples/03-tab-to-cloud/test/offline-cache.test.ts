// The service worker's two pure rules: how a request is keyed, and the headers every answer carries so a reload with no network is cross-origin isolated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheKey, isolated } from "../tab/offline-cache.ts";

test("a request's key is its origin and path: a page opened with a query is the same page", () => {
  assert.equal(cacheKey("http://127.0.0.1:5/run/abc?threads=6&judge=on"), "http://127.0.0.1:5/run/abc");
  const chunk = "http://127.0.0.1:5/api/runs/abc/work/" + "home/model/chunk-0001.bin";
  assert.equal(cacheKey(new URL(chunk)), chunk);
});

test("every answer carries the isolation headers, and keeps its body, status and own headers", async () => {
  const out = isolated(new Response("hello", { status: 200, statusText: "OK", headers: { "content-type": "text/html", "x-own": "1" } }));
  assert.equal(out.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(out.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(out.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(out.headers.get("content-type"), "text/html");
  assert.equal(out.headers.get("x-own"), "1");
  assert.equal(out.status, 200);
  assert.equal(await out.text(), "hello");
});

test("a response that cannot be rewrapped is returned as it is", () => {
  const redirect = Response.redirect("http://127.0.0.1:5/x", 302);
  assert.equal(isolated(redirect).status, 302);
  assert.equal(isolated(redirect).headers.get("location"), "http://127.0.0.1:5/x");
});
