import assert from "node:assert/strict";
import { test } from "node:test";
import { apiRoot, apiUrl } from "../page/api-base.ts";

// The obsession page is served at /obsession/ by the show server, and, packaged with the agent's tab on one origin, at /show/obsession/ by the 03 server. Its API calls and its tab are
// relative to where it is served, never to the origin's root; `?api=` points them at another server.
test("the API root follows where the page is served", () => {
  assert.equal(apiRoot("http://h:8752/obsession/", null), "http://h:8752/");
  assert.equal(apiRoot("http://h:8752/obsession/index.html?debug=1", null), "http://h:8752/");
  assert.equal(apiRoot("http://h:8752/obsession", null), "http://h:8752/");
  assert.equal(apiRoot("http://h:8752/show/obsession/", null), "http://h:8752/show/");
  assert.equal(apiRoot("http://h:8752/show/obsession/#x", null), "http://h:8752/show/");
});

test("?api= names another server for the feed; a value that is not http or https is ignored", () => {
  assert.equal(apiRoot("http://h:8752/show/obsession/", "http://stage.example:9/"), "http://stage.example:9/");
  assert.equal(apiRoot("http://h:8752/show/obsession/", "http://stage.example:9"), "http://stage.example:9/");
  assert.equal(apiRoot("http://h:8752/show/obsession/", "javascript:alert(1)"), "http://h:8752/show/");
  assert.equal(apiRoot("http://h:8752/show/obsession/", "not a url"), "http://h:8752/show/");
});

test("a path joins the root, with or without a leading slash, and keeps its query", () => {
  assert.equal(apiUrl("http://h:8752/show/", "/api/state"), "http://h:8752/show/api/state");
  assert.equal(apiUrl("http://h:8752/show/", "api/events?after=4"), "http://h:8752/show/api/events?after=4");
  assert.equal(apiUrl("http://h:8752/", "/api/disk/train/progress.jsonl"), "http://h:8752/api/disk/train/progress.jsonl");
});
