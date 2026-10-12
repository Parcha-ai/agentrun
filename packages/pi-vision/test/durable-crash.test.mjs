// The crash matrix's rows at the adapter: a `read` with a question, cut by SIGKILL at a point of the core's work, and
// a new process on the same SQLite file. The wrapped read is replay-safe, so the cut call runs again in the same task
// with the same memos: a derivation cut half way is made again, a source that changed is read for what it now holds,
// and an answer the eyes gave before the cut is not asked for twice. The core is crash-child.mjs's.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pngBytes } from "@parcha/pi-vision/testing";
import { tmp } from "./durable/rig.mjs";

const CHILD = path.join(import.meta.dirname, "durable", "crash-child.mjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const SOURCE = pngBytes(40, 30, (x, y) => [x * 6, y * 8, 90]);

function child(paths, cut, mode) {
  const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, ...paths, CUT: cut, MODE: mode }, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk; });
  const exit = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, line: stdout.split("\n").find((l) => l.startsWith("RESULT ")) })));
  return { proc, exit, result: exit.then(({ line }) => (line === undefined ? undefined : JSON.parse(line.slice("RESULT ".length)))) };
}

/** A run cut at `cut` (`between` runs after the cut point is reached, before the kill), then resumed; or, with cut
 *  "none", one run that was never cut. */
async function run(cut, between = async () => {}) {
  const dir = tmp("vision-crash-");
  const paths = { DB: path.join(dir, "run.sqlite"), CWD: path.join(dir, "work"), OUT: path.join(dir, "evidence"), LEDGER: path.join(dir, "eyes.jsonl") };
  fs.mkdirSync(paths.CWD); fs.mkdirSync(paths.OUT);
  fs.writeFileSync(path.join(paths.CWD, "scan.png"), SOURCE);
  if (cut !== "none") {
    const first = child(paths, cut, "first");
    const marker = path.join(paths.CWD, `.cut-${cut}`);
    for (let waited = 0; !fs.existsSync(marker); waited += 20) {
      assert.ok(waited < 20_000, `the first process never reached ${cut}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await between(paths);
    first.proc.kill("SIGKILL");
    assert.deepEqual(await first.exit, { code: null, signal: "SIGKILL", line: undefined }, "the first process died by SIGKILL at the cut, answering nothing");
  }
  const second = await child(paths, cut, "second").result;
  const derivedDir = path.join(paths.CWD, ".vision", "derived");
  return {
    ...second,
    paths,
    asks: lines(paths.LEDGER).length,
    filings: lines(path.join(paths.OUT, "calls.jsonl")).map((call) => call.key),
    receipts: fs.existsSync(path.join(paths.OUT, "vision")) ? fs.readdirSync(path.join(paths.OUT, "vision")).sort() : [],
    derived: fs.existsSync(derivedDir) ? fs.readdirSync(derivedDir).sort() : [],
  };
}

const clean = await run("none");
const readUsd = (outcome) => outcome.usage.tools.read.cost.total;

test("an uncut run asks the eyes once, derives once, files one receipt and prices the look once", () => {
  assert.equal(clean.settled, "done");
  assert.equal(clean.results.length, 1);
  assert.equal(clean.results[0].isError, false);
  assert.deepEqual([clean.asks, clean.filings.length, clean.receipts.length, clean.derived.length], [1, 1, 1, 1]);
  assert.ok(readUsd(clean) > 0);
  assert.equal(readUsd(clean), clean.results[0].usage.cost.total);
});

test("cut during a derivation: the half-written file is ignored, the page is derived again, no extra eyes request, the same result", async () => {
  const cut = await run("derive");
  assert.equal(cut.settled, "done");
  assert.deepEqual(cut.results.map((r) => [r.isError, r.content]), clean.results.map((r) => [r.isError, r.content]), "the model sees the same result");
  assert.equal(cut.asks, 1, "0 extra eyes requests");
  const finished = cut.derived.filter((name) => !name.endsWith(".tmp"));
  assert.deepEqual(finished, clean.derived, "one finished derivation, named by the source's hash and its parameters");
  assert.ok(finished[0].startsWith(sha(SOURCE).slice(0, 16)));
  assert.equal(cut.derived.filter((name) => name.endsWith(".tmp")).length, 1, "the cut attempt's temporary file is left and never used");
  assert.deepEqual(fs.readFileSync(path.join(cut.paths.CWD, ".vision", "derived", finished[0])), Buffer.from(SOURCE));
  assert.equal(readUsd(cut), readUsd(clean), "priced once");
});

test("the source changes between hash and copy: the rerun names its derivation by the bytes it read and answers for them", async () => {
  const changed = pngBytes(64, 48, (x, y) => [200, x * 3, y * 5]);
  const cut = await run("copy", async (paths) => fs.writeFileSync(path.join(paths.CWD, "scan.png"), changed));
  assert.equal(cut.settled, "done");
  const [result] = cut.results;
  assert.equal(result.details.sha256, sha(changed), "the result is for the bytes the rerun read");
  assert.deepEqual(cut.derived, [`${sha(changed).slice(0, 16)}${clean.derived[0].slice(16)}`], "nothing was derived from the bytes the cut attempt read");
  assert.match(result.content[0].text, new RegExp(`an image of ${Buffer.from(changed).toString("base64").length} base64 characters`));
  assert.equal(cut.asks, 1, "0 extra eyes requests: the cut attempt never asked");
  assert.match(fs.readFileSync(path.join(cut.paths.OUT, "vision", cut.receipts[0]), "utf8"), new RegExp(`sha256: ${sha(changed)}`));
});

test("cut during the receipt: the answer is a memo by then, so the rerun asks nothing, files again under the same key, and one receipt stands", async () => {
  const cut = await run("receipt");
  assert.equal(cut.settled, "done");
  assert.deepEqual(cut.results.map((r) => [r.isError, r.content]), clean.results.map((r) => [r.isError, r.content]), "the model sees the same result");
  assert.equal(cut.asks, 1, "0 extra eyes requests");
  assert.equal(cut.filings.length, 2, "the sink is called again");
  assert.equal(new Set(cut.filings).size, 1, "with the same key");
  assert.deepEqual(cut.receipts.filter((name) => !name.endsWith(".tmp")), clean.receipts, "one receipt");
  assert.equal(readUsd(cut), readUsd(clean), "the look is priced once, at the commit of its result");
});
