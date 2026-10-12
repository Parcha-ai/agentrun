// Two cases for the read and the guard, each red before its fix:
// 1. A source replaced while one read is in flight (no crash): the read hashes the file, then a reader or a program
//    opens the path again, and what is kept is named by the first hash.
// 2. A lead that takes no images: its own image limits do not matter, the eyes' do.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_LIMITS, guardResult, readMedia, resolveLimits } from "@parcha/pi-vision";
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
