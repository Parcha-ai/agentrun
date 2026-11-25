import assert from "node:assert/strict";
import test from "node:test";

// The fal meter's quote and settle, driven through its `ask` (the gateway's call to fal's own tools): what a job is held
// at before it is sent and what it is booked at after. fal's get_pricing is faked here; the rates are fal's model pages'.
const load = () => import("../dist/fal-price.js");
const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

const KLING_PRO = "fal-ai/kling-video/v3/pro/image-to-video";
/** A Kling v3 pro job of 5 seconds with its default audio on: fal's model page bills it $0.168 a second. */
const klingJob = { endpoint_id: KLING_PRO, input: { prompt: "a lighthouse at dusk", start_image_url: "https://v3.fal.media/files/x/still.png", duration: "5" } };
/** fal's reply to a job that completed a 5 second video. */
const completed = { structuredContent: { status: "completed", request_id: "req-1", submission_replayed: false, endpoint_id: KLING_PRO, result: { video: { url: "https://v3.fal.media/files/x/clip.mp4", duration: 5 } } } };
const accepted = { structuredContent: { status: "queued", request_id: "req-2", submission_replayed: false, endpoint_id: KLING_PRO } };

/** An `ask` whose get_pricing states `unitPrice` a second for every endpoint asked, after `answers` (in order) if given:
 *  "error" answers an MCP error, "none" no answer. It counts the get_pricing calls it is asked. */
function pricing(unitPrice, { answers = [], unit = "seconds", delayMs = 0 } = {}) {
  const asked = [];
  const queue = [...answers];
  const ask = async (tool, args) => {
    assert.equal(tool, "get_pricing");
    asked.push(args.endpoint_id);
    if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
    const next = queue.shift();
    if (next === "error") return { isError: true, content: [{ type: "text", text: "upstream error" }] };
    if (next === "none") return undefined;
    return { structuredContent: { prices: [{ endpoint_id: args.endpoint_id, unit, unit_price: unitPrice, currency: "USD" }] } };
  };
  return { ask, asked };
}

const signal = new AbortController().signal;

test("a tiered job is held and booked at its tier's rate on fal's model page when get_pricing states less than the rate the tiers were decided at", async () => {
  const { falMeter } = await load();
  // fal corrects Kling v3 pro from $0.14 to $0.112 a second on get_pricing, its model page still billing audio on at $0.168.
  const { ask } = pricing(0.112);
  const quote = await falMeter().quote("submit_job", klingJob, ask, signal);
  assert.equal(quote.unpriceable, undefined);
  near(quote.holdUsd, 0.84, "held at $0.168 a second for 5 seconds, not $0.112 × 1.2 = $0.1344");
  near(quote.chargeOf(completed), 0.84, "booked at the rate it was held at");
  near(quote.chargeOf(undefined), 0.84, "a lost reply is booked at its hold");
  assert.match(quote.basis, /\$0\.112/, "the basis gives get_pricing's rate");
  assert.match(quote.basis, /get_pricing states \$0\.112, not the \$0\.14 its rates were decided at: held at the model page's \$0\.168 per second/, "and says it was held at the model page's rate, not get_pricing's");
});

test("a tiered job at the rate the tiers were decided at is held at get_pricing's rate times its ratio, as before", async () => {
  const { falMeter } = await load();
  const quote = await falMeter().quote("submit_job", klingJob, pricing(0.14).ask, signal);
  near(quote.holdUsd, 0.84, "$0.14 × 1.2 × 5");
  near(quote.chargeOf(completed), 0.84, "booked the same");
  assert.doesNotMatch(quote.basis, /its rates were decided at/, "nothing moved, so the basis says nothing about it");
});

test("a tiered job is held at get_pricing's rate times its ratio when that is more than the model page's rate", async () => {
  const { falMeter } = await load();
  // fal raises Kling v3 pro to $0.16: the scaled rate, $0.192 a second, is the higher one.
  const quote = await falMeter().quote("submit_job", klingJob, pricing(0.16).ask, signal);
  near(quote.holdUsd, 0.96, "$0.16 × 1.2 × 5");
  near(quote.chargeOf(completed), 0.96, "booked the same");
  assert.doesNotMatch(quote.basis, /its rates were decided at/, "held at get_pricing's own rate scaled, so the basis says nothing about the page");
});

test("a tiered job whose get_pricing states another unit than its rates were decided in can't be priced: nothing held, an accepted one booked as unknown, its media never read", async () => {
  const { falMeter } = await load();
  // fal starts stating sync-lipsync v2 per second ($0.05, its $3 a minute) and Nano Banana 2 per megapixel: neither the
  // ratio nor the model page's rate (per minute, per image) holds in the new unit.
  for (const [endpoint, unit, input, now, was] of [
    ["fal-ai/sync-lipsync/v2", "seconds", { video_url: "https://v3.fal.media/files/x/clip.mp4", audio_url: "https://v3.fal.media/files/x/voice.mp3" }, "second", "minute"],
    // Before, this one was held at $2.72: 17 megapixels at the page's $0.16 an image.
    ["fal-ai/nano-banana-2", "megapixels", { prompt: "a lighthouse", resolution: "4K", image_size: { width: 4096, height: 4096 } }, "megapixel", "image"],
  ]) {
    const read = [];
    const meter = falMeter({ media: async (url) => { read.push(url); throw new Error("no media in this test"); } });
    const quote = await meter.quote("submit_job", { endpoint_id: endpoint, input }, pricing(0.05, { unit }).ask, signal);
    assert.equal(quote.unpriceable, `get_pricing states ${endpoint} per ${now}, and its rates were decided per ${was}`, `${endpoint}: refused under a cap`);
    assert.equal(quote.holdUsd, 0, `${endpoint}: nothing held`);
    assert.equal(quote.chargeOf({ structuredContent: { status: "queued", request_id: "req-3", submission_replayed: false, endpoint_id: endpoint } }), null, `${endpoint}: an accepted job is an unknown charge`);
    assert.deepEqual(read, [], `${endpoint}: no media read for a job that can't be priced`);
  }
});

test("a price of $0 on get_pricing is no price: the job can't be priced, and an accepted one is booked as unknown, never $0", async () => {
  const { falMeter } = await load();
  for (const endpoint of [KLING_PRO, "fal-ai/flux/schnell"]) {
    const job = endpoint === KLING_PRO ? klingJob : { endpoint_id: endpoint, input: { prompt: "a lighthouse" } };
    const quote = await falMeter().quote("submit_job", job, pricing(0, { unit: endpoint === KLING_PRO ? "seconds" : "images" }).ask, signal);
    assert.match(quote.unpriceable ?? "", /\$0/, `${endpoint}: refused under a cap, saying get_pricing stated $0`);
    assert.equal(quote.holdUsd, 0, `${endpoint}: nothing held`);
    assert.equal(quote.chargeOf(accepted), null, `${endpoint}: an accepted job is an unknown charge`);
  }
});

test("jobs on one endpoint quoted at once read its price once: one get_pricing call, every job priced", async () => {
  const { falMeter } = await load();
  const meter = falMeter();
  const { ask, asked } = pricing(0.14, { delayMs: 30 });
  const quotes = await Promise.all([1, 2, 3, 4].map(() => meter.quote("submit_job", klingJob, ask, signal)));
  assert.deepEqual(asked, [KLING_PRO], "one read for the four");
  for (const quote of quotes) near(quote.holdUsd, 0.84, "each priced");
});

test("an error from get_pricing is asked once more before the job is called unpriceable; a second error is", async () => {
  const { falMeter } = await load();
  const once = pricing(0.14, { answers: ["error"] });
  const quote = await falMeter().quote("submit_job", klingJob, once.ask, signal);
  assert.deepEqual(once.asked, [KLING_PRO, KLING_PRO], "asked again after the error");
  near(quote.holdUsd, 0.84, "priced from the second answer");

  const meter = falMeter();
  const twice = pricing(0.14, { answers: ["error", "error"] });
  const refused = await meter.quote("submit_job", klingJob, twice.ask, signal);
  assert.equal(twice.asked.length, 2, "two asks, no more");
  assert.match(refused.unpriceable ?? "", /answered an error/);
  // The same meter's next job asks again: an error is never kept as the price.
  const again = pricing(0.14);
  const later = await meter.quote("submit_job", klingJob, again.ask, signal);
  assert.deepEqual(again.asked, [KLING_PRO], "read again");
  near(later.holdUsd, 0.84, "priced");
});

/** An `ask` as the gateway gives a call whose signal is `stop`: get_pricing waits, and once that call stops (its deadline,
 *  its run's abort) it answers nothing, as the gateway does when it catches the abort. */
function stopping(stop) {
  const asked = [];
  const ask = async (tool, args) => {
    asked.push(args.endpoint_id);
    await new Promise((done) => (stop.signal.aborted ? done() : stop.signal.addEventListener("abort", done, { once: true })));
    return undefined;
  };
  return { ask, asked };
}

test("a job whose own call is live is priced when the call that read the price for both stops before fal answers", async () => {
  const { falMeter } = await load();
  const meter = falMeter();
  const first = new AbortController();
  const stopped = stopping(first);
  const live = pricing(0.14);
  const firstQuote = meter.quote("submit_job", klingJob, stopped.ask, first.signal);
  const liveQuote = meter.quote("submit_job", klingJob, live.ask, new AbortController().signal);
  await new Promise((done) => setTimeout(done, 10));
  first.abort();
  const [gone, priced] = await Promise.all([firstQuote, liveQuote]);
  assert.ok(gone.unpriceable, "the stopped call has no price");
  assert.equal(priced.unpriceable, undefined, `the live call is priced, not refused: ${priced.unpriceable}`);
  near(priced.holdUsd, 0.84, "priced from its own read");
  assert.deepEqual(live.asked, [KLING_PRO], "the live call read the price once, with its own ask");
});

test("a price read that failed while its call was live is not asked again by the jobs that shared it", async () => {
  const { falMeter } = await load();
  const meter = falMeter();
  const { ask, asked } = pricing(0.14, { answers: ["error", "error"], delayMs: 20 });
  const quotes = await Promise.all([1, 2, 3].map(() => meter.quote("submit_job", klingJob, ask, signal)));
  assert.equal(asked.length, 2, "one read and its one retry for the three");
  for (const quote of quotes) assert.match(quote.unpriceable ?? "", /answered an error/);
});
