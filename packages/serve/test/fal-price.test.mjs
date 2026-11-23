// fal's pricing rules as pure functions (fal-price.ts): which server is fal's, which calls submit jobs, a job's billed
// units read from its input before it is sent and from its output after, and a price read from get_pricing's answer.
// Units and prices are fal's own (get_pricing's answers for these endpoints, read 2026-11-20); the input and output
// shapes are each endpoint's public OpenAPI.
import assert from "node:assert/strict";
import { test } from "node:test";

const load = () => import("../dist/fal-price.js");
const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

test("a server is fal's by its toolkit or by its host, never by a name that only looks like it", async () => {
  const { meterNamed } = await load();
  assert.equal(meterNamed("https://mcp.fal.ai/mcp"), "fal", "the key endpoint");
  assert.equal(meterNamed("https://mcp.fal.ai/mcp-relay", null), "fal", "the sign-in endpoint");
  assert.equal(meterNamed("http://127.0.0.1:9/mcp", "fal"), "fal", "the toolkit its owner gave it");
  assert.equal(meterNamed("https://example.com/mcp", null), undefined);
  assert.equal(meterNamed("https://example.com/mcp", "linear"), undefined);
  assert.equal(meterNamed("https://mcp.fal.ai.example.com/mcp"), undefined, "another host");
  assert.equal(meterNamed("not a url"), undefined);
});

test("run_model and submit_job submit one job, submit_jobs one per request; any other tool submits none", async () => {
  const { falJobsOf } = await load();
  const input = { prompt: "a lighthouse" };
  assert.deepEqual(falJobsOf("run_model", { endpoint_id: "fal-ai/flux/schnell", input, submission_key: "k1", user_intent: "x" }), [{ endpoint: "fal-ai/flux/schnell", input }]);
  assert.deepEqual(falJobsOf("submit_job", { endpoint_id: "fal-ai/veo3/fast", input }), [{ endpoint: "fal-ai/veo3/fast", input }]);
  assert.deepEqual(falJobsOf("submit_jobs", { requests: [{ index: 0, endpoint_id: "a/b", input }, { index: 4, endpoint_id: "c/d", input: {} }] }), [{ endpoint: "a/b", input, index: 0 }, { endpoint: "c/d", input: {}, index: 4 }]);
  for (const free of ["get_pricing", "estimate_cost", "get_model_schema", "wait_for_jobs", "get_submission", "upload_file"]) assert.equal(falJobsOf(free, { endpoint_id: "a/b" }), undefined, free);
  // A call with no endpoint or no requests is still a paid tool's: one job that can't be priced, never a free call.
  assert.deepEqual(falJobsOf("run_model", {}), [{ endpoint: undefined, input: undefined }]);
  assert.deepEqual(falJobsOf("submit_jobs", {}), [{ endpoint: undefined, input: undefined }]);
});

test("images and audios are counted from the input, one by default", async () => {
  const { unitsBefore } = await load();
  assert.equal(unitsBefore("fal-ai/ideogram/v3", "images", { prompt: "x", num_images: 3 }).units, 3);
  assert.equal(unitsBefore("fal-ai/nano-banana", "images", { prompt: "x" }).units, 1);
  assert.equal(unitsBefore("fal-ai/some/model", "images", { num_outputs: 2 }).units, 2);
  assert.equal(unitsBefore("fal-ai/stable-audio-25/text-to-audio", "audios", { prompt: "x", seconds_total: 30 }).units, 1);
  assert.ok("unknown" in unitsBefore("fal-ai/ideogram/v3", "images", { num_images: "many" }), "a count that is no number");
  assert.ok("unknown" in unitsBefore("fal-ai/ideogram/v3", "images", { num_images: 0 }), "a count of none");
});

test("megapixels are each image's width by height, rounded up to a whole megapixel, times the images; with no image_size, unknown", async () => {
  const { unitsBefore } = await load();
  const mp = (input) => unitsBefore("fal-ai/flux/schnell", "megapixels", input);
  assert.equal(mp({ image_size: "landscape_4_3", num_images: 1 }).units, 1, "1024x768 is 0.79 MP: 1");
  assert.equal(mp({ image_size: "square_hd", num_images: 2 }).units, 4, "1024x1024 is 1.05 MP: 2 each");
  assert.equal(mp({ image_size: "square" }).units, 1, "512x512");
  for (const preset of ["portrait_4_3", "portrait_16_9", "landscape_16_9"]) assert.equal(mp({ image_size: preset }).units, 1, preset);
  assert.equal(mp({ image_size: { width: 2048, height: 2048 }, num_images: 1 }).units, 5, "4.19 MP: 5");
  assert.equal(mp({ image_size: { width: 1000, height: 1000 } }).units, 1, "exactly 1 MP");
  assert.ok("unknown" in mp({ prompt: "x" }), "no image_size: the model's default is not guessed");
  assert.ok("unknown" in mp({ image_size: "poster" }), "a preset not known here");
  assert.ok("unknown" in mp({ image_size: { width: -1, height: 100 } }));
});

test("1000 characters are the characters of the input's text, a dialogue's lines summed", async () => {
  const { unitsBefore } = await load();
  near(unitsBefore("fal-ai/elevenlabs/tts/eleven-v3", "1000 characters", { text: "a".repeat(250), voice: "Aria" }).units, 0.25, "250 characters");
  near(unitsBefore("fal-ai/elevenlabs/text-to-dialogue/eleven-v3", "1000 characters", { inputs: [{ text: "a".repeat(100), voice: "Aria" }, { text: "b".repeat(400), voice: "Bill" }] }).units, 0.5, "100 and 400");
  assert.ok("unknown" in unitsBefore("fal-ai/elevenlabs/tts/eleven-v3", "1000 characters", { voice: "Aria" }), "no text");
  assert.ok("unknown" in unitsBefore("fal-ai/elevenlabs/text-to-dialogue/eleven-v3", "1000 characters", { inputs: [{ voice: "Aria" }] }), "a line with no text");
});

test("seconds and minutes are the length the input names, only in the field that sets the output fal bills, on the endpoints known to take it", async () => {
  const { unitsBefore } = await load();
  const s = (input, endpoint = "fal-ai/kling-video/v2.5-turbo/pro/text-to-video") => unitsBefore(endpoint, "seconds", input);
  assert.equal(s({ prompt: "x", duration: "5" }).units, 5);
  assert.equal(s({ duration: 10 }).units, 10);
  assert.equal(s({ duration: "10" }, "fal-ai/kling-video/v2.5-turbo/pro/image-to-video").units, 10);
  assert.equal(s({ duration: "12" }, "fal-ai/kling-video/v3/pro/image-to-video").units, 12);
  assert.equal(s({ duration: "6" }, "fal-ai/minimax/hailuo-02/standard/text-to-video").units, 6);
  for (const veo of ["fal-ai/veo3/fast", "fal-ai/veo3.1", "fal-ai/veo3.1/fast", "fal-ai/veo3.1/image-to-video"]) assert.equal(s({ duration: "8s" }, veo).units, 8, veo);
  assert.equal(s({ seconds_total: 30 }, "fal-ai/stable-audio-25/text-to-audio").units, 30);
  assert.equal(s({ duration: 45 }, "fal-ai/ace-step").units, 45);
  near(unitsBefore("fal-ai/elevenlabs/music", "minutes", { prompt: "x", music_length_ms: 90_000 }).units, 1.5, "90 s in minutes");
  near(unitsBefore("fal-ai/elevenlabs/music", "minutes", { composition_plan: { sections: [{ duration_ms: 20_000 }, { duration_ms: 40_000 }] } }).units, 1, "a plan's sections");
  assert.ok("unknown" in s({ prompt: "x" }), "no length named: the model's default is not guessed");
  for (const bad of ["soon", "-5", 0, Number.NaN, null]) assert.ok("unknown" in s({ duration: bad }), `duration ${String(bad)}`);
  assert.ok("unknown" in unitsBefore("fal-ai/elevenlabs/music", "minutes", { prompt: "a song" }), "music with no length");
  // Only the endpoint's own field: another length field on it is not what fal bills.
  for (const other of [{ duration_seconds: 6 }, { seconds_total: 6 }, { music_length_ms: 6000 }]) assert.ok("unknown" in s(other), JSON.stringify(other));
  assert.ok("unknown" in unitsBefore("fal-ai/elevenlabs/music", "minutes", { duration: 60 }), "music's length is music_length_ms or its plan, not duration");
});

test("ElevenLabs Music with a composition plan is priced from its sections alone, and only while the model keeps their lengths", async () => {
  const { unitsBefore } = await load();
  const music = (input) => unitsBefore("fal-ai/elevenlabs/music", "minutes", input);
  const plan = { positive_global_styles: [], negative_global_styles: [], sections: Array.from({ length: 5 }, () => ({ duration_ms: 120_000 })) };
  const bills = "fal bills fal-ai/elevenlabs/music per minute, and this job's input";
  // A plan sets the song's length; music_length_ms goes only with a prompt. Both: neither is read.
  const both = `${bills} names both music_length_ms and a composition_plan: a plan sets the song's length and music_length_ms goes only with a prompt (fal's OpenAPI), so send one of them`;
  assert.deepEqual(music({ music_length_ms: 10_000, composition_plan: plan }), { unknown: both }, "10 s named beside a 10 min plan");
  assert.deepEqual(music({ prompt: "x", music_length_ms: 10_000, composition_plan: plan }), { unknown: both });
  assert.deepEqual(music({ music_length_ms: null, composition_plan: plan }), { unknown: both }, "a null music_length_ms is still named");
  // The sections are read when the model keeps their lengths: respect_sections_durations true, or left out (its default).
  for (const keep of [{}, { respect_sections_durations: true }]) assert.deepEqual(music({ composition_plan: plan, ...keep }), { units: 10, from: "its composition plan's sections" }, JSON.stringify(keep));
  for (const loose of [false, "true", 1, null]) {
    assert.deepEqual(music({ composition_plan: plan, respect_sections_durations: loose }), { unknown: `${bills} has a composition_plan with respect_sections_durations ${JSON.stringify(loose)}, so the model may change its sections' lengths: they are read only when it is true or left out (fal's OpenAPI default is true)` }, String(loose));
  }
  // A null plan is none: music_length_ms is read.
  near(music({ prompt: "x", music_length_ms: 90_000, composition_plan: null }).units, 1.5, "a null plan");
});

test("a length the input names is never read on an endpoint fal bills by its media or by an output no input sets", async () => {
  const { unitsBefore } = await load();
  const v = "https://v3.fal.media/files/v.mp4";
  const a = "https://v3.fal.media/files/a.mp3";
  const tiny = [{ duration: 0.001 }, { duration: "0.001" }, { duration_seconds: 0.001 }, { seconds_total: 0.001 }, { music_length_ms: 1 }, { composition_plan: { sections: [{ duration_ms: 1 }] } }];
  // Billed by the media it is given: priced from that media, never from the named length.
  for (const [endpoint, unit, input, media] of [
    ["fal-ai/sync-lipsync/v2", "minutes", { video_url: v, audio_url: a }, [a, v]],
    ["fal-ai/elevenlabs/dubbing", "minutes", { video_url: v, target_lang: "es" }, [v]],
    ["fal-ai/elevenlabs/audio-isolation", "minutes", { video_url: v }, [v]],
    ["fal-ai/elevenlabs/speech-to-text", "minutes", { audio_url: a }, [a]],
  ]) {
    for (const named of tiny) assert.deepEqual(unitsBefore(endpoint, unit, { ...input, ...named }), { media }, `${endpoint} ${JSON.stringify(named)}`);
  }
  // Billed by an output no input sets (a talking head not on the list, a lip-sync, a merge, an endpoint not known):
  // unknown, whatever length the input names.
  for (const endpoint of ["fal-ai/infinitalk", "fal-ai/latentsync", "fal-ai/ffmpeg-api/merge-audio-video", "veed/fabric-1.0/fast", "fal-ai/bytedance/omnihuman", "fal-ai/some/new-video-model"]) {
    for (const named of tiny) {
      const units = unitsBefore(endpoint, "seconds", { image_url: "https://v3.fal.media/files/i.png", video_url: v, audio_url: a, resolution: "480p", ...named });
      assert.equal(units.unknown, `fal bills ${endpoint} per second, and no input of this endpoint is known to set the length fal bills, so a length it names is not read`, `${endpoint} ${JSON.stringify(named)}`);
    }
  }
});

test("a job that names no length is billed by its input media only where fal bills that media's length: its URLs are what must be read", async () => {
  const { unitsBefore } = await load();
  assert.deepEqual(unitsBefore("fal-ai/sync-lipsync/v2", "minutes", { video_url: "https://m.example/v.mp4", audio_url: "https://m.example/a.mp3" }), { media: ["https://m.example/a.mp3", "https://m.example/v.mp4"] });
  assert.deepEqual(unitsBefore("fal-ai/elevenlabs/speech-to-text", "minutes", { audio_url: "https://m.example/a.wav" }), { media: ["https://m.example/a.wav"] });
  assert.deepEqual(unitsBefore("fal-ai/elevenlabs/dubbing", "minutes", { video_url: "https://m.example/v.mp4", target_lang: "es" }), { media: ["https://m.example/v.mp4"] });
  // fal bills these by their output's length, which no input states.
  assert.ok("unknown" in unitsBefore("fal-ai/latentsync", "seconds", { video_url: "https://m.example/v.mp4", audio_url: "https://m.example/a.mp3" }), "LatentSync, per second of its output video");
  assert.ok("unknown" in unitsBefore("fal-ai/infinitalk", "seconds", { image_url: "https://m.example/i.png", audio_url: "https://m.example/a.mp3" }), "infinitalk, per second of its output video");
  assert.ok("unknown" in unitsBefore("fal-ai/ffmpeg-api/merge-audio-video", "seconds", { video_url: "https://m.example/v.mp4", audio_url: "https://m.example/a.mp3" }), "a merge");
  assert.ok("unknown" in unitsBefore("fal-ai/some/concat", "seconds", { video_urls: ["https://m.example/1.mp4", "https://m.example/2.mp4"] }), "a concat");
  // A named length wins over the media beside it.
  assert.equal(unitsBefore("fal-ai/kling-video/v2.5-turbo/pro/image-to-video", "seconds", { image_url: "https://m.example/i.png", duration: "10" }).units, 10);
});

test("a talking head is billed by the voice at its audio_url alone, https only", async () => {
  const { unitsBefore } = await load();
  const face = "https://m.example/i.png";
  const voice = "https://v3.fal.media/files/a.mp3";
  assert.deepEqual(unitsBefore("veed/fabric-1.0", "seconds", { image_url: face, audio_url: voice, resolution: "480p" }), { voice });
  assert.deepEqual(unitsBefore("fal-ai/bytedance/omnihuman/v1.5", "seconds", { image_url: face, audio_url: voice }), { voice });
  assert.deepEqual(unitsBefore("fal-ai/bytedance/omnihuman/v1.5", "seconds", { image_url: face, audio_url: voice, resolution: "720p" }), { voice }, "one rate at any resolution");
  // A length the input states is not what fal bills.
  assert.deepEqual(unitsBefore("fal-ai/bytedance/omnihuman/v1.5", "seconds", { image_url: face, audio_url: voice, duration: 1 }), { voice });
  assert.deepEqual(unitsBefore("veed/fabric-1.0", "seconds", { image_url: face, audio_url: voice, resolution: "480p", duration_seconds: 1 }), { voice });
  // Fabric's resolution sets its rate (rateOf), not its length: the voice is the length at any resolution.
  for (const resolution of ["720p", undefined, "480", 480]) {
    assert.deepEqual(unitsBefore("veed/fabric-1.0", "seconds", { image_url: face, audio_url: voice, ...(resolution === undefined ? {} : { resolution }) }), { voice }, String(resolution));
  }
  for (const audio_url of ["http://m.example/a.mp3", "ftp://m.example/a.mp3", "not a url", "", 3, null, undefined]) {
    const units = unitsBefore("fal-ai/bytedance/omnihuman/v1.5", "seconds", { image_url: face, audio_url });
    assert.match(units.unknown ?? "", /^fal bills fal-ai\/bytedance\/omnihuman\/v1\.5 per second of the video it makes, as long as the voice at its audio_url, and this job's audio_url is not an https URL on fal\.media/, String(audio_url));
  }
  // The voice is read once here and fetched again by fal: only fal's own media, which serves the same file to both, is
  // priced. A voice anywhere else could play 1 s to this read and 60 s to fal.
  assert.deepEqual(unitsBefore("veed/fabric-1.0", "seconds", { image_url: face, audio_url: "https://fal.media/files/a.mp3", resolution: "480p" }), { voice: "https://fal.media/files/a.mp3" });
  // The voice read is the exact URL fal fetches: one whose parsed form is written otherwise is not priced.
  for (const audio_url of ["https://V3.fal.media/files/a.mp3", "https://v3.fal.media/files/a b.mp3", "https://v3.fal.media/files/x/../a.mp3", "https://v3.fal.media:443/files/a.mp3", " https://v3.fal.media/files/a.mp3", "https://v3.fal.media/files/a.mp3\t", "https://v3.fal.media\\files\\a.mp3"]) {
    const units = unitsBefore("veed/fabric-1.0", "seconds", { image_url: face, audio_url, resolution: "480p" });
    assert.match(units.unknown ?? "", /audio_url is not an https URL on fal\.media, written as fal answered it/, JSON.stringify(audio_url));
  }
  // The host is the parsed URL's: fal.media as a user name or in a path is not fal's host.
  for (const audio_url of ["https://m.example/a.mp3", "https://fal.media.example/a.mp3", "https://notfal.media/a.mp3", "https://v3.fal.media.m.example/a.mp3", "https://storage.googleapis.com/falserverless/a.mp3", "https://fal.media@evil.example/x", "https://v3.fal.media@evil.example/a.mp3", "https://evil.example/fal.media", "https://evil.example/?u=https://v3.fal.media/a.mp3", "https://evil.example#.fal.media"]) {
    const units = unitsBefore("fal-ai/bytedance/omnihuman/v1.5", "seconds", { image_url: face, audio_url });
    assert.equal(units.unknown, "fal bills fal-ai/bytedance/omnihuman/v1.5 per second of the video it makes, as long as the voice at its audio_url, and this job's audio_url is not an https URL on fal.media, written as fal answered it (a voice fal made, or one uploaded to fal): the voice's length is read before the call and fal fetches it again, and only fal's own media is known to serve the same file both times", audio_url);
  }
});

test("a media read is capped at web_save's 200 MiB, or the lower cap its caller asks, and https only, redirects included, when asked", async () => {
  const { publicMedia } = await load();
  const { SAVE_MAX_BYTES } = await import("../dist/web-save.js");
  const dialled = [];
  const body = () => new Response(new Uint8Array(100), { status: 200, headers: { "content-type": "audio/mpeg" } });
  const answers = {
    "https://m.example/a.mp3": body,
    "http://m.example/a.mp3": body,
    "https://m.example/hop": () => new Response(null, { status: 302, headers: { location: "http://m.example/a.mp3" } }),
    "https://m.example/away": () => new Response(null, { status: 302, headers: { location: "https://m.example/a.mp3" } }),
    "https://m.example/big": () => new Response(new Uint8Array(1), { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(SAVE_MAX_BYTES + 1) } }),
  };
  const guard = async () => ({ lookup: async () => ["93.184.216.34"], fetchImpl: async (url) => (dialled.push(url.href), (answers[url.href] ?? (() => new Response("no", { status: 404 })))()) });
  const read = publicMedia(guard);
  const signal = new AbortController().signal;
  assert.equal((await read("https://m.example/a.mp3", signal)).length, 100);
  assert.equal((await read("https://m.example/a.mp3", signal, { maxBytes: 100 })).length, 100, "exactly the cap");
  await assert.rejects(read("https://m.example/a.mp3", signal, { maxBytes: 99 }), /over 99 bytes/);
  await assert.rejects(read("https://m.example/big", signal, { maxBytes: SAVE_MAX_BYTES * 2 }), /over 200 MiB/, "never above web_save's cap");
  dialled.length = 0;
  await assert.rejects(read("http://m.example/a.mp3", signal, { httpsOnly: true }), /http: is not https/);
  assert.deepEqual(dialled, [], "an http URL is never dialled");
  await assert.rejects(read("https://m.example/hop", signal, { httpsOnly: true }), /a redirect left https/);
  assert.deepEqual(dialled, ["https://m.example/hop"], "the http hop is never dialled");
  // A talking head's voice is read as VOICE_READ: no redirect is followed, so a fal.media URL that sends the read
  // elsewhere can't put a host whose bytes may change behind the price.
  const { VOICE_READ, VOICE_MAX_BYTES } = await load();
  assert.deepEqual(VOICE_READ, { maxBytes: VOICE_MAX_BYTES, httpsOnly: true, maxRedirects: 0 });
  dialled.length = 0;
  await assert.rejects(read("https://m.example/away", signal, VOICE_READ), /a redirect, and this download follows none/);
  assert.deepEqual(dialled, ["https://m.example/away"], "the redirect's target is never dialled");
  assert.equal((await read("https://m.example/a.mp3", signal, VOICE_READ)).length, 100, "a voice served directly is read");
  assert.equal((await read("https://m.example/hop", signal)).length, 100, "without httpsOnly an http hop is followed, as web_save's is");
});

test("a job is priced at the rate its settings are billed at: get_pricing's rate times the model page's ratio, a default included; a value the page names no rate for is unknown", async () => {
  const { rateOf, unitsBefore } = await load();
  const ratio = (endpoint, unit, input) => {
    const rate = rateOf(endpoint, unit, input);
    assert.ok(!("unknown" in rate), `${endpoint} ${JSON.stringify(input)}: ${rate.unknown}`);
    assert.equal(rate.extraUsd, 0, `${endpoint} ${JSON.stringify(input)}: no flat charge`);
    return rate.ratio;
  };
  const off = (endpoint, unit, input) => rateOf(endpoint, unit, input).unknown;
  // fal's model pages (read 2026-11-23) state each tier; get_pricing states one rate, the base below.
  // Ideogram v3: $0.03 an image at TURBO (get_pricing's), $0.06 at BALANCED (the default), $0.09 at QUALITY.
  for (const endpoint of ["fal-ai/ideogram/v3", "fal-ai/ideogram/v3/edit", "fal-ai/ideogram/v3/remix", "fal-ai/ideogram/v3/reframe", "fal-ai/ideogram/v3/replace-background"]) {
    near(ratio(endpoint, "images", { prompt: "x", rendering_speed: "TURBO" }), 1, `${endpoint} TURBO`);
    near(ratio(endpoint, "images", { prompt: "x" }), 2, `${endpoint} BALANCED, the default`);
    near(ratio(endpoint, "images", { prompt: "x", rendering_speed: "BALANCED" }), 2, `${endpoint} BALANCED`);
    near(ratio(endpoint, "images", { prompt: "x", rendering_speed: "QUALITY" }), 3, `${endpoint} QUALITY`);
    for (const [speed, shown] of [["turbo", '"turbo"'], [null, "null"], [2, "2"]]) {
      assert.equal(off(endpoint, "images", { prompt: "x", rendering_speed: speed }), `fal bills ${endpoint} per image at a rate its rendering_speed sets, and fal's model page names no rate for rendering_speed ${shown}`, `${endpoint} ${shown}`);
    }
    // The setting sets the rate, not the units.
    assert.deepEqual(unitsBefore(endpoint, "images", { prompt: "x", num_images: 2 }), { units: 2, from: "num_images" }, endpoint);
  }
  assert.deepEqual(rateOf("fal-ai/ideogram/v3", "images", { prompt: "x" }), { ratio: 2, extraUsd: 0, words: [`× 2 for rendering_speed "BALANCED", its default (fal's model page: $0.06 against $0.03)`] });
  assert.deepEqual(rateOf("fal-ai/ideogram/v3", "images", { prompt: "x", rendering_speed: "TURBO" }), { ratio: 1, extraUsd: 0, words: [] }, "get_pricing's own rate: no words");
  // Veo 3.1 and its image-to-video: $0.20 a second without audio and $0.40 with (get_pricing's) at 720p, the default, or
  // 1080p; at 4k $0.40 without and $0.60 with. Audio is on by default.
  for (const endpoint of ["fal-ai/veo3.1", "fal-ai/veo3.1/image-to-video"]) {
    for (const resolution of [undefined, "720p", "1080p"]) {
      for (const generate_audio of [undefined, true]) near(ratio(endpoint, "seconds", { prompt: "x", duration: "8s", resolution, generate_audio }), 1, `${endpoint} ${resolution} ${generate_audio}`);
      near(ratio(endpoint, "seconds", { prompt: "x", duration: "8s", resolution, generate_audio: false }), 0.5, `${endpoint} ${resolution} audio off`);
    }
    near(ratio(endpoint, "seconds", { prompt: "x", duration: "8s", resolution: "4k" }), 1.5, `${endpoint} 4k with audio`);
    near(ratio(endpoint, "seconds", { prompt: "x", duration: "8s", resolution: "4k", generate_audio: false }), 1, `${endpoint} 4k without audio`);
  }
  // Veo 3.1 fast: $0.10 without audio and $0.15 with (get_pricing's) at 720p or 1080p; at 4k $0.30 and $0.35.
  near(ratio("fal-ai/veo3.1/fast", "seconds", { prompt: "x", duration: "8s" }), 1);
  near(ratio("fal-ai/veo3.1/fast", "seconds", { prompt: "x", duration: "8s", generate_audio: false }), 0.1 / 0.15);
  near(ratio("fal-ai/veo3.1/fast", "seconds", { prompt: "x", duration: "8s", resolution: "4k" }), 0.35 / 0.15);
  near(ratio("fal-ai/veo3.1/fast", "seconds", { prompt: "x", duration: "8s", resolution: "4k", generate_audio: false }), 2);
  // Veo 3 fast: $0.10 without audio and $0.15 with (get_pricing's); it has no 4k, so its resolution sets no rate.
  near(ratio("fal-ai/veo3/fast", "seconds", { prompt: "x", duration: "8s" }), 1);
  near(ratio("fal-ai/veo3/fast", "seconds", { prompt: "x", duration: "8s", generate_audio: false }), 0.1 / 0.15);
  for (const endpoint of ["fal-ai/veo3.1", "fal-ai/veo3.1/fast", "fal-ai/veo3.1/image-to-video", "fal-ai/veo3/fast"]) {
    assert.equal(off(endpoint, "seconds", { prompt: "x", duration: "8s", generate_audio: "false" }), `fal bills ${endpoint} per second at a rate its generate_audio sets, and fal's model page names no rate for generate_audio "false"`, endpoint);
  }
  for (const endpoint of ["fal-ai/veo3.1", "fal-ai/veo3.1/fast", "fal-ai/veo3.1/image-to-video"]) {
    for (const [resolution, shown] of [["4K", '"4K"'], ["2160p", '"2160p"'], [null, "null"]]) {
      assert.equal(off(endpoint, "seconds", { prompt: "x", duration: "8s", resolution }), `fal bills ${endpoint} per second at a rate its resolution sets, and fal's model page names no rate for resolution ${shown}`, `${endpoint} ${shown}`);
    }
  }
  // Kling v3 pro image-to-video: $0.112 a second with audio off, $0.168 with audio on (the default), $0.196 with voice
  // control (an element with a voice_id); get_pricing states $0.14.
  const kling3 = "fal-ai/kling-video/v3/pro/image-to-video";
  const start = { start_image_url: "https://m.example/i.png", duration: "5" };
  near(ratio(kling3, "seconds", start), 1.2, "audio on, the default");
  near(ratio(kling3, "seconds", { ...start, generate_audio: true }), 1.2, "audio on");
  near(ratio(kling3, "seconds", { ...start, generate_audio: false }), 0.8, "audio off");
  near(ratio(kling3, "seconds", { ...start, elements: [{ frontal_image_url: "https://m.example/f.png" }] }), 1.2, "an element with no voice");
  near(ratio(kling3, "seconds", { ...start, elements: [{ frontal_image_url: "https://m.example/f.png" }, { voice_id: "v1" }] }), 1.4, "voice control");
  near(ratio(kling3, "seconds", { ...start, generate_audio: true, elements: [{ voice_id: "" }] }), 1.4, "any voice_id named");
  assert.equal(off(kling3, "seconds", { ...start, generate_audio: false, elements: [{ voice_id: "v1" }] }), `fal bills ${kling3} per second at a rate its generate_audio and voice control set, and fal's model page names no rate for voice control with generate_audio false`);
  assert.equal(off(kling3, "seconds", { ...start, elements: { voice_id: "v1" } }), `fal bills ${kling3} per second at a rate voice control sets (an element's voice_id), and this job's elements are not a list`);
  assert.equal(off(kling3, "seconds", { ...start, generate_audio: "true" }), `fal bills ${kling3} per second at a rate its generate_audio sets, and fal's model page names no rate for generate_audio "true"`);
  // sync-lipsync v2: $3 a minute for lipsync-2 (the default, get_pricing's), $5 for lipsync-2-pro.
  const media = { video_url: "https://v3.fal.media/files/v.mp4", audio_url: "https://v3.fal.media/files/a.mp3" };
  for (const model of [undefined, "lipsync-2"]) near(ratio("fal-ai/sync-lipsync/v2", "minutes", { ...media, model }), 1, String(model));
  near(ratio("fal-ai/sync-lipsync/v2", "minutes", { ...media, model: "lipsync-2-pro" }), 5 / 3, "lipsync-2-pro");
  assert.equal(off("fal-ai/sync-lipsync/v2", "minutes", { ...media, model: "lipsync-1.9" }), `fal bills fal-ai/sync-lipsync/v2 per minute at a rate its model sets, and fal's model page names no rate for model "lipsync-1.9"`);
  assert.deepEqual(unitsBefore("fal-ai/sync-lipsync/v2", "minutes", { ...media, model: "lipsync-2-pro" }), { media: [media.audio_url, media.video_url] }, "still priced from its media");
  // Nano Banana Pro: $0.15 an image at 1K (the default) or 2K (get_pricing's), double at 4K; a web search adds $0.015.
  for (const resolution of [undefined, "1K", "2K"]) near(ratio("fal-ai/nano-banana-pro", "images", { prompt: "x", resolution, enable_web_search: false }), 1, String(resolution));
  near(ratio("fal-ai/nano-banana-pro", "images", { prompt: "x", resolution: "4K" }), 2, "4K");
  assert.deepEqual(rateOf("fal-ai/nano-banana-pro", "images", { prompt: "x", enable_web_search: true }), { ratio: 1, extraUsd: 0.015, words: ["plus $0.015 for a web search"] });
  assert.deepEqual(rateOf("fal-ai/nano-banana-pro", "images", { prompt: "x", resolution: "4K", enable_web_search: true }), { ratio: 2, extraUsd: 0.015, words: [`× 2 for resolution "4K" (fal's model page: $0.3 against $0.15)`, "plus $0.015 for a web search"] });
  assert.equal(off("fal-ai/nano-banana-pro", "images", { prompt: "x", resolution: "4k" }), `fal bills fal-ai/nano-banana-pro per image at a rate its resolution sets, and fal's model page names no rate for resolution "4k"`);
  assert.equal(off("fal-ai/nano-banana-pro", "images", { prompt: "x", enable_web_search: "yes" }), `fal bills fal-ai/nano-banana-pro per image at a rate plus a charge its enable_web_search sets, and fal's model page names no rate for enable_web_search "yes"`);
  // Fabric: $0.08 a second at 480p (get_pricing's), $0.15 at 720p; its resolution has no default (its OpenAPI).
  const talking = { image_url: "https://m.example/i.png", audio_url: "https://v3.fal.media/files/a.mp3" };
  near(ratio("veed/fabric-1.0", "seconds", { ...talking, resolution: "480p" }), 1, "480p");
  near(ratio("veed/fabric-1.0", "seconds", { ...talking, resolution: "720p" }), 0.15 / 0.08, "720p");
  assert.equal(off("veed/fabric-1.0", "seconds", talking), "fal bills veed/fabric-1.0 per second at a rate its resolution sets, and resolution has no default and this job sets none");
  for (const [resolution, shown] of [["480", '"480"'], [480, "480"], ["1080p", '"1080p"']]) {
    assert.equal(off("veed/fabric-1.0", "seconds", { ...talking, resolution }), `fal bills veed/fabric-1.0 per second at a rate its resolution sets, and fal's model page names no rate for resolution ${shown}`, shown);
  }
  // An endpoint not listed is priced at get_pricing's one rate, whatever its settings.
  assert.deepEqual(rateOf("fal-ai/kling-video/v2.5-turbo/pro/text-to-video", "seconds", { duration: "5", rendering_speed: "QUALITY", resolution: "4k", generate_audio: true }), { ratio: 1, extraUsd: 0, words: [] });
  assert.deepEqual(rateOf("fal-ai/bytedance/omnihuman/v1.5", "seconds", { ...talking, resolution: "1080p" }), { ratio: 1, extraUsd: 0, words: [] });
});

test("ffmpeg's compose is billed by its timeline's end: the last keyframe's end across its tracks, in milliseconds", async () => {
  const { unitsBefore } = await load();
  const tracks = [
    { id: "v", type: "video", keyframes: [{ timestamp: 0, duration: 4000, url: "https://m.example/1.mp4" }, { timestamp: 4000, duration: 2500, url: "https://m.example/2.mp4" }] },
    { id: "a", type: "audio", keyframes: [{ timestamp: 500, duration: 5000, url: "https://m.example/a.mp3" }] },
  ];
  near(unitsBefore("fal-ai/ffmpeg-api/compose", "seconds", { tracks }).units, 6.5, "ends at 6500 ms");
  assert.ok("unknown" in unitsBefore("fal-ai/ffmpeg-api/compose", "seconds", { tracks: [] }), "no keyframe");
  assert.ok("unknown" in unitsBefore("fal-ai/ffmpeg-api/compose", "seconds", { tracks: [{ id: "v", type: "video", keyframes: [{ timestamp: 0, url: "https://m.example/1.mp4" }] }] }), "a keyframe with no duration");
});

test("a unit that can't be known before the job runs, or one not known here, is unknown, in words that name it", async () => {
  const { unitsBefore } = await load();
  assert.match(unitsBefore("fal-ai/whisper", "compute seconds", { audio_url: "https://m.example/a.mp3" }).unknown, /fal bills fal-ai\/whisper per compute second, which can't be known before the job runs/);
  assert.match(unitsBefore("fal-ai/bytedance/seedance/v1/lite/text-to-video", "1m tokens", { prompt: "x", duration: "5" }).unknown, /per 1m tokens, which can't be known before the job runs/);
  assert.match(unitsBefore("fal-ai/x", "widgets", {}).unknown, /fal bills fal-ai\/x per widgets, a unit this server can't count/);
  assert.match(unitsBefore("fal-ai/kling-video/v2.5-turbo/pro/text-to-video", "seconds", { prompt: "x" }).unknown, /fal bills fal-ai\/kling-video\/v2\.5-turbo\/pro\/text-to-video per second, and this job's input names no length/);
  assert.ok("unknown" in unitsBefore("fal-ai/ideogram/v3", "images", "not an object"));
});

test("the units an output states: its images, their megapixels, a duration; none stated is undefined", async () => {
  const { unitsAfter } = await load();
  assert.equal(unitsAfter("images", { images: [{ url: "a" }, { url: "b" }, { url: "c" }] }), 3);
  assert.equal(unitsAfter("megapixels", { images: [{ url: "a", width: 1024, height: 768 }, { url: "b", width: 1024, height: 1024 }] }), 3, "1 and 2");
  assert.equal(unitsAfter("megapixels", { images: [{ url: "a", content_type: "image/png" }] }), undefined, "no size stated");
  assert.equal(unitsAfter("seconds", { video: { url: "v" }, duration: 7.5 }), 7.5);
  near(unitsAfter("minutes", { duration: 90 }), 1.5, "90 s");
  assert.equal(unitsAfter("seconds", { video: { url: "v", duration: 4 } }), 4, "on its file");
  assert.equal(unitsAfter("seconds", { video: { url: "v" } }), undefined);
  assert.equal(unitsAfter("1000 characters", { audio: { url: "a" } }), undefined);
  assert.equal(unitsAfter("audios", { audio: { url: "a" } }), undefined);
  assert.equal(unitsAfter("images", undefined), undefined);
  assert.equal(unitsAfter("images", { images: [] }), undefined, "an empty list states nothing");
});

test("a price is read from get_pricing's answer for its own endpoint, in USD", async () => {
  const { priceIn } = await load();
  const answer = { prices: [{ endpoint_id: "fal-ai/ideogram/v3", unit_price: 0.03, unit: "images", currency: "USD" }, { endpoint_id: "fal-ai/flux/schnell", unit_price: 0.003, unit: "megapixels", currency: "USD" }], next_cursor: null, has_more: false };
  assert.deepEqual(priceIn(answer, "fal-ai/flux/schnell"), { unitPrice: 0.003, unit: "megapixels" });
  assert.equal(priceIn(answer, "fal-ai/nano-banana"), undefined, "another endpoint's price is never taken");
  assert.equal(priceIn({ status: "not_found", suggestions: [] }, "fal-ai/ideogram/v3"), undefined);
  for (const bad of [{ unit_price: -1 }, { unit_price: "0.03" }, { unit_price: Number.NaN }, { currency: "EUR" }, { unit: "" }, { unit: 7 }]) {
    assert.equal(priceIn({ prices: [{ endpoint_id: "a/b", unit_price: 0.03, unit: "images", currency: "USD", ...bad }] }, "a/b"), undefined, JSON.stringify(bad));
  }
  assert.equal(priceIn("prices", "a/b"), undefined);
});
