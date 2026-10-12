// A line typed into the agent page's own composer takes the same road as one typed into the stage: through the server's placement when the page
// is attached to it, and to the page's own conversation only when it cannot reach the server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composerRoute, submitFrameKind, type ComposerFacts } from "../tab/composer.ts";

const writer: ComposerFacts = { held: false, running: true, mode: "writer", online: true, placed: true };

test("a writer page attached to a placing server sends its line to the server", () => {
  assert.equal(composerRoute(writer), "server");
});

test("offline, or checked out to this browser, the page runs the line itself", () => {
  assert.equal(composerRoute({ ...writer, online: false }), "local");
  assert.equal(composerRoute({ ...writer, mode: "offline" }), "local");
});

test("a server that does not place runs keeps the page's own conversation", () => {
  assert.equal(composerRoute({ ...writer, placed: false }), "local");
});

test("a page that only watches a run in the cloud or the browser sends to the server; one watching nothing sends nowhere", () => {
  const viewer: ComposerFacts = { held: false, running: false, mode: "viewer", online: true, placed: true };
  assert.equal(composerRoute({ ...viewer, watching: "cloud" }), "server");
  assert.equal(composerRoute({ ...viewer, watching: "tab" }), "server");
  assert.equal(composerRoute(viewer), "ignore");
  assert.equal(composerRoute({ ...viewer, mode: "lost", watching: "cloud" }), "ignore");
});

test("nothing is accepted while a checkout or a swap holds the run", () => {
  assert.equal(composerRoute({ ...writer, held: true }), "ignore");
});

test("a submit frame is a user's line (through the brain router) unless it is the server's own turn (requestId server-<switchId>), which goes straight in", () => {
  assert.equal(submitFrameKind("ui-5d1c"), "user");
  assert.equal(submitFrameKind("stage-1"), "user");
  assert.equal(submitFrameKind("server-sw-12"), "server");
});
