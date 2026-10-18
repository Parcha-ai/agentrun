// Fake speech-to-text providers: a `fetch` that answers each provider's documented request with its documented answer
// (fal's queue: a submit, a status poll that is IN_PROGRESS once and then COMPLETED, words with spacing entries;
// ElevenLabs' multipart answer; OpenAI's verbose_json with word times and the file's duration), and a ledger of every
// request with its headers and fields, so a test sees the call a provider's own key would make. No network.

/** A word as the fake answers it, in seconds. */
export type FakeWord = { readonly text: string; readonly start: number; readonly end: number };
/** One request the fake provider received: its address, method, headers and fields. */
export type FakeTranscriptionRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON fields, or each multipart field as its text, a file as `{ name, type, size }`. */
  readonly fields: Readonly<Record<string, unknown>>;
};

/** `fetch` for one provider: it answers with `words` (and `durationS`, which only OpenAI states), or refuses every
 *  request with `refuse`. */
export function fakeTranscriptionFetch(provider: "fal" | "elevenlabs" | "openai", answer: { readonly words: readonly FakeWord[]; readonly durationS?: number; readonly refuse?: { readonly status: number; readonly body: string } }): { readonly fetch: typeof globalThis.fetch; readonly requests: FakeTranscriptionRequest[] } {
  const requests: FakeTranscriptionRequest[] = [];
  const polls = new Map<string, number>();
  const text = answer.words.map((w) => w.text).join(" ");
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const fields: Record<string, unknown> = {};
    if (init.body instanceof FormData) {
      for (const [name, value] of init.body.entries()) fields[name] = typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size };
    } else if (typeof init.body === "string") Object.assign(fields, JSON.parse(init.body) as Record<string, unknown>);
    requests.push({ url, method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string>) }, fields });
    if (answer.refuse) return new Response(answer.refuse.body, { status: answer.refuse.status });
    if (provider === "elevenlabs") {
      return reply({ language_code: "eng", language_probability: 1, text, words: answer.words.flatMap((w, i) => [...(i ? [{ text: " ", type: "spacing", logprob: 0, start: w.start, end: w.start }] : []), { text: w.text, type: "word", logprob: -0.01, start: w.start, end: w.end, speaker_id: null }]) });
    }
    if (provider === "openai") return reply({ task: "transcribe", language: "english", text, ...(answer.durationS === undefined ? {} : { duration: answer.durationS }), words: answer.words.map((w) => ({ word: w.text, start: w.start, end: w.end })) });
    const request = /\/requests\/([^/]+)(\/status)?$/.exec(new URL(url).pathname);
    if (!request) {
      const id = `fake-${requests.length}`;
      const at = `https://queue.fal.run/fal-ai/elevenlabs/requests/${id}`;
      return reply({ status: "IN_QUEUE", request_id: id, status_url: `${at}/status`, response_url: at, cancel_url: `${at}/cancel` });
    }
    const id = request[1]!;
    if (request[2]) {
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      return reply({ status: n === 1 ? "IN_PROGRESS" : "COMPLETED", request_id: id });
    }
    return reply({ text, language_code: "eng", language_probability: 1, words: answer.words.flatMap((w, i) => [...(i ? [{ text: " ", start: w.start, end: w.start, type: "spacing", speaker_id: null }] : []), { text: w.text, start: w.start, end: w.end, type: "word", speaker_id: null }]) });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}
