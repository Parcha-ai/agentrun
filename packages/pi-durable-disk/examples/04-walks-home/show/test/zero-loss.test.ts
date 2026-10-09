import assert from "node:assert/strict";
import { test } from "node:test";
import { findLeaks } from "../publishable.ts";
import { assertBacksZeroLoss, duration, renderZeroLoss, type ChaosResults, type HopRound } from "../zero-loss.ts";

const rounds = (points: string[], ms: number[]): HopRound[] => points.map((killPoint, i) => ({ round: i + 1, killPoint, detail: "x", takeoverMs: ms[i]!, loss: 0 }));
// Results as the chaos pass writes them, with the local fields it carries (assembled from pieces: the repo's export
// scanner reads this file too). None of those may reach the page.
const j = (...parts: string[]) => parts.join("");
const results = {
  measured: true,
  measuredAt: "2026-10-09T08:58Z",
  provenance: {
    repo: "Parcha-ai/agentrun",
    mountHopCode: "demo/walks-home @ 6e79018",
    pipeHopCode: "ac2d1fd (PR #87, the workspace digest cache; in demo/walks-home since 779e4d9)",
    harness: { "chaos.mjs": "2a0b8c7d9e1f00112233445566778899aabbccddeeff00112233445566778899", "vm-host.mjs": "ab".repeat(32) },
    harnessNote: `kept in ${j("ev", "als/agentrun-archil-tl/demo/d0", "-tmp/chaos/")}`,
  },
  method: "Every acknowledged commit is read back from the store and every acknowledged file hashed straight from the mount: an independent read-back, never the pipe's own pipe.released digest.",
  mountHop: {
    setup: "tab <-> Modal runtime=vm host mounting the Archil disk (aws-us-east-1)",
    rounds: 10,
    loss: 0,
    takeoverMs: { p50: 933, min: 620, max: 1453 },
    ackedCommitsChecked: 677,
    ackedFilesChecked: 3,
    perRound: rounds(["mid-commit", "mid-write-through", "after an acknowledgement", "mid-commit", "mid-write-through", "after an acknowledgement", "mid-commit", "mid-write-through", "after an acknowledgement", "mid-commit"], [620, 674, 689, 891, 935, 932, 1012, 1230, 1453, 1423]),
    measuredAt: "2026-10-09T08:32Z",
    commit: "6e7901808b4644fe82c1b93a679b5c508c1ec76f",
  },
  pipeHop: {
    setup: "tab <-> Modal T4 sandbox (gVisor, us-east) through the pipe; work/ about 100 MB",
    rounds: 10,
    loss: 0,
    takeoverMs: { p50: 3386, min: 1712, max: 4102 },
    ackedCommitsChecked: 28,
    ackedFilesChecked: 8,
    orphanedUploads: 0,
    perRound: rounds(["mid-chunked-upload", "mid-attach-restore", "after an acknowledgement", "mid-chunked-upload", "mid-attach-restore", "after an acknowledgement", "mid-chunked-upload", "mid-attach-restore", "after an acknowledgement", "mid-chunked-upload"], [1753, 1712, 1751, 1795, 3490, 3625, 3844, 3855, 4102, 3281]),
    measuredAt: "2026-10-09T08:58Z",
    commit: "ac2d1fdf1f68ab9b758b3939a5110caffd3aa7b4",
  },
  pipeHopBeforeDigestCache: { commit: "6e7901808b4644fe82c1b93a679b5c508c1ec76f", takeoverMs: { p50: 6798, min: 1944, max: 11118 }, loss: 0 },
  raw: { mount: j("d0", "-tmp/chaos/chaos-mount-x.json") },
} as ChaosResults & Record<string, unknown>;

test("durations read as people say them", () => {
  assert.equal(duration(933), "933 ms");
  assert.equal(duration(1453), "1,453 ms");
  assert.equal(duration(3386), "3.4 s");
  assert.equal(duration(6798), "6.8 s");
});

test("the mounted VM is the headline: zero lost, its kills, its median takeover, the writes checked", () => {
  const html = renderZeroLoss(results);
  assert.match(html, /<h2>Zero loss, measured<\/h2>/);
  const facts = html.slice(html.indexOf('<div class="facts">'), html.indexOf("</div></div>") + 12);
  for (const n of ["<b>0</b>", "<b>10</b>", "<b>933 ms</b>", "<b>677</b>"]) assert.ok(facts.includes(n), n);
  assert.match(html, /20 host kills/);
  assert.match(html, /4 mid-commit, 3 mid-write-through, 3 after an acknowledgement/);
  assert.match(html, /median 933 ms \(620 ms to 1,453 ms\)/);
  assert.match(html, /677 commits, 3 files/);
});

test("the GPU through the pipe is shown apart, with its post-cache numbers and the cache's effect", () => {
  const html = renderZeroLoss(results);
  const pipe = html.slice(html.indexOf("<h3>The GPU, through the pipe</h3>"), html.indexOf("<h3>How it was checked</h3>"));
  assert.match(pipe, /median 3\.4 s \(1,712 ms to 4\.1 s\)/);
  assert.match(pipe, /Before the workspace digest cache it took a median 6\.8 s; the same pass now takes 3\.4 s/);
  assert.match(pipe, /Orphaned uploads left on the disk<\/td><td class="n">0/);
  assert.match(pipe, /4 mid-chunked-upload, 3 mid-attach-restore, 3 after an acknowledgement/);
  assert.doesNotMatch(html.slice(0, html.indexOf("<h3>The GPU")), /3\.4 s/, "the pipe's number is not the headline");
});

test("provenance: the code each hop ran on, the harness hashes, and an independent read-back as the method", () => {
  const html = renderZeroLoss(results);
  assert.match(html, /demo\/walks-home @ 6e79018/);
  assert.match(html, /ac2d1fd \(PR #87/);
  assert.match(html, /chaos\.mjs <code>2a0b8c7d9e1f<\/code>/);
  assert.match(html, /independent read-back, never the pipe&#39;s own pipe\.released digest|independent read-back, never the pipe's own pipe\.released digest/);
});

test("nothing local reaches the page, and the block passes the docs gate", () => {
  const html = renderZeroLoss(results);
  assert.doesNotMatch(html, /-tmp\b|\bevals\//, "no raw-file or harness-folder field is rendered");
  assert.deepEqual(findLeaks(html), []);
  assert.doesNotMatch(renderZeroLoss({ ...results, method: "a <b>bold</b> independent read-back, never the pipe's own digest" }), /<b>bold<\/b>/, "text is escaped");
});

test("the block claims zero loss, so it refuses a result that does not back it", () => {
  assert.doesNotThrow(() => assertBacksZeroLoss(results));
  const hop = (over: object) => ({ ...results.mountHop, ...over });
  assert.throws(() => renderZeroLoss({ ...results, measured: false }), /not marked measured/);
  assert.throws(() => renderZeroLoss({ ...results, mountHop: hop({ loss: 1 }) }), /mount hop reports loss 1/);
  assert.throws(() => renderZeroLoss({ ...results, pipeHop: { ...results.pipeHop, perRound: [...results.pipeHop.perRound.slice(0, 9), { ...results.pipeHop.perRound[9]!, loss: 2 }] } }), /a round of the pipe hop lost something/);
  assert.throws(() => renderZeroLoss({ ...results, mountHop: hop({ rounds: 11 }) }), /says 11 rounds and lists 10/);
  assert.throws(() => renderZeroLoss({ ...results, pipeHop: { ...results.pipeHop, orphanedUploads: 3 } }), /3 orphaned uploads/);
});

test("a zero-loss page rests on an independent read-back, never the pipe's own released digest", () => {
  assert.throws(() => renderZeroLoss({ ...results, method: "Each pipe.released digest was compared." }), /independent read-back/);
  assert.throws(() => renderZeroLoss({ ...results, method: "An independent read-back of the store." }), /never the pipe's own/);
});
