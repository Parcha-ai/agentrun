// The providers and the image processor the adapter hands the core, with the real core behind it: the host's
// converters first and the package's own after them, so a host that names none still reads a PDF; and Photon when the
// host gives no processor.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createVisionExtension, packageProviders } from "@parcha/pi-vision/durable";
import { pdfBytes } from "@parcha/pi-vision/testing";
import { drive, textOf, tmp } from "./durable/rig.mjs";

const evidence = { file: async () => null };
const scope = (id) => ({ label: `conv-${id}`, deriveDir: `.vision/${id}` });
const LINES = ["Invented notice for a test", "Reference number 4471", "Nothing here is real"];

test("the package's own providers: binaries before the zero-install readers, one of each, a fresh list each call", () => {
  const names = packageProviders().map((provider) => provider.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.indexOf("poppler") < names.indexOf("unpdf"), "poppler is tried before pdf.js");
  assert.ok(names.indexOf("poppler") < names.indexOf("pdfium"), "poppler is tried before PDFium");
  assert.ok(names.includes("office-js") && names.includes("soffice") && names.includes("ffmpeg"));
  assert.notEqual(packageProviders(), packageProviders());
});

test("a host that names no providers gets a PDF's text from handle.pdfText and from the wrapped read", async () => {
  const vision = createVisionExtension({ evidence, scope });
  const text = await vision.pdfText(pdfBytes([{ lines: LINES }]));
  for (const line of LINES) assert.match(text, new RegExp(line));
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, "notice.pdf"), pdfBytes([{ lines: LINES }]));
  const run = await drive({ extensions: [vision.extension], rounds: [[["read", { path: "notice.pdf" }]]], cwd });
  assert.equal(run.results[0].isError, false);
  for (const line of LINES) assert.match(textOf(run.results[0]), new RegExp(line));
});

test("a host's provider is tried before the package's own", async () => {
  const asked = [];
  const hosted = {
    name: "hosted-reader", capabilities: ["text"], kinds: ["pdf"],
    detect: async () => ({ available: true, version: "1" }),
    text: async (source) => { asked.push(source.kind); return { madeBy: { provider: "hosted-reader", version: "1" }, pages: [{ page: 1, text: "read by the host's reader" }] }; },
  };
  const vision = createVisionExtension({ evidence, scope, providers: [hosted] });
  const text = await vision.pdfText(pdfBytes([{ lines: LINES }]));
  assert.match(text, /read by the host's reader/);
  assert.doesNotMatch(text, /Invented notice/, "the package's readers were not reached");
  assert.deepEqual(asked, ["pdf"]);
});

test("importing ./durable and making an extension loads no provider's dependency: each loads when a provider first runs", () => {
  const script = `
    import { registerHooks } from "node:module";
    const seen = new Set();
    registerHooks({ resolve(specifier, context, next) { if (!/^(node:|\\.|\\/|file:)/.test(specifier)) seen.add(specifier); return next(specifier, context); } });
    const { createVisionExtension, packageProviders } = await import("@parcha/pi-vision/durable");
    createVisionExtension({ evidence: { file: async () => null }, scope: () => ({ label: "l", deriveDir: "d" }) });
    packageProviders();
    console.log(JSON.stringify([...seen]));`;
  const seen = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" }));
  assert.deepEqual(seen, ["@parcha/pi-vision/durable"]);
});
