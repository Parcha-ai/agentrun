// The media half of `read`, through pi-durable's own Node environment on files each test writes: the kind decides
// the reader, the reader gets the source's hash and the call's limits, a document's text is paged like a file, wrong
// arguments are refused in one line before any reader runs, a strict route's zero values are absent, what cannot be
// done is a miss with a failed receipt and an event, and a recording handle is answered by its source and filed. The
// kind readers are stubs here; each kind's own suite proves its reader.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_LIMITS, DESCRIBE_ASK, SOURCE_BYTES_IN_PROCESS, readMedia, readsAsText, receiptFacts, withoutStrictDefaults } from "@parcha/pi-vision";
import { SENTINEL_LINK_SIGNATURE, SENTINEL_LINK_TOKEN, SENTINEL_SIGNED_LINK, fixtureDir, imageSize, pngBytes } from "@parcha/pi-vision/testing";

const PDF_HEAD = Buffer.from("%PDF-1.4\n");
/** A stub sniffer in kinds.ts's shape, by first bytes, then name: PNG and PDF by signature, mp4 and xlsx by extension,
 *  a NUL byte is binary; a PNG named .pdf is a mismatch. */
const sniff = (head, path) => {
  const png = imageSize(head);
  const pdf = Buffer.from(head.subarray(0, 5)).toString("latin1") === "%PDF-";
  const signature = Buffer.from(head.subarray(0, 4)).toString("hex");
  if (png && path.endsWith(".pdf")) return { ok: false, code: "unsupported", reason: "its bytes are a PNG image and its name says PDF" };
  if (png) return { ok: true, kind: "image", mimeType: png.mimeType, signature };
  if (pdf) return { ok: true, kind: "pdf", mimeType: "application/pdf", signature };
  if (path.endsWith(".mp4")) return { ok: true, kind: "video", mimeType: "video/mp4", signature };
  if (path.endsWith(".xlsx")) return { ok: true, kind: "sheet", mimeType: null, signature };
  return { ok: true, kind: head.includes(0) ? "unknown" : "text", mimeType: null, signature };
};

async function rig(readers = {}, more = {}) {
  const dir = await fixtureDir("pi-vision-read-");
  const env = new NodeExecutionEnv({ cwd: dir.path });
  const calls = [], filed = [], looks = [], misses = [];
  const stub = (kind, answer) => async (request, context) => {
    calls.push({ kind, request, context, tempExists: existsSync(context.tempDir) });
    return typeof answer === "function" ? answer(request, context) : answer;
  };
  const setup = {
    scope: { label: "n", deriveDir: `${dir.path}/evidence/n/media` }, limits: DEFAULT_LIMITS, eyes: undefined, providers: [], sources: {},
    evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}-look.md` }; } },
    onLook: (look) => looks.push(look), onMiss: (miss) => misses.push(miss),
    ...more,
  };
  const kinds = { sniff, sizeOf: imageSize, readers: Object.fromEntries(Object.entries(readers).map(([kind, answer]) => [kind, stub(kind, answer)])) };
  const call = (signal) => ({ conversationId: "c1", callId: "t1", model: undefined, signal });
  const read = (args, signal) => readMedia(env, args, call(signal), setup, kinds);
  return { dir, env, setup, kinds, call, read, calls, filed, looks, misses };
}
const text = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("an image goes to the image reader with its hash, header, question and the call's limits; the result names the media for the guard", async (t) => {
  const block = { type: "image", data: "AAAA", mimeType: "image/png" };
  const r = await rig({ image: { content: [{ type: "text", text: "Image file photo.png." }, block], fit: { reduction: "as_is" } } });
  t.after(() => r.dir.remove());
  const bytes = pngBytes(30, 20);
  await r.dir.file("photo.png", bytes);
  const out = await r.read({ path: "photo.png", ask: "  What colour?  " });
  assert.deepEqual(out.content, [{ type: "text", text: "Image file photo.png." }, block]);
  const [{ request, context, tempExists }] = r.calls;
  const { source, data, ...asked } = request;
  assert.deepEqual(asked, { name: "photo.png", mimeType: "image/png", width: 30, height: 20, ask: "What colour?" });
  assert.deepEqual([source.kind, source.bytes, source.sha256], ["image", bytes.length, sha(bytes)]);
  assert.deepEqual(Buffer.from(data), Buffer.from(bytes), "the reader is handed the bytes that were hashed");
  assert.ok(source.path.startsWith(`${context.tempDir}/`) && source.path.endsWith(".png"), "and a private copy of them, never the model's own path");
  assert.equal(context.limits, DEFAULT_LIMITS);
  assert.equal(context.deriveDir, r.setup.scope.deriveDir);
  assert.ok(tempExists, "the reader has a directory of its own while it runs");
  assert.ok(!existsSync(context.tempDir), "and it is gone when the read ends");
  assert.deepEqual(out.details, { path: "photo.png", media: { kind: "image", path: "photo.png", sha256: sha(bytes), original: "30x20", ask: "What colour?", fit: { reduction: "as_is" } } });
  assert.equal(r.filed.length, 0, "a read files no look itself: the guard files what the lead or the eyes saw");
});

test("a plain text file, a directory and a missing path are the host's read", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  await r.dir.file("notes.txt", "a\nb\n");
  await r.dir.file("sub/x.txt", "x");
  for (const path of ["notes.txt", "sub", "nope.png"]) assert.equal(await r.read({ path }), null, path);
});

test("window and page arguments on the wrong kind are refused in one line before any reader runs", async (t) => {
  const r = await rig({ image: { content: [] }, pdf: { content: [] }, video: { content: [] } });
  t.after(() => r.dir.remove());
  await r.dir.file("a.png", pngBytes(2, 2));
  await r.dir.file("d.pdf", PDF_HEAD);
  await r.dir.file("v.mp4", "not really a video");
  const cases = [
    [{ path: "a.png", from_s: 1, to_s: 0 }, "from_s/to_s apply to video files only; a.png is not a video. Read it without a window."],
    [{ path: "a.png", page: 2 }, "page applies to PDF files and office documents only; a.png is neither. Read it without a page."],
    [{ path: "v.mp4", page: 3 }, "page applies to PDF files and office documents only; v.mp4 is neither. Read it without a page."],
    [{ path: "v.mp4", from_s: "soon" }, "from_s/to_s must be numbers of seconds (got from_s=soon, to_s=undefined)."],
    [{ path: "v.mp4", from_s: 30, to_s: 20 }, "Cannot read v.mp4: to_s (20) must be greater than from_s (30)."],
    [{ path: "d.pdf", page: 0.5 }, "Cannot read d.pdf: page must be an integer of 1 or more (got 0.5)."],
  ];
  for (const [args, refusal] of cases) assert.deepEqual(await r.read(args), { content: [{ type: "text", text: refusal }], isError: true }, JSON.stringify(args));
  assert.equal(r.calls.length, 0);
});

test("a strict route's zero values are the absent argument; a real window or page is kept", async (t) => {
  assert.deepEqual(withoutStrictDefaults({ path: "x", from_s: 0, to_s: 1, page: 1, offset: 1, char_offset: 0, limit: 0, ask: "" }, { windowed: false, paged: false }), { path: "x", ask: "" });
  assert.deepEqual(withoutStrictDefaults({ path: "x", from_s: 0, to_s: 0, page: 0, offset: 0 }, { windowed: true, paged: true }), { path: "x", page: 0 });
  assert.deepEqual(withoutStrictDefaults({ path: "x", from_s: 0, to_s: 1, page: 1 }, { windowed: true, paged: true }), { path: "x", from_s: 0, to_s: 1, page: 1 }, "0..1 on a video and page 1 on a document are real");
  assert.deepEqual(withoutStrictDefaults({ path: "x", from_s: 5, to_s: 0 }, { windowed: true, paged: false }), { path: "x", from_s: 5, to_s: 0 }, "from 5 to 0 stays, and is refused");
  const r = await rig({ image: { content: [{ type: "text", text: "shown" }] } });
  t.after(() => r.dir.remove());
  await r.dir.file("drawer.png", pngBytes(2, 2));
  const out = await r.read({ path: "drawer.png", from_s: 0, to_s: 1, page: 1, offset: 1, char_offset: 0, limit: 0, ask: "" });
  assert.notEqual(out.isError, true, text(out));
  assert.deepEqual(r.calls[0].request.ask, undefined);
});

test("a document's text is paged like a file: by offset and limit, by character in a long line, past the end refused", async (t) => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const long = "x".repeat(60 * 1024);
  const r = await rig({ pdf: (request) => ({ content: [{ type: "text", text: `Text of ${request.name} (2 pages).` }], text: `--- page 1 ---\n${lines.join("\n")}\n--- page 2 ---\n${long}` }) });
  t.after(() => r.dir.remove());
  await r.dir.file("d.pdf", PDF_HEAD);
  assert.equal(text(await r.read({ path: "d.pdf", offset: 2, limit: 3 })), "Text of d.pdf (2 pages).\n\nline 1\nline 2\nline 3\n\n[29 more lines in file. Use offset=5 to continue.]");
  const first = text(await r.read({ path: "d.pdf", offset: 33 }));
  assert.match(first, /\n\n\[Showing line 33 character 0 to line 33 character 51200 of d\.pdf \(33 lines\)\. Use offset=33 char_offset=51200 to continue\.\]$/);
  const rest = text(await r.read({ path: "d.pdf", offset: 33, char_offset: 51200 }));
  assert.equal(rest, `Text of d.pdf (2 pages).\n\n${"x".repeat(long.length - 51200)}`);
  assert.deepEqual(await r.read({ path: "d.pdf", offset: 40 }), { content: [{ type: "text", text: "Cannot read d.pdf: Offset 40 is beyond end of file (33 lines total)" }], isError: true });
});

test("a page of text is 50 KiB of UTF-8, cut where a character starts, and the next window takes up exactly where it stopped", async (t) => {
  const line = "\u6c49".repeat(20_000) + "\u{1F600}".repeat(5_000);
  const r = await rig({ pdf: { content: [{ type: "text", text: "Text of w.pdf." }], text: line } });
  t.after(() => r.dir.remove());
  await r.dir.file("w.pdf", PDF_HEAD);
  let at = 0, seen = "";
  for (let i = 0; i < 10 && at < line.length; i++) {
    const page = text(await r.read({ path: "w.pdf", ...(at ? { char_offset: at } : {}) })).slice("Text of w.pdf.\n\n".length);
    const note = /\n\n\[Showing line 1 character (\d+) to line 1 character (\d+) of w\.pdf \(1 lines\)\. Use offset=1 char_offset=(\d+) to continue\.\]$/.exec(page);
    const body = note ? page.slice(0, note.index) : page;
    assert.ok(Buffer.byteLength(body, "utf8") <= 50 * 1024, `window ${i} is ${Buffer.byteLength(body, "utf8")} bytes`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(body) && !/^[\uDC00-\uDFFF]/.test(body), "no half of a surrogate pair at either end");
    seen += body;
    if (!note) break;
    assert.equal(Number(note[1]), at);
    at = Number(note[3]);
  }
  assert.equal(seen, line, "the windows read back the whole line");
});

test("what a reader cannot do is a miss: text the model acts on, the text that still came back, a failed receipt and an event", async (t) => {
  const r = await rig({ pdf: { miss: "needs", reason: "page 2 has no text layer and no page renderer is installed (PDFium or poppler)", text: "Text layer of page 2: none" } });
  t.after(() => r.dir.remove());
  const bytes = Buffer.concat([PDF_HEAD, Buffer.from("scan")]);
  await r.dir.file("scan.pdf", bytes);
  const out = await r.read({ path: "scan.pdf", page: 2, ask: "What is the date?" });
  assert.equal(out.isError, undefined, "a miss is not an error");
  assert.equal(text(out), "scan.pdf could not be read: page 2 has no text layer and no page renderer is installed (PDFium or poppler). The file is saved at scan.pdf. Receipt filed at evidence/n/1-look.md. What does not need it still reads; to have the rest, install it where the shell runs, or work from the saved file with bash.\nText layer of page 2: none");
  assert.deepEqual(out.details, { path: "scan.pdf", look: "evidence/n/1-look.md", miss: { code: "needs" } });
  assert.deepEqual([r.filed[0].status, r.filed[0].args, receiptFacts(r.filed[0]).sha256], ["failed", { path: "scan.pdf", ask: "What is the date?", page: 2, model: "none", native: false }, sha(bytes)]);
  assert.deepEqual(r.misses, [{ conversationId: "c1", tool: "read", source: "scan.pdf", ask: "What is the date?", code: "needs", reason: "page 2 has no text layer and no page renderer is installed (PDFium or poppler)", receipt: "evidence/n/1-look.md" }]);
});

test("a sink that throws before it returns a promise loses no miss", async (t) => {
  const r = await rig({}, { evidence: { file: () => { throw new Error("no disk"); } } });
  t.after(() => r.dir.remove());
  await r.dir.file("blob.bin", Buffer.from([0, 1, 2]));
  assert.match(text(await r.read({ path: "blob.bin" })), /^blob\.bin could not be read: its bytes are in no format read takes .*\. The file is saved at blob\.bin\. Work from/);
  assert.equal(r.misses[0].receipt, null);
});

test("a reader that throws on a file it cannot parse is an unreadable miss with the cause's first line; a cancelled read throws", async (t) => {
  let cut = null;
  const r = await rig({ pdf: () => { cut?.abort(); throw new Error("bad xref table at offset 9\n    at parse (pdf.js:1)"); } });
  t.after(() => r.dir.remove());
  await r.dir.file("broken.pdf", PDF_HEAD);
  const out = await r.read({ path: "broken.pdf" });
  assert.equal(out.isError, undefined);
  assert.match(text(out), /^broken\.pdf could not be read: bad xref table at offset 9\. The file is saved at broken\.pdf\. Receipt filed at evidence\/n\/1-look\.md\. The file is damaged or protected/);
  assert.ok(!text(out).includes("pdf.js:1"), "only the first line of the cause");
  assert.deepEqual(r.misses.map((m) => m.code), ["unreadable"]);
  cut = new AbortController();
  await assert.rejects(r.read({ path: "broken.pdf" }, cut.signal), /bad xref table/);
  assert.equal(r.misses.length, 1, "a cancelled read files no miss");
});

test("a renamed file, bytes in no format, a kind with no reader and a host that says no are misses with their reason", async (t) => {
  const r = await rig({}, { allow: ({ path }) => (path.startsWith("private/") ? "documents under private/ are read by the verification tools only" : true) });
  t.after(() => r.dir.remove());
  await r.dir.file("photo.pdf", pngBytes(2, 2));
  await r.dir.file("blob.bin", Buffer.from([0xca, 0xfe, 0, 1]));
  await r.dir.file("book.xlsx", "PK");
  await r.dir.file("private/id.png", pngBytes(2, 2));
  assert.match(text(await r.read({ path: "photo.pdf" })), /^photo\.pdf could not be read: its bytes are a PNG image and its name says PDF\./);
  assert.match(text(await r.read({ path: "blob.bin" })), /^blob\.bin could not be read: its bytes are in no format read takes \(first bytes cafe0001\)\./);
  assert.match(text(await r.read({ path: "book.xlsx" })), /^book\.xlsx could not be read: no reader for sheet files is installed\./);
  assert.match(text(await r.read({ path: "private/id.png" })), /^private\/id\.png could not be read: documents under private\/ are read by the verification tools only\. .* This host does not allow it; go on without it\.$/);
  assert.deepEqual(r.misses.map((m) => m.code), ["unsupported", "unsupported", "needs", "refused"]);
});

test("a recording by handle: its source answers the question about the window, and the look is filed with who billed it", async (t) => {
  const asks = [];
  const session = { via: "tools:review_recording", owns: async (id) => (id === "sess_1" ? true : `session:${id} is not a browser session this run opened`), look: async (request) => { asks.push(request); return { model: "reviewer-model", text: "0:23 Drawer open", costUsd: 0, billedBy: "tools" }; } };
  const r = await rig({}, { sources: { session } });
  t.after(() => r.dir.remove());
  const out = await r.read({ path: "session:sess_1", ask: "which marks are in the drawer?", from_s: 20, to_s: 30 });
  assert.equal(out.isError, undefined);
  assert.deepEqual(asks, [{ id: "sess_1", ask: "which marks are in the drawer?", fromS: 20, toS: 30 }]);
  assert.equal(text(out), "(recording session:sess_1 (20s\u201330s) seen for you by reviewer-model via tools:review_recording \u2014 your question: which marks are in the drawer?; look filed at evidence/n/1-look.md:)\n0:23 Drawer open");
  assert.deepEqual(out.details.media, { kind: "recording", sessionId: "sess_1", ask: "which marks are in the drawer?", fromS: 20, toS: 30 });
  assert.deepEqual(JSON.stringify(r.filed[0].args), JSON.stringify({ path: "session:sess_1", ask: "which marks are in the drawer?", from_s: 20, to_s: 30, via: "tools:review_recording", native: false, model: "reviewer-model" }));
  assert.deepEqual([receiptFacts(r.filed[0]).cost_usd, receiptFacts(r.filed[0]).fragment], [0, "t=20,30"]);
  assert.deepEqual([r.looks[0].costUsd, r.looks[0].billedBy, r.looks[0].usage], [0, "tools", null]);
  assert.equal(receiptFacts(r.filed[0]).provider, "tools", "the receipt names who billed it, as the event does");

  await r.read({ path: "session:sess_1", from_s: 0, to_s: 0, page: 1, offset: 1, char_offset: 0, limit: 0, ask: "" });
  assert.deepEqual(asks[1], { id: "sess_1", ask: DESCRIBE_ASK }, "a strict route's filler is the whole recording, described");
  const refused = [
    [{ path: "session:sess_1", page: 2 }, /^page applies to PDF files only; session:sess_1 is a recording/],
    [{ path: "session:sess_1", from_s: 30, to_s: 20 }, /to_s \(20\) must be greater than from_s \(30\)/],
    [{ path: "session:sess_1", from_s: -1 }, /from_s \(-1\) must not be negative/],
    [{ path: "session:sess_1", to_s: -1 }, /to_s \(-1\) must be greater than from_s \(0\)/],
    [{ path: "session:sess_9" }, /^session:sess_9 is not a browser session this run opened$/],
  ];
  for (const [args, pattern] of refused) {
    const result = await r.read(args);
    assert.equal(result.isError, true);
    assert.match(text(result), pattern);
  }
  assert.equal(asks.length, 2, "a refused read asks nothing");
});

test("a recording source that bills names its price on the receipt; one that answers nothing is a failed look", async (t) => {
  const answers = [{ model: "m", text: "a form", costUsd: 0.004, billedBy: "svc" }, { model: "m", text: "  " }];
  const r = await rig({}, { sources: { session: { via: "svc-reviewer", look: async () => answers.shift() } } });
  t.after(() => r.dir.remove());
  await r.read({ path: "session:sess_1" });
  assert.deepEqual([receiptFacts(r.filed[0]).cost_usd, receiptFacts(r.filed[0]).provider, r.looks[0].costUsd, r.looks[0].billedBy], [0.004, "svc", 0.004, "svc"]);
  const empty = await r.read({ path: "session:sess_1" });
  assert.deepEqual(empty, { content: [{ type: "text", text: "Cannot read session:sess_1: the recording reviewer m via svc-reviewer returned no text (look filed at evidence/n/2-look.md)" }], isError: true });
  assert.deepEqual([r.looks.length, r.misses.map((m) => m.code), r.filed[1].status], [1, ["look_failed"], "failed"]);
});

test("a recording source's failure is the read's refusal and a failed look; a host with no source refuses the handle", async (t) => {
  const session = { via: "tools:review_recording", look: async () => { throw new Error("The session is still running.\nstack"); } };
  const r = await rig({}, { sources: { session } });
  t.after(() => r.dir.remove());
  const out = await r.read({ path: "session:sess_1", ask: "anything?" });
  assert.deepEqual(out, { content: [{ type: "text", text: "Cannot read session:sess_1: The session is still running. (look filed at evidence/n/1-look.md)" }], isError: true });
  assert.deepEqual([r.filed[0].status, r.filed[0].args.model, r.misses[0].code], ["failed", "none", "look_failed"]);
  const bare = await rig();
  t.after(() => bare.dir.remove());
  assert.match(text(await bare.read({ path: "session:sess_1" })), /^session:sess_1 names a browser session's recording, and this run has no recording reviewer/);
  assert.equal(await bare.read({ path: "evidence/session:sess_1" }), null, "only the bare handle is a handle");
});

test("readsAsText: only a plain file with no media argument is the host's text read", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  await r.dir.file("notes.txt", "a");
  await r.dir.file("a.png", pngBytes(2, 2));
  await r.dir.file("blob.bin", Buffer.from([0xca, 0xfe, 0, 1]));
  const is = (args) => readsAsText(r.env, args, r.call(), r.setup, r.kinds);
  assert.deepEqual(await Promise.all([is({ path: "notes.txt" }), is({ path: "missing.txt" }), is({ path: "notes.txt", ask: " " }), is({ path: "a.png" }), is({ path: "blob.bin" }), is({ path: "notes.txt", page: 2 }), is({ path: "notes.txt", ask: "q" }), is({ path: "session:s1" })]), [true, true, true, false, false, false, false, false]);
});

test("a reader's cause that holds a signed link reaches the model, the receipt and the event cut to its origin and path", async (t) => {
  // Built at run time from the sentinels, so the source holds no link with credentials in it.
  const link = Object.assign(new URL(`${SENTINEL_SIGNED_LINK}#p2`), { username: "pv-sentinel-user", password: SENTINEL_LINK_TOKEN }).href;
  const r = await rig({ pdf: () => { throw new Error(`fetch '${link}' timed out\nat x`); } });
  t.after(() => r.dir.remove());
  await r.dir.file("doc.pdf", PDF_HEAD);
  const out = await r.read({ path: "doc.pdf" });
  assert.match(text(out), /^doc\.pdf could not be read: fetch 'https:\/\/files\.sentinel\.invalid\/reports\/statement\.pdf' timed out\./);
  for (const where of [JSON.stringify(out), JSON.stringify(r.filed), JSON.stringify(r.misses)]) assert.ok(![SENTINEL_LINK_SIGNATURE, SENTINEL_LINK_TOKEN, "pv-sentinel-user", "#p2"].some((v) => where.includes(v)), where);
});

test("the package's own readers are public, so a host replacing or adding one reader keeps the rest", async () => {
  const { PACKAGE_KINDS } = await import("@parcha/pi-vision");
  assert.deepEqual(Object.keys(PACKAGE_KINDS.readers).sort(), ["image", "office", "pdf", "sheet", "video"]);
  assert.equal(typeof PACKAGE_KINDS.sniff, "function");
  assert.equal(typeof PACKAGE_KINDS.sizeOf, "function");
});

/** `env`, with the file at `path` replaced by `bytes` the first time a scratch directory is asked for: after the read
 *  has taken the source and before any reader runs. */
const swappedMidRead = (env, path, bytes) => {
  let swapped = false;
  return Object.assign(Object.create(Object.getPrototypeOf(env)), env, { createTempDir: async (...args) => { if (!swapped) { swapped = true; writeFileSync(path, bytes); } return env.createTempDir(...args); } });
};

test("a source replaced while it is read: the reader gets the bytes that were hashed, so the hash names what was read", async (t) => {
  const A = Buffer.concat([PDF_HEAD, Buffer.from("first version")]), B = Buffer.concat([PDF_HEAD, Buffer.from("second version, replaced")]);
  const r = await rig({ pdf: async (request, context) => { const read = await context.env.readBinaryFile(request.source.path, { abortSignal: undefined, value: () => undefined }); return { content: [{ type: "text", text: Buffer.from(read.value).toString("latin1") }] }; } });
  t.after(() => r.dir.remove());
  const path = await r.dir.file("notice.pdf", A);
  const out = await readMedia(swappedMidRead(r.env, path, B), { path: "notice.pdf" }, r.call(), r.setup, r.kinds);
  assert.deepEqual(readFileSync(path), B, "the file was replaced during the read");
  assert.equal(sha(Buffer.from(text(out), "latin1")), out.details.media.sha256, "what the reader read is what the hash names");
  assert.equal(out.details.media.sha256, sha(A));
  assert.match(text(out), /first version$/);
});

test("a source too large to hold is read where it is: it keeps no derivation, and one that changed while it was read is an unreadable miss with no receipt", async (t) => {
  const seen = [];
  let touch = null;
  const r = await rig({ video: async (request, context) => { seen.push({ path: request.source.path, data: request.data, deriveDir: context.deriveDir, tempDir: context.tempDir }); touch?.(); return { content: [{ type: "text", text: "frames" }] }; } });
  t.after(() => r.dir.remove());
  const path = await r.dir.file("long.mp4", "ftyp");
  truncateSync(path, SOURCE_BYTES_IN_PROCESS + 1024);
  const steady = await r.read({ path: "long.mp4" });
  assert.equal(text(steady), "frames");
  assert.match(steady.details.media.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([seen[0].path, seen[0].data], ["long.mp4", undefined], "read in place, not copied");
  assert.equal(seen[0].deriveDir, undefined, "it is given nowhere to keep a derivation");
  touch = () => appendFileSync(path, "more");
  const moved = await r.read({ path: "long.mp4" });
  assert.equal(moved.details.miss.code, "unreadable");
  assert.match(text(moved), /^long\.mp4 could not be read: the file changed while it was read, so what was read is not one version of it; read it again\. The file is saved at long\.mp4\. The file is damaged or protected/);
  assert.deepEqual([r.filed.length, r.misses.length, r.misses[0].receipt], [0, 1, null], "nothing is filed under a hash that names no one version");
});

test("a file that grows past what the process holds between the two looks at it is never loaded whole", async (t) => {
  const r = await rig({ pdf: { content: [{ type: "text", text: "never reached" }] } });
  t.after(() => r.dir.remove());
  const path = await r.dir.file("grown.pdf", PDF_HEAD);
  // The size is taken while the file is small; by the time its bytes are read it holds more than the process may.
  let read = 0, whole = 0;
  const growing = Object.assign(Object.create(Object.getPrototypeOf(r.env)), r.env, {
    fileInfo: async (...args) => { const info = await r.env.fileInfo(...args); truncateSync(path, SOURCE_BYTES_IN_PROCESS + 4096); return info; },
    readBinaryFile: async (...args) => { whole += 1; return r.env.readBinaryFile(...args); },
    openBinaryReader: async (...args) => {
      const opened = await r.env.openBinaryReader(...args);
      if (!opened.ok) return opened;
      const reader = opened.value;
      return { ok: true, value: { info: (c) => reader.info(c), close: (c) => reader.close(c), read: async (offset, length, c) => { const chunk = await reader.read(offset, length, c); if (chunk.ok) read += chunk.value.length; return chunk; } } };
    },
  });
  const out = await readMedia(growing, { path: "grown.pdf" }, r.call(), r.setup, r.kinds);
  assert.equal(out.details.miss.code, "unreadable");
  assert.match(text(out), /^grown\.pdf could not be read: the file changed while it was read/);
  assert.ok(read <= SOURCE_BYTES_IN_PROCESS + 3 * 1024 * 1024, `read ${read} bytes`);
  assert.deepEqual([whole, r.calls.length, r.filed.length], [0, 0, 0], "not loaded whole, no reader run, nothing filed");
});

test("a read that is refused never holds the file: its arguments and the host's policy are checked on its first bytes", async (t) => {
  const r = await rig({ pdf: { content: [{ type: "text", text: "never reached" }] } }, { allow: ({ path }) => (path.startsWith("private/") ? "not for this read" : true) });
  t.after(() => r.dir.remove());
  const big = Buffer.concat([PDF_HEAD, Buffer.alloc(3 * 1024 * 1024, 32)]);
  await r.dir.file("big.pdf", big);
  await r.dir.file("private/big.pdf", big);
  let largest = 0, whole = 0;
  const counting = Object.assign(Object.create(Object.getPrototypeOf(r.env)), r.env, {
    readBinaryFile: async (...args) => { whole += 1; return r.env.readBinaryFile(...args); },
    openBinaryReader: async (...args) => {
      const opened = await r.env.openBinaryReader(...args);
      if (!opened.ok) return opened;
      const reader = opened.value;
      let total = 0;
      return { ok: true, value: { info: (c) => reader.info(c), close: (c) => reader.close(c), read: async (offset, length, c) => { const chunk = await reader.read(offset, length, c); if (chunk.ok) { total += chunk.value.length; largest = Math.max(largest, total); } return chunk; } } };
    },
  });
  const refused = await readMedia(counting, { path: "big.pdf", page: 0.5 }, r.call(), r.setup, r.kinds);
  assert.equal(refused.isError, true);
  assert.ok(largest <= 1024 * 1024, `a refusal of the arguments read ${largest} bytes: the first megabyte at most`);
  const denied = await readMedia(counting, { path: "private/big.pdf" }, r.call(), r.setup, r.kinds);
  assert.equal(denied.details.miss.code, "refused");
  assert.equal(receiptFacts(r.filed[0]).sha256, sha(big), "its receipt still names the file's bytes");
  assert.deepEqual([whole, r.calls.length], [0, 0], "never loaded whole, no reader run");
});

test("a file that is another kind by the time its bytes are held changed between the two looks at it", async (t) => {
  const r = await rig({ pdf: { content: [{ type: "text", text: "never reached" }] }, image: { content: [{ type: "text", text: "never reached" }] } });
  t.after(() => r.dir.remove());
  const path = await r.dir.file("notice.pdf", PDF_HEAD);
  // The first opening reads the head that decides the kind; the file is a picture by the second, which holds it.
  let opened = 0;
  const turned = Object.assign(Object.create(Object.getPrototypeOf(r.env)), r.env, { openBinaryReader: async (...args) => { if (++opened === 2) writeFileSync(path, pngBytes(2, 2)); return r.env.openBinaryReader(...args); } });
  const out = await readMedia(turned, { path: "notice.pdf" }, r.call(), r.setup, r.kinds);
  assert.equal(out.details.miss.code, "unreadable");
  assert.match(text(out), /^notice\.pdf could not be read: the file changed while it was read/);
  assert.deepEqual([r.calls.length, r.filed.length, r.misses[0].receipt], [0, 0, null], "no reader run, nothing filed");
});
