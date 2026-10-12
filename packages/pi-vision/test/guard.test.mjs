// The guard over any tool's result: every image block fits the lead's limits or is withheld with a typed miss (never
// the original), and each block goes where the lead's route can take it. A route that takes images sees them and the
// look is filed natively; one that does not gets the eyes' answer to the agent's question (or a description) in their
// place, filed with its usage and price; when no look can happen the model reads why, where the file is and what to
// do, and the host gets a failed receipt and a miss. An image read as tiles is one unit and one look.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, DESCRIBE_ASK, guardResult, receiptFacts, resolveLimits } from "@parcha/pi-vision";
import { SENTINEL_EYES_KEY, fakeEyes, imageSize, pngBytes } from "@parcha/pi-vision/testing";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const png = (w, h) => ({ type: "image", data: b64(pngBytes(w, h)), mimeType: "image/png" });

/** A sink that keeps every record, and the host's hooks, each call in order. */
function host({ sinkFails = false, hooksThrow = false } = {}) {
  const filed = [], looks = [], misses = [];
  return {
    filed, looks, misses,
    setup: {
      scope: { label: "n", deriveDir: "evidence/n/media" }, eyes: undefined, providers: [], sources: {},
      evidence: { file: async (label, record) => { if (sinkFails) throw new Error("disk full"); filed.push({ label, record }); return { path: `evidence/${label}/${String(filed.length).padStart(8, "0")}-look.md` }; } },
      onLook: (look) => { looks.push(look); if (hooksThrow) throw new Error("row write failed"); },
      onMiss: async (miss) => { misses.push(miss); if (hooksThrow) throw new Error("row write failed"); },
    },
  };
}
const SEES = { id: "lead-model", input: ["text", "image"] };
const TEXT_ONLY = { id: "lead-model", input: ["text"] };
const VIDEO = { ...DEFAULT_LIMITS, video: { ...DEFAULT_LIMITS.video, native: true } };
/** The guard on one call of `model`: the host's setup, the limits resolved from the model as an adapter does, and `over` them. */
const guard = (result, h, { model = SEES, signal, memo, ...over } = {}) =>
  guardResult(result, { conversationId: "c1", callId: "t1", model, signal, ...(memo ? { memo } : {}) }, { ...h.setup, limits: resolveLimits(model), ...over }, imageSize);
const shot = (media, blocks = [png(40, 30)]) => ({ content: [{ type: "text", text: `${media?.path ?? "a screenshot"} read.` }, ...blocks], details: { path: media?.path ?? "evidence/n/1-screenshot.png", ...(media ? { media } : {}) } });
const images = (result) => result.content.filter((b) => b.type === "image");
const texts = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text);

test("a text-only lead: the eyes answer the agent's question in the image's place, and the look is filed with what it showed and cost", async () => {
  const h = host();
  const eyes = fakeEyes({ answers: [{ text: "Badges: three payment marks.", input: 1200, output: 30 }] });
  const media = { kind: "image", path: "drawer.png", ask: "Which payment badges are visible?", sha256: "ab".repeat(32), original: "40x30" };
  const out = await guard(shot(media), h, { model: TEXT_ONLY, eyes });
  assert.equal(eyes.ledger.length, 1);
  assert.equal(eyes.ledger[0].ask, media.ask, "the eyes receive exactly the agent's question");
  assert.deepEqual(eyes.ledger[0].parts.map((p) => [p.type, p.mimeType, p.width, p.height]), [["image", "image/png", 40, 30]]);
  assert.equal(images(out).length, 0, "no image block reaches a text-only lead");
  assert.equal(texts(out)[1], "(image seen for you by fake-eyes \u2014 your question: Which payment badges are visible?; the file is saved at drawer.png; look filed at evidence/n/00000001-look.md:)\nBadges: three payment marks.");
  const [{ label, record }] = h.filed;
  assert.equal(label, "n");
  assert.deepEqual(record.args, { path: "drawer.png", ask: media.ask, model: "fake-eyes", native: false });
  assert.equal(record.status, "ok");
  assert.equal(record.body, "Badges: three payment marks.");
  const facts = receiptFacts(record);
  assert.deepEqual(Object.keys(facts), ["original", "shown", "shown_blocks", "shown_bytes", "sha256", "kind", "key", "tokens_in", "tokens_out", "cost_usd"], "an empty fragment (the whole file) is left out");
  assert.deepEqual([facts.original, facts.shown, facts.shown_blocks, facts.shown_bytes, facts.sha256, facts.kind], ["40x30", "40x30", 1, shot(media).content[1].data.length, media.sha256, "image"]);
  assert.deepEqual([facts.tokens_in, facts.tokens_out], [1200, 30]);
  assert.ok(Math.abs(facts.cost_usd - (1200 * 1 + 30 * 4) / 1e6) < 1e-12);
  assert.match(facts.key, /^[0-9a-f]{64}$/);
  assert.equal(h.looks.length, 1);
  assert.deepEqual([h.looks[0].tool, h.looks[0].source, h.looks[0].ask, h.looks[0].model, h.looks[0].receipt], ["read", "drawer.png", media.ask, "fake-eyes", "evidence/n/00000001-look.md"]);
  assert.equal(out.usage.input, 1200, "the eyes' usage is on the result");
  assert.equal(out.usage.cost.total, h.looks[0].costUsd);
});

test("a lead that takes images sees the block itself; the look is still filed, naming the lead's model, and the host hears of it", async () => {
  const h = host();
  const eyes = fakeEyes();
  const media = { kind: "image", path: "drawer.png", ask: "What is in the drawer?" };
  const out = await guard(shot(media), h, { eyes });
  assert.equal(eyes.ledger.length, 0, "a lead with eyes of its own borrows none");
  assert.equal(images(out).length, 1);
  assert.equal(out.content.at(-1).text, "(look filed at evidence/n/00000001-look.md; your question: What is in the drawer?)");
  assert.deepEqual(h.filed[0].record.args, { path: "drawer.png", ask: media.ask, model: "lead-model", native: true });
  assert.equal(h.filed[0].record.body, "shown to the model natively");
  assert.deepEqual([h.looks.length, h.looks[0].usage, h.looks[0].record.args.native], [1, null, true]);
  assert.equal(out.usage, undefined, "a native look spends nothing of its own");
  const unknown = host();
  await guard(shot(media), unknown, { model: null });
  assert.equal(unknown.filed[0].record.args.model, "the lead model", "a lead that does not describe itself is taken to see");
  const ref = host();
  await guard(shot(media), ref, { model: { provider: "p", modelId: "ref-model" } });
  assert.equal(ref.filed[0].record.args.model, "ref-model", "a model reference names the lead by its id");
});

test("the host's word decides whether the lead takes images: a route that rejects them in a tool result gets the eyes", async () => {
  const h = host();
  const eyes = fakeEyes({ answers: ["A form."] });
  const out = await guard(shot({ kind: "screenshot", path: "s.png" }), h, { eyes, limits: resolveLimits(SEES, { image: { native: false } }) });
  assert.equal(images(out).length, 0);
  assert.equal(eyes.ledger.length, 1);
  assert.equal(h.filed[0].record.args.native, false);
});

test("an eyes answer is kept under its look's key before the result: a call run again does not ask again, and two pages are two looks", async () => {
  const kept = new Map();
  const memo = async (key, compute) => (kept.has(key) ? kept.get(key) : (kept.set(key, await compute()), kept.get(key)));
  const eyes = fakeEyes({ answers: [(r) => `answer ${r.n}`] });
  const media = { kind: "pdf_page", path: "scan.pdf", sha256: "cd".repeat(32), ask: "What is the date?" };
  const result = shot(media, [png(10, 14), png(10, 15)]);
  const first = await guard(result, host(), { model: TEXT_ONLY, eyes, memo });
  const again = await guard(result, host(), { model: TEXT_ONLY, eyes, memo });
  assert.equal(eyes.ledger.length, 2, "one request a page, none on the run again");
  assert.deepEqual(texts(again), texts(first));
  assert.deepEqual([...kept.keys()].map((k) => k.startsWith("vision:look:")), [true, true]);
  assert.deepEqual(texts(first).filter((t) => /seen for you/.test(t)).map((t) => t.split("\n")[1]), ["answer 1", "answer 2"]);
});

test("the same image twice in one result is asked and paid for once, with or without a memo", async () => {
  for (const memo of [undefined, async (key, compute) => compute()]) {
    const h = host();
    const eyes = fakeEyes({ answers: [{ text: "A seal.", input: 1000, output: 10 }] });
    const out = await guard(shot({ kind: "screenshot", path: "s.png" }, [png(8, 8), png(8, 8)]), h, { model: TEXT_ONLY, eyes, memo });
    assert.equal(eyes.ledger.length, 1);
    assert.equal(texts(out).filter((t) => /seen for you/.test(t)).length, 2, "each place the image stood has the answer");
    assert.deepEqual([out.usage.input, h.looks.length, h.filed.length], [1000, 1, 1]);
  }
});

test("a video on a text-only lead goes to eyes that take video, with the window on the look; eyes that do not take it are a video_unseeable miss", async () => {
  const h = host();
  const eyes = fakeEyes({ accepts: { video: true }, answers: ["A drawer opens."] });
  const media = { kind: "video", path: "0.mp4", ask: "What appears between 0:12 and 0:27?", fromS: 12, toS: 27 };
  const video = { type: "image", data: "AAAA", mimeType: "video/mp4" };
  const out = await guard(shot(media, [video]), h, { model: TEXT_ONLY, eyes });
  assert.deepEqual(eyes.ledger[0].parts.map((p) => [p.type, p.mimeType]), [["video", "video/mp4"]], "the video itself");
  assert.match(texts(out).at(-1), /^\(video seen for you by fake-eyes \u2014 your question: What appears between 0:12 and 0:27\?/);
  assert.deepEqual(h.filed[0].record.args, { path: "0.mp4", ask: media.ask, from_s: 12, to_s: 27, model: "fake-eyes", native: false });
  assert.equal(receiptFacts(h.filed[0].record).fragment, "t=12,27");
  assert.equal(receiptFacts(h.filed[0].record).shown, undefined, "a video look records no image facts");

  const h2 = host();
  const out2 = await guard(shot(media, [video]), h2, { model: TEXT_ONLY, eyes: fakeEyes() });
  assert.match(texts(out2).at(-1), /^\(video withheld for this model and not described: the vision route fake-eyes does not take video; read the file again for frames\. The file is saved at 0\.mp4\. Receipt filed at evidence\/n\/00000001-look\.md\. Read a shorter from_s\.\.to_s window/);
  assert.deepEqual(h2.misses.map((m) => m.code), ["video_unseeable"]);

  const h3 = host();
  const native = await guard(shot(media, [video]), h3, { model: TEXT_ONLY, limits: VIDEO, eyes: fakeEyes() });
  assert.deepEqual(images(native), [video], "a lead whose route takes video sees it");
  assert.deepEqual([h3.filed[0].record.args.native, receiptFacts(h3.filed[0].record).shown], [true, undefined]);
});

test("a result with no image passes through as it is", async () => {
  const h = host();
  const result = { content: [{ type: "text", text: "t" }], details: { path: "a.txt" } };
  assert.equal(await guard(result, h, { model: TEXT_ONLY }), result);
  assert.deepEqual([h.filed.length, h.looks.length, h.misses.length], [0, 0, 0]);
});

test("with no eyes the image is withheld loudly: the saved file, the missing route and the operator's fix; a failed receipt and a miss", async () => {
  const h = host();
  const media = { kind: "screenshot", path: "evidence/n/1-screenshot.png" };
  const out = await guard(shot(media), h, { model: TEXT_ONLY });
  assert.equal(texts(out)[0], "evidence/n/1-screenshot.png read.");
  assert.equal(texts(out)[1], "(image withheld for this model and not described: no vision route is configured for this run. The file is saved at evidence/n/1-screenshot.png. Receipt filed at evidence/n/00000001-look.md. The operator's fix is to give this host eyes (a vision model that accepts images), or to run a model that accepts images. Until then, work from the saved file with bash (OCR, pixel statistics, metadata).)");
  assert.equal(images(out).length, 0);
  assert.deepEqual([h.filed[0].record.status, h.filed[0].record.args.model, h.filed[0].record.body], ["failed", "no vision route", "not seen: no vision route is configured for this run"]);
  assert.deepEqual(h.misses, [{ conversationId: "c1", tool: "read", source: "evidence/n/1-screenshot.png", code: "no_vision_route", reason: "no vision route is configured for this run", receipt: "evidence/n/00000001-look.md" }]);
  assert.equal(h.looks.length, 0, "a miss is not a look");
});

test("with no question the eyes describe; a failing route is named with its cause, never with the key; an empty answer is a failed look", async () => {
  const h = host();
  const eyes = fakeEyes({ answers: ["A checkout page.", { fail: "route down" }, ""] });
  const s = { model: TEXT_ONLY, eyes };
  const described = await guard(shot(), h, s);
  assert.equal(eyes.ledger[0].ask, DESCRIBE_ASK);
  assert.equal(texts(described)[1], "(image seen for you by fake-eyes; the file is saved at evidence/n/1-screenshot.png:)\nA checkout page.");
  assert.equal(h.filed.length, 0, "an image no door named is routed, with nothing to cite");
  assert.deepEqual(h.looks.map((l) => [l.source, l.receipt, l.costUsd > 0]), [["evidence/n/1-screenshot.png", null, true]], "its look still reaches the host's spend");
  const failed = await guard(shot(), h, s);
  assert.match(texts(failed)[1], /^\(image withheld for this model and not described: the vision route fake-eyes failed: route down\. The file is saved at evidence\/n\/1-screenshot\.png\. Read it again to retry the look/);
  assert.ok(!JSON.stringify(failed).includes(SENTINEL_EYES_KEY));
  const empty = await guard(shot(), h, s);
  assert.match(texts(empty)[1], /the vision route fake-eyes returned no text/);
  assert.deepEqual(h.misses.map((m) => m.code), ["look_failed", "look_failed"]);
});

test("the tiles of one image are one unit: kept together and filed as one look on a lead that sees, one eyes request on one that does not", async () => {
  const tiles = [png(64, 156), png(64, 156), png(64, 100)];
  const media = { kind: "image", path: "tall.png", tiles: 3, original: "64x380" };
  const result = { content: [{ type: "text", text: "tall.png, shown as 3 tiles." }, ...tiles], details: { path: "tall.png", media } };
  const h = host();
  const shown = await guard(result, h);
  assert.deepEqual(images(shown).map((b) => b.data), tiles.map((b) => b.data));
  assert.equal(h.filed.length, 1, "the tiles are one look");
  const facts = receiptFacts(h.filed[0].record);
  assert.deepEqual([facts.original, facts.shown, facts.shown_blocks, facts.shown_bytes], ["64x380", "64x156", 3, Math.max(tiles[0].data.length, tiles[1].data.length)]);
  const h2 = host();
  const eyes = fakeEyes({ answers: ["Rows of text."] });
  const asked = await guard({ ...result, details: { ...result.details, media: { ...media, ask: "Which rows are text?" } } }, h2, { model: TEXT_ONLY, eyes });
  assert.equal(eyes.ledger.length, 1);
  assert.equal(eyes.ledger[0].parts.length, 3);
  assert.equal(images(asked).length, 0);
  assert.deepEqual(texts(asked).filter((t) => /seen for you/.test(t)).length, 1);
  assert.match(texts(asked)[1], /^\(3-tile image seen for you by fake-eyes/);
  assert.equal(receiptFacts(h2.filed[0].record).shown_blocks, 3);
});

test("a block over the limits is fitted by the processor or withheld; the original never stays", async () => {
  const limits = { ...DEFAULT_LIMITS, image: { ...DEFAULT_LIMITS.image, maxWidth: 100, maxHeight: 100 } };
  const big = png(300, 120);
  const halve = { prepare: async (bytes, mimeType, l) => { const s = imageSize(bytes); return { data: b64(pngBytes(Math.min(l.maxWidth, s.width), Math.min(l.maxHeight, s.height))), mimeType: "image/png", resized: { from: s, to: { width: l.maxWidth, height: l.maxHeight } } }; } };
  const h = host();
  const fit = await guard(shot({ kind: "screenshot", path: "s.png" }, [big]), h, { limits, images: halve });
  assert.deepEqual(images(fit).map((b) => imageSize(Buffer.from(b.data, "base64"))), [{ mimeType: "image/png", width: 100, height: 100 }]);
  assert.equal(receiptFacts(h.filed[0].record).shown, "100x100");
  for (const [images_, code] of [[undefined, "needs"], [{ prepare: async () => undefined }, "over_budget"], [{ prepare: async () => { throw new Error("decode failed"); } }, "over_budget"], [{ prepare: async () => ({ data: big.data, mimeType: "image/png" }) }, "over_budget"]]) {
    const hx = host();
    const out = await guard(shot({ kind: "screenshot", path: "s.png" }, [big]), hx, { limits, images: images_ });
    assert.equal(images(out).length, 0, `${code}: the original is gone`);
    assert.ok(!JSON.stringify(out).includes(big.data));
    assert.match(texts(out)[1], /^\(image withheld for this model and not described: it is 300x120 and \d+ base64 characters, over 100x100 and 4718592/);
    assert.deepEqual(hx.misses.map((m) => m.code), [code]);
  }
});

test("no image block over the limits leaves the guard, for random sizes, limits and processors", async () => {
  let seed = 7;
  const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  for (let i = 0; i < 60; i++) {
    const limits = { ...DEFAULT_LIMITS, image: { ...DEFAULT_LIMITS.image, maxWidth: 1 + rand(80), maxHeight: 1 + rand(80), maxBytes: 100 + rand(400) } };
    const blocks = Array.from({ length: 1 + rand(3) }, () => png(1 + rand(120), 1 + rand(120)));
    const careless = { prepare: async (bytes) => (rand(2) ? { data: b64(pngBytes(1 + rand(120), 1 + rand(120))), mimeType: "image/png" } : { data: b64(bytes), mimeType: "image/png" }) };
    const out = await guard(shot({ kind: "image", path: "x.png" }, blocks), host(), { limits, images: rand(2) ? careless : undefined });
    for (const block of images(out)) {
      const size = imageSize(Buffer.from(block.data, "base64"));
      assert.ok(size.width <= limits.image.maxWidth && size.height <= limits.image.maxHeight && block.data.length <= limits.image.maxBytes, JSON.stringify({ size, chars: block.data.length, limits: limits.image }));
    }
  }
});

test("a result shows at most the images one call may carry; a tiled image over it is withheld whole", async () => {
  const limits = { ...DEFAULT_LIMITS, imagesPerCall: 2 };
  const h = host();
  const out = await guard(shot({ kind: "screenshot", path: "s.png" }, [png(4, 4), png(5, 5), png(6, 6)]), h, { limits });
  assert.deepEqual(images(out).map((b) => imageSize(Buffer.from(b.data, "base64")).width), [4, 5]);
  assert.match(texts(out).find((t) => /withheld/.test(t)), /^\(image withheld for this model and not described: this result holds more images than the 2 one call may show\./);
  assert.deepEqual(h.misses.map((m) => m.code), ["over_budget"]);
  const tiled = { content: [png(4, 9), png(4, 9), png(4, 9)], details: { path: "t.png", media: { kind: "image", path: "t.png", tiles: 3 } } };
  const out2 = await guard(tiled, host(), { limits });
  assert.equal(images(out2).length, 0);
  assert.match(texts(out2)[0], /^\(3-tile image withheld/);
});

test("a sink or a hook that throws, at once or later, never fails the result; the call's cancellation does", async () => {
  const h = host({ sinkFails: true, hooksThrow: true });
  const out = await guard(shot({ kind: "image", path: "a.png" }), h, { model: TEXT_ONLY, eyes: fakeEyes({ answers: ["ok"] }) });
  assert.equal(texts(out)[1], "(image seen for you by fake-eyes; the file is saved at a.png:)\nok");
  const sync = { file: () => { throw new Error("no disk"); } };
  const native = await guard(shot({ kind: "image", path: "a.png" }), host(), { evidence: sync });
  assert.equal(images(native).length, 1, "a sink that throws before it returns a promise loses no result");
  const withheld = await guard(shot({ kind: "image", path: "a.png" }), host(), { model: TEXT_ONLY, evidence: sync });
  assert.match(texts(withheld)[1], /^\(image withheld for this model and not described: no vision route/);
  const cut = new AbortController();
  const pending = guard(shot({ kind: "image", path: "a.png" }), host(), { model: TEXT_ONLY, eyes: fakeEyes({ answers: [{ hang: true }] }), signal: cut.signal });
  setTimeout(() => cut.abort(), 10);
  await assert.rejects(pending);
});
