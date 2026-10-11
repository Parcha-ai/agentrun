// The planner: what each kind of source becomes for the lead (`show`) and for the eyes (`ask`), with the budgets the
// eyes bench set (pages at 150 dpi, a 1,200 px floor) and the tile rule hosts already ship. The property tests draw
// random sources, selectors and limits: no plan exceeds its limits, nothing shrunk is sent under the floor, and tiles
// cover the whole picture. A failure names its seed; replay it with PI_VISION_PLAN_SEED=<seed>.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LIMITS, FLOOR_EDGE, LOOK_FRAMES_PER_CALL, LOOK_FRAMES_PER_REQUEST, LOOK_PAGES_PER_CALL, LOOK_PAGES_PER_REQUEST, MISS_CODES,
  PDF_MAX_DPI, RESULT_BYTES_SHARE, TILE_OVERLAP, formatFragment, lookRequests, parseFragment, plan, priceLook,
} from "@parcha/pi-vision";

const MiB = 1024 * 1024;
const LETTER = { width: 612, height: 792 };
const A4 = { width: 595, height: 842 };
const image = (width, height, bytes = 200_000) => ({ kind: "image", bytes, sha256: "0".repeat(64), mimeType: "image/png", width, height });
const pdf = (pages, { size = LETTER, textPages = [] } = {}) => ({ kind: "pdf", bytes: 500_000, sha256: "1".repeat(64), pages, pageSizes: Array.from({ length: pages }, () => size), textPages });
const video = (durationS, bytes = 50_000_000) => ({ kind: "video", bytes, sha256: "2".repeat(64), width: 640, height: 360, durationS });
const limits = (over = {}) => ({ ...DEFAULT_LIMITS, ...over, image: { ...DEFAULT_LIMITS.image, ...over.image }, video: { ...DEFAULT_LIMITS.video, ...over.video } });
const tops = (p) => p.parts.map((part) => part.crop.top);

test("a tall screenshot is cut into tiles of 1,568 px that overlap by 64, in reading order, as hosts already do", () => {
  const p = plan(image(1288, 8319), {}, DEFAULT_LIMITS, "show");
  assert.equal(p.fit.reduction, "tiled");
  assert.deepEqual(p.fit.shown, { width: 1288, height: 8319, tiles: 6 });
  assert.deepEqual(p.parts.map((part) => [part.derive, part.width, part.height]), Array(6).fill(["tile", 1288, 1568]));
  assert.deepEqual(tops(p), [0, 1504, 3008, 4512, 6016, 6751], "the last tile ends at the bottom edge");
  assert.deepEqual(p.parts[0].raster, { width: 1288, height: 8319 });
  assert.deepEqual(p.parts[5].fragment, { xywh: { x: 0, y: 81.151, w: 100, h: 18.849 } }, "the citation of the last tile, in percent of the image");
});

test("past eight tiles, the whole is scaled so eight cover it", () => {
  const p = plan(image(1288, 30_000), {}, DEFAULT_LIMITS, "show");
  assert.equal(p.parts.length, 8);
  assert.deepEqual(p.parts[0].raster, { width: 519, height: 1568 + 7 * 1504 });
  assert.equal(tops(p).at(-1) + 1568, 1568 + 7 * 1504);
  // Fewer images a call means fewer, larger-scaled tiles.
  assert.equal(plan(image(1288, 30_000), {}, limits({ imagesPerCall: 3 }), "show").parts.length, 3);
});

test("a photo is fitted, a wide dashboard is fitted and not tiled, a small image goes as it is", () => {
  const photo = plan(image(3024, 4032, 3_000_000), {}, DEFAULT_LIMITS, "show");
  assert.equal(photo.fit.reduction, "downscaled");
  assert.deepEqual(photo.parts.map((p) => [p.derive, p.width, p.height]), [["image", 1500, 2000]]);
  const dashboard = plan(image(3840, 2160), {}, DEFAULT_LIMITS, "show");
  assert.deepEqual(dashboard.parts.map((p) => [p.derive, p.width, p.height]), [["image", 2000, 1125]]);
  const small = plan(image(800, 600, 90_000), {}, DEFAULT_LIMITS, "show");
  assert.equal(small.fit.reduction, "as_is");
  assert.deepEqual(small.parts.map((p) => [p.derive, p.width, p.height]), [["as_is", 800, 600]]);
  assert.deepEqual(small.parts[0].fragment, {}, "the whole source");
  // Within the edges but over the bytes it may take: re-encoded at the same size.
  const heavy = plan(image(1900, 1900, 4_000_000), {}, DEFAULT_LIMITS, "show");
  assert.deepEqual(heavy.parts.map((p) => [p.derive, p.width, p.height, p.maxBytes]), [["image", 1900, 1900, 4 * MiB]]);
  assert.equal(heavy.fit.reduction, "downscaled");
});

test("a region of an image is cut from it, at full resolution when it fits", () => {
  const strip = plan(image(3024, 4032), { region: { x: 10, y: 80, w: 50, h: 10 } }, DEFAULT_LIMITS, "show");
  assert.equal(strip.fit.reduction, "as_is");
  assert.deepEqual(strip.parts.map((part) => [part.derive, part.width, part.height]), [["image", 1513, 404]]);
  assert.deepEqual([strip.parts[0].raster, strip.parts[0].crop], [{ width: 3024, height: 4032 }, { left: 302, top: 3225, width: 1513, height: 404 }]);
  assert.deepEqual(strip.parts[0].fragment, { xywh: { x: 9.986, y: 79.985, w: 50.034, h: 10.02 } });
  const quarter = plan(image(3024, 4032), { region: { x: 50, y: 50, w: 50, h: 50 } }, DEFAULT_LIMITS, "show");
  assert.equal(quarter.fit.reduction, "downscaled");
  assert.deepEqual([quarter.parts[0].raster, quarter.parts[0].crop], [{ width: 3000, height: 4000 }, { left: 1500, top: 2000, width: 1500, height: 2000 }]);
});

test("a region of a page is given the pixels of the whole page, so a closer look sees more", () => {
  const corner = plan(pdf(2), { pages: { from: 2, to: 2 }, region: { x: 50, y: 50, w: 50, h: 50 } }, DEFAULT_LIMITS, "ask");
  assert.deepEqual(corner.parts.map((p) => [p.derive, p.dpi, p.width, p.height]), [["page", 300, 1275, 1650]]);
  assert.deepEqual(corner.parts[0].crop, { left: 1275, top: 1650, width: 1275, height: 1650 });
  assert.deepEqual(corner.parts[0].fragment, { page: { from: 2, to: 2 }, xywh: { x: 50, y: 50, w: 50, h: 50 } });
});

test("a page renders at 150 dpi, or at the highest whole dpi the image limit allows", () => {
  const letter = plan(pdf(1), {}, DEFAULT_LIMITS, "show");
  assert.deepEqual(letter.parts.map((p) => [p.derive, p.dpi, p.width, p.height]), [["page", 150, 1275, 1650]]);
  assert.deepEqual(letter.fit, { reduction: "as_is", original: { pages: 1, bytes: 500_000 }, shown: { pages: 1, dpi: 150 } });
  assert.deepEqual(plan(pdf(1, { size: A4 }), {}, DEFAULT_LIMITS, "show").parts.map((p) => [p.dpi, p.width, p.height]), [[150, 1240, 1754]]);
  // A0: floor(72 * 2000 / 3370) = 42 dpi.
  const a0 = plan(pdf(1, { size: { width: 2384, height: 3370 } }), {}, DEFAULT_LIMITS, "show");
  assert.deepEqual(a0.parts.map((p) => [p.dpi, p.width, p.height]), [[42, 1391, 1966]]);
  assert.equal(a0.fit.reduction, "downscaled");
  assert.equal(PDF_MAX_DPI, 150);
});

test("a scan shows the first pages up to the page budget; a look takes every page, ten a request on a route that takes ten", () => {
  const shown = plan(pdf(37), {}, DEFAULT_LIMITS, "show");
  assert.equal(shown.fit.reduction, "windowed");
  assert.deepEqual(shown.fit.shown, { pages: 4, dpi: 150 });
  assert.deepEqual(shown.parts.map((p) => formatFragment(p.fragment)), ["page=1", "page=2", "page=3", "page=4"]);
  assert.deepEqual(plan(pdf(37), { pages: { from: 30, to: 99 } }, DEFAULT_LIMITS, "show").parts.map((p) => p.fragment.page.from), [30, 31, 32, 33]);
  const twenty = limits({ imagesPerCall: 20 });
  const asked = plan(pdf(37), {}, twenty, "ask");
  assert.equal(asked.parts.length, 37);
  assert.deepEqual(lookRequests(asked, twenty).map((r) => r.length), [10, 10, 10, 7]);
  assert.deepEqual([...new Set(asked.parts.map((p) => p.maxBytes))], [Math.floor(16 * MiB / 10), Math.floor(16 * MiB / 7)], "each image's share of its own request");
  // The default eight images a call bounds a request too.
  assert.deepEqual(lookRequests(plan(pdf(37), {}, DEFAULT_LIMITS, "ask"), DEFAULT_LIMITS).map((r) => r.length), [8, 8, 8, 8, 5]);
  const over = plan(pdf(LOOK_PAGES_PER_CALL + 1), {}, DEFAULT_LIMITS, "ask");
  assert.equal(over.fit.refusal.code, "over_budget");
  assert.match(over.fit.refusal.detail, /201 pages, over the 200/);
  assert.equal(plan(pdf(LOOK_PAGES_PER_CALL + 1), { pages: { from: 2, to: 201 } }, DEFAULT_LIMITS, "ask").parts.length, LOOK_PAGES_PER_CALL);
});

test("pages with a text layer read as text; a page with none, or a read with a question, is rendered", () => {
  const mixed = pdf(30, { textPages: Array.from({ length: 30 }, (_, i) => i + 1).filter((p) => p !== 17) });
  const text = plan(mixed, {}, DEFAULT_LIMITS, "show");
  assert.deepEqual(text.parts, [{ fragment: { page: { from: 1, to: 30 } }, derive: "text" }]);
  assert.deepEqual(text.fit, { reduction: "text_only", original: { pages: 30, bytes: 500_000 }, shown: { pages: 29 } });
  assert.deepEqual(plan(mixed, { pages: { from: 17, to: 17 } }, DEFAULT_LIMITS, "show").parts.map((p) => [p.derive, formatFragment(p.fragment)]), [["page", "page=17"]]);
  assert.deepEqual(plan(mixed, { pages: { from: 3, to: 3 }, render: true }, DEFAULT_LIMITS, "show").parts.map((p) => [p.derive, p.dpi]), [["page", 150]]);
  assert.equal(plan(mixed, { pages: { from: 3, to: 3 } }, DEFAULT_LIMITS, "ask").parts[0].derive, "page", "the eyes always see the page");
});

test("a page past the end, or an impossible region, is a refusal that names the range", () => {
  const past = plan(pdf(37), { pages: { from: 40, to: 40 } }, DEFAULT_LIMITS, "show");
  assert.deepEqual(past, { parts: [], fit: { reduction: "refused", original: { pages: 37, bytes: 500_000 }, refusal: { code: "refused", detail: "page 40 is past the last page, 37" } } });
  for (const region of [{ x: 60, y: 0, w: 50, h: 10 }, { x: 0, y: 0, w: 0, h: 10 }, { x: -1, y: 0, w: 10, h: 10 }]) {
    assert.equal(plan(image(100, 100), { region }, DEFAULT_LIMITS, "show").fit.refusal.code, "refused");
  }
  assert.equal(plan(video(60), { fromS: 60 }, DEFAULT_LIMITS, "show").fit.refusal.code, "refused");
  assert.equal(plan(video(60), { fromS: 30, toS: 20 }, DEFAULT_LIMITS, "show").fit.refusal.code, "refused");
});

test("the floor: nothing is shrunk under 1,200 px on its long edge; a source already smaller goes as it is", () => {
  assert.equal(FLOOR_EDGE, 1200);
  const small = limits({ image: { maxWidth: 1000, maxHeight: 1000 } });
  const photo = plan(image(3024, 4032), {}, small, "show");
  assert.equal(photo.fit.reduction, "refused");
  assert.equal(photo.fit.refusal.code, "over_budget");
  assert.match(photo.fit.refusal.detail, /750x1000, under the 1,200 px floor/);
  assert.equal(plan(pdf(3), {}, small, "show").fit.refusal.code, "over_budget", "a Letter page at 90 dpi would be 765x990");
  assert.deepEqual(plan(image(900, 700), {}, small, "show").parts.map((p) => [p.derive, p.width, p.height]), [["as_is", 900, 700]]);
  // A business card at 150 dpi is 525x300: the page is small, not shrunk.
  assert.deepEqual(plan(pdf(1, { size: { width: 252, height: 144 } }), {}, DEFAULT_LIMITS, "show").parts.map((p) => [p.dpi, p.width, p.height]), [[150, 525, 300]]);
  // Shrinking a 1,100 px image at all would put it under the floor.
  assert.equal(plan(image(1100, 600), {}, limits({ image: { maxWidth: 1000 } }), "show").fit.refusal.code, "over_budget");
});

test("a header over 100 megapixels is refused before anything is decoded", () => {
  const p = plan(image(10_001, 10_000), {}, DEFAULT_LIMITS, "show");
  assert.deepEqual(p.fit.refusal, { code: "over_budget", detail: "10001x10000 is 100,010,000 pixels, over the 100,000,000 decoded" });
  assert.equal(plan(image(10_000, 10_000), {}, DEFAULT_LIMITS, "show").fit.reduction, "downscaled");
});

test("video: eight frames by seek over the window for the lead; one a second for a look, at most 120, twenty a request", () => {
  const whole = plan(video(1800), {}, DEFAULT_LIMITS, "show");
  assert.equal(whole.fit.reduction, "sampled");
  assert.deepEqual(whole.parts.map((p) => p.atS), [112.5, 337.5, 562.5, 787.5, 1012.5, 1237.5, 1462.5, 1687.5]);
  assert.deepEqual(whole.parts.map((p) => formatFragment(p.fragment)).slice(0, 2), ["t=112.5", "t=337.5"]);
  assert.ok(whole.parts.every((p) => p.derive === "frame" && p.width === 640 && p.height === 360 && p.maxBytes === DEFAULT_LIMITS.requestBytes * RESULT_BYTES_SHARE / 8));
  assert.deepEqual(plan(video(1800), { fromS: 60, toS: 68 }, DEFAULT_LIMITS, "show").parts.map((p) => p.atS), [60.5, 61.5, 62.5, 63.5, 64.5, 65.5, 66.5, 67.5]);
  assert.equal(plan(video(1800), { fromS: 60, toS: 68 }, DEFAULT_LIMITS, "ask").parts.length, 8);
  const twenty = limits({ imagesPerCall: 20 });
  const minute = plan(video(60), {}, twenty, "ask");
  assert.equal(minute.parts.length, 60);
  assert.deepEqual(lookRequests(minute, twenty).map((r) => r.length), [20, 20, 20]);
  assert.equal(plan(video(1800), {}, DEFAULT_LIMITS, "ask").parts.length, LOOK_FRAMES_PER_CALL);
  assert.deepEqual(plan(video(1800), { toS: 9000 }, DEFAULT_LIMITS, "show").parts.at(-1).atS, 1687.5, "a window past the end ends at the end");
});

test("a route that takes video gets the file when it fits, else the window; a look maps a long video over windows", () => {
  const native = limits({ video: { native: true, inlineBytes: 12_000_000 } });
  assert.deepEqual(plan(video(60, 3_000_000), {}, native, "show").parts, [{ fragment: {}, derive: "as_is", maxBytes: 16_000_000 }]);
  const window = plan(video(1800), { fromS: 60, toS: 68 }, native, "show");
  assert.deepEqual(window.parts, [{ fragment: { t: { from: 60, to: 68 } }, derive: "clip", maxBytes: 16_000_000 }]);
  assert.equal(window.fit.reduction, "windowed");
  assert.equal(plan(video(1800), {}, native, "show").fit.reduction, "sampled", "too big and no window: frames, never the whole file");
  const look = plan(video(1800, 50_000_000), {}, native, "ask");
  assert.deepEqual(look.parts.map((p) => formatFragment(p.fragment)), ["t=0,360", "t=360,720", "t=720,1080", "t=1080,1440", "t=1440,1800"]);
  assert.deepEqual(lookRequests(look, native).map((r) => r.length), [1, 1, 1, 1, 1]);
});

test("a route that takes few images a message gets requests that hold no more", () => {
  const two = limits({ imagesPerCall: 2 });
  assert.deepEqual(lookRequests(plan(pdf(5), {}, two, "ask"), two).map((r) => r.length), [2, 2, 1]);
  assert.deepEqual(lookRequests(plan(video(10), {}, two, "ask"), two).map((r) => r.length), [2, 2, 2, 2, 2]);
  assert.ok(plan(image(1288, 8319), {}, two, "ask").parts.length <= 2);
});

test("a region of a video is a crop of its frames, also on a route that takes video", () => {
  const native = limits({ video: { native: true, inlineBytes: 12_000_000 } });
  const region = { x: 50, y: 0, w: 50, h: 50 };
  for (const selector of [{ region }, { region, fromS: 10, toS: 18 }]) {
    const p = plan(video(60, 3_000_000), selector, native, "show");
    assert.equal(p.fit.reduction, "sampled");
    assert.deepEqual(p.parts[0].crop, { left: 320, top: 0, width: 320, height: 180 });
    assert.deepEqual(p.parts[0].fragment.xywh, region);
  }
});

test("video sent inline fits the request too: a host's inline budget over the request is held to it", () => {
  const tight = limits({ requestBytes: 3 * MiB, video: { native: true, inlineBytes: 12_000_000 } });
  const small = plan(video(60, 5_000_000), {}, tight, "show");
  assert.notEqual(small.parts[0]?.derive, "as_is", "a 5 MB file does not fit a 3 MiB request");
  const window = plan(video(60, 5_000_000), { fromS: 0, toS: 8 }, tight, "show");
  assert.equal(window.parts[0].derive, "clip");
  assert.ok(window.parts[0].maxBytes <= 3 * MiB);
});

test("a route with no bytes for an image is a refusal, never a part no encoder can make", () => {
  const none = limits({ requestBytes: 0 });
  for (const facts of [image(800, 600), pdf(1), video(60)]) {
    const p = plan(facts, {}, none, "show");
    assert.equal(p.fit.refusal?.code, "over_budget", facts.kind);
    assert.match(p.fit.refusal.detail, /leaves no bytes/);
  }
});

test("a look over a long video on a route that takes video is capped at 120 clips", () => {
  const native = limits({ video: { native: true, inlineBytes: 12_000_000 } });
  const huge = plan(video(3600, 20_000_000_000), {}, native, "ask");
  assert.equal(huge.fit.refusal.code, "over_budget");
  assert.match(huge.fit.refusal.detail, /1667 clips .* over the 120 video parts/);
  assert.equal(plan(video(3600, 20_000_000_000), { fromS: 0, toS: 60 }, native, "ask").parts.length, 28);
});

test("a look over a document of a billion pages is refused without walking its pages", () => {
  const started = performance.now();
  const p = plan({ kind: "pdf", bytes: 1, sha256: "4", pages: 1e9, textPages: [1] }, {}, DEFAULT_LIMITS, "ask");
  assert.equal(p.fit.refusal.code, "over_budget");
  assert.ok(performance.now() - started < 1000);
});

test("a look is priced before its first request and refused over the cap", () => {
  const pages = plan(pdf(37), {}, DEFAULT_LIMITS, "ask");
  assert.deepEqual(priceLook(pages, DEFAULT_LIMITS, 0.1), { parts: 37, requests: 5, tokens: 111_000, usd: 0.0111 });
  const dear = priceLook(plan(pdf(100), {}, DEFAULT_LIMITS, "ask"), DEFAULT_LIMITS, 2);
  assert.equal(dear.usd, 0.6);
  assert.equal(dear.refusal.code, "over_budget");
  assert.match(dear.refusal.detail, /\$0\.6000 .*over the \$0\.25 cap/);
  assert.equal(priceLook(plan(pdf(100), {}, DEFAULT_LIMITS, "ask"), DEFAULT_LIMITS, 2, 1).refusal, undefined, "the host's cap");
  assert.equal(priceLook(pages, DEFAULT_LIMITS, null).usd, null);
});

test("documents and spreadsheets read as text; an unknown kind is unsupported", () => {
  for (const kind of ["office", "sheet", "text"]) {
    assert.deepEqual(plan({ kind, bytes: 10, sha256: "3" }, {}, DEFAULT_LIMITS, "show"), { parts: [{ fragment: {}, derive: "text" }], fit: { reduction: "text_only", original: { bytes: 10 } } });
  }
  assert.equal(plan({ kind: "unknown", bytes: 10, sha256: "3" }, {}, DEFAULT_LIMITS, "show").fit.refusal.code, "unsupported");
  assert.equal(plan({ kind: "image", bytes: 10, sha256: "3" }, {}, DEFAULT_LIMITS, "show").fit.refusal.code, "unreadable");
});

// Property tests.

/** mulberry32: a small seeded generator, so every case replays from its seed. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const int = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];
/** Mostly ordinary values, sometimes extreme ones. */
const edge = (rand, lo, hi) => (rand() < 0.7 ? int(rand, lo, Math.min(hi, lo * 20)) : int(rand, lo, hi));

function randomCase(seed) {
  const rand = rng(seed);
  const limits = {
    image: { maxWidth: edge(rand, 200, 8000), maxHeight: edge(rand, 200, 8000), maxBytes: edge(rand, 50_000, 20_000_000), jpegQuality: 80 },
    imagesPerCall: int(rand, 1, 20), pagesPerRead: int(rand, 1, 10), requestBytes: edge(rand, MiB, 64 * MiB),
    video: { native: rand() < 0.3, inlineBytes: edge(rand, 100_000, 48 * MiB) },
  };
  const kind = pick(rand, ["image", "image", "pdf", "pdf", "video", "office", "unknown"]);
  const facts = { kind, bytes: edge(rand, 1, 400_000_000), sha256: "f".repeat(64) };
  if (kind === "image") Object.assign(facts, { width: edge(rand, 1, 40_000), height: edge(rand, 1, 40_000) });
  if (kind === "pdf") {
    const pages = edge(rand, 1, 400);
    const size = () => ({ width: edge(rand, 30, 15_000), height: edge(rand, 30, 15_000) });
    const one = size();
    Object.assign(facts, { pages, pageSizes: Array.from({ length: pages }, () => (rand() < 0.8 ? one : size())), textPages: Array.from({ length: pages }, (_, i) => i + 1).filter(() => rand() < 0.4) });
  }
  if (kind === "video") Object.assign(facts, { width: edge(rand, 16, 8000), height: edge(rand, 16, 8000), durationS: rand() * pick(rand, [2, 60, 7200]) });
  const selector = {};
  if (rand() < 0.3) { const x = rand() * 90, y = rand() * 90; selector.region = { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), w: Number(Math.max(0.01, rand() * (100 - x)).toFixed(3)), h: Number(Math.max(0.01, rand() * (100 - y)).toFixed(3)) }; }
  if (kind === "pdf" && rand() < 0.5) { const from = int(rand, 1, facts.pages); selector.pages = { from, to: int(rand, from, facts.pages + 5) }; }
  if (kind === "video" && rand() < 0.5) { selector.fromS = rand() * facts.durationS * 0.9; if (rand() < 0.7) selector.toS = selector.fromS + rand() * facts.durationS; }
  if (rand() < 0.3) selector.render = true;
  return { facts, selector, limits, mode: pick(rand, ["show", "ask"]) };
}

const SEED = Number(process.env.PI_VISION_PLAN_SEED ?? 1);
const CASES = process.env.PI_VISION_PLAN_SEED ? 1 : 4000;
const base64 = (raw) => Math.ceil(raw / 3) * 4;

/** Every part's pixels and bytes, every result's count and bytes, every request's: within the limits given. */
function assertWithin({ facts, selector, limits, mode }, p) {
  const images = p.parts.filter((part) => ["image", "tile", "page", "frame"].includes(part.derive));
  for (const part of p.parts) {
    if (part.width !== undefined) {
      assert.ok(part.width >= 1 && part.height >= 1 && part.width <= limits.image.maxWidth && part.height <= limits.image.maxHeight, `part ${part.width}x${part.height} within ${limits.image.maxWidth}x${limits.image.maxHeight}`);
      const crop = part.crop ?? { left: 0, top: 0, width: part.raster.width, height: part.raster.height };
      assert.deepEqual([crop.width, crop.height], [part.width, part.height]);
      assert.ok(crop.left >= 0 && crop.top >= 0 && crop.left + crop.width <= part.raster.width && crop.top + crop.height <= part.raster.height, "the cut is within its raster");
    }
    if (part.derive === "as_is" && facts.kind === "image") assert.ok(base64(facts.bytes) <= part.maxBytes, "a file sent as it is fits its bytes");
    if (part.derive === "clip" || (part.derive === "as_is" && facts.kind === "video")) {
      assert.equal(part.maxBytes, base64(Math.min(limits.video.inlineBytes, Math.floor(limits.requestBytes / 4) * 3)));
      assert.ok(part.maxBytes <= limits.requestBytes, "video inline fits the request");
      assert.ok(!selector.region, "a region is a crop of frames, never a clip");
    }
    if (part.fragment.page && part.dpi !== undefined && !selector.region) assert.ok(part.dpi <= PDF_MAX_DPI, "a page renders at no more than the dpi cap");
    if (Object.keys(part.fragment).length) assert.deepEqual(parseFragment(formatFragment(part.fragment)), part.fragment, "the fragment reads back");
  }
  for (const part of images) assert.ok(part.maxBytes >= 1 && part.maxBytes <= limits.image.maxBytes, "an image's bytes are within one image's limit");
  if (mode === "show") {
    assert.ok(images.length <= limits.imagesPerCall, `${images.length} images in a result, at most ${limits.imagesPerCall}`);
    assert.ok(images.reduce((sum, part) => sum + part.maxBytes, 0) <= limits.requestBytes * RESULT_BYTES_SHARE, "a result's images within its share of the request");
    assert.ok((p.fit.shown?.pages ?? 0) <= limits.pagesPerRead || p.fit.reduction === "text_only");
  } else {
    assert.ok(new Set(p.parts.map((part) => part.fragment.page?.from).filter(Boolean)).size <= LOOK_PAGES_PER_CALL);
    assert.ok(p.parts.filter((part) => part.derive === "frame").length <= LOOK_FRAMES_PER_CALL);
    assert.ok(p.parts.filter((part) => part.derive === "clip").length <= LOOK_FRAMES_PER_CALL);
    for (const request of lookRequests(p, limits)) {
      const shown = request.filter((part) => images.includes(part));
      assert.ok(shown.reduce((sum, part) => sum + part.maxBytes, 0) <= limits.requestBytes, "a request's images within the request");
      assert.ok(shown.length <= limits.imagesPerCall, "a request's images within the route's images a message");
      assert.ok(request.filter((part) => part.derive === "frame").length <= LOOK_FRAMES_PER_REQUEST);
      assert.ok(request.filter((part) => part.derive !== "frame").length <= LOOK_PAGES_PER_REQUEST);
    }
  }
}

/** A part has fewer pixels than its source gives: an image or frame scaled down, a page under the dpi it renders at
 *  unshrunk (the cap; for a region, the dpi that gives it the pixels of the whole page). */
function shrunk({ facts, selector }, part) {
  if (!part.fragment.page) return part.raster.width < facts.width || part.raster.height < facts.height;
  const share = selector.region ? (selector.region.w * selector.region.h) / 10_000 : 1;
  return part.dpi < Math.floor(PDF_MAX_DPI / Math.sqrt(share));
}

test("property: no plan exceeds the limits it was given", () => {
  for (let seed = SEED; seed < SEED + CASES; seed++) {
    const c = randomCase(seed);
    const p = plan(c.facts, c.selector, c.limits, c.mode);
    try {
      if (p.fit.reduction === "refused") {
        assert.deepEqual(p.parts, []);
        assert.ok(MISS_CODES.includes(p.fit.refusal.code) && p.fit.refusal.detail.length > 0);
        continue;
      }
      assertWithin(c, p);
      assert.deepEqual(plan(c.facts, c.selector, c.limits, c.mode), p, "the same inputs make the same plan");
    } catch (error) {
      error.message = `seed ${seed}: ${error.message}\n${JSON.stringify(c)}`;
      throw error;
    }
  }
});

test("property: below the floor is always a refusal", () => {
  let refusedForFloor = 0;
  for (let seed = SEED; seed < SEED + CASES; seed++) {
    const c = randomCase(seed);
    const p = plan(c.facts, c.selector, c.limits, c.mode);
    if (/under the 1,200 px floor/.test(p.fit.refusal?.detail ?? "")) refusedForFloor++;
    for (const part of p.parts) {
      if (!part.raster || !["image", "tile", "page", "frame"].includes(part.derive)) continue;
      if (shrunk(c, part)) {
        assert.ok(Math.max(part.width, part.height) >= FLOOR_EDGE, `seed ${seed}: a shrunk part of ${part.width}x${part.height} is under the floor\n${JSON.stringify(c)}`);
      }
    }
  }
  if (CASES > 1) assert.ok(refusedForFloor > 20, `the cases reach the floor (${refusedForFloor} refusals)`);
});

test("property: tiles cover the whole picture, overlapping by at least 64 px, in reading order", () => {
  let tiled = 0;
  for (let seed = SEED; seed < SEED + CASES; seed++) {
    const c = randomCase(seed);
    const p = plan(c.facts, c.selector, c.limits, c.mode);
    const groups = Map.groupBy(p.parts.filter((part) => part.derive === "tile"), (part) => part.fragment.page?.from ?? 0);
    for (const tiles of groups.values()) {
      tiled++;
      const { raster } = tiles[0];
      const vertical = tiles.every((t) => t.crop.left === tiles[0].crop.left && t.crop.width === tiles[0].crop.width);
      const [start, length, across, acrossLength] = vertical ? ["top", "height", "left", "width"] : ["left", "width", "top", "height"];
      const message = `seed ${seed}\n${JSON.stringify(c)}`;
      assert.ok(tiles.length > 1 && tiles.length <= (c.mode === "show" ? c.limits.imagesPerCall : Math.min(c.limits.imagesPerCall, LOOK_PAGES_PER_REQUEST)), message);
      assert.ok(tiles.every((t) => t.crop[across] === tiles[0].crop[across] && t.crop[acrossLength] === tiles[0].crop[acrossLength]), message);
      if (!c.selector.region) {
        assert.equal(tiles[0].crop[start], 0, message);
        assert.equal(tiles.at(-1).crop[start] + tiles.at(-1).crop[length], vertical ? raster.height : raster.width, message);
        assert.equal(tiles[0].crop[acrossLength], vertical ? raster.width : raster.height, message);
      }
      for (let i = 1; i < tiles.length; i++) {
        assert.ok(tiles[i].crop[start] > tiles[i - 1].crop[start], message);
        assert.ok(tiles[i].crop[start] <= tiles[i - 1].crop[start] + tiles[i - 1].crop[length] - TILE_OVERLAP, message);
      }
    }
  }
  if (CASES > 1) assert.ok(tiled > 50, `the cases reach tiling (${tiled} tiled pictures)`);
});
