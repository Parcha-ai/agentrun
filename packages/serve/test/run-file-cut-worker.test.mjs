// A run file's cut read (GET /v2/runs/{id}/files/{path}?cut=run) makes its cut in one kept worker thread (cut-pool.ts),
// off the server's event loop, under one deadline for the read: past it, or when the worker fails, the read is 503
// `unavailable`, never the text uncut. A cut running at its deadline is stopped with its worker, a cut still waiting
// behind it is dropped, and the next cut makes a new worker. The worker's cut is redactSecrets' own, census spans
// included, and the worker never holds a process open. That the read cuts what it should is run-file-cut's,
// run-file-cut-handed's and planted-run-reads' to say: each reads through this worker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CutPool, CutUnserved, cutInWorker } from "../dist/cut-pool.js";
import { heldSpans, redactSecrets } from "../dist/learn/secrets.js";
import { readRunFile } from "../dist/run-reads-over-store.js";
import { plantedValue } from "./fixtures/planted-secrets.mjs";
import { follow, runDir, serve, startRun } from "./support.mjs";

const FAULTS = new URL("./fixtures/cut-worker-faults.mjs", import.meta.url);
const CUT_ONCE = new URL("./fixtures/cut-once.mjs", import.meta.url);

/** How `promise` settles: ["ok", value] or ["refused", message], with how long it took. */
async function settled(promise) {
  const at = performance.now();
  try {
    return { how: "ok", value: await promise, ms: performance.now() - at };
  } catch (error) {
    assert.ok(error instanceof CutUnserved, `refused as CutUnserved, not ${error?.name}`);
    return { how: "refused", value: error.message, ms: performance.now() - at };
  }
}

test("a cut read whose cut is past its deadline is 503 unavailable, never the text uncut; read raw it is the bytes as written", { timeout: 120_000 }, async (t) => {
  const served = await serve(t, { cutMs: 1 });
  const monid = plantedValue("monid");
  assert.equal((await served.api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: monid } })).status, 204);
  const { run_id } = await startRun(served.api, "writer", "Write the report.", { tools: ["write"] });
  await follow(served.api, run_id, ["completed"]);
  // About 200 KiB with the key throughout: its cut takes far longer than 1 ms, in a worker or not.
  const text = Array.from({ length: 2500 }, (_, i) => `line ${i}: key=${monid} and the words around it.`).join("\n");
  await writeFile(join(runDir(served.data, run_id), "work", "long.txt"), text);
  const read = (cut) => fetch(`${served.baseUrl}/runs/${run_id}/files/long.txt${cut ? "?cut=run" : ""}`, { headers: { authorization: `Bearer ${served.token}` } });
  const cut = await read(true);
  const body = await cut.text();
  assert.equal(cut.status, 503, body.slice(0, 300));
  assert.equal(JSON.parse(body).error.code, "unavailable");
  assert.match(JSON.parse(body).error.message, /did not finish within \d+ ms/);
  assert.ok(!body.includes(monid), "no byte of the key in the refusal");
  assert.equal(cut.headers.get("x-agentrun-cut"), null, "a refusal is not marked as the cut text");
  const raw = await read(false);
  assert.equal(raw.status, 200);
  assert.equal(await raw.text(), text, "without the cut, the bytes as written");
});

test("the deadline is the whole read's: a cut read whose re-read of the run's cut runs past it is 503, not a late 200", { timeout: 30_000 }, async () => {
  const key = plantedValue();
  const bytes = Buffer.from(`key=${key} and the rest\n`);
  const workspace = {
    list: async () => [{ name: "notes.txt", kind: "file", size: bytes.length }],
    read: async () => new Uint8Array(bytes),
  };
  // The first read of the run's cut answers at once; the one underCut makes after the cut, to see nothing was saved
  // meanwhile, takes 3 s: a store slow to answer.
  let reads = 0;
  const deps = {
    withheld: async () => false,
    runWorkspace: async () => workspace,
    cutValues: async () => {
      reads += 1;
      if (reads > 1) await new Promise((resolve) => setTimeout(resolve, 3_000));
      return { values: [key] };
    },
    cutMs: 300,
  };
  const res = { status: undefined, body: undefined, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  const url = new URL("http://server.test/runs/r1/files/notes.txt?cut=run");
  const at = performance.now();
  const refused = await readRunFile({}, "r1", "notes.txt", { method: "GET" }, res, url, deps).then(() => undefined, (error) => error);
  const ms = performance.now() - at;
  assert.equal(res.status, undefined, `nothing answered: ${res.status} ${res.body}`);
  assert.equal(refused?.code, "unavailable", String(refused));
  assert.match(refused.message, /did not finish within 300 ms/);
  assert.ok(!refused.message.includes(key));
  assert.ok(ms < 2_000, `refused at the read's deadline, not after the slow re-read (${Math.round(ms)} ms)`);
});

test("the cut worker cuts as redactSecrets does: values in place, census spans, a byte order mark, compact JSON past 8 KB, a value split by a line break", async () => {
  const key = plantedValue();
  const other = plantedValue("whsec");
  const cases = [
    { text: `key=${key}\nhook=${other}\nthe rest stays.\n`, values: [key, other] },
    { text: `﻿key=${key} after a byte order mark`, values: [key] },
    { text: JSON.stringify({ key, words: Array.from({ length: 1500 }, (_, i) => ({ w: `word${i}`, at: i })) }), values: [key] },
    { text: `split ${key.slice(0, 10)}\n${key.slice(10)} across a line`, values: [key] },
    { text: "nothing held here at all", values: [key] },
  ];
  for (const { text, values } of cases) {
    const max = Buffer.byteLength(text);
    assert.equal(await cutInWorker(text, values, max), redactSecrets(text, values, max), text.slice(0, 40));
  }
  // A census's spans, the values gone: the worker cuts there as redactSecrets does given the same spans.
  const text = `first ${key} then ${other} last`;
  const spans = heldSpans(text, [key, other]);
  assert.notEqual(spans, "whole");
  const cut = await cutInWorker(text, [], Buffer.byteLength(text), spans);
  assert.equal(cut, redactSecrets(text, [], Buffer.byteLength(text), spans));
  assert.ok(!cut.includes(key) && !cut.includes(other), cut);
});

test("a cut running at its deadline is refused and its worker stopped; the next cut makes a new worker and is answered", { timeout: 30_000 }, async () => {
  const pool = new CutPool(FAULTS);
  assert.deepEqual([(await settled(pool.cut("warm", [], 64, [], 5_000))).value], ["WARM"]);
  const hung = await settled(pool.cut("hang", [], 64, [], 300));
  assert.equal(hung.how, "refused");
  assert.match(hung.value, /did not finish within 300 ms/);
  assert.ok(hung.ms < 5_000, `refused at its deadline, not later (${hung.ms} ms)`);
  const next = await settled(pool.cut("after", [], 64, [], 5_000));
  assert.deepEqual([next.how, next.value], ["ok", "AFTER"], "answered by a new worker, the hung one gone");
});

test("a cut stopped at its deadline takes its worker's thread with it: the process holds as many threads after as before", { timeout: 30_000, skip: process.platform !== "linux" && "reads /proc/self/task" }, async () => {
  const threads = () => readdirSync("/proc/self/task").length;
  // libuv's pool of threads starts at its first use: started here, so it is counted on both sides.
  await readFile(FAULTS);
  const pool = new CutPool(FAULTS);
  assert.equal((await settled(pool.cut("warm", [], 64, [], 5_000))).value, "WARM");
  const before = threads();
  assert.equal((await settled(pool.cut("hang", [], 64, [], 300))).how, "refused");
  assert.equal((await settled(pool.cut("after", [], 64, [], 5_000))).value, "AFTER");
  let after = threads();
  for (let i = 0; i < 50 && after > before; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = threads();
  }
  assert.ok(after <= before, `the hung worker's thread is gone: ${before} threads before, ${after} after`);
});

test("a cut waiting behind a hung one is dropped at its own deadline; one whose deadline outlasts the hung cut's is answered after it", { timeout: 30_000 }, async () => {
  const pool = new CutPool(FAULTS);
  const hung = settled(pool.cut("hang", [], 64, [], 600));
  const short = settled(pool.cut("short", [], 64, [], 150));
  const long = settled(pool.cut("long", [], 64, [], 10_000));
  const [h, s, l] = await Promise.all([hung, short, long]);
  assert.equal(h.how, "refused");
  assert.deepEqual([s.how, s.value], ["refused", "the cut did not finish within 150 ms"], "dropped while it waited");
  assert.ok(s.ms < h.ms, "dropped before the hung cut's own deadline");
  assert.deepEqual([l.how, l.value], ["ok", "LONG"]);
});

test("a worker that stops or throws refuses the cut it held, naming no word of the text, and the next cut is answered", { timeout: 30_000 }, async () => {
  const pool = new CutPool(FAULTS);
  const stopped = await settled(pool.cut("exit", [], 64, [], 5_000));
  assert.deepEqual([stopped.how, stopped.value], ["refused", "its worker stopped"]);
  assert.ok(stopped.ms < 5_000, "refused when the worker stopped, not at the deadline");
  assert.deepEqual([(await settled(pool.cut("again", [], 64, [], 5_000))).value], ["AGAIN"]);
  const threw = await settled(pool.cut("throw", [], 64, [], 5_000));
  assert.deepEqual([threw.how, threw.value], ["refused", "the cut failed (TypeError)"]);
  assert.deepEqual([(await settled(pool.cut("then", [], 64, [], 5_000))).value], ["THEN"]);
  // Thrown uncaught, the worker's "error" event: the cut it held is refused by the error's name alone, and a new worker
  // answers the next.
  const crashed = await settled(pool.cut("crash", [], 64, [], 5_000));
  assert.deepEqual([crashed.how, crashed.value], ["refused", "its worker failed (TypeError)"]);
  assert.ok(crashed.ms < 5_000, "refused when the worker failed, not at the deadline");
  assert.deepEqual([(await settled(pool.cut("last", [], 64, [], 5_000))).value], ["LAST"]);
});

test("the kept cut worker never holds a process open: one that cut a text and returned ends on its own", { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, [CUT_ONCE.pathname], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [code, signal] = await new Promise((resolve) => child.on("exit", (...args) => resolve(args)));
  clearTimeout(timer);
  assert.deepEqual([code, signal], [0, null], `ended on its own; stderr: ${err.slice(0, 300)}`);
  assert.equal(out, "key=[redacted] stays\n");
});
