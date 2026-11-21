// fal's pricing, for the run's MCP gateway (mcp-gateway.ts McpMeter): a job sent to a fal MCP server (run_model,
// submit_job, each request of submit_jobs) is priced before it leaves, at fal's unit price for its endpoint times the
// units fal bills it by.
//  - The unit price is the server's own get_pricing, asked with exactly `{ endpoint_id: "<id>" }` (a contract: a fake
//    server matches arguments by equality), one endpoint a call, kept PRICE_TTL_MS.
//  - The units are read from the job's input (unitsBefore). Nothing is guessed: an input that leaves out the size or
//    length its model would default is unpriceable.
//  - fal's reply states no cost, so the charge is this estimate (chargeOfJob).
// fal can bill what get_pricing does not expose (a minimum, a discount, a rate that depends on a setting such as
// resolution): a booked figure is fal's list price for the job, not its invoice.
// fal's hosted server also keeps one submission_key journal per fal account, which refuses a key it has seen with another
// request: a server at fal's own host scopes each key to the run before it leaves (falKeys).
import { createHash } from "node:crypto";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import type { McpKeys, McpMeter, McpQuote } from "./mcp-gateway.js";
import { mediaSeconds } from "./media-duration.js";
import { SAVE_MAX_BYTES, type SaveSlots, SERVER_SLOTS } from "./web-save.js";

/** The host of fal's hosted MCP server (its key endpoint /mcp and its sign-in endpoint /mcp-relay). */
export const FAL_MCP_HOST = "mcp.fal.ai";
/** A pin's `meter` for a fal server. */
export const FAL_METER = "fal";
/** How long a unit price read from get_pricing is used. */
export const PRICE_TTL_MS = 5 * 60_000;
/** One deadline for reading an input media file's length. */
export const MEDIA_TIMEOUT_MS = 120_000;

/** Whether a saved server is fal's: its owner's toolkit for it is `fal`, or its URL is on fal's MCP host. */
export function falServer(url: string, toolkit?: string | null): boolean {
  return toolkit === FAL_METER || URL.parse(url)?.hostname === FAL_MCP_HOST;
}
/** The `meter` a save pins for a server at `url` with `toolkit` (mcp-gateway.ts mcpPinOf). */
export const meterNamed = (url: string, toolkit?: string | null): string | undefined => (falServer(url, toolkit) ? FAL_METER : undefined);

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
 *  URLs whose length it is billed by (the longest); or `unknown`, why they can't be known, in words. */
export type Units = { units: number; from: string } | { media: string[] } | { unknown: string };

/** How many outputs the input asks for (num_images, else num_outputs, else 1), or undefined for a count that is none. */
function countOf(input: Record<string, unknown>, unit: string): { n: number; from: string } | undefined {
  const field = input.num_images !== undefined ? "num_images" : input.num_outputs !== undefined ? "num_outputs" : undefined;
  if (!field) return { n: 1, from: `1 ${oneOf(unit === "megapixels" ? "images" : unit)} by default` };
  const n = input[field];
  return Number.isInteger(n) && (n as number) > 0 ? { n: n as number, from: field } : undefined;
}

/** The length in seconds the input names: `duration` ("5", "5s" or a number), duration_seconds, seconds_total,
 *  music_length_ms, or a music composition plan's sections. */
function namedSeconds(input: Record<string, unknown>): { seconds: number; from: string } | "bad" | undefined {
  for (const [field, per] of [["duration", 1], ["duration_seconds", 1], ["seconds_total", 1], ["music_length_ms", 1000]] as const) {
    const given = input[field];
    if (given === undefined) continue;
    const said = typeof given === "string" && /^\d+(\.\d+)?s?$/.test(given.trim()) ? Number.parseFloat(given) : given;
    return positive(said) ? { seconds: said / per, from: field } : "bad";
  }
  const sections = isObject(input.composition_plan) ? input.composition_plan.sections : undefined;
  if (Array.isArray(sections) && sections.length) {
    const each = sections.map((section) => (isObject(section) ? section.duration_ms : undefined));
    return each.every(positive) ? { seconds: each.reduce((sum, ms) => sum + ms, 0) / 1000, from: "its composition plan's sections" } : "bad";
  }
  return undefined;
}

/** The audio and video URLs among the input's own fields (audio_url, video_url, video_urls, ...): an image has no length. */
function mediaOf(input: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const [field, value] of Object.entries(input)) {
    if (!/(audio|video)_urls?$/.test(field)) continue;
    for (const one of Array.isArray(value) ? value : [value]) if (typeof one === "string" && one) urls.push(one);
  }
  return urls;
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
    const named = namedSeconds(input);
    if (named === "bad") return { unknown: `${bills}, and the length this job's input names is not a number above 0` };
    if (named) return { units: named.seconds / per, from: named.from };
    const media = mediaOf(input);
    if (media.length) return { media };
    return { unknown: `${bills}, and this job's input names no length (duration, duration_seconds, seconds_total or music_length_ms)` };
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

/** In whole millionths of a dollar. */
const usd = (dollars: number) => Math.round(dollars * 1e6) / 1e6;
const shown = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** The bytes of a job's input media at `url`, read before the job is sent; it throws when they can't be read. */
export type MediaReader = (url: string, signal: AbortSignal) => Promise<Uint8Array>;

/** A MediaReader over the public-host guard web_fetch and web_save download through (`guard`: their fetch options),
 *  within web_save's size cap and download slots. */
export const publicMedia = (guard: () => Promise<Omit<PublicFetchOptions, "maxBytes" | "signal">>, slots: SaveSlots = SERVER_SLOTS): MediaReader => async (url, signal) => {
  const { publicDownload } = await import("@parcha/pi-browser");
  const bound = AbortSignal.any([signal, AbortSignal.timeout(MEDIA_TIMEOUT_MS)]);
  const release = await slots.take(bound);
  try {
    const file = await publicDownload(url, { ...(await guard()), maxBytes: SAVE_MAX_BYTES, signal: bound });
    if (!file.bytes) throw new Error(`the host answered ${file.status}`);
    return file.bytes;
  } finally {
    release();
  }
};

type Priced = { job: FalJob; holdUsd: number; unitPrice: number; unit: string; words: string; at: number };
type Unpriced = { job: FalJob; why: string };

/** A reply in which fal says it refused the job's input: status "rejected", or an error of type validation_error or
 *  with field_errors. */
const refusedInput = (item: Record<string, unknown>): boolean =>
  item.status === "rejected" || (isObject(item.error) && (item.error.type === "validation_error" || Array.isArray(item.error.field_errors)));

/** What one job charged, by its reply `item` (run_model's reply, or its own entry of submit_jobs'): $0 when the
 *  submission was replayed or fal refused its input; a completed job's stated units at its unit price; else its hold
 *  (still running, or nothing stated). Null for a job with no price whose reply says it was accepted. */
function chargeOfJob(quote: Priced | Unpriced, item: unknown): number | null {
  const hold = "holdUsd" in quote ? quote.holdUsd : null;
  if (!isObject(item)) return hold;
  if (item.submission_replayed === true) return 0;
  // fal refused the input before it made a job (no request_id, and a validation error or a rejection it says so in):
  // nothing to bill. Any other reply without a job (a timeout, an unknown error) may hide one, so it stays at its hold.
  if (typeof item.request_id !== "string" && refusedInput(item)) return 0;
  if (!("holdUsd" in quote)) return null;
  const after = item.status === "completed" ? unitsAfter(quote.unit, item.result) : undefined;
  return after === undefined ? quote.holdUsd : usd(quote.unitPrice * after);
}

/** fal's tools that take a submission_key: the three that submit jobs, and get_submission, which reads one back. */
const KEYED = new Set(["run_model", "submit_job", "submit_jobs", "get_submission"]);
/** fal's longest submission_key: its tools declare `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. */
export const KEY_MAX = 128;
const hex16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The submission keys of one run on fal's hosted server (McpMeter.keys). fal's journal is per account, so the same key
 *  from two runs (a model makes the same key for the same task) would bind the second run's request to the first's and be
 *  refused. Each key leaves as the agent's key and `.<16 hex of the run>`: the same run's key leaves the same each time,
 *  so a retry is deduped, and another run's never matches it. A key too long for KEY_MAX with that suffix keeps its start
 *  and a hash of the whole key in its place, never cut into another key, and ends `:<16 hex of the run>` instead: its
 *  shortened start is itself a valid key, and the different mark keeps an agent key that spells it from leaving as the
 *  same key. `back` reads each scoped key in a reply as the agent's: by the keys this gateway sent, else by taking the
 *  suffix off. */
export function falKeys(run: string): McpKeys {
  const mark = hex16(`agentrun fal submission_key\0${run}`);
  const tail = mark.length + 1;
  const own = new Map<string, string>();
  const scoped = (key: unknown): unknown => {
    if (typeof key !== "string" || !key) return key;
    const sent = key.length + tail <= KEY_MAX ? `${key}.${mark}` : `${key.slice(0, KEY_MAX - tail - 17)}.${hex16(key)}:${mark}`;
    own.set(sent, key);
    return sent;
  };
  const anyScoped = new RegExp(`[A-Za-z0-9._:-]+[.:]${mark}(?![A-Za-z0-9._:-])`, "g");
  return {
    out(tool, args) {
      if (!KEYED.has(tool)) return args;
      let sent = Object.hasOwn(args, "submission_key") ? { ...args, submission_key: scoped(args.submission_key) } : args;
      if (tool === "submit_jobs" && Array.isArray(args.requests)) sent = { ...sent, requests: args.requests.map((one: unknown) => (isObject(one) && Object.hasOwn(one, "submission_key") ? { ...one, submission_key: scoped(one.submission_key) } : one)) };
      return sent;
    },
    back(text) {
      if (!text.includes(mark)) return text;
      // One pass: a key read back once is never read again, so an agent's key that ends like a scoped one stays as it is.
      const known = [...own.keys()].sort((a, b) => b.length - a.length);
      return text.replace(anyScoped, (token) => {
        const sent = known.find((key) => token.endsWith(key));
        return sent ? `${token.slice(0, -sent.length)}${own.get(sent)}` : token.slice(0, -tail);
      });
    },
  };
}

/** A fal server's meter: fal's unit prices read through the gateway's `ask`, kept per endpoint for PRICE_TTL_MS.
 *  `media` reads an input media file (none: such a job is unpriceable); `now`, the clock; `run`, the run whose
 *  submission keys it scopes (falKeys; none: they leave as the agent sent them). */
export function falMeter({ media, now = Date.now, run }: { media?: MediaReader; now?: () => number; run?: string } = {}): McpMeter {
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
  /** The longest of the media at `urls`, in seconds, or the URL whose length could not be read. */
  const longest = async (urls: readonly string[], signal: AbortSignal): Promise<number | { unread: string }> => {
    const lengths = await Promise.all([...new Set(urls)].map(async (url) => {
      try {
        return (media && mediaSeconds(await media(url, signal))) || { unread: url };
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
    let units = unitsBefore(job.endpoint, price.unit, job.input);
    if ("media" in units) {
      const seconds = await longest(units.media, signal);
      if (typeof seconds !== "number") return { job, why: `fal bills ${job.endpoint} per ${oneOf(price.unit)} of its input media, and the length of ${seconds.unread.slice(0, 200)} could not be read` };
      units = { units: seconds / (price.unit === "minutes" ? 60 : 1), from: units.media.length > 1 ? "the longest of its input media, read before the call" : "its input media's length, read before the call" };
    }
    if ("unknown" in units) return { job, why: units.unknown };
    return { job, holdUsd: usd(price.unitPrice * units.units), unitPrice: price.unitPrice, unit: price.unit, at: price.at, words: `fal's price for ${job.endpoint}: $${price.unitPrice} per ${oneOf(price.unit)} × ${shown(units.units)} (${units.from})` };
  };
  return {
    ...(run ? { keys: falKeys(run) } : {}),
    bills: (tool) => falJobsOf(tool, {}) !== undefined,
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
          if (!reply) return null;
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
 *  to `deps.run`: the journal they collide in is that server's, and a server marked `fal` elsewhere (a template eval's
 *  fake, whose answers and log graders read by the agent's own key) receives them as the agent sent them. */
export const meterFor = (pinned: { url: string; meter?: string }, deps?: Parameters<typeof falMeter>[0]): McpMeter | undefined => {
  if (!falServer(pinned.url, pinned.meter)) return undefined;
  const { run, ...rest } = deps ?? {};
  return falMeter({ ...rest, ...(run && URL.parse(pinned.url)?.hostname === FAL_MCP_HOST ? { run } : {}) });
};
