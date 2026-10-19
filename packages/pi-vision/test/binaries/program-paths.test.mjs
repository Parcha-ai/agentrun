// A source named like an option or an address, read by the real programs: poppler takes a file named `-h` for the option
// and ffmpeg takes `a:b.mp4` for an address in a protocol of its own, unless the path is handed over as a path. These run in the
// `vision-binaries` job, where a missing program fails them, and skip elsewhere with their reason.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ffmpegProvider } from "@parcha/pi-vision/providers/ffmpeg";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { fixtureDir } from "@parcha/pi-vision/testing";
import { textPdf } from "../support/pdf-builders.mjs";

const dir = await fixtureDir("pi-vision-paths-");
after(() => dir.remove());
const env = new NodeExecutionEnv({ cwd: dir.path });
const call = { env, signal: undefined, tempDir: dir.path };
const sourceOf = async (name, bytes, kind) => {
  await dir.file(name, bytes);
  return { path: name, kind, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
/** True when the programs are not here: the test is skipped with the reason, or fails when the binaries job requires them. */
const without = (t, programs, found) => {
  if (found) return false;
  const why = `${programs} are not installed here`;
  if (process.env.PI_VISION_REQUIRE_BINARIES === "1") throw new Error(why);
  t.skip(why);
  return true;
};

test("a PDF named -h, an option of every poppler program, is read by poppler: its text, its facts and a page", async (t) => {
  const poppler = popplerProvider();
  if (without(t, "pdftotext, pdftoppm and pdfinfo", (await poppler.detect(env)).available)) return;
  const source = await sourceOf("-h", textPdf(["Invoice 4471"]), "pdf");
  const document = await poppler.document(source, call);
  assert.deepEqual([document.pages.length, document.pages[0].includes("Invoice 4471"), document.info.pages], [1, true, 1]);
  const page = await poppler.render(source, { page: 1, dpi: 72 }, call);
  assert.deepEqual([page.image.width, page.image.height], [612, 792]);
});

test("a video named with a colon or a leading dash is probed and cut by ffprobe and ffmpeg", async (t) => {
  const ffmpeg = ffmpegProvider();
  const have = ["ffmpeg", "ffprobe"].every((program) => spawnSync(program, ["-version"]).status === 0);
  if (without(t, "ffmpeg and ffprobe", have)) return;
  for (const name of ["a:b.mp4", "-x.mp4"]) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=5", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", `${dir.path}/${name}`]);
    const source = await sourceOf(name, readFileSync(`${dir.path}/${name}`), "video");
    const { facts } = await ffmpeg.probe(source, call);
    assert.deepEqual([facts.width, facts.height], [64, 48], name);
    const { frames } = await ffmpeg.frames(source, { atS: [1], maxEdge: 64 }, call);
    assert.equal(frames.length, 1, `${name}: a frame by seek`);
  }
});
