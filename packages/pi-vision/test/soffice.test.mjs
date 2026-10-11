// The LibreOffice provider against a stand-in program that writes a PDF the way `soffice --convert-to` does: what the
// provider runs and where (a profile, an input and an output of its own under the call's directory, all removed
// after), what it makes of each way a conversion goes wrong, and that a bomb never reaches the program. A real
// LibreOffice is exercised in test/binaries when the environment has one.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OfficeMissError } from "@parcha/pi-vision";
import { sofficeProvider } from "@parcha/pi-vision/providers/soffice";
import { registerProviderConformance } from "@parcha/pi-vision/testing";
import { zipSync } from "fflate";
import { docx, para, workspace } from "./office-fixtures.mjs";

const FAKE = `#!/bin/sh
here=$(dirname "$0")
mode=$(cat "$here/mode" 2>/dev/null || echo ok)
echo "$@" >> "$here/calls.log"
if [ "$1" = "--version" ]; then echo "LibreOffice 24.8.1.2 stand-in build"; exit 0; fi
outdir=""; profile=""; input=""; prev=""
for arg in "$@"; do
  case "$prev" in --outdir) outdir="$arg";; esac
  case "$arg" in -env:UserInstallation=file://*) profile="\${arg#-env:UserInstallation=file://}";; esac
  prev="$arg"; input="$arg"
done
mkdir -p "$profile"
case "$mode" in
  fail) echo "Error: source file could not be loaded" >&2; exit 3;;
  empty) exit 0;;
  hang) sleep 30; exit 0;;
esac
cp "$input" "$here/last-input"
name=$(basename "$input"); stem="\${name%.*}"
printf '%%PDF-1.4 stand-in render of %s\\n' "$name" > "$outdir/$stem.pdf"
`;
const MiB = 1024 * 1024;
const misses = (code, message) => (error) => error instanceof OfficeMissError && error.code === code && message.test(error.message);

async function rig(t, options = {}) {
  const w = await workspace(t);
  const bin = join(w.dir.path, "bin");
  const work = join(w.dir.path, "work");
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(bin, "soffice"), FAKE);
  chmodSync(join(bin, "soffice"), 0o755);
  const mode = (value) => writeFileSync(join(bin, "mode"), value);
  const log = () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n") : []);
  const provider = sofficeProvider({ command: join(bin, "soffice"), ...options });
  return { ...w, bin, work, mode, log, provider, call: () => ({ env: w.env, signal: undefined, tempDir: work }) };
}

test("detect names the program's own version line", async (t) => {
  const r = await rig(t);
  assert.deepEqual(await r.provider.detect(r.env), { available: true, version: "LibreOffice 24.8.1.2 stand-in build" });
});

test("a conversion runs the program in a private profile, with an input and an output of its own, and leaves only the PDF", async (t) => {
  const r = await rig(t);
  const bytes = docx(para("A letter"));
  const source = await r.source("letter.DOCX", bytes);
  const out = await r.provider.office(source, {}, r.call());
  assert.deepEqual(out.madeBy, { provider: "soffice", version: "LibreOffice 24.8.1.2 stand-in build" });
  assert.equal(out.path, join(r.work, `soffice-${source.sha256}.pdf`));
  const stem = source.sha256.slice(0, 16);
  assert.equal(readFileSync(out.path, "utf8"), `%PDF-1.4 stand-in render of ${stem}.docx\n`, "the input is named by its hash and keeps its extension");
  assert.deepEqual(readFileSync(join(r.bin, "last-input")), Buffer.from(bytes), "LibreOffice was given the document's own bytes");
  assert.deepEqual(readdirSync(r.work), [`soffice-${source.sha256}.pdf`], "the profile, the input and the output directory are gone");
  const [, run] = r.log();
  const work = join(r.work, `soffice-${stem}`);
  assert.equal(run, `--headless --invisible --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://${work}/profile --convert-to pdf --outdir ${work}/out ${work}/in/${stem}.docx`);
  assert.ok(existsSync(join(r.dir.path, "letter.DOCX")), "the source is untouched");
});

test("a directory whose name has a space, a hash or a question mark reaches LibreOffice as a URL that names it", async (t) => {
  const r = await rig(t);
  const odd = join(r.dir.path, "odd dir #1 ?");
  mkdirSync(odd);
  const source = await r.source("letter.docx", docx(para("A letter")));
  const out = await r.provider.office(source, {}, { ...r.call(), tempDir: odd });
  assert.equal(out.path, join(odd, `soffice-${source.sha256}.pdf`));
  const [, run] = r.log();
  const url = /-env:UserInstallation=(\S+)/.exec(run)[1];
  assert.equal(url, `file://${join(odd, `soffice-${source.sha256.slice(0, 16)}`, "profile").split("/").map(encodeURIComponent).join("/")}`);
  assert.ok(url.includes("odd%20dir%20%231%20%3F/"), url);
});

test("two conversions of different documents do not share a directory or a profile", async (t) => {
  const r = await rig(t);
  const [a, b] = await Promise.all([r.source("a.docx", docx(para("one"))), r.source("b.docx", docx(para("two")))]);
  const [x, y] = await Promise.all([r.provider.office(a, {}, r.call()), r.provider.office(b, {}, r.call())]);
  assert.notEqual(x.path, y.path);
  assert.equal(readdirSync(r.work).length, 2);
  const profiles = r.log().filter((line) => line.includes("--convert-to")).map((line) => /UserInstallation=file:\/\/(\S+)/.exec(line)[1]);
  assert.equal(new Set(profiles).size, 2);
});

test("a conversion that fails, or ends without a PDF, is unreadable and leaves nothing behind", async (t) => {
  const r = await rig(t);
  const source = await r.source("broken.docx", docx(para("x")));
  r.mode("fail");
  await assert.rejects(r.provider.office(source, {}, r.call()), misses("unreadable", /LibreOffice could not convert it to a PDF \(exit 3\)/));
  r.mode("empty");
  await assert.rejects(r.provider.office(source, {}, r.call()), misses("unreadable", /LibreOffice could not convert it to a PDF \(exit 0\)/));
  assert.deepEqual(readdirSync(r.work), []);
});

test("a conversion that runs too long is cut and is over budget", async (t) => {
  const r = await rig(t, { timeoutS: 1 });
  r.mode("hang");
  const source = await r.source("slow.docx", docx(para("x")));
  const started = performance.now();
  await assert.rejects(r.provider.office(source, {}, r.call()), misses("over_budget", /LibreOffice did not finish within 1 s/));
  assert.ok(performance.now() - started < 10_000);
  assert.deepEqual(readdirSync(r.work), []);
});

test("a zip bomb never reaches the program", async (t) => {
  const r = await rig(t);
  const source = await r.source("bomb.docx", zipSync({ "word/document.xml": new Uint8Array(60 * MiB) }, { level: 1 }));
  await assert.rejects(r.provider.office(source, {}, r.call()), misses("over_budget", /the archive declares 60\.0 MiB from 0\.[0-9] MiB, over 100 to 1/));
  assert.equal(r.log().filter((line) => line.includes("--convert-to")).length, 0);
  await assert.rejects(r.provider.office({ ...(await r.source("big.docx", docx(para("x")))), bytes: 70 * MiB }, {}, r.call()), misses("over_budget", /over the 64\.0 MiB the reader takes into memory/));
  assert.equal(r.log().filter((line) => line.includes("--convert-to")).length, 0);
});

test("without the program the provider says what it needs, never throws from detect, and office is a needs miss", async (t) => {
  const w = await workspace(t);
  const provider = sofficeProvider({ command: join(w.dir.path, "no-such-soffice") });
  const found = await provider.detect(w.env);
  assert.equal(found.available, false);
  assert.equal(found.needs, "LibreOffice (soffice) in the environment");
  assert.match(found.reason, /exited 127/);
  const throwing = { ...w.env, id: "throws", createTempDir: async () => { throw new Error("no disk"); } };
  assert.deepEqual(await provider.detect(throwing), { available: false, needs: "LibreOffice (soffice) in the environment", reason: "no disk" });
  await assert.rejects(provider.office(await w.source("x.docx", docx(para("x"))), {}, w.call()), misses("needs", /^LibreOffice \(soffice\) in the environment: .*exited 127/));
});

// The conformance suite's own cases for a provider that has the `office` capability: it detects and has its method.
const w = await workspace({ after: (f) => test.after(f) });
registerProviderConformance({ provider: sofficeProvider({ command: join(w.dir.path, "missing") }), env: () => w.env, fixtures: [], requireAvailable: false });
