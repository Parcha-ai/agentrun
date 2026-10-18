// Speech-to-text models for `vision.transcribe`, one a provider, each reached with the host's own key: fal's queue
// (directly with `Authorization: Key`, or through a pass-through that takes a bearer key), ElevenLabs' speech-to-text,
// and OpenAI's transcriptions with `whisper-1` (the one OpenAI model that gives word times). The host passes a function
// that returns the key at each request; nothing a transcriber returns or throws carries it. Words come back in one
// shape whatever the provider gave: `{ text, start, end }` in seconds.
import { ProviderMiss } from "./core/derive.js";
import type { Transcriber, TranscriptWord } from "./core/transcribe.js";

type Fetch = typeof globalThis.fetch;
type Common = {
  /** The key for each request, read when the request is made. */
  readonly apiKey: () => string | undefined;
  /** The list price per audio minute, when the host knows it; absent, prices are unknown (null). */
  readonly usdPerMinute?: number;
  readonly fetch?: Fetch;
};

/** The provider's words as `{ text, start, end }`, without spacing or sound entries. */
const words = (list: unknown): TranscriptWord[] => (Array.isArray(list) ? list : []).flatMap((w: Record<string, unknown>) => {
  if (w.type !== undefined && w.type !== "word") return [];
  const text = String(w.word ?? w.text ?? "").trim();
  return text && typeof w.start === "number" && typeof w.end === "number" ? [{ text, start: w.start, end: w.end }] : [];
});
/** The body of a refused request, never the request: a key is in its headers. */
async function refused(res: Response, what: string): Promise<never> {
  throw new Error(`${what}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
}
/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
const pause = (ms: number, signal: AbortSignal | undefined) => new Promise<void>((done, fail) => {
  if (signal?.aborted) return fail(signal.reason);
  const stop = () => { clearTimeout(timer); fail(signal!.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); done(); }, ms);
  signal?.addEventListener("abort", stop, { once: true });
});
const key = (options: Common, provider: string): string => {
  const value = options.apiKey()?.trim();
  if (!value) throw new Error(`no ${provider} key: the host's apiKey returned none`);
  return value;
};

export type FalTranscriberOptions = Common & {
  /** Default `fal-ai/elevenlabs/speech-to-text/scribe-v2`. */
  readonly model?: string;
  /** Default `https://queue.fal.run`; a pass-through's address takes its place, and fal's own addresses in its
   *  answers are rewritten to it. */
  readonly queueUrl?: string;
  /** `key` sends `Authorization: Key <key>` (fal's own); `bearer` sends `Authorization: Bearer <key>` (a pass-through). */
  readonly auth?: "key" | "bearer";
  /** Default one second. */
  readonly pollMs?: number;
  /** Default ten minutes: a job with no answer by then fails the request. */
  readonly timeoutMs?: number;
};

/** fal's queue: the audio goes inline as a data URI. fal states no size limit; 2.5 MB (10 minutes 25 seconds at 32 kbps;
 *  a ten-minute piece ffmpeg cuts runs a little over its 2.4 MB) was measured to work, 4.8 MB to fail. */
export function falTranscriber(options: FalTranscriberOptions): Transcriber {
  const model = options.model ?? "fal-ai/elevenlabs/speech-to-text/scribe-v2";
  const queue = (options.queueUrl ?? "https://queue.fal.run").replace(/\/+$/, "");
  const fetch = options.fetch ?? globalThis.fetch;
  const via = (url: string) => url.replace("https://queue.fal.run", queue);
  const usd = options.usdPerMinute ?? (model === "fal-ai/elevenlabs/speech-to-text/scribe-v2" ? 0.008 : undefined);
  return {
    provider: "fal", model, maxBytes: 2_500_000, limit: "2.5 MB (measured: 10 minutes 25 seconds at 32 kbps)",
    ...(usd === undefined ? {} : { usdPerMinute: usd }),
    async transcribe(audio, request, signal) {
      const auth = () => ({ Authorization: `${options.auth === "bearer" ? "Bearer" : "Key"} ${key(options, "fal")}` });
      const timeoutMs = options.timeoutMs ?? 600_000;
      const body = JSON.stringify({ audio_url: `data:${audio.mimeType};base64,${Buffer.from(audio.bytes).toString("base64")}`, diarize: false, tag_audio_events: false, ...(request.language ? { language_code: request.language } : {}) });
      const submitted = await fetch(`${queue}/${model}`, { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body, ...(signal ? { signal } : {}) });
      if (!submitted.ok) await refused(submitted, "fal refused the request");
      const job = (await submitted.json()) as { status_url: string; response_url: string };
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const polled = await fetch(via(job.status_url), { headers: auth(), ...(signal ? { signal } : {}) });
        if (!polled.ok) await refused(polled, "fal refused a status poll");
        const { status, error } = (await polled.json()) as { status?: string; error?: string };
        if (error) throw new Error(`fal: ${String(error).slice(0, 300)}`);
        if (status === "COMPLETED") break;
        if (Date.now() >= deadline) throw new Error(`fal: no answer within timeoutMs ${timeoutMs}; the job was ${status ?? "without a status"}`);
        await pause(options.pollMs ?? 1000, signal);
      }
      const answered = await fetch(via(job.response_url), { headers: auth(), ...(signal ? { signal } : {}) });
      if (!answered.ok) await refused(answered, "fal refused the answer");
      const answer = (await answered.json()) as { text?: string; words?: unknown; error?: unknown };
      if (!Array.isArray(answer.words)) throw new Error(`fal: no words (${JSON.stringify(answer.error ?? answer).slice(0, 300)})`);
      return { words: words(answer.words), text: answer.text ?? "" };
    },
  };
}

export type ElevenLabsTranscriberOptions = Common & {
  /** Default `scribe_v2`. */
  readonly model?: string;
  /** Default `https://api.elevenlabs.io`, or a regional host. */
  readonly baseUrl?: string;
};

/** ElevenLabs' speech-to-text: multipart, the key as `xi-api-key`; files up to 3 GB and 10 hours. */
export function elevenLabsTranscriber(options: ElevenLabsTranscriberOptions): Transcriber {
  const model = options.model ?? "scribe_v2";
  const base = (options.baseUrl ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    provider: "elevenlabs", model, maxBytes: 3e9, limit: "3 GB",
    ...(options.usdPerMinute === undefined ? {} : { usdPerMinute: options.usdPerMinute }),
    async transcribe(audio, request, signal) {
      const form = new FormData();
      form.set("model_id", model);
      form.set("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }), audio.name);
      form.set("timestamps_granularity", "word");
      form.set("tag_audio_events", "false");
      form.set("diarize", "false");
      if (request.language) form.set("language_code", request.language);
      const res = await fetch(`${base}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": key(options, "ElevenLabs") }, body: form, ...(signal ? { signal } : {}) });
      if (!res.ok) await refused(res, "ElevenLabs refused the request");
      const answer = (await res.json()) as { text?: string; words?: unknown };
      return { words: words(answer.words), text: answer.text ?? "", model };
    },
  };
}

export type OpenAiTranscriberOptions = Common & {
  /** Default `whisper-1`: OpenAI gives word times only from it (`verbose_json` with word granularity). At OpenAI's own
   *  address another model is an `unsupported` miss before any request; a compatible server at `baseUrl` is asked as
   *  named, and an answer without word times is the same miss. */
  readonly model?: string;
  /** Default `https://api.openai.com/v1`. */
  readonly baseUrl?: string;
};

/** OpenAI's transcriptions: multipart, a bearer key, `verbose_json` with word times; files up to 25 MB. */
export function openAiTranscriber(options: OpenAiTranscriberOptions): Transcriber {
  const model = options.model ?? "whisper-1";
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const untimed = base === "https://api.openai.com/v1" && model !== "whisper-1";
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    provider: "openai", model, maxBytes: 25e6, limit: "25 MB",
    ...(options.usdPerMinute === undefined ? {} : { usdPerMinute: options.usdPerMinute }),
    async transcribe(audio, request, signal) {
      if (untimed) throw new ProviderMiss("unsupported", `OpenAI gives word times only from whisper-1; ${model} answers with text alone, and vision.transcribe never gives words without their seconds`);
      const form = new FormData();
      form.set("model", model);
      form.set("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }), audio.name);
      form.set("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      if (request.language) form.set("language", request.language);
      const res = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key(options, "OpenAI")}` }, body: form, ...(signal ? { signal } : {}) });
      if (!res.ok) await refused(res, "OpenAI refused the request");
      const answer = (await res.json()) as { text?: string; words?: unknown; duration?: number };
      return { words: words(answer.words), text: answer.text ?? "", model, ...(typeof answer.duration === "number" ? { durationS: answer.duration } : {}) };
    },
  };
}
