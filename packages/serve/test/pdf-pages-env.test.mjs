// pdf_pages starts helper programs (pdfinfo, pdftoppm, pdftotext, ffmpeg) on a document that may be hostile. They get
// a minimal environment: PATH to be found, the locale and the temp directory, nothing else. No server secret (a model key,
// a tool key, the server's token) is in a helper's environment, where any process of the same user could read it from
// /proc/<pid>/environ. Stand-ins named like the helpers, first on PATH, write their environment to a file named in their
// own text (never through the environment they are checking), so each call's environment is read back whole.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pdfPages } from "../dist/pdf-pages.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { scratch } from "./support.mjs";

/** A stand-in for `tool` in `bin`: dumps its environment to `dumps/<tool>.<n>.env`, then does what pdf_pages needs of it. */
async function standIn(bin, dumps, tool, body) {
  const script = `#!/bin/sh\nn=0; while [ -e "${dumps}/${tool}.$n.env" ]; do n=$((n+1)); done\n/usr/bin/env > "${dumps}/${tool}.$n.env"\n${body}\n`;
  await writeFile(join(bin, tool), script);
  await chmod(join(bin, tool), 0o755);
}

/** A PNG's first bytes, its IHDR saying `width` x `height`: what imageDimensions reads, so a large one goes to ffmpeg. */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("pdf_pages' helper programs start with PATH, the locale and the temp directory, and no server secret", async (t) => {
  const bin = await scratch(t);
  const dumps = await scratch(t);
  const work = await scratch(t);
  await standIn(bin, dumps, "pdfinfo", 'echo "Pages: 1"; echo "Page    1 size: 612 x 792 pts"');
  await standIn(bin, dumps, "pdftoppm", 'for last; do :; done; : > "$last-1.png"');
  await standIn(bin, dumps, "pdftotext", "echo 'page text'");
  await standIn(bin, dumps, "ffmpeg", 'for last; do :; done; : > "$last"');
  await writeFile(join(work, "doc.pdf"), "%PDF-1.4 stand-in\n");
  await writeFile(join(work, "big.png"), pngHeader(3000, 2000));

  // Planted secrets, made at run time: a model key's name, a tool key's, the server token's, and one of no known name.
  const planted = { OPENAI_API_KEY: `sk-${randomBytes(18).toString("hex")}`, PARALLEL_API_KEY: randomBytes(16).toString("hex"), AGENTRUN_TOKEN: randomBytes(16).toString("hex"), AGENTRUN_TEST_PLANTED_SECRET: randomBytes(16).toString("hex") };
  const saved = Object.fromEntries(["PATH", ...Object.keys(planted)].map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  Object.assign(process.env, planted);
  process.env.PATH = `${bin}:${process.env.PATH}`;

  const pdf = await pdfPages({ path: "doc.pdf", maxPages: 1 }, { work: localWorkspace(work) });
  assert.equal(pdf.text.trim(), "page text", "the stand-ins answered the PDF path");
  const image = await pdfPages({ path: "big.png" }, { work: localWorkspace(work) });
  assert.equal(image.pages.length, 1, "the stand-in ffmpeg scaled the image");

  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dumps)).sort();
  assert.deepEqual(files.map((f) => f.replace(/\.\d+\.env$/, "")).sort(), ["ffmpeg", "pdfinfo", "pdfinfo", "pdftoppm", "pdftotext"], `each helper call was seen: ${files}`);
  for (const file of files) {
    const env = await readFile(join(dumps, file), "utf8");
    for (const [name, value] of Object.entries(planted)) {
      assert.equal(env.includes(value), false, `${file}: the planted ${name} is not in the helper's environment`);
      assert.equal(new RegExp(`^${name}=`, "m").test(env), false, `${file}: no ${name} at all in the helper's environment`);
    }
    assert.match(env, new RegExp(`^PATH=${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), `${file}: PATH reaches the helper`);
    const names = env.split("\n").filter(Boolean).map((line) => line.split("=")[0]);
    assert.deepEqual(names.filter((name) => !["PATH", "LANG", "LC_ALL", "TMPDIR", "PWD", "SHLVL", "_"].includes(name)), [], `${file}: only PATH, the locale and TMPDIR (and what the shell adds): ${names}`);
  }
});
