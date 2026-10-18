// Three cases for the read and the guard, each red before its fix:
// 1. A source replaced while one read is in flight (no crash): the read hashes the file, then a reader or a program
//    opens the path again, and what is kept is named by the first hash.
// 2. A lead that takes no images: its own image limits do not matter, the eyes' do.
// 3. A video, for a lead that takes no video and eyes that do, is planned with the eyes' video limits whatever images
//    the lead takes; the lead's other reads keep its own limits; a clip that cannot be made leaves a lead that takes
//    images its own frames, and a lead that takes no images the miss.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_LIMITS, PACKAGE_KINDS, guardResult, readMedia, resolveLimits } from "@parcha/pi-vision";
import { pdfiumProvider } from "@parcha/pi-vision/providers/pdfium";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { unpdfProvider } from "@parcha/pi-vision/providers/unpdf";
import { fakeEyes, fixtureDir, pdfBytes, pngBytes } from "@parcha/pi-vision/testing";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const images = sharpImages(sharp);
const providers = [popplerProvider(), unpdfProvider(), pdfiumProvider()];
const A = pdfBytes([{ lines: ["Invented notice for a test", "Reference number 4471"] }]);
const B = pdfBytes([{ lines: ["A second invented notice", "Reference number 9026"] }]);
/** Whose text a string holds: A's, B's, both or neither. */
const whose = (s) => [/4471/.test(s) ? "A" : "", /9026/.test(s) ? "B" : ""].join("") || "neither";

test("a source replaced while it is read: the result is of one set of bytes, nothing is kept under a hash it did not come from, and the first bytes still read as themselves", async (t) => {
  const dir = await fixtureDir("pi-vision-swap-");
  t.after(() => dir.remove());
  const file = await dir.file("notice.pdf", A);
  const deriveDir = `${dir.path}/evidence/n/media`;
  const setup = { limits: DEFAULT_LIMITS, eyes: undefined, images, providers, sources: {}, scope: { label: "n", deriveDir }, evidence: { file: async () => null } };
  const call = { conversationId: "c1", callId: "t1", model: { id: "lead", input: ["text", "image"] }, signal: undefined };
  /** pi's Node environment with another writer in it: the file is replaced when the read asks for its first scratch
   *  directory, which today is after it has hashed the file and before a reader opens it. */
  class Racing extends NodeExecutionEnv {
    swapped = false;
    async createTempDir(prefix, context) {
      if (!this.swapped) { this.swapped = true; fs.writeFileSync(file, B); }
      return super.createTempDir(prefix, context);
    }
  }
  const racing = new Racing({ cwd: dir.path });
  const first = await readMedia(racing, { path: "notice.pdf" }, call, setup);
  assert.equal(racing.swapped, true, "the file was replaced during the read");
  assert.ok(first && !first.isError);
  const says = first.details.media.sha256 === sha(A) ? "A" : first.details.media.sha256 === sha(B) ? "B" : "neither";
  assert.equal(whose(text(first)), says, "the hash the result reports is of the bytes whose text it shows");
  const kept = fs.existsSync(deriveDir) ? fs.readdirSync(deriveDir) : [];
  for (const name of kept) {
    const holds = whose(fs.readFileSync(path.join(deriveDir, name), "utf8"));
    const under = name.includes(sha(A).slice(0, 16)) ? "A" : name.includes(sha(B).slice(0, 16)) ? "B" : "neither";
    assert.equal(holds, under, `${name}: a kept derivation holds the text of the bytes its name is the hash of`);
  }
  // The first bytes again (a restore, or another file with the same bytes read under the same derive directory).
  fs.writeFileSync(file, A);
  const again = await readMedia(new NodeExecutionEnv({ cwd: dir.path }), { path: "notice.pdf" }, call, setup);
  assert.deepEqual([again.details.media.sha256, whose(text(again))], [sha(A), "A"], "A's bytes read as A's text, whatever an earlier read kept");
});

test("a lead that takes no images: a page over the lead's own image limits still goes to the eyes, inside the eyes' limits", async (t) => {
  const dir = await fixtureDir("pi-vision-blind-");
  t.after(() => dir.remove());
  await dir.file("notice.pdf", A);
  const env = new NodeExecutionEnv({ cwd: dir.path });
  // The lead's catalog entry declares image limits under the floor a page is never shrunk below; its route takes no images.
  const model = { id: "lead", input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 1000, maxHeight: 1000, maxBytes: 1_000_000 } } } };
  const call = { conversationId: "c1", callId: "t1", model, signal: undefined };
  const base = { images, providers, sources: {}, scope: { label: "n", deriveDir: `${dir.path}/evidence/n/media` }, evidence: { file: async () => null }, limits: resolveLimits(model, { image: { native: false } }) };

  // Through read and the guard, with the same setup: the page is rendered, and the eyes (2000x2000) look at it.
  const eyes = fakeEyes({ answers: ["the reference number is 4471"] });
  const read = await readMedia(env, { path: "notice.pdf", ask: "what is the reference number?" }, call, { ...base, eyes });
  const out = await guardResult(read, call, { ...base, eyes });
  assert.equal(eyes.ledger.length, 1, "the eyes are asked once");
  assert.match(text(out), /the reference number is 4471/);
  assert.doesNotMatch(text(out), /withheld/);
  assert.equal(out.content.filter((b) => b.type === "image").length, 0, "no image reaches the lead");

  // The guard alone, on another tool's image within the eyes' limits and over the lead's.
  const other = fakeEyes({ answers: ["a blank page"] });
  const shot = { content: [{ type: "image", data: Buffer.from(pngBytes(1275, 1650)).toString("base64"), mimeType: "image/png" }] };
  const guarded = await guardResult(shot, call, { ...base, eyes: other });
  assert.equal(other.ledger.length, 1, "the eyes are asked");
  assert.deepEqual([other.ledger[0].parts.find((p) => p.type === "image").width, other.ledger[0].parts.find((p) => p.type === "image").height], [1275, 1650], "as it is: it fits the eyes' limits");
  assert.match(text(guarded), /a blank page/);
});

/** An ISO base media file whose brand makes it a video: enough for the read to take it as one. */
const mp4Head = () => {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2")]);
  return Buffer.concat([ftyp, Buffer.from([0, 0, 0, 16]), Buffer.from("free"), Buffer.alloc(8)]);
};

test("a video read by a lead that takes no video is planned with the eyes' video limits when the eyes take video, whatever images the lead takes; frames are for eyes that take none", async (t) => {
  const dir = await fixtureDir("pi-vision-video-limits-");
  t.after(() => dir.remove());
  await dir.file("clip.mp4", mp4Head());
  await dir.file("shot.png", pngBytes(64, 48));
  const env = new NodeExecutionEnv({ cwd: dir.path });
  const seen = [];
  const recorder = (kind) => async (_request, context) => { seen.push({ kind, limits: context.limits }); return { content: [{ type: "text", text: `${kind} read` }] }; };
  const kinds = { ...PACKAGE_KINDS, readers: { ...PACKAGE_KINDS.readers, video: recorder("video"), image: recorder("image") } };
  // Eyes whose request budget differs from every lead's, so the limits a reader is handed say whose they are.
  const videoEyes = fakeEyes({ accepts: { video: true }, limits: resolveLimits(undefined, { requestBytes: 50 * 1024 * 1024, video: { native: true } }) });
  const stillEyes = fakeEyes({ limits: resolveLimits(undefined, { requestBytes: 50 * 1024 * 1024 }) });
  const lead = (input, video = false) => { const model = { id: "lead", input }; return { model, limits: resolveLimits(model, { video: { native: video } }) }; };
  const read = async (path, { model, limits }, eyes) => {
    seen.length = 0;
    const setup = { limits, eyes, sources: {}, scope: { label: "n", deriveDir: `${dir.path}/evidence/n/media` }, evidence: { file: async () => null } };
    await readMedia(env, { path }, { conversationId: "c1", callId: "t1", model, signal: undefined }, setup, kinds);
    assert.equal(seen.length, 1, `${path} reached its reader`);
    return seen[0].limits;
  };

  const images = lead(["text", "image"]);
  const clipped = await read("clip.mp4", images, videoEyes);
  assert.deepEqual(clipped, { ...images.limits, video: { ...videoEyes.limits.video, native: true }, requestBytes: videoEyes.limits.requestBytes },
    "an image-taking lead's video is planned as the eyes take video: one clip within their budget");
  assert.deepEqual(await read("shot.png", images, videoEyes), images.limits, "the same lead's image keeps the lead's own limits");
  assert.deepEqual(await read("clip.mp4", images, stillEyes), images.limits, "with eyes that take no video, the lead's frames");
  assert.deepEqual(await read("clip.mp4", images, undefined), images.limits, "with no eyes, the lead's frames");

  const blind = lead(["text"]);
  const forEyes = { ...blind.limits, image: { ...videoEyes.limits.image, native: false }, video: { ...videoEyes.limits.video, native: true }, requestBytes: videoEyes.limits.requestBytes };
  assert.deepEqual(await read("clip.mp4", blind, videoEyes), forEyes, "a lead that takes no images: as before, the eyes' limits");
  assert.deepEqual(await read("shot.png", blind, videoEyes), forEyes, "and its image is fitted for the eyes, as before");

  const watching = lead(["text", "image"], true);
  assert.deepEqual(await read("clip.mp4", watching, videoEyes), watching.limits, "a lead that takes video is given the video itself");
});

test("a clip the eyes cannot be handed leaves a lead that takes images its own frames, and a lead that takes no images the miss", async (t) => {
  const dir = await fixtureDir("pi-vision-video-fallback-");
  t.after(() => dir.remove());
  await dir.file("clip.mp4", mp4Head());
  const env = new NodeExecutionEnv({ cwd: dir.path });
  const calls = [];
  // A reader that cannot fit the clip in the eyes' budget, and shows frames when planned for a lead's own images.
  const video = async (_request, context) => {
    calls.push(context.limits.video.native ? "clip" : "frames");
    return context.limits.video.native ? { miss: "over_budget", reason: "the window does not fit the bytes a request carries inline" } : { content: [{ type: "text", text: "8 frames" }] };
  };
  const kinds = { ...PACKAGE_KINDS, readers: { ...PACKAGE_KINDS.readers, video } };
  const eyes = fakeEyes({ accepts: { video: true } });
  const read = async (input) => {
    calls.length = 0;
    const model = { id: "lead", input };
    const setup = { limits: resolveLimits(model), eyes, sources: {}, scope: { label: "n", deriveDir: `${dir.path}/evidence/n/media` }, evidence: { file: async () => null } };
    return readMedia(env, { path: "clip.mp4" }, { conversationId: "c1", callId: "t1", model, signal: undefined }, setup, kinds);
  };
  const images = await read(["text", "image"]);
  assert.deepEqual(calls, ["clip", "frames"], "the clip is tried, then the lead's own frames");
  assert.match(text(images), /8 frames/);
  assert.equal(images.details.miss, undefined);
  const blind = await read(["text"]);
  assert.deepEqual(calls, ["clip"], "a lead that takes no images is not given frames of its own");
  assert.equal(blind.details.miss.code, "over_budget");
});
