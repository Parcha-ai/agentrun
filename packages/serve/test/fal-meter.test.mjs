// fal's jobs are counted like any priced tool call (mcp-gateway.ts sent, fal-price.ts): a job of a fal MCP server is held
// on the run's one ledger at fal's unit price (the server's own get_pricing) times the job's billed units before it is
// sent, refused unsent when the cap can't take it, and settled at what its reply says of it. A fake MCP server stands in
// for fal's, with fal's tool names, its get_pricing answers for these endpoints (read 2026-11-20) and its reply shapes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { mcpGateway, mcpPinOf } from "../dist/mcp-gateway.js";
import { bookedIn } from "../dist/paid-calls.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { SAMPLES } from "./fixtures/media-samples.mjs";

const cap = await import("../../run-adapters/dist/kernel/cap/index.js");
const { sessionSpendOf } = await import("../../run-adapters/dist/runner.js");
const TOKEN = "mcp-token";
const T0 = Date.parse("2026-11-20T12:00:00Z");
const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

/** fal's get_pricing answers, by endpoint: [unit_price, unit]. */
const PRICES = {
  "fal-ai/ideogram/v3": [0.03, "images"],
  "fal-ai/flux/schnell": [0.003, "megapixels"],
  "fal-ai/elevenlabs/tts/eleven-v3": [0.1, "1000 characters"],
  "fal-ai/kling-video/v2.5-turbo/pro/text-to-video": [0.07, "seconds"],
  "fal-ai/latentsync": [0.005, "seconds"],
  "fal-ai/sync-lipsync/v2": [3, "minutes"],
  "fal-ai/elevenlabs/speech-to-text": [0.03, "minutes"],
  "fal-ai/whisper": [0.001111111, "compute seconds"],
  "fal-ai/elevenlabs/dubbing": [0.6, "minutes"],
  "veed/fabric-1.0": [0.08, "seconds"],
};
const KLING = "fal-ai/kling-video/v2.5-turbo/pro/text-to-video";
const TTS = "fal-ai/elevenlabs/tts/eleven-v3";

/** A run_model reply as fal's reads: `status`, the job's handles, and its result when completed. */
const reply = (args, { status = "completed", result, replayed = false } = {}) => ({
  content: [{ type: "text", text: JSON.stringify({ status, ...(args.submission_key ? { submission_key: args.submission_key } : {}), submission_replayed: replayed, submission_journal_status: "confirmed", endpoint_id: args.endpoint_id, request_id: "01a1fa6e-6585-7862-9e90-77c1ea3097af", status_url: "https://queue.fal.run/x/requests/1/status", response_url: "https://queue.fal.run/x/requests/1", ...(result ? { result, has_result: true } : {}) }) }],
});

/** A fake fal server, a gateway pinned to it and the run's ledger. `capUsd`: the run's cap (null: none). `entry`:
 *  what the pin holds of the server beside its URL and tools. `run`: what a job answers. `pricing`: what get_pricing
 *  answers (a function of its arguments), by default PRICES. `gate`: the fake's own (a transport failure). */
async function setup(t, { capUsd = 1, entry = { meter: "fal" }, run, pricing, gate, media, now = () => T0, url, ledger = true } = {}) {
  const fake = await startFakeMcp({ token: TOKEN, ...(gate ? { gate } : {}) });
  t.after(() => fake.close());
  const asked = { pricing: [], jobs: [], media: [] };
  // get_pricing takes exactly { endpoint_id }: the fake refuses any other argument, as an eval's fake matches by equality.
  fake.tools.get_pricing = {
    description: "fal's price for an endpoint.", input: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false },
    run: (args) => {
      asked.pricing.push(args);
      if (pricing) return pricing(args);
      const price = PRICES[args.endpoint_id];
      return { content: [{ type: "text", text: JSON.stringify(price ? { prices: [{ endpoint_id: args.endpoint_id, unit_price: price[0], unit: price[1], currency: "USD" }], next_cursor: null, has_more: false } : { status: "not_found", endpoint_id: args.endpoint_id, suggestions: [] }) }] };
    },
  };
  for (const tool of ["run_model", "submit_job", "submit_jobs", "get_model_schema"]) {
    fake.tools[tool] = { description: tool, input: { type: "object", properties: {} }, run: (args) => (asked.jobs.push({ tool, args }), run ? run(args, tool) : reply(args)) };
  }
  const work = await mkdtemp(join(tmpdir(), "fal-meter-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const store = memorySessionStore();
  const tools = await cap.runCap({ sessions: store, capUsd: () => capUsd ?? undefined, now: () => T0, modelOf: () => undefined }).tools(await store.open(cap.TOOL_SESSION));
  const admits = [];
  const paid = { admit: (request) => (admits.push(request), tools.admit(request)), settle: (id, usd, options) => tools.settle(id, usd, options) };
  const root = [];
  const pinned = url ?? fake.url;
  const gateway = mcpGateway({
    pin: { fal: { url: pinned, tools: ["run_model", "submit_job", "submit_jobs", "get_model_schema"].map((name) => ({ name, inputSchema: { type: "object" } })), ...entry } },
    credentials: { fal: { url: pinned, headers: { authorization: `Bearer ${TOKEN}` } } },
    work: () => work,
    commit: () => async (change) => change({ appendEntry: async (_conversation, value) => void root.push(value) }),
    capped: () => capUsd !== null,
    now,
    // A pin at fal's own address is sent to the fake.
    ...(url ? { fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace(url, fake.url), init) } : {}),
    media: async (at) => {
      asked.media.push(at);
      if (!media || !(at in media)) throw new Error("the host answered 404");
      return media[at];
    },
  });
  let calls = 0;
  const call = (tool, args) => {
    const callId = `c${(calls += 1)}`;
    const send = () => gateway.call("fal", tool, args, { signal: new AbortController().signal, callId });
    return ledger ? bookedIn({ call: callId, paid }, send) : send();
  };
  const records = async () => store.read(cap.TOOL_SESSION);
  const turns = async () => (await records()).filter((r) => r.kind === "runner.turn").map((r) => r.data.usd ?? null);
  const received = (tool) => fake.log.filter((one) => one.method === "tools/call" && one.tool === tool).length;
  return { fake, call, asked, admits, root, records, turns, received, spent: () => tools.spentUsd(), cost: async () => sessionSpendOf(await records()).cost };
}
const textOf = (result) => result.content.map((block) => block.text).join("");

test("a fal image job is held before it is sent and booked at fal's price per image times its images", async (t) => {
  const run = await setup(t);
  const result = await run.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "a share card", image_size: "landscape_16_9", num_images: 2 }, submission_key: "card-1" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(JSON.parse(textOf(result)).status, "completed", "the model reads fal's reply");
  near(run.spent(), 0.06, "$0.03 an image, 2 images");
  assert.deepEqual(run.asked.pricing, [{ endpoint_id: "fal-ai/ideogram/v3" }], "get_pricing was asked for the job's endpoint, with exactly that argument");
  assert.equal(run.admits.length, 1, "one paid step: the price's read is not booked");
  const [held] = run.admits;
  assert.deepEqual({ name: held.name, holdUsd: held.holdUsd, call: held.call, chargedBy: held.chargedBy }, { name: "mcp:fal/run_model", holdUsd: 0.06, call: "c1", chargedBy: "fal" });
  assert.equal(held.basis, "fal's price for fal-ai/ideogram/v3: $0.03 per image × 2 (num_images), from get_pricing at 2026-11-20T12:00:00.000Z");
  const requests = (await run.records()).filter((r) => r.kind === "runner.request").map((r) => r.data);
  assert.deepEqual(requests.map(({ model, heldUsd, call, charged_by }) => ({ model, heldUsd, call, charged_by })), [{ model: "paid:mcp:fal/run_model", heldUsd: 0.06, call: "c1", charged_by: "fal" }], "its record names its call and who charged");
  assert.deepEqual(run.root, [], "a counted job is not marked not metered, and the price's read leaves no record");
});

test("a job that returns fewer images than it asked for is booked at the images it returned", async (t) => {
  const run = await setup(t, { run: (args) => reply(args, { result: { images: [{ url: "https://v3.fal.media/1.png" }, { url: "https://v3.fal.media/2.png" }, { url: "https://v3.fal.media/3.png" }] } }) });
  await run.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 4 } });
  near(run.admits[0].holdUsd, 0.12, "held at 4 images");
  near(run.spent(), 0.09, "booked at the 3 it returned");
});

test("flux/schnell is booked per megapixel, each image rounded up to a whole one", async (t) => {
  const run = await setup(t, { run: (args) => reply(args, { result: { images: Array.from({ length: args.input.num_images ?? 1 }, () => ({ url: "https://v3.fal.media/i.jpg", ...(args.input.image_size === "square_hd" ? { width: 1024, height: 1024 } : { width: 1024, height: 768 }), content_type: "image/jpeg" })) } }) });
  await run.call("run_model", { endpoint_id: "fal-ai/flux/schnell", input: { prompt: "a lighthouse", image_size: "landscape_4_3", num_images: 1 } });
  near(run.spent(), 0.003, "1024x768: 1 megapixel at $0.003");
  assert.equal(run.admits[0].basis, "fal's price for fal-ai/flux/schnell: $0.003 per megapixel × 1 (image_size landscape_4_3, 1 image), from get_pricing at 2026-11-20T12:00:00.000Z");
  await run.call("run_model", { endpoint_id: "fal-ai/flux/schnell", input: { prompt: "a lighthouse", image_size: "square_hd", num_images: 2 } });
  near(run.admits[1].holdUsd, 0.012, "1024x1024 is 2 megapixels each, 2 images");
  near(run.spent(), 0.003 + 0.012, "both jobs");
});

test("a voiceover is booked per 1000 characters of its text", async (t) => {
  const run = await setup(t, { run: (args) => reply(args, { result: { audio: { url: "https://v3.fal.media/o.mp3", content_type: "audio/mpeg", file_size: 367848 }, timestamps: null } }) });
  await run.call("run_model", { endpoint_id: TTS, input: { text: "a".repeat(1500), voice: "Aria", stability: 0.4 } });
  near(run.spent(), 0.15, "1500 characters at $0.10 per 1000");
  assert.equal(run.admits[0].basis, `fal's price for ${TTS}: $0.1 per 1000 characters × 1.5 (the 1500 characters of its text), from get_pricing at 2026-11-20T12:00:00.000Z`);
});

test("a video job is held at its input's duration; still processing, it is booked at that hold", async (t) => {
  const run = await setup(t, { run: (args) => reply(args, { status: "processing" }) });
  for (const tool of ["run_model", "submit_job"]) await run.call(tool, { endpoint_id: KLING, input: { prompt: "a wave", duration: "5" } });
  assert.deepEqual(run.admits.map((one) => one.holdUsd), [0.35, 0.35], "5 s at $0.07 a second, each");
  assert.deepEqual(await run.turns(), [0.35, 0.35], "booked at the hold: fal's reply states no units");
});

test("a job whose hold passes the run's cap is refused before it is submitted", async (t) => {
  const run = await setup(t, { capUsd: 0.2 });
  const result = await run.call("run_model", { endpoint_id: KLING, input: { prompt: "a wave", duration: "5" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^spend_cap_reached: Not sent: this run has spent \$0 of its \$0\.20 cap, and the next step, mcp:fal\/run_model, could cost up to \$0\.35 \(fal's price for fal-ai\/kling-video\/v2\.5-turbo\/pro\/text-to-video: \$0\.07 per second × 5 \(duration\), from get_pricing at 2026-11-20T12:00:00\.000Z\)/);
  assert.equal(run.received("run_model"), 0, "fal never received the job");
  assert.equal(run.received("get_pricing"), 1, "only its price was read");
  near(run.spent(), 0, "nothing booked");
  assert.deepEqual(await run.records(), [], "no step");
});

test("a replayed submission is booked $0: the job was booked when it was first sent", async (t) => {
  const seen = new Set();
  const run = await setup(t, { run: (args) => { const replayed = seen.has(args.submission_key); seen.add(args.submission_key); return reply(args, { replayed, result: { images: [{ url: "https://v3.fal.media/1.png" }] } }); } });
  const job = { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 1 }, submission_key: "card-go122-1" };
  await run.call("run_model", job);
  await run.call("run_model", job);
  assert.equal(run.received("run_model"), 2, "both calls reached fal");
  assert.deepEqual(await run.turns(), [0.03, 0], "the first at its price, the replay at $0");
  near(run.spent(), 0.03, "one job");
});

test("a reply that carries no job was never billed: booked $0; a job that failed after it was accepted is booked at its hold", async (t) => {
  // fal validates the input before any charge: its refusal is an error with no request_id.
  const refused = await setup(t, { run: () => ({ content: [{ type: "text", text: JSON.stringify({ status: "error", error: { type: "validation_error", message: "Input validation failed", field_errors: [{ field: "image_size", message: "expected one of square_hd, square" }] } }) }], isError: true }) });
  const result = await refused.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", image_size: "poster", num_images: 1 } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /validation_error/, "the model reads fal's refusal");
  assert.equal(refused.received("run_model"), 1, "it reached fal");
  assert.deepEqual(await refused.turns(), [0], "booked $0");
  // An error that names the job it accepted: fal may have billed it.
  const failed = await setup(t, { run: (args) => ({ ...reply(args, { status: "failed" }), isError: true }) });
  await failed.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 1 } });
  assert.deepEqual(await failed.turns(), [0.03], "booked at its hold");
  // An error in words alone says nothing a program can read: at its hold, never $0.
  const prose = await setup(t, { run: () => ({ content: [{ type: "text", text: "Something went wrong." }], isError: true }) });
  await prose.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 1 } });
  assert.deepEqual(await prose.turns(), [0.03], "booked at its hold");
  // A structured error with no request_id that is not a refusal of the input (a timeout after the request left): the
  // job may exist, so at its hold, never $0.
  const timedOut = await setup(t, { run: () => ({ content: [{ type: "text", text: JSON.stringify({ status: "error", error: { type: "upstream_timeout", message: "the queue closed before its reply arrived" } }) }], isError: true }) });
  await timedOut.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 1 } });
  assert.deepEqual(await timedOut.turns(), [0.03], "a timeout is booked at its hold");
});

test("a reply lost after the job left is booked at its hold, the price it was sent at; unknown only for a job that had none", async (t) => {
  const lost = (_url, message) => (message?.method === "tools/call" && message.params?.name === "run_model" ? { status: 500, body: { error: "upstream" } } : undefined);
  const run = await setup(t, { gate: lost });
  const result = await run.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 1 } });
  assert.equal(result.isError, true);
  assert.deepEqual(await run.turns(), [0.03], "$0.03 an image, 1 image: its hold, never $0");
  const cost = await run.cost();
  assert.equal(cost.usd, 0.03, `the run's tool cost is the hold: ${JSON.stringify(cost)}`);

  const open = await setup(t, { capUsd: null, gate: lost });
  const unpriced = await open.call("run_model", { endpoint_id: "fal-ai/whisper", input: { audio_url: "https://media.example/a.mp3" } });
  assert.equal(unpriced.isError, true);
  assert.deepEqual(await open.turns(), [null], "no price to settle at: unknown, never $0");
  assert.equal((await open.cost()).usd, null);
});

test("a unit that can't be known before the job runs: refused unsent under a cap, in words; with no cap it runs, booked as an unknown charge", async (t) => {
  const job = { endpoint_id: "fal-ai/whisper", input: { audio_url: "https://media.example/a.mp3" } };
  const capped = await setup(t);
  const refused = await capped.call("run_model", job);
  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), "mcp:fal/run_model was not sent: fal bills fal-ai/whisper per compute second, which can't be known before the job runs, so a run with a spend cap can't send it. Nothing was sent.");
  assert.equal(capped.received("run_model"), 0, "fal never received the job");
  assert.deepEqual(await capped.records(), [], "nothing booked");

  const open = await setup(t, { capUsd: null, run: (args) => reply(args, { result: { text: "hello" } }) });
  const result = await open.call("run_model", job);
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(open.received("run_model"), 1, "with no cap it runs");
  assert.deepEqual(await open.turns(), [null], "an unknown charge, never $0");
  assert.equal((await open.cost()).usd, null, "the run's tool cost reads unknown");
  assert.deepEqual(open.root, [], "never marked not metered: fal bills it");
});

test("a price that can't be read makes the job unpriceable: get_pricing failing, or listing no price for the endpoint", async (t) => {
  const failing = await setup(t, { pricing: () => ({ content: [{ type: "text", text: "rate limited" }], isError: true }) });
  const refused = await failing.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x" } });
  assert.equal(textOf(refused), "mcp:fal/run_model was not sent: fal's price for fal-ai/ideogram/v3 could not be read (its get_pricing answered an error), so a run with a spend cap can't send it. Nothing was sent.");
  assert.equal(failing.received("run_model"), 0);

  const unlisted = await setup(t);
  const unknown = await unlisted.call("run_model", { endpoint_id: "fal-ai/not-a-model", input: { prompt: "x" } });
  assert.equal(textOf(unknown), "mcp:fal/run_model was not sent: fal's price for fal-ai/not-a-model could not be read (its get_pricing lists no USD price for it), so a run with a spend cap can't send it. Nothing was sent.");
  assert.equal(unlisted.received("run_model"), 0);

  const noEndpoint = await setup(t);
  assert.match(textOf(await noEndpoint.call("run_model", { input: { prompt: "x" } })), /^mcp:fal\/run_model was not sent: this job names no endpoint_id to price/);
  assert.equal(noEndpoint.received("get_pricing"), 0);

  const open = await setup(t, { capUsd: null, pricing: () => ({ content: [{ type: "text", text: "rate limited" }], isError: true }) });
  await open.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x" } });
  assert.equal(open.received("run_model"), 1, "with no cap it runs");
  assert.deepEqual(await open.turns(), [null], "an unknown charge");
});

test("a job billed by the media it is given is priced from that media's length, read before the call: the longest", async (t) => {
  const media = { "https://media.example/clip.mp4": SAMPLES.mp4.bytes, "https://media.example/voice.mp3": SAMPLES.mp3Info.bytes, "https://media.example/voice.wav": SAMPLES.wav.bytes, "https://media.example/page.html": new TextEncoder().encode("<html></html>") };
  const run = await setup(t, { media, run: (args) => reply(args, { result: { video: { url: "https://v3.fal.media/o.mp4" } } }) });
  await run.call("run_model", { endpoint_id: "fal-ai/sync-lipsync/v2", input: { video_url: "https://media.example/clip.mp4", audio_url: "https://media.example/voice.mp3" } });
  assert.deepEqual(run.asked.media.sort(), ["https://media.example/clip.mp4", "https://media.example/voice.mp3"], "each was read");
  near(run.spent(), (4 / 60) * 3, "the 4 s clip, longer than the 3.1 s voice, at $3 a minute");
  assert.equal(run.admits[0].basis, "fal's price for fal-ai/sync-lipsync/v2: $3 per minute × 0.066667 (the longest of its input media, read before the call), from get_pricing at 2026-11-20T12:00:00.000Z");
  await run.call("run_model", { endpoint_id: "fal-ai/elevenlabs/speech-to-text", input: { audio_url: "https://media.example/voice.wav" } });
  near(run.admits[1].holdUsd, (2 / 60) * 0.03, "2 s at $0.03 a minute");

  // Media whose length can't be read (not media, or not there): the job is unpriceable.
  for (const audio_url of ["https://media.example/page.html", "https://media.example/gone.mp3"]) {
    const before = run.received("run_model");
    const refused = await run.call("run_model", { endpoint_id: "fal-ai/sync-lipsync/v2", input: { video_url: "https://media.example/clip.mp4", audio_url } });
    assert.equal(textOf(refused), `mcp:fal/run_model was not sent: fal bills fal-ai/sync-lipsync/v2 per minute of its input media, and the length of ${audio_url} could not be read, so a run with a spend cap can't send it. Nothing was sent.`);
    assert.equal(run.received("run_model"), before, "never sent");
  }
});

test("only an endpoint fal bills by the length of the media it is given is priced from that length; another billed per second whose input names none is unpriceable", async (t) => {
  const media = { "https://media.example/clip.mp4": SAMPLES.mp4.bytes, "https://media.example/voice.mp3": SAMPLES.mp3Info.bytes };
  const dub = await setup(t, { media, run: (args) => reply(args, { status: "processing" }) });
  await dub.call("submit_job", { endpoint_id: "fal-ai/elevenlabs/dubbing", input: { video_url: "https://media.example/clip.mp4", target_lang: "es" } });
  near(dub.admits[0].holdUsd, (4 / 60) * 0.6, "dubbing: the 4 s clip at $0.60 a minute");
  // veed/fabric-1.0 makes a talking video from a picture and a voice: fal bills it per second of its output.
  const job = { endpoint_id: "veed/fabric-1.0", input: { image_url: "https://media.example/face.png", audio_url: "https://media.example/voice.mp3", resolution: "480p" } };
  const capped = await setup(t, { media });
  const refused = await capped.call("run_model", job);
  assert.match(textOf(refused), /^mcp:fal\/run_model was not sent: fal bills veed\/fabric-1\.0 per second, and this job's input names no length/);
  assert.equal(capped.received("run_model"), 0, "never sent under a cap");
  assert.deepEqual(capped.asked.media, [], "its media were never read");
  // LatentSync bills per second of its output video, with a minimum up to 40 s that get_pricing does not state.
  const lipsync = await capped.call("run_model", { endpoint_id: "fal-ai/latentsync", input: { video_url: "https://media.example/clip.mp4", audio_url: "https://media.example/voice.mp3" } });
  assert.match(textOf(lipsync), /^mcp:fal\/run_model was not sent: fal bills fal-ai\/latentsync per second, and this job's input names no length/);
  assert.equal(capped.received("run_model"), 0, "LatentSync never sent under a cap");
  assert.deepEqual(capped.asked.media, [], "its media were never read either");
  const open = await setup(t, { capUsd: null, media, run: (args) => reply(args, { result: { video: { url: "https://v3.fal.media/o.mp4" } } }) });
  await open.call("run_model", job);
  assert.equal(open.received("run_model"), 1, "with no cap it runs");
  assert.deepEqual(await open.turns(), [null], "booked as an unknown charge");
});

test("submit_jobs is held at the sum of its jobs; one job that can't be priced refuses the whole call under a cap", async (t) => {
  const run = await setup(t, { run: (args) => ({ content: [{ type: "text", text: JSON.stringify({ results: args.requests.map((one) => ({ index: one.index, endpoint_id: one.endpoint_id, status: "submitted", request_id: `r${one.index}`, submission_replayed: false })) }) }] }) });
  const requests = [
    { index: 0, endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 1 } },
    { index: 1, endpoint_id: TTS, input: { text: "a".repeat(1000), voice: "Aria" } },
    { index: 2, endpoint_id: KLING, input: { prompt: "a wave", duration: "10" } },
    { index: 3, endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "y", num_images: 2 } },
  ];
  await run.call("submit_jobs", { requests });
  near(run.admits[0].holdUsd, 0.03 + 0.1 + 0.7 + 0.06, "the sum of its four jobs");
  near(run.spent(), 0.89, "booked at the sum");
  assert.deepEqual(run.asked.pricing, [{ endpoint_id: "fal-ai/ideogram/v3" }, { endpoint_id: TTS }, { endpoint_id: KLING }], "each endpoint's price read once, one endpoint a call");
  assert.match(run.admits[0].basis, /^fal's price for fal-ai\/ideogram\/v3: \$0\.03 per image × 1 \(num_images\); fal's price for fal-ai\/elevenlabs\/tts\/eleven-v3: /);

  const refused = await run.call("submit_jobs", { requests: [...requests.slice(0, 1), { index: 1, endpoint_id: "fal-ai/whisper", input: { audio_url: "https://media.example/a.mp3" } }] });
  assert.equal(textOf(refused), "mcp:fal/submit_jobs was not sent: fal bills fal-ai/whisper per compute second, which can't be known before the job runs, so a run with a spend cap can't send it. Nothing was sent.");
  assert.equal(run.received("submit_jobs"), 1, "the second call never reached fal");
});

test("submit_jobs books each job by its own outcome: a replayed or rejected one $0", async (t) => {
  const run = await setup(t, { run: (args) => ({ content: [{ type: "text", text: JSON.stringify({ results: [{ index: 0, endpoint_id: "fal-ai/ideogram/v3", status: "submitted", request_id: "r0", submission_replayed: false }, { index: 1, endpoint_id: TTS, status: "submitted", request_id: "r1", submission_replayed: true }, { index: 2, endpoint_id: KLING, status: "rejected", error: { type: "validation_error" } }] }) }] }) });
  await run.call("submit_jobs", { requests: [{ index: 0, endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x" } }, { index: 1, endpoint_id: TTS, input: { text: "a".repeat(1000) } }, { index: 2, endpoint_id: KLING, input: { prompt: "w", duration: "10" } }] });
  near(run.admits[0].holdUsd, 0.03 + 0.1 + 0.7, "held at the sum");
  assert.deepEqual(await run.turns(), [0.03], "only the job fal accepted anew");
});

test("a price its owner saved for a tool wins over fal's metering for that tool", async (t) => {
  const run = await setup(t, { entry: { meter: "fal", prices: { run_model: 0.5 } } });
  await run.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 2 } });
  near(run.spent(), 0.5, "its owner's price");
  assert.equal(run.admits[0].basis, "the price its owner set for mcp:fal/run_model");
  assert.equal(run.received("get_pricing"), 0, "fal's price is never read");
});

test("a revision pinned before servers were marked is metered by its server's host; another host's run_model is not fal's", async (t) => {
  const old = await setup(t, { entry: {}, url: "https://mcp.fal.ai/mcp" });
  await old.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 1 } });
  near(old.spent(), 0.03, "metered: its pinned URL is fal's");
  assert.equal(old.admits[0].chargedBy, "fal");

  const other = await setup(t, { entry: {} });
  await other.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 1 } });
  assert.equal(other.received("get_pricing"), 0, "no price is read of a server that is not fal's");
  assert.deepEqual(other.admits, [], "nothing booked");
  assert.deepEqual(other.root.map((entry) => entry.data), [{ tool: "mcp:fal/run_model", charged_by: "fal", call: "c1" }], "not metered, as any unpriced MCP tool");
});

test("a fal tool that submits no job is not held or booked", async (t) => {
  const run = await setup(t);
  await run.call("get_model_schema", { endpoint_id: "fal-ai/ideogram/v3" });
  assert.deepEqual(run.admits, []);
  assert.equal(run.received("get_pricing"), 0);
});

test("fal's price is read once per endpoint and kept 5 minutes", async (t) => {
  let at = T0;
  const run = await setup(t, { now: () => at });
  const job = { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x", num_images: 1 } };
  await run.call("run_model", job);
  at = T0 + 299_000;
  await run.call("run_model", job);
  assert.equal(run.received("get_pricing"), 1, "within 5 minutes: the price read before");
  assert.match(run.admits[1].basis, /from get_pricing at 2026-11-20T12:00:00\.000Z$/, "its basis names when it was read");
  at = T0 + 301_000;
  await run.call("run_model", job);
  assert.equal(run.received("get_pricing"), 2, "past 5 minutes: read again");
  near(run.spent(), 0.09, "three jobs");
});

test("a fal job with no run to book it under is never sent", async (t) => {
  const run = await setup(t, { ledger: false });
  const result = await run.call("run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "x" } });
  assert.equal(textOf(result), "mcp:fal/run_model was not sent: this call has no run to book its price under.");
  assert.equal(run.received("run_model"), 0);
});

test("a save pins a fal server as metered: by the toolkit its owner gave it, or by its host; a carried pin keeps its mark", () => {
  const listed = { tools: [{ name: "run_model", inputSchema: { type: "object" } }] };
  const servers = {
    key: { url: "https://mcp.fal.ai/mcp", ...listed },
    named: { url: "https://fal.internal.example/mcp", toolkit: "fal", ...listed },
    linear: { url: "https://mcp.linear.app/mcp", toolkit: "linear", ...listed },
    carried: { url: "https://fal.internal.example/mcp", meter: "fal", ...listed },
  };
  const pin = mcpPinOf(Object.keys(servers).map((name) => `mcp:${name}/run_model`), { server: (name) => servers[name] });
  assert.deepEqual(Object.fromEntries(Object.entries(pin).map(([name, entry]) => [name, entry.meter])), { key: "fal", named: "fal", linear: undefined, carried: "fal" });
  assert.deepEqual(Object.keys(pin.linear), ["url", "tools"], "a server that is not fal's is pinned as before");
});
