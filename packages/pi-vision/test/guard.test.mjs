// The guard over any tool's result: every image block fits the lead's limits or is withheld with a typed miss (never
// the original), and each block goes where the lead's route can take it. A route that takes images sees them and the
// look is filed natively; one that does not gets the eyes' answer to the agent's question (or a description) in their
// place, filed with its usage and price; when no look can happen the model reads why, where the file is and what to
// do, and the host gets a failed receipt and a miss. The blocks of one unit (an image's tiles, a read's pages) are one
// look, sent to the eyes in requests of at most the images one request takes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, DESCRIBE_ASK, detectOnce, guardResult, linkSafe, receiptFacts, resolveLimits } from "@parcha/pi-vision";
import { SENTINEL_EYES_KEY, SENTINEL_LINK_SIGNATURE, SENTINEL_LINK_TOKEN, SENTINEL_SIGNED_LINK, fakeEyes, imageSize, pngBytes } from "@parcha/pi-vision/testing";

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
/** The media parts of one eyes request, without the caption lines that go beside them. */
const seen = (request) => request.parts.filter((p) => p.type !== "text");
const texts = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text);

test("a text-only lead: the eyes answer the agent's question in the image's place, and the look is filed with what it showed and cost", async () => {
  const h = host();
  const eyes = fakeEyes({ answers: [{ text: "Badges: three payment marks.", input: 1200, output: 30 }] });
  const media = { kind: "image", path: "drawer.png", ask: "Which payment badges are visible?", sha256: "ab".repeat(32), original: "40x30" };
  const out = await guard(shot(media), h, { model: TEXT_ONLY, eyes });
  assert.equal(eyes.ledger.length, 1);
  assert.equal(eyes.ledger[0].ask, media.ask, "the eyes receive exactly the agent's question");
  assert.deepEqual(seen(eyes.ledger[0]).map((p) => [p.type, p.mimeType, p.width, p.height]), [["image", "image/png", 40, 30]]);
  assert.equal(images(out).length, 0, "no image block reaches a text-only lead");
  assert.equal(texts(out)[1], "(image seen for you by fake-eyes \u2014 your question: Which payment badges are visible?; the file is saved at drawer.png; look filed at evidence/n/00000001-look.md:)\nBadges: three payment marks.");
  const [{ label, record }] = h.filed;
  assert.equal(label, "n");
  assert.deepEqual(record.args, { path: "drawer.png", ask: media.ask, model: "fake-eyes", native: false });
  assert.equal(record.status, "ok");
  assert.equal(record.body, "Badges: three payment marks.");
  const facts = receiptFacts(record);
  assert.deepEqual(Object.keys(facts), ["original", "shown", "shown_blocks", "shown_bytes", "sha256", "kind", "key", "tokens_in", "tokens_out", "cost_usd", "startedAt"], "an empty fragment (the whole file) is left out; the request's start is a fact, and no tool call was named");
  assert.ok(Number.isInteger(facts.startedAt) && Math.abs(Date.now() - facts.startedAt) < 60_000, "the milliseconds the request began");
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
  assert.deepEqual([...kept.keys()].map((k) => k.slice(0, k.lastIndexOf(":"))), ["vision:look", "vision:told", "vision:look", "vision:told"], "each answer is kept, then that its host was told");
  assert.deepEqual(texts(first).filter((t) => /seen for you/.test(t)).map((t) => t.split("\n")[1]), ["answer 1", "answer 2"]);
});

test("an answer read back from the call's memo is filed as kept; its event is kept only when the host was told in that earlier attempt; its usage stays on the result", async () => {
  const kept = new Map();
  const memo = async (key, compute) => (kept.has(key) ? kept.get(key) : (kept.set(key, await compute()), kept.get(key)));
  const eyes = fakeEyes({ answers: [{ text: "A round seal.", input: 1000, output: 10 }] });
  const media = { kind: "image", path: "seal.png", ask: "Which seal is this?" };
  const [paid, again, untold] = [host(), host(), host()];
  const first = await guard(shot(media), paid, { model: TEXT_ONLY, eyes, memo });
  const out = await guard(shot(media), again, { model: TEXT_ONLY, eyes, memo });
  assert.equal(eyes.ledger.length, 1, "the run again reads the kept answer");
  assert.deepEqual([paid.looks[0].kept, paid.filed[0].record.facts.kept], [undefined, undefined], "a look paid now is as it was");
  assert.deepEqual([again.looks[0].kept, again.filed[0].record.facts.kept, receiptFacts(again.filed[0].record).kept], [true, true, "true"]);
  assert.deepEqual([again.looks[0].costUsd, again.looks[0].usage], [paid.looks[0].costUsd, paid.looks[0].usage], "the event still says what the look cost");
  assert.deepEqual([out.usage, texts(out)], [first.usage, texts(first)], "the result that commits is the first to carry the look's usage");
  for (const key of kept.keys()) if (key.startsWith("vision:told:")) kept.delete(key);
  await guard(shot(media), untold, { model: TEXT_ONLY, eyes, memo });
  assert.equal(eyes.ledger.length, 1);
  assert.deepEqual([untold.looks.length, untold.looks[0].kept, untold.filed[0].record.facts.kept], [1, undefined, true], "cut before its host was told: the record says no request was made, the event is charged once");
});

test("a look whose host's onLook threw is not kept as told: run again, its event is not kept, so the host can charge it", async () => {
  const kept = new Map();
  const memo = async (key, compute) => (kept.has(key) ? kept.get(key) : (kept.set(key, await compute()), kept.get(key)));
  const eyes = fakeEyes({ answers: [{ text: "A round seal.", input: 1000, output: 10 }] });
  const [failing, again] = [host({ hooksThrow: true }), host()];
  const first = await guard(shot({ kind: "image", path: "seal.png" }), failing, { model: TEXT_ONLY, eyes, memo });
  assert.match(texts(first)[1], /seen for you by fake-eyes/, "a hook that throws never fails the call");
  assert.deepEqual([...kept.keys()].map((k) => k.slice(0, k.lastIndexOf(":"))), ["vision:look"], "the answer is kept, the telling is not");
  await guard(shot({ kind: "image", path: "seal.png" }), again, { model: TEXT_ONLY, eyes, memo });
  assert.deepEqual([eyes.ledger.length, again.looks[0].kept, again.filed[0].record.facts.kept], [1, undefined, true]);
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
  assert.deepEqual(seen(eyes.ledger[0]).map((p) => [p.type, p.mimeType]), [["video", "video/mp4"]], "the video itself");
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
  assert.deepEqual(h.misses, [{ conversationId: "c1", tool: "read", source: "evidence/n/1-screenshot.png", code: "no_vision_route", reason: "no vision route is configured for this run", receipt: "evidence/n/00000001-look.md", record: h.filed[0].record }]);
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
  const media = { kind: "image", path: "tall.png", units: [0, 0, 0], original: "64x380" };
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
  assert.equal(seen(eyes.ledger[0]).length, 3);
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
  const tiled = { content: [png(4, 9), png(4, 9), png(4, 9)], details: { path: "t.png", media: { kind: "image", path: "t.png", units: [0, 0, 0] } } };
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

test("one unit goes to the eyes in requests of at most the images one request takes, each kept and filed under its own blocks", async () => {
  const pages = Array.from({ length: 37 }, (_, i) => png(10, 10 + i));
  const media = { kind: "pdf", path: "scan.pdf", sha256: "ef".repeat(32), units: pages.map(() => 0) };
  const kept = new Map();
  const memo = async (key, compute) => (kept.has(key) ? kept.get(key) : (kept.set(key, await compute()), kept.get(key)));
  const h = host();
  const eyes = fakeEyes({ answers: [(r) => `part ${r.n}`] });
  const out = await guard(shot(media, pages), h, { model: TEXT_ONLY, eyes, memo, limits: { ...resolveLimits(TEXT_ONLY), imagesPerCall: 40 } });
  assert.deepEqual(eyes.ledger.map((r) => seen(r).length), [8, 8, 8, 8, 5], "37 pages are five requests of at most 8");
  assert.equal(images(out).length, 0);
  assert.deepEqual(texts(out).filter((t) => /seen for you/.test(t)).map((t) => /^\(37 page images \(part (\d) of 5\)/.exec(t)?.[1]), ["1", "2", "3", "4", "5"]);
  assert.deepEqual([h.filed.length, new Set(h.filed.map((f) => f.record.facts.key)).size, [...kept.keys()].filter((k) => k.startsWith("vision:look:")).length], [5, 5, 5], "five looks, five keys, five answers kept");
  assert.deepEqual(h.filed.map((f) => f.record.facts.shown_blocks), [8, 8, 8, 8, 5]);
});

test("blocks of different units are different looks; a block with no unit is one of its own", async () => {
  const h = host();
  const eyes = fakeEyes({ answers: [(r) => `look ${r.n}`] });
  const media = { kind: "image", path: "two.png", units: [0, 0, 1] };
  const out = await guard(shot(media, [png(5, 5), png(5, 6), png(5, 7)]), h, { model: TEXT_ONLY, eyes });
  assert.deepEqual(eyes.ledger.map((r) => seen(r).length), [2, 1]);
  assert.match(texts(out)[1], /^\(2-tile image seen for you/);
  assert.match(texts(out)[2], /^\(image seen for you/);
  const loose = host();
  await guard(shot({ kind: "screenshot", path: "s.png" }, [png(5, 5), png(5, 6)]), loose, { model: TEXT_ONLY, eyes: fakeEyes() });
  assert.equal(loose.filed.length, 2, "two images with no unit are two looks");
});

test("unit ids that do not match the image blocks are not trusted: each block is its own look, and its receipt says why", async () => {
  const h = host();
  const eyes = fakeEyes({ answers: [(r) => `look ${r.n}`] });
  const media = { kind: "image", path: "x.png", units: [0, 0] };
  const out = await guard(shot(media, [png(5, 5), png(5, 6), png(5, 7)]), h, { model: TEXT_ONLY, eyes });
  assert.deepEqual(eyes.ledger.map((r) => seen(r).length), [1, 1, 1]);
  assert.equal(texts(out).filter((t) => /^\(image seen for you/.test(t)).length, 3);
  assert.deepEqual(h.filed.map((f) => receiptFacts(f.record).units_dropped), Array(3).fill("2 unit ids for 3 image blocks; each block was looked at on its own"));
  assert.ok(h.looks.every((l) => l.record.facts.units_dropped), "the host's events carry it too");
  const fine = host();
  await guard(shot({ ...media, units: [0, 0, 0] }, [png(5, 5), png(5, 6), png(5, 7)]), fine, { model: TEXT_ONLY, eyes: fakeEyes() });
  assert.equal(receiptFacts(fine.filed[0].record).units_dropped, undefined);
});

/** A PNG that does not compress: each pixel from a hash of its place. */
const noisy = (w, h, seed = 1) => ({ type: "image", data: b64(pngBytes(w, h, (x, y) => { const v = Math.imul(x * 7919 + y * 104729 + seed, 2654435761) >>> 0; return [v & 255, (v >> 8) & 255, (v >> 16) & 255]; })), mimeType: "image/png" });

test("a result's images in all are held to its share of the request: re-encoded smaller, else looked at by the eyes, else withheld; never sent as they are", async () => {
  const limits = { ...resolveLimits(SEES), requestBytes: 16_000 };
  const share = 4_000;
  const pair = [noisy(30, 30, 1), noisy(30, 30, 2)];
  assert.ok(pair.every((b) => b.data.length < limits.image.maxBytes) && pair[0].data.length + pair[1].data.length > share, "each within its own limit, together over the share");
  const asked = [];
  const smaller = { prepare: async (bytes, mimeType, l) => { asked.push(l); return { data: b64(pngBytes(Math.min(20, l.maxWidth), Math.min(20, l.maxHeight))), mimeType: "image/png" }; } };
  const h = host();
  const refit = await guard(shot({ kind: "screenshot", path: "s.png", units: [0, 0] }, pair), h, { limits, images: smaller });
  assert.equal(images(refit).length, 2);
  assert.ok(images(refit).reduce((sum, b) => sum + b.data.length, 0) <= share);
  assert.ok(asked.length >= 2 && asked.every((l) => l.maxBytes <= share / 2), "each block of the unit is re-encoded within its part of the share");
  assert.ok(!JSON.stringify(refit).includes(pair[0].data) && !JSON.stringify(refit).includes(pair[1].data));
  const loose = await guard(shot({ kind: "screenshot", path: "s.png" }, pair), host(), { limits, images: smaller });
  assert.deepEqual(images(loose).map((b) => b.data === pair[0].data), [true, false], "two looks: the first fits the share as it is, the second is made to fit what is left");
  assert.ok(images(loose).reduce((sum, b) => sum + b.data.length, 0) <= share);

  const eyes = fakeEyes({ answers: ["two panels"] });
  const looked = await guard(shot({ kind: "screenshot", path: "s.png", units: [0, 0] }, pair), host(), { limits, eyes });
  assert.deepEqual([images(looked).length, eyes.ledger.length], [0, 1], "no processor: the eyes look in the lead's place");
  const withheld = host();
  const out = await guard(shot({ kind: "screenshot", path: "s.png", units: [0, 0] }, pair), withheld, { limits });
  assert.equal(images(out).length, 0);
  assert.match(texts(out)[1], /^\(2-tile image withheld for this model and not described: its images come to \d+ base64 characters, over the 4000 left of the 4000 one result carries/);
  assert.deepEqual(withheld.misses.map((m) => m.code), ["over_budget"]);
});

test("the eyes are asked in requests within their own request budget as well as their image count", async () => {
  const blocks = Array.from({ length: 4 }, (_, i) => noisy(30, 30, i + 10));
  const eyes = fakeEyes({ limits: { ...DEFAULT_LIMITS, requestBytes: blocks[0].data.length * 2 + 10 } });
  await guard(shot({ kind: "pdf", path: "d.pdf", units: [0, 0, 0, 0] }, blocks), host(), { model: TEXT_ONLY, eyes });
  assert.deepEqual(eyes.ledger.map((r) => seen(r).length), [2, 2]);
});

test("a cause's first line never carries a link's query, fragment or credentials, however the link is wrapped", async () => {
  const cut = "https://files.sentinel.invalid/reports/statement.pdf";
  // Built at run time from the sentinels, so the source holds no link with credentials in it.
  const signed = Object.assign(new URL(`${SENTINEL_SIGNED_LINK}#frag`), { username: "pv-sentinel-user", password: SENTINEL_LINK_TOKEN }).href;
  const secret = (text) => [SENTINEL_LINK_SIGNATURE, SENTINEL_LINK_TOKEN, "pv-sentinel-user", "#frag"].some((value) => text.includes(value));
  assert.equal(linkSafe(`GET ${signed} failed (403)`), `GET ${cut} failed (403)`);
  for (const [open, close] of [["'", "'"], ['"', '"'], ["(", ")"], ["<", ">"], ["[", "]"], ["", "."], ["url=", ","], ["(", ")."]]) {
    const line = `request to ${open}${SENTINEL_SIGNED_LINK}${close} failed`;
    assert.equal(linkSafe(line), `request to ${open}${cut}${close} failed`, `${open}...${close}`);
  }
  assert.equal(linkSafe(`socket ${SENTINEL_SIGNED_LINK.replace("https://", "wss://")} closed`), `socket ${cut.replace("https://", "wss://")} closed`, "a web socket link");
  assert.equal(linkSafe(`socket '${SENTINEL_SIGNED_LINK.replace("https://", "ws://")}'`), `socket '${cut.replace("https://", "ws://")}'`);
  assert.equal(linkSafe(`{"url":"${SENTINEL_SIGNED_LINK.split("/").join("\\/")}"}`), `{"url":"${cut}"}`, "a link with its slashes escaped as JSON writes them");
  assert.equal(linkSafe("a\\/b is not a link"), "a\\/b is not a link", "a word with an escaped slash and no link is left as it is");
  assert.equal(linkSafe("a plain line with no link: ok?"), "a plain line with no link: ok?");
  assert.equal(linkSafe("file:///tmp/a?b and mailto:x@y.z"), "file:///tmp/a?b and mailto:x@y.z", "only http and https links are cut");
  assert.equal(linkSafe(`<${SENTINEL_SIGNED_LINK.replace("https://files.sentinel.invalid", "HTTPS://FILES.SENTINEL.INVALID")}>`), `<${cut}>`, "a scheme in capitals");
  assert.equal(linkSafe("broken https://[bad?x=1 link"), "broken (a link) link", "a link that does not parse keeps none of it");
  const h = host();
  const eyes = fakeEyes({ answers: [{ fail: `request to "${signed}" failed\nstack` }] });
  const out = await guard(shot({ kind: "image", path: "a.png" }), h, { model: TEXT_ONLY, eyes });
  for (const where of [texts(out).join("\n"), JSON.stringify(h.filed), JSON.stringify(h.misses)]) assert.ok(!secret(where), where);
  assert.ok(texts(out)[1].includes(`failed: request to "${cut}" failed.`));
  const found = await detectOnce({ name: "linked", capabilities: [], kinds: ["pdf"], detect: async () => { throw new Error(`could not fetch (${signed})`); } }, { id: "link-env" });
  assert.equal(found.reason, `detect failed: could not fetch (${cut})`);
});

test("a failed look says what it cost: nothing when no request was sent, the answer's tokens and price when the eyes answered with no text, no price when the request threw", async () => {
  const spent = (h) => h.filed.filter(({ record }) => record.status === "failed").map(({ record }) => { const f = receiptFacts(record); return [f.tokens_in, f.tokens_out, f.cost_usd]; });
  const image = (blocks) => shot({ kind: "image", path: "a.png" }, blocks);
  const narrow = { ...DEFAULT_LIMITS, image: { ...DEFAULT_LIMITS.image, maxWidth: 10, maxHeight: 10 } };
  const unasked = [
    ["no eyes", image([png(4, 4)]), { model: TEXT_ONLY }],
    ["eyes that take no images", image([png(4, 4)]), { model: TEXT_ONLY, eyes: fakeEyes({ accepts: { image: false } }) }],
    ["eyes that take no video", shot({ kind: "video", path: "a.mp4" }, [{ type: "image", data: "AAAA", mimeType: "video/mp4" }]), { model: TEXT_ONLY, eyes: fakeEyes() }],
    ["more images than one call shows", image([png(4, 4), png(5, 5)]), { limits: { ...DEFAULT_LIMITS, imagesPerCall: 1 } }],
    ["over the result's share", shot({ kind: "image", path: "a.png", units: [0, 0] }, [noisy(30, 30, 1), noisy(30, 30, 2)]), { limits: { ...resolveLimits(SEES), requestBytes: 16_000 } }],
    ["over one eyes request", image([noisy(30, 30, 3)]), { model: TEXT_ONLY, eyes: fakeEyes({ limits: { ...DEFAULT_LIMITS, requestBytes: 1_000 } }) }],
    ["no processor to fit it", image([png(30, 20)]), { limits: narrow }],
    ["a processor that cannot fit it", image([png(30, 20)]), { limits: narrow, images: { prepare: async () => undefined } }],
  ];
  for (const [name, result, over] of unasked) {
    const h = host();
    await guard(result, h, over);
    assert.deepEqual(spent(h), [[0, 0, 0]], name);
    assert.equal(over.eyes?.ledger.length ?? 0, 0, `${name}: no request`);
  }

  const kept = new Map();
  const memo = async (key, compute) => (kept.has(key) ? kept.get(key) : (kept.set(key, await compute()), kept.get(key)));
  const empty = fakeEyes({ answers: [{ text: " ", input: 900, output: 2 }] });
  const [paid, again] = [host(), host()];
  const out = await guard(image([png(4, 4)]), paid, { model: TEXT_ONLY, eyes: empty, memo });
  assert.ok(out.usage.cost.total > 0);
  assert.deepEqual(spent(paid), [[900, 2, out.usage.cost.total]], "the answer's tokens and price");
  assert.equal(out.usage.input, 900, "counted once on the result");
  await guard(image([png(4, 4)]), again, { model: TEXT_ONLY, eyes: empty, memo });
  assert.deepEqual([empty.ledger.length, spent(again), again.filed[0].record.facts.kept], [1, [[900, 2, out.usage.cost.total]], true], "read back, the record says it is that look's, not another payment");
  const unpriced = host();
  await guard(image([png(4, 4)]), unpriced, { model: TEXT_ONLY, eyes: fakeEyes({ answers: [{ text: "", input: 50, output: 0 }], price: null }) });
  assert.deepEqual(spent(unpriced), [[50, 0, "unknown"]]);

  const thrown = host();
  await guard(image([png(4, 4)]), thrown, { model: TEXT_ONLY, eyes: fakeEyes({ answers: [{ fail: "socket hang up" }] }) });
  assert.deepEqual(spent(thrown), [[undefined, undefined, undefined]], "a request that threw may have been billed");
  const cut = new AbortController();
  const cancelled = host();
  const pending = guard(image([png(4, 4)]), cancelled, { model: TEXT_ONLY, eyes: fakeEyes({ answers: [{ hang: true }] }), signal: cut.signal });
  setTimeout(() => cut.abort(), 10);
  await assert.rejects(pending);
  assert.equal(cancelled.filed.length, 0, "a cancelled look files nothing");
});

test("an image over what one eyes request carries is re-encoded smaller for them, or its unit is withheld; never sent over it", async () => {
  const big = noisy(30, 30, 3);
  const eyesLimits = { ...DEFAULT_LIMITS, requestBytes: 1_000 };
  const smaller = { prepare: async (bytes, mimeType, l) => ({ data: b64(pngBytes(Math.min(8, l.maxWidth), Math.min(8, l.maxHeight))), mimeType: "image/png" }) };
  const eyes = fakeEyes({ limits: eyesLimits });
  await guard(shot({ kind: "image", path: "a.png" }, [big]), host(), { model: TEXT_ONLY, eyes, images: smaller });
  assert.equal(eyes.ledger.length, 1);
  assert.ok(seen(eyes.ledger[0])[0].chars <= 1_000);
  const h = host();
  const none = fakeEyes({ limits: eyesLimits });
  const out = await guard(shot({ kind: "image", path: "a.png" }, [big]), h, { model: TEXT_ONLY, eyes: none });
  assert.equal(none.ledger.length, 0);
  assert.match(texts(out)[1], /^\(image withheld for this model and not described: an image of it is 30x30 and \d+ base64 characters, over the 2000x2000 and 1000 one request to the vision route fake-eyes carries/);
  const narrow = fakeEyes({ limits: { ...DEFAULT_LIMITS, image: { ...DEFAULT_LIMITS.image, maxWidth: 12, maxHeight: 12 } } });
  await guard(shot({ kind: "image", path: "a.png" }, [png(30, 20)]), host(), { model: TEXT_ONLY, eyes: narrow, images: smaller });
  assert.ok(seen(narrow.ledger[0]).every((p) => p.width <= 12 && p.height <= 12), "fitted inside the eyes' own edges, which are smaller than the lead's");
  assert.deepEqual(h.misses.map((m) => m.code), ["over_budget"]);
});

test("the blocks of one unit shown to the lead stay where they stood, each beside its own caption", async () => {
  const pages = [png(10, 11), png(10, 12)];
  const result = { content: [{ type: "text", text: "page 1" }, pages[0], { type: "text", text: "page 2" }, pages[1]], details: { path: "d.pdf", media: { kind: "pdf", path: "d.pdf", units: [0, 0] } } };
  const h = host();
  const out = await guard(result, h);
  assert.deepEqual(out.content.map((b) => (b.type === "text" ? b.text.split(" ")[0] : b.data === pages[0].data ? "image 1" : "image 2")), ["page", "image 1", "page", "image 2", "(look"]);
  assert.equal(h.filed.length, 1, "still one look");
});

test("the same image object twice in a result is two blocks: each place gets the answer, and it is asked once", async () => {
  const same = png(9, 9);
  const eyes = fakeEyes({ answers: ["a mark"] });
  const out = await guard({ content: [{ type: "text", text: "two of the same" }, same, same], details: { path: "s.png" } }, host(), { model: TEXT_ONLY, eyes });
  assert.equal(eyes.ledger.length, 1);
  assert.equal(texts(out).filter((t) => /seen for you by fake-eyes/.test(t)).length, 2);
});

test("the eyes are told each image's caption line beside it, so they can say which page or time they saw a thing at", async () => {
  const pages = [png(10, 11), png(10, 12)];
  const result = { content: [{ type: "text", text: "PDF d.pdf, page 1 of 2, rendered at 150 dpi.\nText layer of this page:\nlong text" }, pages[0], { type: "text", text: "PDF d.pdf, page 2 of 2, rendered at 150 dpi." }, pages[1]], details: { path: "d.pdf", media: { kind: "pdf", path: "d.pdf", units: [0, 0] } } };
  const eyes = fakeEyes();
  await guard(result, host(), { model: TEXT_ONLY, eyes });
  assert.deepEqual(eyes.ledger[0].parts.map((p) => p.type), ["text", "image", "text", "image"]);
  assert.deepEqual(eyes.ledger[0].parts.filter((p) => p.type === "text").map((p) => p.chars), ["PDF d.pdf, page 1 of 2, rendered at 150 dpi.".length, "PDF d.pdf, page 2 of 2, rendered at 150 dpi.".length], "the first line of each caption only");
});

test("a lead that takes no images does not hold a block to its own image limits: a page over them reaches the eyes inside theirs", async () => {
  const capped = { ...resolveLimits(TEXT_ONLY), image: { ...resolveLimits(TEXT_ONLY).image, maxWidth: 1000, maxHeight: 1000 } };
  assert.equal(capped.image.native, false);
  const page = png(1275, 1650);
  const h = host();
  const eyes = fakeEyes({ answers: ["a letter"] });
  const out = await guard(shot({ kind: "pdf", path: "scan.pdf", page: 1 }, [page]), h, { model: TEXT_ONLY, limits: capped, eyes });
  assert.deepEqual(seen(eyes.ledger[0]).map((p) => [p.width, p.height]), [[1275, 1650]], "no processor is needed: the page is within the eyes' limits");
  assert.match(texts(out)[1], /^\(image seen for you by fake-eyes/);
  assert.deepEqual([h.misses.length, receiptFacts(h.filed[0].record).shown], [0, "1275x1650"]);
  const narrow = fakeEyes({ limits: { ...DEFAULT_LIMITS, image: { ...DEFAULT_LIMITS.image, maxWidth: 1200, maxHeight: 1200 } } });
  const withheld = await guard(shot({ kind: "pdf", path: "scan.pdf", page: 1 }, [page]), host(), { model: TEXT_ONLY, limits: capped, eyes: narrow });
  assert.match(texts(withheld)[1], /^\(image withheld for this model and not described: it is 1275x1650 and \d+ base64 characters, over 1200x1200/, "the eyes' own limits still hold");
  assert.equal(narrow.ledger.length, 0);
});

test("a look or a miss at another tool's image names that tool and its result in the host's rows and to the eyes; a caller that names no tool gets read", async () => {
  for (const [tool, named] of [["screenshot", ["screenshot", "a screenshot result"]], [undefined, ["read", "a tool result"]]]) {
    const h = host();
    const eyes = fakeEyes({ answers: ["a page"] });
    const result = { content: [{ type: "text", text: "a page" }, png(40, 30)] };
    const call = { conversationId: "c1", callId: "t1", ...(tool ? { tool } : {}), model: TEXT_ONLY, signal: undefined };
    await guardResult(result, call, { ...h.setup, limits: resolveLimits(TEXT_ONLY), eyes }, imageSize);
    await guardResult(result, call, { ...h.setup, limits: resolveLimits(TEXT_ONLY) }, imageSize);
    assert.deepEqual(h.looks.map((look) => [look.tool, look.source, look.record.args.path]), [[...named, named[1]]]);
    assert.deepEqual(h.misses.map((miss) => [miss.tool, miss.source]), [named]);
    assert.deepEqual(seen(eyes.ledger[0]).map((part) => part.fragment), [named[1]]);
    assert.equal(h.filed.length, 0, "a result no door named files no receipt");
  }
});
