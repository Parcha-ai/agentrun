import assert from "node:assert/strict";
import { test } from "node:test";
import { findLeaks } from "../publishable.ts";

// The leaky samples are assembled from pieces: this repo is public and its own export scanner (rightly) cannot tell a fixture
// from a leak, so no literal machine path or key block is written in this file.
const j = (...parts: string[]) => parts.join("");
const HOME_PATH = j("/ho", "me/ubuntu/");
const TMP_PATH = j("/t", "mp/claude-1000/x");
const KEY_BLOCK = j("-----BEGIN ", "RSA PRIVATE KEY-----");

const clean = `<!doctype html><html><head><meta charset="utf-8"><title>Storyboard</title><style>body{color:#111}</style></head><body><p>Switched in 797 ms.</p><a href="2026-10-09-other.html">other</a><img src="data:image/png;base64,${"A".repeat(300)}"><video src="data:video/webm;base64,${"B".repeat(300)}"></video></body></html>`;

test("a clean page passes, and embedded bytes are not read as prose", () => {
  assert.deepEqual(findLeaks(clean), []);
  // base64 can contain anything; it must not trip the path or credential rules.
  assert.deepEqual(findLeaks(clean.replace("AAAA", `${HOME_PATH}sk-abcdefghijklmnop`)), []);
});

test("machine-local detail is found", () => {
  for (const [bad, rule] of [
    [`see ${HOME_PATH}worktrees/x`, "a machine-local path"],
    [`scratch in ${TMP_PATH}`, "a machine-local path"],
    ["run as user ubuntu", "a machine or user name"],
    ["the box greppy3", "a machine or user name"],
    ["listening on 127.0.0.1:8750", "a local or tailnet address"],
    ["tailnet 100.106.234.74", "a local or tailnet address"],
  ] as const) assert.ok(findLeaks(`<p>${bad}</p>`).some((l) => l.rule === rule), bad);
});

test("secrets are found: keys, tokens, bearer values and a run link with its secret", () => {
  for (const bad of [KEY_BLOCK, "key sk-abcdefghijklmnop1234", "ghs_abcdefghijklmnopqrstuvwxyz", "Authorization: Bearer abcdefghijklmnop123", "token=abcdefghijklmnop1234", "http://x/run/stage#abcdefghij1234"]) {
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

test("lane scratch paths, worktree names and more host names are found", () => {
  // Assembled from pieces, as above: the repo's export scanner reads this file too.
  for (const [bad, rule] of [
    [`raw rounds in ${j("d0", "-tmp/chaos/rounds.json")}`, "a lane scratch path"],
    [`see ${j("d12", "-tmp/x")}`, "a lane scratch path"],
    [`report in ${j("ev", "als/agentrun-archil-tl/demo/D0-REPORT.md")}`, "a lane scratch path"],
    [`a temp dir ${j("tm", "p/pda-demo-links")}`, "a lane scratch path"],
    [`built in ${j("work", "trees/demo-d0-show")}`, "a worktree name"],
    [`checked out as ${j("demo-", "d4-vm")}`, "a worktree name"],
    [`the ${j("agentrun-", "pda-demo")} checkout`, "a worktree name"],
    [`the box ${j("grep", "py2")}`, "a machine or user name"],
    [`host ${j("ns", "1234567")}`, "a machine or user name"],
    [`reach it at ${j("box.tail1234.", "ts", ".", "net")}`, "a machine or user name"],
    [`instance ${j("ip-10-", "0-1-23")}`, "a machine or user name"],
  ] as const) assert.ok(findLeaks(`<p>${bad}</p>`).some((l) => l.rule === rule), bad);
  // Words the show uses legitimately are fine.
  for (const ok of ["a Modal T4 sandbox in us-east, the disk in aws-us-east-1", "demo/walks-home @ 779e4d9", "the tab-to-cloud demo, 10 rounds", "pipe hop median 3.4 s"]) {
    assert.deepEqual(findLeaks(`<p>${ok}</p>`), [], ok);
  }
});

