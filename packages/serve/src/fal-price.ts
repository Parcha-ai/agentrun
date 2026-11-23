// fal's pricing, for the run's MCP gateway (mcp-gateway.ts McpMeter): a job sent to a fal MCP server (run_model,
// submit_job, each request of submit_jobs) is priced before it leaves, at fal's unit price for its endpoint times the
// units fal bills it by.
//  - The unit price is the server's own get_pricing, asked with exactly `{ endpoint_id: "<id>" }` (a contract: a fake
//    server matches arguments by equality), one endpoint a call, kept PRICE_TTL_MS.
//  - The units are read from the job's input (unitsBefore). Nothing is guessed: an input that leaves out the size or
//    length its model would default is unpriceable, and a length is read only from the field that sets it on the
//    endpoints known to take one (NAMED_LENGTH). A job billed by its media's length reads that media first; a talking
//    head reads its voice alone (TALKING_HEADS).
//  - fal's reply states no cost, so the charge is this estimate (chargeOfJob).
// fal can bill what get_pricing does not expose (a minimum, a discount, a rate that depends on a setting such as
// resolution): a booked figure is fal's list price for the job, not its invoice.
// fal's hosted server also keeps one submission_key journal per fal account, which refuses a key it has seen with another
// request: a server at fal's own host scopes each key to the run before it leaves (falKeys).
import { createHash } from "node:crypto";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import type { McpKeys, McpMeter, McpQuote } from "./mcp-gateway.js";
import { mediaSeconds, voiceSeconds } from "./media-duration.js";
import { usd } from "./paid-calls.js";
import { SAVE_MAX_BYTES, type SaveSlots, SERVER_SLOTS } from "./web-save.js";

/** The host of fal's hosted MCP server (its key endpoint /mcp and its sign-in endpoint /mcp-relay). */
export const FAL_MCP_HOST = "mcp.fal.ai";
/** A pin's `meter` for a fal server. */
export const FAL_METER = "fal";
export type FalMeterName = typeof FAL_METER;
/** How long a unit price read from get_pricing is used. */
export const PRICE_TTL_MS = 5 * 60_000;
/** One deadline for reading an input media file's length. */
export const MEDIA_TIMEOUT_MS = 120_000;
/** The most of a talking head's voice read to price it: a minute of 48 kHz stereo 32-bit WAV (23 MB) fits, and fal's
 *  talking heads take a minute of voice at most (OmniHuman v1.5's OpenAPI). A larger voice is unpriceable. */
export const VOICE_MAX_BYTES = 32 * 1024 * 1024;
/** How a talking head's voice is read: https only, under VOICE_MAX_BYTES, and following no redirect, so a fal.media URL
 *  can't send the read to a host whose bytes may change (voiceOf). fal.media serves its files with no redirect. */
export const VOICE_READ = { maxBytes: VOICE_MAX_BYTES, httpsOnly: true, maxRedirects: 0 } as const;

/** Whether `url` is on fal's MCP host. */
const onFalHost = (url: string): boolean => URL.parse(url)?.hostname === FAL_MCP_HOST;
/** The one test of a server being fal's: `fal` when `named` (its owner's toolkit for it, or the meter a pin carries) is
 *  `fal` or its URL is on fal's MCP host; the `meter` a save pins (mcp-gateway.ts mcpPinOf). */
export const meterNamed = (url: string, named?: string | null): FalMeterName | undefined => (named === FAL_METER || onFalHost(url) ? FAL_METER : undefined);

/** One job a call submits: its endpoint and input as the call gives them, and its index in a submit_jobs call. */
export type FalJob = { endpoint: string | undefined; input: unknown; index?: number };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const jobOf = (given: unknown): FalJob => {
  const one = isObject(given) ? given : {};
  return { endpoint: typeof one.endpoint_id === "string" && one.endpoint_id ? one.endpoint_id : undefined, input: one.input, ...(Number.isInteger(one.index) ? { index: one.index as number } : {}) };
};
/** The jobs a call of fal's `tool` submits: one for run_model and submit_job, one per request for submit_jobs. Undefined
 *  for a tool that submits none (get_pricing, wait_for_jobs, ...), which fal does not bill. */
export function falJobsOf(tool: string, args: unknown): FalJob[] | undefined {
  if (tool === "run_model" || tool === "submit_job") return [jobOf(args)];
  if (tool !== "submit_jobs") return undefined;
  const requests = isObject(args) && Array.isArray(args.requests) ? args.requests : [];
  return requests.length ? requests.map(jobOf) : [jobOf(undefined)];
}

/** Whether fal bills a call of `tool`: one that submits jobs. */
export const falBills = (tool: string): boolean => falJobsOf(tool, {}) !== undefined;

/** fal's image_size presets, in pixels. */
const SIZES: Record<string, readonly [number, number]> = { square_hd: [1024, 1024], square: [512, 512], portrait_4_3: [768, 1024], portrait_16_9: [576, 1024], landscape_4_3: [1024, 768], landscape_16_9: [1024, 576] };
/** A unit as one of it reads: "per image". */
const ONE: Record<string, string> = { images: "image", megapixels: "megapixel", seconds: "second", minutes: "minute", audios: "audio", "compute seconds": "compute second" };
const oneOf = (unit: string): string => ONE[unit] ?? unit;
/** Units fal counts only once the job has run. */
const AFTER_ONLY = new Set(["compute seconds", "1m tokens"]);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
/** An image's megapixels as billed: rounded up to a whole one. */
const megapixels = (width: number, height: number): number => Math.ceil((width * height) / 1e6);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A job's billed units before it runs: `units` and where the number came from (`from`); `media`, the audio and video
 *  URLs whose length it is billed by (the longest); `voice`, a talking head's voice URL, whose length in whole seconds
 *  it is billed by (TALKING_HEADS); or `unknown`, why they can't be known, in words. */
export type Units = { units: number; from: string } | { media: string[] } | { voice: string } | { unknown: string };

/** How many outputs the input asks for (num_images, else num_outputs, else 1), or undefined for a count that is none. */
function countOf(input: Record<string, unknown>, unit: string): { n: number; from: string } | undefined {
  const field = input.num_images !== undefined ? "num_images" : input.num_outputs !== undefined ? "num_outputs" : undefined;
  if (!field) return { n: 1, from: `1 ${oneOf(unit === "megapixels" ? "images" : unit)} by default` };
  const n = input[field];
  return Number.isInteger(n) && (n as number) > 0 ? { n: n as number, from: field } : undefined;
}

/** The endpoints whose input sets the length of the output fal bills, and the one field that does, from fal's OpenAPI
 *  (read 2026-11-23): Kling's and Hailuo's `duration` ("5", "10"), Veo's ("4s", "6s", "8s"), ACE-Step's (seconds),
 *  Stable Audio's `seconds_total`, and ElevenLabs Music's `music_length_ms` or its composition plan's sections (planSeconds). Only
 *  these are read: on another endpoint a length its input names may be a field fal ignores, or none it has, while fal
 *  bills its media or an output no input sets, so a job could name 0.001 s and be billed for minutes. A listed endpoint
 *  whose input names no length is not priced at the model's default either. */
const NAMED_LENGTH: ReadonlyMap<string, "duration" | "seconds_total" | "music_length_ms"> = new Map([
  ...["fal-ai/kling-video/v2.5-turbo/pro/text-to-video", "fal-ai/kling-video/v2.5-turbo/pro/image-to-video", "fal-ai/kling-video/v3/pro/image-to-video", "fal-ai/minimax/hailuo-02/standard/text-to-video", "fal-ai/veo3/fast", "fal-ai/veo3.1", "fal-ai/veo3.1/fast", "fal-ai/veo3.1/image-to-video", "fal-ai/ace-step"].map((endpoint) => [endpoint, "duration"] as const),
  ["fal-ai/stable-audio-25/text-to-audio", "seconds_total"],
  ["fal-ai/elevenlabs/music", "music_length_ms"],
]);

/** The length in seconds `input` names in `field` (NAMED_LENGTH): `duration` as "5", "5s" or a number, seconds_total,
 *  or music_length_ms; a music job with a composition plan is read by planSeconds. "bad" when it names one that is not
 *  above 0; `why`, in words, when what it names can't be the length fal bills. */
function namedSeconds(input: Record<string, unknown>, field: "duration" | "seconds_total" | "music_length_ms"): { seconds: number; from: string } | "bad" | { why: string } | undefined {
  if (field === "music_length_ms" && input.composition_plan !== undefined && input.composition_plan !== null) return planSeconds(input);
  const given = input[field];
  if (given === undefined) return undefined;
  const said = typeof given === "string" && /^\d+(\.\d+)?s?$/.test(given.trim()) ? Number.parseFloat(given) : given;
  return positive(said) ? { seconds: said / (field === "music_length_ms" ? 1000 : 1), from: field } : "bad";
}

/** The length of an ElevenLabs Music job with a composition plan, from fal's OpenAPI (read 2026-11-23): the plan sets the
 *  song's length, and music_length_ms is "used only in conjunction with prompt", so a job naming both is not read
 *  (either could be what fal bills). The sections' duration_ms are summed only while the model keeps them:
 *  respect_sections_durations true, or left out (its default is true); false lets the model change them. */
function planSeconds(input: Record<string, unknown>): { seconds: number; from: string } | "bad" | { why: string } | undefined {
  if (input.music_length_ms !== undefined) return { why: "names both music_length_ms and a composition_plan: a plan sets the song's length and music_length_ms goes only with a prompt (fal's OpenAPI), so send one of them" };
  const keep = input.respect_sections_durations;
  if (keep !== undefined && keep !== true) return { why: `has a composition_plan with respect_sections_durations ${JSON.stringify(keep)}, so the model may change its sections' lengths: they are read only when it is true or left out (fal's OpenAPI default is true)` };
  const sections = isObject(input.composition_plan) ? input.composition_plan.sections : undefined;
  if (!Array.isArray(sections) || !sections.length) return undefined;
  const each = sections.map((section) => (isObject(section) ? section.duration_ms : undefined));
  return each.every(positive) ? { seconds: each.reduce((sum, ms) => sum + ms, 0) / 1000, from: "its composition plan's sections" } : "bad";
}

/** The endpoints fal bills per minute of media whose length the input's media bound (fal's model pages, read 2026-11-21):
 *  dubbing and voice isolation return the media they are given, re-voiced or cleaned; speech-to-text returns text, so
 *  its input is the only media to bill; sync-lipsync v2 bills "per minute of video", held at the longest it is given.
 *  Each settles at the length its output states, if it states one, and none is priced from a length its input names.
 *  Another endpoint billed by length, not in NAMED_LENGTH, bills its output's (LatentSync's video, infinitalk's, a
 *  merge, an upscale), which no input states: it is unpriceable, but for the talking heads (TALKING_HEADS). */
const BY_INPUT_MEDIA: ReadonlySet<string> = new Set(["fal-ai/elevenlabs/dubbing", "fal-ai/elevenlabs/audio-isolation", "fal-ai/elevenlabs/speech-to-text", "fal-ai/sync-lipsync/v2"]);
/** The input's audio_url and video_url. */
const mediaOf = (input: Record<string, unknown>): string[] => [input.audio_url, input.video_url].filter((url): url is string => typeof url === "string" && url !== "");

/** The talking heads fal bills per second of the video they make, which runs as long as the voice they lip-sync: fal's
 *  OpenAPI (read 2026-11-23) gives OmniHuman v1.5's output `duration` as "Duration of audio input/video output as used
 *  for billing", and Fabric's video is its voice's picture. Such a job is held at that voice's length in whole seconds,
 *  as fal bills them. The length is read from the audio at its audio_url alone (https only, under VOICE_MAX_BYTES), as
 *  long as it plays (media-duration.ts voiceSeconds: an MP3 or a PCM WAV), never from a length its header or its input
 *  states, never from its image.
 *  The voice is read once here and fetched again by fal, so a host that served this read a short voice and fal a long
 *  one would pass the cap: only a voice on fal's own media (fal.media and its subdomains, where fal puts what it makes
 *  and what is uploaded to it, a new URL for each file) is priced. Any other is unpriceable.
 *  Fabric's rate depends on its resolution (RATE_TIERS). OmniHuman v1.5 has one rate: fal's model page (read
 *  2026-11-23) bills it per second at $0.16, with no rate by resolution or turbo_mode. */
const TALKING_HEADS: ReadonlySet<string> = new Set(["veed/fabric-1.0", "fal-ai/bytedance/omnihuman/v1.5"]);

/** `input`'s `field`, or `fallback` (its default) when the job leaves it out, if it is one of the values `named`
 *  (compared exactly: the string "false" is not false); else why not, in words. */
function settingOf(input: Record<string, unknown>, field: string, named: readonly unknown[], fallback?: unknown): { value: unknown; words: string } | { why: string } {
  const given = input[field];
  if (given === undefined && fallback === undefined) return { why: `its ${field} sets, and ${field} has no default and this job sets none` };
  const value = given === undefined ? fallback : given;
  if (!named.includes(value)) return { why: `its ${field} sets, and fal's model page names no rate for ${field} ${JSON.stringify(given)}` };
  return { value, words: `${field} ${JSON.stringify(value)}${given === undefined ? ", its default" : ""}` };
}
type Tier = { rate: number; words: string } | { why: string };
/** The endpoints fal bills at a rate a setting sets, while get_pricing states one rate. Each has `base`, the rate fal's
 *  model page gives for the setting get_pricing's rate is for, and `rate`, the page's rate for the job's settings: a job
 *  is priced at get_pricing's live rate times rate / base, so a price change at fal moves every tier. A setting the
 *  job leaves out is priced at its default; a value the page names no rate for is unpriceable. `extraUsd` is a flat
 *  charge the page adds. The rates are fal's model pages, read 2026-11-23:
 *  - Ideogram v3 (and its edit, remix, reframe and replace-background): $0.03 an image at TURBO (get_pricing's rate),
 *    $0.06 at BALANCED (the default), $0.09 at QUALITY: ratios 1, 2 and 3.
 *  - Veo 3.1 and its image-to-video: $0.20 a second without audio and $0.40 with (get_pricing's), at 720p (the
 *    default) or 1080p; at 4k $0.40 without and $0.60 with. Audio is on by default.
 *  - Veo 3.1 fast: $0.10 without audio and $0.15 with (get_pricing's) at 720p or 1080p; at 4k $0.30 and $0.35.
 *  - Veo 3 fast: $0.10 without audio and $0.15 with (get_pricing's), at either of its resolutions.
 *  - Kling v3 pro image-to-video: $0.112 a second with audio off, $0.168 with audio on (the default), $0.196 with voice
 *    control (an element with a voice_id, its OpenAPI); get_pricing states $0.14: ratios 0.8, 1.2 and 1.4.
 *  - sync-lipsync v2: $3 a minute for lipsync-2 (the default, get_pricing's), $5 for lipsync-2-pro: ratio 5/3.
 *  - Nano Banana Pro: $0.15 an image at 1K (the default) or 2K (get_pricing's), double at 4K; a web search adds $0.015.
 *  - Fabric: $0.08 a second at 480p (get_pricing's), $0.15 at 720p. Its resolution has no default (its OpenAPI).
 *  An endpoint not listed here is priced at get_pricing's one rate, whatever its settings. */
type Tiers = { base: number; rate: (input: Record<string, unknown>) => Tier; extraUsd?: (input: Record<string, unknown>) => { usd: number; words: string } | { why: string } | undefined };
/** A rate set by one setting: `rates` by value. */
const byOne = (field: string, base: number, rates: ReadonlyMap<unknown, number>, fallback?: unknown): Tiers => ({
  base,
  rate: (input) => {
    const setting = settingOf(input, field, [...rates.keys()], fallback);
    return "why" in setting ? setting : { rate: rates.get(setting.value)!, words: setting.words };
  },
});
/** Veo's rate: by resolution (`at4k`, the 4k rates, when it has one) and whether it makes audio. */
const veo = (base: number, off: number, on: number, at4k?: { off: number; on: number }): Tiers => ({
  base,
  rate: (input) => {
    const audio = settingOf(input, "generate_audio", [true, false], true);
    if ("why" in audio) return audio;
    if (!at4k) return { rate: audio.value ? on : off, words: audio.words };
    const resolution = settingOf(input, "resolution", ["720p", "1080p", "4k"], "720p");
    if ("why" in resolution) return resolution;
    const rates = resolution.value === "4k" ? at4k : { off, on };
    return { rate: audio.value ? rates.on : rates.off, words: `${resolution.words}, ${audio.words}` };
  },
});
const RATE_TIERS: ReadonlyMap<string, Tiers> = new Map<string, Tiers>([
  ...["fal-ai/ideogram/v3", "fal-ai/ideogram/v3/edit", "fal-ai/ideogram/v3/remix", "fal-ai/ideogram/v3/reframe", "fal-ai/ideogram/v3/replace-background"].map((endpoint) => [endpoint, byOne("rendering_speed", 0.03, new Map([["TURBO", 0.03], ["BALANCED", 0.06], ["QUALITY", 0.09]]), "BALANCED")] as const),
  ["fal-ai/veo3.1", veo(0.4, 0.2, 0.4, { off: 0.4, on: 0.6 })],
  ["fal-ai/veo3.1/image-to-video", veo(0.4, 0.2, 0.4, { off: 0.4, on: 0.6 })],
  ["fal-ai/veo3.1/fast", veo(0.15, 0.1, 0.15, { off: 0.3, on: 0.35 })],
  ["fal-ai/veo3/fast", veo(0.15, 0.1, 0.15)],
  ["fal-ai/kling-video/v3/pro/image-to-video", {
    base: 0.14,
    rate: (input) => {
      const audio = settingOf(input, "generate_audio", [true, false], true);
      if ("why" in audio) return audio;
      const elements = input.elements;
      if (elements !== undefined && elements !== null && !Array.isArray(elements)) return { why: "voice control sets (an element's voice_id), and this job's elements are not a list" };
      // Any element naming a voice_id, whatever its value: the page names no rate for one that turns out not to be a voice.
      const voiced = Array.isArray(elements) && elements.some((element) => isObject(element) && element.voice_id !== undefined && element.voice_id !== null);
      if (voiced && !audio.value) return { why: "its generate_audio and voice control set, and fal's model page names no rate for voice control with generate_audio false" };
      if (voiced) return { rate: 0.196, words: `${audio.words}, with voice control (an element's voice_id)` };
      return audio.value ? { rate: 0.168, words: audio.words } : { rate: 0.112, words: audio.words };
    },
  }],
  ["fal-ai/sync-lipsync/v2", byOne("model", 3, new Map([["lipsync-2", 3], ["lipsync-2-pro", 5]]), "lipsync-2")],
  ["fal-ai/nano-banana-pro", {
    ...byOne("resolution", 0.15, new Map([["1K", 0.15], ["2K", 0.15], ["4K", 0.3]]), "1K"),
    extraUsd: (input) => {
      const search = settingOf(input, "enable_web_search", [true, false], false);
      return "why" in search ? search : search.value ? { usd: 0.015, words: "a web search" } : undefined;
    },
  }],
  ["veed/fabric-1.0", byOne("resolution", 0.08, new Map([["480p", 0.08], ["720p", 0.15]]))],
]);

/** The rate a job of `endpoint` is billed at, against get_pricing's (in `unit`): `ratio`, its tier's rate over the rate
 *  get_pricing states (RATE_TIERS), `extraUsd` a flat charge, and `words` the settings they came from (none at
 *  get_pricing's own rate); or `unknown`, why it can't be known. 1 and nothing for an endpoint with one rate. */
export function rateOf(endpoint: string, unit: string, input: unknown): { ratio: number; extraUsd: number; words: string[] } | { unknown: string } {
  const tiers = RATE_TIERS.get(endpoint);
  if (!tiers || !isObject(input)) return { ratio: 1, extraUsd: 0, words: [] };
  const bills = `fal bills ${endpoint} per ${oneOf(unit)} at a rate`;
  const tier = tiers.rate(input);
  if ("why" in tier) return { unknown: `${bills} ${tier.why}` };
  const extra = tiers.extraUsd?.(input);
  if (extra && "why" in extra) return { unknown: `${bills} plus a charge ${extra.why}` };
  const ratio = tier.rate / tiers.base;
  return { ratio, extraUsd: extra?.usd ?? 0, words: [...(ratio === 1 ? [] : [`× ${shown(ratio)} for ${tier.words} (fal's model page: $${tier.rate} against $${tiers.base})`]), ...(extra ? [`plus $${extra.usd} for ${extra.words}`] : [])] };
}

/** A talking head's voice: its input's audio_url when that is an https URL on fal's own media, written as it parses
 *  (TALKING_HEADS). */
function voiceOf(input: Record<string, unknown>): string | undefined {
  const url = typeof input.audio_url === "string" ? URL.parse(input.audio_url) : null;
  // The cap rests on this check. It assumes a file on fal.media never changes: fal gives each file its own path and
  // never overwrites one, so the voice this meter reads (VOICE_READ, no redirect followed) is the voice fal fetches. If
  // fal ever serves changing bytes at one fal.media URL, this is where the cap breaks. The host is the parsed URL's, so
  // fal.media as a user name, a path or a query is not it.
  // The URL read is the URL fal is sent, as written: one whose parsed form differs (case, spaces, dot segments, a port)
  // is not priced, so no difference between two URL parsers can make the read and fal's fetch two files.
  return url?.protocol === "https:" && url.href === input.audio_url && (url.hostname === "fal.media" || url.hostname.endsWith(".fal.media")) ? url.href : undefined;
}

/** ffmpeg-api/compose's timeline end in seconds: the last keyframe's end across its tracks (timestamp and duration are
 *  milliseconds, by its OpenAPI). */
function composeSeconds(input: Record<string, unknown>): number | undefined {
  const frames = (Array.isArray(input.tracks) ? input.tracks : []).flatMap((track) => (isObject(track) && Array.isArray(track.keyframes) ? track.keyframes : []));
  const ends = frames.map((frame) => (isObject(frame) && typeof frame.timestamp === "number" && frame.timestamp >= 0 && positive(frame.duration) ? frame.timestamp + frame.duration : Number.NaN));
  return ends.length && ends.every(Number.isFinite) ? Math.max(...ends) / 1000 : undefined;
}
const COMPOSE = "fal-ai/ffmpeg-api/compose";

/** The units fal bills a job of `endpoint` by, in `unit` (get_pricing's), read from its `input`. */
export function unitsBefore(endpoint: string, unit: string, input: unknown): Units {
  const bills = `fal bills ${endpoint} per ${oneOf(unit)}`;
  if (AFTER_ONLY.has(unit)) return { unknown: `${bills}, which can't be known before the job runs` };
  if (!isObject(input)) return { unknown: `${bills}, and this job has no input to count them from` };
  if (unit === "images" || unit === "audios") {
    const count = countOf(input, unit);
    return count ? { units: count.n, from: count.from } : { unknown: `${bills}, and this job's input does not say how many as a whole number above 0` };
  }
  if (unit === "megapixels") {
    const count = countOf(input, unit);
    const size = input.image_size;
    const pixels = typeof size === "string" && Object.hasOwn(SIZES, size) ? SIZES[size] : isObject(size) && positive(size.width) && positive(size.height) ? ([size.width, size.height] as const) : undefined;
    if (!count || !pixels) return { unknown: `${bills}, and this job's input names no image_size (a preset such as landscape_4_3, or a width and height) and count to work them out from` };
    return { units: megapixels(pixels[0], pixels[1]) * count.n, from: `image_size ${typeof size === "string" ? size : `${pixels[0]}x${pixels[1]}`}, ${plural(count.n, "image")}` };
  }
  if (unit === "1000 characters") {
    const lines = typeof input.text === "string" ? [input.text] : Array.isArray(input.inputs) ? input.inputs.map((line) => (isObject(line) ? line.text : undefined)) : [];
    if (!lines.length || !lines.every((line): line is string => typeof line === "string")) return { unknown: `${bills}, and this job's input has no text to count` };
    const characters = lines.reduce((sum, line) => sum + line.length, 0);
    return { units: characters / 1000, from: `the ${characters} characters of its ${typeof input.text === "string" ? "text" : plural(lines.length, "line")}` };
  }
  if (unit === "seconds" || unit === "minutes") {
    const per = unit === "minutes" ? 60 : 1;
    if (endpoint === COMPOSE) {
      const end = composeSeconds(input);
      return end ? { units: end / per, from: "its timeline's end" } : { unknown: `${bills}, and this job's tracks have no keyframes with a timestamp and a duration to read its length from` };
    }
    if (TALKING_HEADS.has(endpoint)) {
      const voice = voiceOf(input);
      return voice ? { voice } : { unknown: `fal bills ${endpoint} per ${oneOf(unit)} of the video it makes, as long as the voice at its audio_url, and this job's audio_url is not an https URL on fal.media, written as fal answered it (a voice fal made, or one uploaded to fal): the voice's length is read before the call and fal fetches it again, and only fal's own media is known to serve the same file both times` };
    }
    if (BY_INPUT_MEDIA.has(endpoint)) {
      const media = mediaOf(input);
      return media.length ? { media } : { unknown: `${bills} of the media it is given, and this job's input has no audio_url or video_url` };
    }
    const field = NAMED_LENGTH.get(endpoint);
    if (!field) return { unknown: `${bills}, and no input of this endpoint is known to set the length fal bills, so a length it names is not read` };
    const named = namedSeconds(input, field);
    if (named === "bad") return { unknown: `${bills}, and the length this job's input names is not a number above 0` };
    if (named && "why" in named) return { unknown: `${bills}, and this job's input ${named.why}` };
    return named ? { units: named.seconds / per, from: named.from } : { unknown: `${bills}, and this job's input names no length (its ${field === "music_length_ms" ? "music_length_ms or composition_plan" : field})` };
  }
  return { unknown: `${bills}, a unit this server can't count` };
}

/** The units a completed job's `output` states, in `unit`: its images, their megapixels, a duration in seconds (its own,
 *  or its video's or audio's). Undefined when it states none. */
export function unitsAfter(unit: string, output: unknown): number | undefined {
  if (!isObject(output)) return undefined;
  const images = Array.isArray(output.images) && output.images.length ? output.images : undefined;
  if (unit === "images") return images?.length;
  if (unit === "megapixels") return images?.every((image) => isObject(image) && positive(image.width) && positive(image.height)) ? images.reduce((sum, image) => sum + megapixels(image.width, image.height), 0) : undefined;
  if (unit === "seconds" || unit === "minutes") {
    const seconds = [output.duration, output.duration_seconds, ...[output.video, output.audio].map((file) => (isObject(file) ? file.duration : undefined))].find(positive);
    return seconds === undefined ? undefined : seconds / (unit === "minutes" ? 60 : 1);
  }
  return undefined;
}

/** fal's unit price for `endpoint` in get_pricing's answer: its own entry of `prices`, in USD. */
export function priceIn(answer: unknown, endpoint: string): { unitPrice: number; unit: string } | undefined {
  const prices = isObject(answer) && Array.isArray(answer.prices) ? answer.prices : [];
  const own = prices.find((price) => isObject(price) && price.endpoint_id === endpoint);
  if (!isObject(own) || own.currency !== "USD" || typeof own.unit !== "string" || !own.unit || typeof own.unit_price !== "number" || !Number.isFinite(own.unit_price) || own.unit_price < 0) return undefined;
  return { unitPrice: own.unit_price, unit: own.unit };
}

/** A tool result's body: its structured content, else its text as JSON; undefined when it is neither. */
function bodyOf(result: Record<string, unknown>): unknown {
  if (isObject(result.structuredContent)) return result.structuredContent;
  const text = (Array.isArray(result.content) ? result.content : []).flatMap((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const shown = (n: number) => String(usd(n));

/** How a MediaReader reads: under `maxBytes` (lower than its own cap; never higher), with `httpsOnly` refusing http
 *  on the first hop and at every redirect, and following at most `maxRedirects` (0 to 5; default 5). */
export type MediaRead = { maxBytes?: number; httpsOnly?: boolean; maxRedirects?: number };
/** The bytes of a job's input media at `url`, read before the job is sent; it throws when they can't be read. */
export type MediaReader = (url: string, signal: AbortSignal, read?: MediaRead) => Promise<Uint8Array>;

/** A MediaReader over the public-host guard web_fetch and web_save download through (`guard`: their fetch options),
 *  within web_save's size cap and download slots. */
export const publicMedia = (guard: () => Promise<Omit<PublicFetchOptions, "maxBytes" | "signal" | "httpsOnly" | "maxRedirects">>, slots: SaveSlots = SERVER_SLOTS): MediaReader => async (url, signal, read = {}) => {
  const { publicDownload } = await import("@parcha/pi-browser");
  const bound = AbortSignal.any([signal, AbortSignal.timeout(MEDIA_TIMEOUT_MS)]);
  const release = await slots.take(bound);
  try {
    const file = await publicDownload(url, { ...(await guard()), maxBytes: Math.min(read.maxBytes ?? SAVE_MAX_BYTES, SAVE_MAX_BYTES), httpsOnly: read.httpsOnly === true, maxRedirects: read.maxRedirects, signal: bound });
    if (!file.bytes) throw new Error(`the host answered ${file.status}`);
    return file.bytes;
  } finally {
    release();
  }
};

/** The endpoints fal bills by a length rounded up to a whole step, in seconds: the talking heads in whole seconds
 *  (TALKING_HEADS), ElevenLabs Music and dubbing in whole minutes (fal's model pages, read 2026-11-23: music "will be
 *  rounded up to the closest minute", dubbing "based on the closest minute after rounding upwards"). A job of one is
 *  held, and settled, at its length rounded up to that step. */
const BILLING_STEP: ReadonlyMap<string, number> = new Map([...[...TALKING_HEADS].map((endpoint) => [endpoint, 1] as const), ["fal-ai/elevenlabs/music", 60], ["fal-ai/elevenlabs/dubbing", 60]]);

/** `unitPrice`: get_pricing's rate times its settings' ratio (RATE_TIERS); `extraUsd`: a flat charge its settings add.
 *  `step`: billed by a length rounded up to that many seconds (BILLING_STEP), its stated length rounded up too. */
type Priced = { job: FalJob; holdUsd: number; unitPrice: number; extraUsd: number; unit: string; words: string; at: number; step?: number };
type Unpriced = { job: FalJob; why: string };

/** A reply in which fal says it refused the job's input: status "rejected", or an error of type validation_error or
 *  with field_errors. */
const refusedInput = (item: Record<string, unknown>): boolean =>
  item.status === "rejected" || (isObject(item.error) && (item.error.type === "validation_error" || Array.isArray(item.error.field_errors)));

/** What one job charged, by its reply `item` (run_model's reply, or its own entry of submit_jobs'): $0 when the
 *  submission was replayed or fal refused its input; a completed job's stated units at its unit price (its settings'
 *  rate, RATE_TIERS; in whole steps for one billed so), plus its flat charge; else its hold (still running, or nothing stated). Null for a job with no price whose reply says
 *  it was accepted. A talking head whose output states no length (Fabric) is booked at its hold: the ledger books its
 *  voice's length, read before the call, not a length fal reports. */
function chargeOfJob(quote: Priced | Unpriced, item: unknown): number | null {
  const hold = "holdUsd" in quote ? quote.holdUsd : null;
  if (!isObject(item)) return hold;
  if (item.submission_replayed === true) return 0;
  // fal refused the input before it made a job (no request_id, and a validation error or a rejection it says so in):
  // nothing to bill. Any other reply without a job (a timeout, an unknown error) may hide one, so it stays at its hold.
  if (typeof item.request_id !== "string" && refusedInput(item)) return 0;
  if (!("holdUsd" in quote)) return null;
  const after = item.status === "completed" ? unitsAfter(quote.unit, item.result) : undefined;
  if (after === undefined) return quote.holdUsd;
  return usd(quote.unitPrice * (quote.step ? roundedUp(after, quote.unit, quote.step) : after) + quote.extraUsd);
}

/** `units` of `unit` (seconds or minutes) rounded up to a whole `step` of seconds, in `unit`. Rounded to the
 *  microsecond first, so a length a float sum or a conversion leaves a hair over a whole step (125 frames of 0.024 s)
 *  is that step. */
const roundedUp = (units: number, unit: string, step: number): number => {
  const per = unit === "minutes" ? 60 : 1;
  return (Math.ceil(Math.round(units * per * 1e6) / 1e6 / step) * step) / per;
};

/** fal's tools that take a submission_key: the three that submit jobs, and get_submission, which reads one back. */
const KEYED = new Set(["run_model", "submit_job", "submit_jobs", "get_submission"]);
/** fal's longest submission_key: its tools declare `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. */
const KEY_MAX = 128;
const hex16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** What a run adds to each key: `.` and 16 hex. */
const KEY_TAIL = 17;
/** The longest submission_key an agent can send fal in a run: fal's KEY_MAX less the run's KEY_TAIL. */
export const KEY_ROOM = KEY_MAX - KEY_TAIL;

/** The submission keys of a call of fal's `tool`: its own, and for submit_jobs each request's. */
const keysOf = (tool: string, args: Record<string, unknown>): unknown[] => [args.submission_key, ...(tool === "submit_jobs" && Array.isArray(args.requests) ? args.requests.map((one: unknown) => (isObject(one) ? one.submission_key : undefined)) : [])];

/** The submission keys of one run on fal's hosted server (McpMeter.keys). fal's journal is per account, so the same key
 *  from two runs (a model makes the same key for the same task) would bind the second run's request to the first's and be
 *  refused. Each key leaves as the agent's key and `.<16 hex of the run>`: the same run's key leaves the same each time,
 *  on every claim of it, so a retry is deduped, and another run's never matches it. A key with no room for that suffix
 *  (over KEY_ROOM) is refused unsent, in words. `back` reads each scoped key in a reply as the agent's by taking the
 *  suffix off. */
export function falKeys(run: string): McpKeys {
  const mark = hex16(`agentrun fal submission_key\0${run}`);
  const scoped = (key: unknown): unknown => (typeof key === "string" && key ? `${key}.${mark}` : key);
  // The suffix where a key ends: one pass, so an agent's key that itself ends like a scoped one keeps that ending.
  const suffix = new RegExp(`\\.${mark}(?![A-Za-z0-9._:-])`, "g");
  return {
    refused(tool, args) {
      if (!KEYED.has(tool)) return undefined;
      const long = keysOf(tool, args).find((key): key is string => typeof key === "string" && key.length > KEY_ROOM);
      return long === undefined ? undefined : `its submission_key ${long.slice(0, 24)}… is ${long.length} characters, over the ${KEY_ROOM} a run can send fal (fal takes ${KEY_MAX}, and the run adds ${KEY_TAIL} to keep its keys its own): send a shorter key`;
    },
    out(tool, args) {
      if (!KEYED.has(tool)) return args;
      let sent = Object.hasOwn(args, "submission_key") ? { ...args, submission_key: scoped(args.submission_key) } : args;
      if (tool === "submit_jobs" && Array.isArray(args.requests)) sent = { ...sent, requests: args.requests.map((one: unknown) => (isObject(one) && Object.hasOwn(one, "submission_key") ? { ...one, submission_key: scoped(one.submission_key) } : one)) };
      return sent;
    },
    back: (text) => (text.includes(mark) ? text.replace(suffix, "") : text),
  };
}

/** A fal server's meter: fal's unit prices read through the gateway's `ask`, kept per endpoint for PRICE_TTL_MS.
 *  `media` reads an input media file (none: such a job is unpriceable); `now`, the clock. */
export function falMeter({ media, now = Date.now }: { media?: MediaReader; now?: () => number } = {}): McpMeter {
  const prices = new Map<string, { unitPrice: number; unit: string; at: number }>();
  const unitPrice = async (endpoint: string, ask: Parameters<McpMeter["quote"]>[2]): Promise<{ unitPrice: number; unit: string; at: number } | { why: string }> => {
    const kept = prices.get(endpoint);
    if (kept && now() - kept.at < PRICE_TTL_MS) return kept;
    const answer = await ask("get_pricing", { endpoint_id: endpoint });
    const unread = (why: string) => ({ why: `fal's price for ${endpoint} could not be read (its get_pricing ${why})` });
    if (!answer) return unread("did not answer");
    if (answer.isError === true) return unread("answered an error");
    const price = priceIn(bodyOf(answer), endpoint);
    if (!price) return unread("lists no USD price for it");
    const read = { ...price, at: now() };
    prices.set(endpoint, read);
    return read;
  };
  /** The longest of the media at `urls`, in seconds by `measure`, or the URL whose length could not be read. */
  const longest = async (urls: readonly string[], signal: AbortSignal, read?: MediaRead, measure: (bytes: Uint8Array) => number | undefined = mediaSeconds): Promise<number | { unread: string }> => {
    const lengths = await Promise.all([...new Set(urls)].map(async (url) => {
      try {
        return (media && measure(await media(url, signal, read))) || { unread: url };
      } catch {
        return { unread: url };
      }
    }));
    return lengths.find((one): one is { unread: string } => typeof one !== "number") ?? Math.max(...(lengths as number[]));
  };
  const quoteJob = async (job: FalJob, ask: Parameters<McpMeter["quote"]>[2], signal: AbortSignal): Promise<Priced | Unpriced> => {
    if (!job.endpoint) return { job, why: "this job names no endpoint_id to price" };
    const price = await unitPrice(job.endpoint, ask);
    if ("why" in price) return { job, why: price.why };
    // The rate its settings are billed at, before any media is read for a job that can't be priced.
    const rate = rateOf(job.endpoint, price.unit, job.input);
    if ("unknown" in rate) return { job, why: rate.unknown };
    let units = unitsBefore(job.endpoint, price.unit, job.input);
    if ("media" in units) {
      const seconds = await longest(units.media, signal);
      if (typeof seconds !== "number") return { job, why: `fal bills ${job.endpoint} per ${oneOf(price.unit)} of its input media, and the length of ${seconds.unread.slice(0, 200)} could not be read` };
      units = { units: seconds / (price.unit === "minutes" ? 60 : 1), from: units.media.length > 1 ? "the longest of its input media, read before the call" : "its input media's length, read before the call" };
    }
    if ("voice" in units) {
      // The length the voice plays (voiceSeconds), never one its header states: whoever sends the job made the file.
      const seconds = await longest([units.voice], signal, VOICE_READ, voiceSeconds);
      if (typeof seconds !== "number") return { job, why: `fal bills ${job.endpoint} per ${oneOf(price.unit)} of the voice at its audio_url, and the length of ${seconds.unread.slice(0, 200)} could not be read` };
      units = { units: seconds / (price.unit === "minutes" ? 60 : 1), from: "its voice at audio_url, read before the call" };
    }
    if ("unknown" in units) return { job, why: units.unknown };
    const step = price.unit === "seconds" || price.unit === "minutes" ? BILLING_STEP.get(job.endpoint) : undefined;
    if (step) units = { units: roundedUp(units.units, price.unit, step), from: `${units.from}, in whole ${step === 60 ? "minutes" : "seconds"}` };
    const rated = price.unitPrice * rate.ratio;
    const words = [`fal's price for ${job.endpoint}: $${price.unitPrice} per ${oneOf(price.unit)}`, ...rate.words.filter((word) => word.startsWith("×")), `× ${shown(units.units)} (${units.from})`, ...rate.words.filter((word) => word.startsWith("plus"))].join(" ");
    return { job, holdUsd: usd(rated * units.units + rate.extraUsd), unitPrice: rated, extraUsd: rate.extraUsd, unit: price.unit, at: price.at, words, ...(step ? { step } : {}) };
  };
  return {
    bills: falBills,
    async quote(tool, args, ask, signal): Promise<McpQuote> {
      const quotes: (Priced | Unpriced)[] = [];
      // One at a time: each endpoint's price is read once, the next job's from what the last one kept.
      for (const job of falJobsOf(tool, args) ?? []) quotes.push(await quoteJob(job, ask, signal));
      const priced = quotes.filter((quote): quote is Priced => "holdUsd" in quote);
      const unpriced = quotes.find((quote): quote is Unpriced => "why" in quote);
      const basis = priced.length ? `${priced.map((quote) => quote.words).join("; ")}, from get_pricing at ${new Date(Math.min(...priced.map((quote) => quote.at))).toISOString()}` : "fal's price for it could not be worked out";
      const holdUsd = usd(priced.reduce((sum, quote) => sum + quote.holdUsd, 0));
      return {
        holdUsd,
        basis: unpriced && priced.length ? `${basis}; not counting what could not be priced` : basis,
        ...(unpriced ? { unpriceable: unpriced.why } : {}),
        chargeOf(reply) {
          // A reply lost after the call left: each job at the hold it was sent at, unknown when one had no price.
          if (!reply) return unpriced ? null : holdUsd;
          const body = bodyOf(reply);
          if (tool !== "submit_jobs") return chargeOfJob(quotes[0]!, body);
          // submit_jobs: each job by its own entry of the reply, matched by the index the call gave it.
          const lists = isObject(body) ? Object.values(body).filter((value): value is Record<string, unknown>[] => Array.isArray(value) && value.length > 0 && value.every((item) => isObject(item) && Number.isInteger(item.index))) : [];
          const items = lists[0];
          // A reply that lists no job by its index: read as one, each job at its hold.
          if (!items) return unpriced ? null : holdUsd;
          let total = 0;
          for (const [at, quote] of quotes.entries()) {
            const charge = chargeOfJob(quote, items.find((item) => item.index === (quote.job.index ?? at)) ?? "missing");
            if (charge === null) return null;
            total += charge;
          }
          return usd(total);
        },
      };
    },
  };
}

/** The meter of a pinned server (mcp-gateway.ts McpPin entry): fal's for one marked `fal` at its save, or, for a pin made
 *  before servers were marked, one whose URL is on fal's MCP host. Only a server at fal's host scopes its submission keys
 *  to `run` (falKeys): the journal they collide in is that server's, and a server marked `fal` elsewhere (a template
 *  eval's fake, whose answers and log graders read by the agent's own key) receives them as the agent sent them. */
export const meterFor = (pinned: { url: string; meter?: string }, { run, ...deps }: Parameters<typeof falMeter>[0] & { run?: string } = {}): McpMeter | undefined => {
  if (!meterNamed(pinned.url, pinned.meter)) return undefined;
  const meter = falMeter(deps);
  return run && onFalHost(pinned.url) ? { ...meter, keys: falKeys(run) } : meter;
};
