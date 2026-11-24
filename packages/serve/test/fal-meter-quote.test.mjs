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
  assert.match(quote.basis, /0\.168/, "and the model page's rate it was held at");
});

test("a tiered job at the rate the tiers were decided at is held at get_pricing's rate times its ratio, as before", async () => {
  const { falMeter } = await load();
  const quote = await falMeter().quote("submit_job", klingJob, pricing(0.14).ask, signal);
  near(quote.holdUsd, 0.84, "$0.14 × 1.2 × 5");
  near(quote.chargeOf(completed), 0.84, "booked the same");
});

test("a tiered job is held at get_pricing's rate times its ratio when that is more than the model page's rate", async () => {
  const { falMeter } = await load();
  // fal raises Kling v3 pro to $0.16: the scaled rate, $0.192 a second, is the higher one.
  const quote = await falMeter().quote("submit_job", klingJob, pricing(0.16).ask, signal);
  near(quote.holdUsd, 0.96, "$0.16 × 1.2 × 5");
  near(quote.chargeOf(completed), 0.96, "booked the same");
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
