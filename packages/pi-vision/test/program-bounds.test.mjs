// What the programs this package starts are given and what is read back from them, with stand-ins for the programs:
// a program that writes more than the package reads back is refused before it is read (its output, its error stream
// and the image it draws), and a source path reaches every program as a path, never as an option or an address.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { PROGRAM_OUTPUT_BYTES, PdfProviderError } from "@parcha/pi-vision";
import { ffmpegProvider } from "@parcha/pi-vision/providers/ffmpeg";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { fixtureDir, pngBytes } from "@parcha/pi-vision/testing";

const dir = await fixtureDir("pi-vision-bounds-");
test.after(() => dir.remove());
const bin = join(dir.path, "bin");
mkdirSync(bin);
const work = join(dir.path, "work");
mkdirSync(work);
const path = process.env.PATH;
process.env.PATH = `${bin}:${path}`;
test.after(() => { process.env.PATH = path; });

/** Every stand-in records its arguments, answers `-v` and `-version`, and does what its `mode-<name>` file says. A program
 *  that writes `huge` writes one byte more than the package reads back. */
const OVER = PROGRAM_OUTPUT_BYTES + 1;
const STAND_IN = `#!/bin/sh
here=$(dirname "$0")
prog=$(basename "$0")
[ "$#" = 1 ] && case "$1" in -v|-version) echo "$prog version 24.02.0" >&2; exit 0;; esac
printf '%s' "$prog" >> "$here/calls.log"; for a in "$@"; do printf '\\t%s' "$a" >> "$here/calls.log"; done; echo >> "$here/calls.log"
mode=$(cat "$here/mode-$prog" 2>/dev/null || echo ok)
for a in "$@"; do last="$a"; done
case "$prog" in
  pdftotext) case "$mode" in huge) head -c ${OVER} /dev/zero | tr '\\0' a;; noisy) head -c ${OVER} /dev/zero | tr '\\0' e >&2; exit 1;; *) printf 'first page\\n\\f';; esac;;
  pdfinfo) case "$mode" in huge) head -c ${OVER} /dev/zero | tr '\\0' a;; *) printf 'Producer: stand-in\\nPage    1 size: 612 x 792 pts (letter)\\nPage    1 rot:  0\\n';; esac;;
  pdftoppm) case "$mode" in huge) head -c ${OVER} /dev/zero > "$last.png";; *) cp "$here/page.png" "$last.png";; esac;;
  ffprobe) for a in "$@"; do [ "$prev" = "-o" ] && report="$a"; prev="$a"; done
    case " $* " in *show_program_version*) echo '{"program_version":{"version":"6.1.1"}}' > "$report";; *) echo '{"streams":[{"width":64,"height":48,"r_frame_rate":"5/1"}],"format":{"duration":"10"}}' > "$report";; esac;;
  ffmpeg) : > "$last";;
esac
`;
for (const name of ["pdftotext", "pdfinfo", "pdftoppm", "ffmpeg", "ffprobe"]) {
  writeFileSync(join(bin, name), STAND_IN);
  chmodSync(join(bin, name), 0o755);
}
writeFileSync(join(bin, "page.png"), pngBytes(8, 8));
const mode = (program, value) => writeFileSync(join(bin, `mode-${program}`), value);
/** Runs `body` with the stand-in doing `value`, and as it was after, whatever `body` does. */
const doing = async (program, value, body) => {
  mode(program, value);
  try { await body(); } finally { mode(program, "ok"); }
};
const calls = () => { try { return readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n").map((line) => line.split("\t")); } catch { return []; } };
const forget = () => { try { writeFileSync(join(bin, "calls.log"), ""); } catch { /* none yet */ } };

const base = new NodeExecutionEnv({ cwd: dir.path });
/** The environment, with the paths of the files it was asked to read. */
const watched = () => {
  const read = [];
  const env = Object.setPrototypeOf({ readBinaryFile: (p, c) => { read.push(p); return base.readBinaryFile(p, c); } }, base);
  return { env, read };
};
const sourceIn = (name, kind) => ({ path: name, kind, bytes: 1, sha256: "0".repeat(64) });
const callIn = (env) => ({ env, signal: undefined, tempDir: work });
const over = (program) => (error) => error instanceof PdfProviderError && error.code === "over_budget" && error.message.startsWith(`${program} wrote 64.0 MiB, over the 64 MiB this package reads back from a program`);

test("what poppler's text program writes past the cap is refused before it is read", () => doing("pdftotext", "huge", async () => {
  const { env, read } = watched();
  await assert.rejects(popplerProvider().document(sourceIn("a.pdf", "pdf"), callIn(env)), over("pdftotext"));
  assert.deepEqual(read.filter((file) => file.endsWith(".out")), [], "its output was never read");
}));

test("what poppler's information program writes past the cap is refused before it is read", () => doing("pdfinfo", "huge", async () => {
  const { env, read } = watched();
  await assert.rejects(popplerProvider().document(sourceIn("a.pdf", "pdf"), callIn(env)), over("pdfinfo"));
  assert.deepEqual(read.filter((file) => file.endsWith(".out")).length, 1, "only the text program's output, which was within the cap, was read");
}));

test("the image poppler draws past the cap is refused before it is read", () => doing("pdftoppm", "huge", async () => {
  const { env, read } = watched();
  await assert.rejects(popplerProvider().render(sourceIn("a.pdf", "pdf"), { page: 1, dpi: 72 }, callIn(env)), over("pdftoppm"));
  assert.deepEqual(read.filter((file) => file.endsWith(".png")), [], "the image was never read");
}));

test("a program that fails with an endless error stream is a failure with its name, and the stream is not read", () => doing("pdftotext", "noisy", async () => {
  const { env, read } = watched();
  await assert.rejects(popplerProvider().document(sourceIn("a.pdf", "pdf"), callIn(env)), /^Error: pdftotext exited 1$/);
  assert.deepEqual(read.filter((file) => file.endsWith(".err")), [], "the stream was measured and left");
}));

test("within the cap everything is read as before: text, facts and a page", async () => {
  const { env } = watched();
  const poppler = popplerProvider();
  const document = await poppler.document(sourceIn("a.pdf", "pdf"), callIn(env));
  assert.deepEqual([document.pages, document.info.pages, document.info.producer], [["first page"], 1, "stand-in"]);
  const page = await poppler.render(sourceIn("a.pdf", "pdf"), { page: 1, dpi: 72 }, callIn(env));
  assert.deepEqual([page.image.width, page.image.height], [8, 8]);
});

test("a source named like an option reaches poppler as a path: every program is given it with ./ first", async () => {
  const { env } = watched();
  const poppler = popplerProvider();
  for (const name of ["-x.pdf", "-h"]) {
    forget();
    await poppler.document(sourceIn(name, "pdf"), callIn(env));
    await poppler.render(sourceIn(name, "pdf"), { page: 1, dpi: 72 }, callIn(env));
    const ran = calls().filter(([program]) => program !== undefined);
    assert.deepEqual(ran.map(([program]) => program), ["pdftotext", "pdfinfo", "pdfinfo", "pdftoppm"], name);
    for (const args of ran) assert.ok(args.includes(`./${name}`) && !args.includes(name), `${args[0]} was given ${args.slice(1).join(" ")}`);
  }
  forget();
  await poppler.document(sourceIn(`${dir.path}/-x.pdf`, "pdf"), callIn(env));
  assert.ok(calls().every((args) => args.includes(`${dir.path}/-x.pdf`)), "an absolute path is left as it is");
});

test("a source named like an option or an address reaches ffprobe and ffmpeg as a path", async () => {
  const ffmpeg = ffmpegProvider();
  const { env } = watched();
  for (const name of ["-x.mp4", "-", "a:b.mp4"]) {
    forget();
    const source = sourceIn(name, "video");
    await ffmpeg.probe(source, callIn(env));
    await ffmpeg.frames(source, { atS: [1], maxEdge: 64 }, callIn(env));
    await ffmpeg.clip(source, { fromS: 0, toS: 1, maxBytes: 1_000_000 }, callIn(env));
    const ran = calls().filter(([program, ...args]) => (program === "ffprobe" || program === "ffmpeg") && args.includes("-i"));
    assert.deepEqual(ran.map(([program]) => program), ["ffprobe", "ffmpeg", "ffmpeg"], name);
    for (const args of ran) assert.equal(args[args.indexOf("-i") + 1], `./${name}`, `${args[0]} was given ${name} as ${args[args.indexOf("-i") + 1]}`);
  }
});
