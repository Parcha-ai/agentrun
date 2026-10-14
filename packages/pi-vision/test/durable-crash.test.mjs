// The crash matrix's rows through the adapter and the package's own readers and guard: a lead whose route takes no
// images asks `read` a question about a PDF page, the process is cut by SIGKILL at a point of that work, and a new
// process opens the same SQLite file. The wrapped read is replay-safe, so the cut call runs again in the same task with
// the same memos: a derivation cut half way is made again, a source that changed is read for what it now holds, and an
// answer the eyes gave before the cut is not asked for twice. crash-child.mjs is one process of a run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pdfBytes } from "@parcha/pi-vision/testing";
import { tmp } from "./durable/rig.mjs";

const CHILD = path.join(import.meta.dirname, "durable", "crash-child.mjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const SOURCE = pdfBytes([{ lines: ["Invented notice for a test", "Reference number 4471", "Nothing here is real"] }]);
const TWO_PAGES = pdfBytes([{ lines: ["Invented report for a test", "Page one of two"] }, { lines: ["The second invented page", "Item code 3318"] }]);
const CHANGED = pdfBytes([{ lines: ["A second invented notice", "Reference number 9026", "It replaced the first", "while the first was being read"] }]);
const PREFIX = (bytes) => sha(bytes).slice(0, 16);
const whole = (names) => names.filter((name) => !name.endsWith(".tmp"));

function child(paths, cut, mode) {
  const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, ...paths, CUT: cut, MODE: mode }, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk; });
  const exit = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, line: stdout.split("\n").find((l) => l.startsWith("RESULT ")) })));
  return { proc, exit, result: exit.then(({ line }) => (line === undefined ? undefined : JSON.parse(line.slice("RESULT ".length)))) };
}

/** A run on `source`, cut at `cut` (`between` runs after the cut point is reached, before the kill) and then resumed;
 *  or, with cut "none", one run that was never cut. */
async function run(cut, { source = SOURCE, between = async () => {} } = {}) {
  const dir = tmp("vision-crash-");
  // The children's temp root is inside the run's directory: what a process killed mid-read leaves goes with it.
  const paths = { DB: path.join(dir, "run.sqlite"), CWD: path.join(dir, "work"), OUT: path.join(dir, "evidence"), LEDGER: path.join(dir, "eyes.jsonl"), TMPDIR: path.join(dir, "tmp") };
  fs.mkdirSync(paths.CWD); fs.mkdirSync(paths.OUT); fs.mkdirSync(paths.TMPDIR);
  fs.writeFileSync(path.join(paths.CWD, "notice.pdf"), source);
  const derivedDir = path.join(paths.CWD, ".vision", "derived");
  const derivedNow = () => (fs.existsSync(derivedDir) ? fs.readdirSync(derivedDir).sort() : []);
  let atCut;
  if (cut !== "none") {
    const first = child(paths, cut, "first");
    const marker = path.join(paths.CWD, `.cut-${cut}`);
    for (let waited = 0; !fs.existsSync(marker); waited += 20) {
      assert.ok(waited < 60_000, `the first process never reached ${cut}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    atCut = { derived: derivedNow(), asks: lines(paths.LEDGER).length, filings: lines(path.join(paths.OUT, "calls.jsonl")).length, told: lines(path.join(paths.OUT, "looks.jsonl")).length };
    await between(paths);
    first.proc.kill("SIGKILL");
    assert.deepEqual(await first.exit, { code: null, signal: "SIGKILL", line: undefined }, "the first process died by SIGKILL at the cut, answering nothing");
  }
  const second = await child(paths, cut, "second").result;
  return {
    ...second,
    paths,
    atCut,
    asks: lines(paths.LEDGER).length,
    filings: lines(path.join(paths.OUT, "calls.jsonl")).map((call) => call.key),
    filedKept: lines(path.join(paths.OUT, "calls.jsonl")).map((call) => call.kept),
    /** Each look the host's rows were told of, with the process that told them. */
    told: lines(path.join(paths.OUT, "looks.jsonl")),
    receipts: fs.existsSync(path.join(paths.OUT, "vision")) ? fs.readdirSync(path.join(paths.OUT, "vision")).sort() : [],
    derived: derivedNow(),
    /** What the processes left in their temp root, by name without the random suffix. */
    left: fs.readdirSync(paths.TMPDIR).map((name) => name.slice(0, name.lastIndexOf("-") + 1)).sort(),
    /** The derivations each process finished, by name: `first` is the process that was cut. */
    kept: Object.fromEntries(["first", "second"].map((by) => [by, lines(path.join(paths.OUT, "kept.jsonl")).filter((k) => k.by === by).map((k) => k.name).sort()])),
  };
}

const clean = await run("none");
const readUsd = (outcome) => outcome.usage.tools.read.cost.total;
const seen = (outcome) => outcome.results.map((r) => [r.isError, r.content, r.details]);

test("an uncut run renders the page once, has the eyes answer once, files one receipt and prices the look once", () => {
  assert.equal(clean.settled, "done");
  assert.deepEqual(clean.left, [], "a run that is not cut leaves nothing in its temp root");
  assert.equal(clean.results.length, 1);
  assert.equal(clean.results[0].isError, false);
  assert.ok(clean.results[0].content.every((block) => block.type === "text"), "a route that takes no images is given the eyes' words");
  assert.match(clean.results[0].content.at(-1).text, /a page of \d+ base64 characters$/, "the eyes' answer is in the result");
  assert.deepEqual([clean.asks, clean.filings.length, clean.receipts.length], [1, 1, 1]);
  assert.ok(clean.derived.length >= 2 && clean.derived.every((name) => name.startsWith(PREFIX(SOURCE)) && !name.endsWith(".tmp")), "the document and its rendered page are kept, named by the source's hash");
  assert.deepEqual(clean.kept.second, clean.derived, "each is made and kept once");
  assert.equal(clean.results[0].details.media.sha256, sha(SOURCE));
  assert.ok(readUsd(clean) > 0);
  assert.equal(readUsd(clean), clean.results[0].usage.cost.total);
});

test("cut during a derivation: the half-written file is ignored, it is derived again, no extra eyes request, the same result", async () => {
  const cut = await run("derive");
  assert.deepEqual([whole(cut.atCut.derived), cut.atCut.derived.length, cut.atCut.asks], [[], 1, 0], "the cut fell with one temporary file written and nothing renamed");
  assert.deepEqual(cut.left, ["pi-vision-pdf-", "pi-vision-read-"], "the killed process leaves its read's temp directory and the PDF scratch, and nothing else");
  assert.equal(cut.settled, "done");
  assert.deepEqual(seen(cut), seen(clean), "the model sees the same result");
  assert.equal(cut.asks, 1, "0 extra eyes requests");
  assert.deepEqual(whole(cut.derived), clean.derived, "the same derivations, named by the source's hash and their parameters");
  assert.deepEqual(cut.kept, { first: [], second: clean.derived }, "each made and kept once, by the rerun");
  assert.deepEqual(cut.derived.filter((name) => name.endsWith(".tmp")), cut.atCut.derived, "the cut attempt's temporary file is left as it was and never used");
  assert.deepEqual([cut.filings.length, cut.receipts], [1, clean.receipts]);
  assert.equal(readUsd(cut), readUsd(clean), "priced once");
});

test("the source changes between hash and copy: the rerun names its derivations by the bytes it read and answers for them", async () => {
  const changed = await run("none", { source: CHANGED });
  const cut = await run("copy", { between: async (paths) => fs.writeFileSync(path.join(paths.CWD, "notice.pdf"), CHANGED) });
  assert.deepEqual([cut.atCut.derived, cut.atCut.asks], [[], 0], "the cut fell before anything was derived or asked");
  assert.equal(cut.settled, "done");
  assert.equal(cut.results[0].details.media.sha256, sha(CHANGED), "the result is for the bytes the rerun read");
  assert.deepEqual(seen(cut), seen(changed), "and is what an uncut read of those bytes gives");
  assert.notDeepEqual(seen(cut), seen(clean));
  assert.deepEqual(cut.derived, changed.derived, "every derivation is named by the hash of the bytes it came from");
  assert.deepEqual(cut.kept, { first: [], second: changed.derived });
  assert.ok(cut.derived.every((name) => name.startsWith(PREFIX(CHANGED))), "nothing is kept under the hash of the bytes the cut attempt hashed");
  assert.equal(cut.asks, 1, "0 extra eyes requests: the cut attempt never asked");
  assert.deepEqual(cut.receipts, changed.receipts);
  assert.match(fs.readFileSync(path.join(cut.paths.OUT, "vision", cut.receipts[0]), "utf8"), new RegExp(`^sha256: ${sha(CHANGED)}\n`));
});

test("cut during the receipt: the answer is a memo by then, so the rerun asks nothing, files again under the same key, and one receipt stands", async () => {
  const cut = await run("receipt");
  assert.deepEqual([cut.atCut.asks, cut.atCut.filings, whole(cut.atCut.derived)], [1, 1, clean.derived], "the cut fell after the eyes answered, inside the sink's first call");
  assert.equal(cut.settled, "done");
  assert.deepEqual(seen(cut), seen(clean), "the model sees the same result");
  assert.equal(cut.asks, 1, "0 extra eyes requests");
  assert.equal(cut.filings.length, 2, "the sink is called again");
  assert.equal(new Set(cut.filings).size, 1, "with the same key");
  assert.deepEqual(whole(cut.receipts), clean.receipts, "one receipt");
  assert.deepEqual(cut.derived, clean.derived);
  assert.deepEqual(cut.kept, { first: clean.derived, second: [] }, "the rerun makes no derivation again: it reads the document and the page the cut process kept");
  assert.equal(readUsd(cut), readUsd(clean), "the look is priced once, at the commit of its result");
  assert.deepEqual(cut.told.map((look) => [look.by, look.kept]), [["second", false]], "the cut attempt never told the host, so the rerun's report is the look's only one, and paid");
});

test("cut before the second of two looks is asked: the rerun asks only the second, reports the first as kept, and the result prices each once", async () => {
  const clean = await run("none", { source: TWO_PAGES });
  const keys = clean.told.map((look) => look.key);
  assert.deepEqual([clean.asks, new Set(keys).size, clean.told.map((look) => look.kept)], [2, 2, [false, false]], "an uncut read of two pages is two paid looks");
  const cut = await run("look", { source: TWO_PAGES });
  assert.deepEqual([cut.atCut.asks, cut.atCut.told], [1, 1], "the cut fell once the host was told of the first look, before the second was asked");
  assert.equal(cut.settled, "done");
  assert.deepEqual(seen(cut), seen(clean), "the model sees the same result");
  assert.equal(cut.asks, 2, "the eyes were asked once per look in all");
  assert.deepEqual(cut.told.map((look) => [look.by, look.key, look.kept]), [["first", keys[0], false], ["second", keys[0], true], ["second", keys[1], false]], "the rerun reports the first look as kept and the second as paid");
  assert.deepEqual(cut.filings.map((key, i) => [key, cut.filedKept[i]]), [[keys[0], false], [keys[0], true], [keys[1], false]], "the first look's receipt filed again says it was kept");
  assert.equal(cut.told.filter((look) => !look.kept).reduce((sum, look) => sum + look.costUsd, 0), clean.told.reduce((sum, look) => sum + look.costUsd, 0), "a host that charges every look not kept charges each once");
  assert.deepEqual(cut.results[0].usage, clean.results[0].usage, "the committed result's usage holds each look once");
  assert.equal(readUsd(cut), readUsd(clean));
});
