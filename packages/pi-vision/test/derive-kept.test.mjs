// What `read` takes back from the derive directory. That directory is shared with whatever runs in the environment,
// the agent's own commands included, so a kept derivation is used again only when it holds the bytes this process
// kept there: a document's text or a page's image written or changed there by anything else is made again from the
// source, and one an earlier process left is made again once.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_LIMITS, guardResult, readMedia } from "@parcha/pi-vision";
import { pdfiumProvider } from "@parcha/pi-vision/providers/pdfium";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { unpdfProvider } from "@parcha/pi-vision/providers/unpdf";
import { fakeEyes, fixtureDir, imageSize, pdfBytes, pngBytes } from "@parcha/pi-vision/testing";

const LINES = ["Invented notice for a test", "Reference number 4471"];
const text = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const shown = (result) => result.content.filter((b) => b.type === "image").map((b) => imageSize(Buffer.from(b.data, "base64")));

/** The zero-install PDF readers, each counting the times it is asked to make a derivation into `made`. */
function counted(made) {
  const unpdf = unpdfProvider();
  const pdfium = pdfiumProvider();
  return [
    { ...unpdf, document: async (...args) => { made.push("text"); return unpdf.document(...args); } },
    { ...pdfium, render: async (...args) => { made.push("render"); return pdfium.render(...args); } },
  ];
}

/** A read of a PDF through the package's own readers, with the derive directory under the environment's directory. */
async function rig(t) {
  const dir = await fixtureDir("pi-vision-kept-");
  t.after(() => dir.remove());
  await dir.file("notice.pdf", pdfBytes([{ lines: LINES }]));
  const made = [];
  const filed = [];
  const env = new NodeExecutionEnv({ cwd: dir.path });
  const deriveDir = `${dir.path}/.derived/c1`;
  const setup = {
    limits: DEFAULT_LIMITS, eyes: undefined, images: sharpImages(sharp), providers: counted(made), sources: {},
    scope: { label: "n", deriveDir }, evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}.md` }; } },
  };
  const call = { conversationId: "c1", callId: "t1", model: { id: "lead", input: ["text", "image"] }, signal: undefined };
  const keptFile = (suffix) => {
    const found = fs.readdirSync(deriveDir).filter((name) => name.endsWith(suffix));
    assert.equal(found.length, 1, `one kept ${suffix}`);
    return path.join(deriveDir, found[0]);
  };
  return { dir, env, setup, call, made, filed, keptFile, read: (args, over = {}) => readMedia(env, args, call, { ...setup, ...over }) };
}

test("a kept document text that something else wrote over is not read as the document: it is made again from the source", async (t) => {
  const r = await rig(t);
  const first = await r.read({ path: "notice.pdf" });
  assert.match(text(first), /Reference number 4471/);
  assert.deepEqual(r.made, ["text"]);
  // A write into the shared directory, as a command in the environment can make: the same name, other pages.
  const file = r.keptFile(".pdf.json");
  const planted = JSON.parse(fs.readFileSync(file, "utf8"));
  planted.pages = ["Invented notice for a test\nReference number 9026"];
  fs.writeFileSync(file, JSON.stringify(planted));

  const again = await r.read({ path: "notice.pdf" });
  assert.match(text(again), /Reference number 4471/, "the text is the source's");
  assert.doesNotMatch(text(again), /9026/, "the written text is never shown");
  assert.deepEqual(r.made, ["text", "text"], "the document was read again from the source");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /9026/, "and kept again in place of what was written there");
});

test("a page image put in place of a kept render is not shown: the page is rendered again", async (t) => {
  const r = await rig(t);
  const first = await r.read({ path: "notice.pdf", ask: "what is the reference number?" });
  const [real] = shown(first);
  assert.ok(real, "the page is shown rendered");
  assert.deepEqual(r.made.filter((m) => m === "render"), ["render"]);
  // A whole PNG under the kept render's name, of another size so it is told apart wherever it shows.
  fs.writeFileSync(r.keptFile(".png"), pngBytes(1200, 1600, [200, 0, 0]));

  const again = await r.read({ path: "notice.pdf", ask: "what is the reference number?" });
  assert.deepEqual(shown(again), [real], "the image shown is the page's own render");
  assert.deepEqual(r.made.filter((m) => m === "render"), ["render", "render"], "the page was rendered again");
  assert.deepEqual(imageSize(fs.readFileSync(r.keptFile(".png"))), real, "and kept again in place of what was written there");
});

test("what this process kept is used again as it is, and a look at it is filed the same", async (t) => {
  const r = await rig(t);
  // A lead that takes no images, so the guard has the eyes look at the page and files the look.
  const setup = { ...r.setup, limits: { ...DEFAULT_LIMITS, image: { ...DEFAULT_LIMITS.image, native: false } }, eyes: fakeEyes({ answers: ["the reference number is 4471"] }) };
  const looks = [];
  for (let n = 0; n < 2; n++) {
    const read = await readMedia(r.env, { path: "notice.pdf", ask: "what is the reference number?" }, r.call, setup);
    looks.push(await guardResult(read, r.call, setup));
  }
  assert.deepEqual(r.made, ["text", "render"], "the document and the page were made once, and kept");
  assert.equal(r.filed.length, 2);
  const record = ({ facts: { startedAt, ...facts }, ...rest }) => ({ ...rest, facts });
  assert.deepEqual(record(r.filed[1]), record(r.filed[0]), "the second look is filed as the first was, but for when it started");
  const told = (look) => look.content.map((block) => (block.type === "text" ? { ...block, text: block.text.replace(/evidence\/n\/\d+\.md/g, "<receipt>") } : block));
  assert.deepEqual(told(looks[1]), told(looks[0]), "and the lead is told the same, but for the receipt's own path");
});

test("what an earlier process kept is made again once, then used again", async (t) => {
  const r = await rig(t);
  // Another process reads the same file with the same derive directory, and keeps the document's text.
  const script = `
    import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
    import { DEFAULT_LIMITS, readMedia } from "@parcha/pi-vision";
    import { unpdfProvider } from "@parcha/pi-vision/providers/unpdf";
    const env = new NodeExecutionEnv({ cwd: ${JSON.stringify(r.dir.path)} });
    const setup = { limits: DEFAULT_LIMITS, eyes: undefined, providers: [unpdfProvider()], sources: {}, scope: { label: "n", deriveDir: ${JSON.stringify(r.setup.scope.deriveDir)} }, evidence: { file: async () => null } };
    const read = await readMedia(env, { path: "notice.pdf" }, { conversationId: "c1", callId: "t0", model: undefined, signal: undefined }, setup);
    console.log(JSON.stringify(read.content.map((b) => b.text ?? "").join("\\n")));`;
  const earlier = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env } }));
  assert.match(earlier, /Reference number 4471/);
  const left = fs.readFileSync(r.keptFile(".pdf.json"));

  assert.match(text(await r.read({ path: "notice.pdf" })), /Reference number 4471/);
  assert.deepEqual(r.made, ["text"], "this process made the document again rather than take the file another left");
  assert.deepEqual(JSON.parse(fs.readFileSync(r.keptFile(".pdf.json"), "utf8")).pages, JSON.parse(left).pages, "to the same text");
  assert.match(text(await r.read({ path: "notice.pdf" })), /Reference number 4471/);
  assert.deepEqual(r.made, ["text"], "and then used its own");
});
