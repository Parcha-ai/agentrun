import assert from "node:assert/strict";
import { test } from "node:test";
import { findLeaks } from "../publishable.ts";

const clean = `<!doctype html><html><head><meta charset="utf-8"><title>Storyboard</title><style>body{color:#111}</style></head><body><p>Switched in 797 ms.</p><a href="2026-10-09-other.html">other</a><img src="data:image/png;base64,${"A".repeat(300)}"><video src="data:video/webm;base64,${"B".repeat(300)}"></video></body></html>`;

test("a clean page passes, and embedded bytes are not read as prose", () => {
  assert.deepEqual(findLeaks(clean), []);
  // base64 can contain anything; it must not trip the path or credential rules.
  assert.deepEqual(findLeaks(clean.replace("AAAA", "/home/ubuntu/sk-abcdefghijklmnop")), []);
});

test("machine-local detail is found", () => {
  for (const [bad, rule] of [
    ["see /home/ubuntu/worktrees/x", "a machine-local path"],
    ["scratch in /tmp/claude-1000/x", "a machine-local path"],
    ["run as user ubuntu", "a machine or user name"],
    ["the box greppy3", "a machine or user name"],
    ["listening on 127.0.0.1:8750", "a local or tailnet address"],
    ["tailnet 100.106.234.74", "a local or tailnet address"],
  ] as const) assert.ok(findLeaks(`<p>${bad}</p>`).some((l) => l.rule === rule), bad);
});

test("secrets are found: keys, tokens, bearer values and a run link with its secret", () => {
  for (const bad of ["-----BEGIN RSA PRIVATE KEY-----", "key sk-abcdefghijklmnop1234", "ghs_abcdefghijklmnopqrstuvwxyz", "Authorization: Bearer abcdefghijklmnop123", "token=abcdefghijklmnop1234", "http://x/run/stage#abcdefghij1234"]) {
    assert.ok(findLeaks(`<p>${bad}</p>`).length > 0, bad);
  }
  assert.deepEqual(findLeaks("<p>the run's secret stays in the link fragment</p>"), [], "the word alone is fine");
});

test("anything the page would load from outside is found", () => {
  for (const bad of ['<link rel="stylesheet" href="https://cdn.x/a.css">', '<script src="https://cdn.x/a.js"></script>', '<img src="https://x/a.png">', "<style>@import 'a.css'</style>", "<style>a{background:url(https://x/a.png)}</style>", '<iframe src="x"></iframe>']) {
    assert.ok(findLeaks(bad).some((l) => l.rule === "a remote resource the page would load"), bad);
  }
  assert.deepEqual(findLeaks('<a href="https://docs.example/page.html">link</a>'), [], "a link is not a load");
});
