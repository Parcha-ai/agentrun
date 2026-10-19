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
import { strToU8, zipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
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
cp "$profile/user/registrymodifications.xcu" "$here/seen-xcu" 2>/dev/null
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

/** The environment with what `unshare` does decided here, and every program it was asked to start recorded. A probe
 *  (`unshare -rn true`) answers as the system would: `works` true is success, false is a refusal, "missing" is a program
 *  that is not there. A conversion behind `unshare -rn --` runs the program after the dashes, as the real one would. */
function withUnshare(env, works) {
  const started = [];
  const exec = (command, options, context) => {
    started.push([...command]);
    if (command[0] !== "unshare") return env.exec(command, options, context);
    if (works === "missing") return Promise.resolve({ ok: false, error: Object.assign(new Error("spawn unshare ENOENT"), { code: "spawn_error" }) });
    if (!works) return Promise.resolve({ ok: true, value: { exitCode: 1 } });
    const dashes = command.indexOf("--");
    return dashes < 0 ? Promise.resolve({ ok: true, value: { exitCode: 0 } }) : env.exec(command.slice(dashes + 1), options, context);
  };
  return { env: Object.setPrototypeOf({ exec }, env), started };
}

async function rig(t, options = {}, works = false) {
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
  const { env, started } = withUnshare(w.env, works);
  return { ...w, env, started, bin, work, mode, log, provider, call: () => ({ env, signal: undefined, tempDir: work }) };
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
  const work = new RegExp(`${join(r.work, `soffice-${stem}-[0-9a-f]{8}`)}`).source;
  assert.match(run, new RegExp(`^--headless --invisible --norestore --nolockcheck --nodefault --nologo -env:UserInstallation=file://(${work})/profile --convert-to pdf --outdir \\1/out \\1/in/${stem}\\.docx$`));
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
  assert.match(url, new RegExp(`^file://${odd.split("/").map(encodeURIComponent).join("/")}/soffice-${source.sha256.slice(0, 16)}-[0-9a-f]{8}/profile$`));
  assert.ok(url.includes("odd%20dir%20%231%20%3F/"), url);
});

test("the timeouts it hands to exec are seconds, as the environment reads them", async (t) => {
  const r = await rig(t, { timeoutS: 7 });
  const seen = [];
  const env = { ...r.env, id: r.env.id, exec: (command, options, context) => { seen.push(options?.timeout); return r.env.exec(command, options, context); } };
  Object.setPrototypeOf(env, r.env);
  const source = await r.source("seconds.docx", docx(para("x")));
  await r.provider.office(source, {}, { ...r.call(), env });
  assert.deepEqual(seen, [30, 10, 7], "the version probe waits 30 s, the isolation probe 10 s and the conversion the 7 s it was given, never 30,000 or 7,000");
  const [defaulted] = [sofficeProvider({ command: join(r.bin, "soffice") })];
  const again = [];
  await defaulted.office(await r.source("default.docx", docx(para("y"))), {}, { ...r.call(), env: Object.setPrototypeOf({ exec: (c, o, x) => { again.push(o?.timeout); return r.env.exec(c, o, x); } }, r.env) });
  assert.deepEqual(again, [30, 10, 180]);
});

test("where the system allows a network namespace, the conversion runs inside one, and the probe ran once", async (t) => {
  const r = await rig(t, {}, true);
  const program = join(r.bin, "soffice");
  const first = await r.source("one.docx", docx(para("one")));
  const second = await r.source("two.docx", docx(para("two")));
  await r.provider.office(first, {}, r.call());
  await r.provider.office(second, {}, r.call());
  const probes = r.started.filter((command) => command[0] === "unshare" && command.at(-1) === "true");
  assert.deepEqual(probes, [["unshare", "-rn", "true"]], "asked once, whatever the number of conversions");
  const conversions = r.started.filter((command) => command.includes("--convert-to"));
  assert.equal(conversions.length, 2);
  for (const command of conversions) assert.deepEqual(command.slice(0, 4), ["unshare", "-rn", "--", program], "the program is started inside the namespace");
  assert.equal(readFileSync(join(r.work, `soffice-${first.sha256}.pdf`), "utf8").startsWith("%PDF-1.4"), true);
});

test("where the system refuses a network namespace, or has no unshare, the conversion still runs as it did", async (t) => {
  for (const works of [false, "missing"]) {
    const r = await rig(t, {}, works);
    const program = join(r.bin, "soffice");
    const source = await r.source("untrusted.docx", docx(para("x")));
    const out = await r.provider.office(source, {}, r.call());
    assert.equal(readFileSync(out.path, "utf8").startsWith("%PDF-1.4"), true, `${works}: the PDF was made`);
    const conversion = r.started.find((command) => command.includes("--convert-to"));
    assert.equal(conversion[0], program, `${works}: the program is started as it was, with nothing before it`);
    assert.deepEqual(out.madeBy, { provider: "soffice", version: "LibreOffice 24.8.1.2 stand-in build" }, "what the result names does not change");
    assert.deepEqual((await r.provider.detect(r.env)).available, true, "the provider is available without isolation");
  }
});

test("a probe that throws is a refusal, and the conversion still runs", async (t) => {
  const r = await rig(t, {}, true);
  const throwing = Object.setPrototypeOf({ exec: (command, options, context) => (command[0] === "unshare" ? Promise.reject(new Error("exec blew up")) : r.env.exec(command, options, context)) }, r.env);
  const out = await r.provider.office(await r.source("a.docx", docx(para("x"))), {}, { ...r.call(), env: throwing });
  assert.equal(readFileSync(out.path, "utf8").startsWith("%PDF-1.4"), true);
  assert.deepEqual((await r.provider.detect(throwing)).available, true);
});

test("the profile is seeded before the program starts, with the settings that turn macros, active content, remote content and link updates off", async (t) => {
  const r = await rig(t);
  await r.provider.office(await r.source("untrusted.docx", docx(para("x"))), {}, r.call());
  const seen = readFileSync(join(r.bin, "seen-xcu"), "utf8");
  const settings = [...seen.matchAll(/<item oor:path="\/org\.openoffice\.Office\.([^"]+)"><prop oor:name="([^"]+)" oor:op="fuse"><value>([^<]*)<\/value>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(settings, [
    ["Common/Security/Scripting", "MacroSecurityLevel", "3"],
    ["Common/Security/Scripting", "DisableMacrosExecution", "true"],
    ["Common/Security/Scripting", "DisablePythonRuntime", "true"],
    ["Common/Security/Scripting", "DisableActiveContent", "true"],
    ["Common/Security/Scripting", "BlockUntrustedRefererLinks", "true"],
    ["Calc/Content/Update", "Link", "1"],
    ["Writer/Content/Update", "Link", "2"],
  ], "Calc counts its choices as always, never, on request; Writer as always, on request, never");
  for (const [path, name, value] of settings) assert.match(seen, new RegExp(`<!-- ${path}/${name} = ${value}: [^>]+ -->`), `${name} is named in a comment line of the file`);
  assert.ok(new DOMParser().parseFromString(seen, "text/xml").documentElement.localName === "items", "the file is XML");
});

test("a relative directory that starts with a dash reaches the program as an absolute path, never as an option", async (t) => {
  const r = await rig(t);
  mkdirSync(join(r.dir.path, "-scratch"));
  const source = await r.source("letter.docx", docx(para("x")));
  const out = await r.provider.office(source, {}, { ...r.call(), tempDir: "-scratch" });
  assert.deepEqual(readdirSync(join(r.dir.path, "-scratch")), [`soffice-${source.sha256}.pdf`]);
  assert.equal(out.path, `-scratch/soffice-${source.sha256}.pdf`);
  const run = r.log().find((line) => line.includes("--convert-to"));
  const args = run.split(" ");
  assert.ok(args.at(-1).startsWith(`${r.dir.path}/-scratch/soffice-`), "the input is absolute");
  assert.ok(args.find((a) => a.startsWith("-env:UserInstallation=")).startsWith("-env:UserInstallation=file:///"), "the profile address names a path, not a host");
});

test("two conversions of the same document at once each have a directory and a profile of their own, and the PDF is whole", async (t) => {
  const r = await rig(t);
  const source = await r.source("same.docx", docx(para("one")));
  const [x, y] = await Promise.all([r.provider.office(source, {}, r.call()), r.provider.office(source, {}, r.call())]);
  assert.equal(x.path, y.path);
  assert.match(readFileSync(x.path, "utf8"), /^%PDF-1\.4 stand-in render of /);
  assert.deepEqual(readdirSync(r.work), [`soffice-${source.sha256}.pdf`]);
  const profiles = r.log().filter((line) => line.includes("--convert-to")).map((line) => /UserInstallation=file:\/\/(\S+)/.exec(line)[1]);
  assert.equal(new Set(profiles).size, 2);
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
  await assert.rejects(r.provider.office(source, {}, r.call()), misses("over_budget", /LibreOffice did not finish within 1 s/));
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

test("an archive that lies about a size or a checksum never reaches the program", async (t) => {
  const r = await rig(t);
  const bomb = zipSync({ "word/document.xml": new Uint8Array(40 * MiB) }, { level: 1 });
  const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
  for (let at = 0; at + 28 < bomb.length; at++) if (view.getUint32(at, true) === 0x02014b50) { view.setUint32(at + 24, 1000, true); break; }
  await assert.rejects(r.provider.office(await r.source("lie.docx", bomb), {}, r.call()), misses("unreadable", /^word\/document\.xml inflates past the size its directory declares$/));
  const stored = zipSync({ "word/document.xml": strToU8(`<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Amount 120.50</w:t></w:r></w:p></w:body></w:document>`) }, { level: 0 });
  const at = Buffer.from(stored).indexOf("120.50");
  assert.ok(at > 0);
  stored[at + 4] = 0x39;
  await assert.rejects(r.provider.office(await r.source("changed.docx", stored), {}, r.call()), misses("unreadable", /^word\/document\.xml is not what its directory declares/));
  assert.equal(r.log().filter((line) => line.includes("--convert-to")).length, 0);
  assert.deepEqual(readdirSync(r.work), []);
});

test("a damaged entry is a typed miss before the program, whatever damaged it", async (t) => {
  const r = await rig(t);
  const good = zipSync({ "word/document.xml": strToU8(`<w:document xmlns:w="x"><w:body>${"<w:p><w:r><w:t>some words to compress</w:t></w:r></w:p>".repeat(50)}</w:body></w:document>`) });
  const view = new DataView(good.buffer, good.byteOffset, good.byteLength);
  let central = 0;
  while (view.getUint32(central, true) !== 0x02014b50) central++;
  const damaged = (change) => { const copy = good.slice(); change(new DataView(copy.buffer), copy); return copy; };
  const local = view.getUint32(central + 42, true);
  const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  await assert.rejects(r.provider.office(await r.source("offset.docx", damaged((v) => v.setUint32(central + 42, good.length + 100, true))), {}, r.call()), misses("unreadable", /^word\/document\.xml has a damaged header$/));
  await assert.rejects(r.provider.office(await r.source("stream.docx", damaged((_, b) => { b[data + 4] ^= 0xff; b[data + 5] ^= 0xff; })), {}, r.call()), misses("unreadable", /^word\/document\.xml (cannot be inflated|is not what its directory declares)/));
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
