// `runs.wait` and `runs.follow`: a run until it ends or waits on a person, and its timeline as it changes. Hand-written
// over the timeline route's two forms, the long-polled JSON page and the event stream, as the CLI's follow.mjs is.
import { backoff, LATE, pause, segmentOf, wholeMs, type Exchange } from "./http.js";
import { AgentRunError, AgentRunRefused, AgentRunTimeout, AgentRunUnreachable, AgentRunUsage } from "./errors.js";
import type { Run, TimelinePage } from "./operations.generated.js";

type Send = (x: Exchange) => Promise<Response>;

export interface WaitOptions {
  /** Stop waiting after this many milliseconds: AgentRunTimeout, and the run goes on. Default: no limit. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FollowOptions {
  /** How long the stream may stay silent, waiting on the server, before it counts as a dropped connection and is
   *  reconnected (default 45000: three of its 15 s keepalives missed). */
  idleMs?: number;
  /** Start after this change number (the timeline's `next_after`). */
  after?: number;
  /** Resume after this event id, as a reconnect does; wins over `after`. */
  lastEventId?: string;
  signal?: AbortSignal;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
// What moves only once a person acts: input_required (a question, the spend cap, a stopped turn) and a workflow's paused.
const PERSON = new Set(["input_required", "paused"]);
const MAX_WAIT_MS = 25_000; // the route's wait_ms maximum
const IDLE_MS = 45_000; // three of the stream's 15 s keepalives missed: the connection is gone
const LAST_READ_MS = 1_000; // the read of the run once a wait's time is up
const RETRIES = 5; // tries in a row that get no event before follow gives up

const TIMELINE = "GET /runs/{run_id}/timeline";
const RUN = "GET /runs/{run_id}";

/** GET `path` as a JSON object, retried as any GET is, ending by `deadline`. */
async function getJson<T>(send: Send, path: string, route: string, deadline: number, signal?: AbortSignal): Promise<T> {
  const response = await send({ method: "GET", path, route, retryable: true, signal, deadline, timeoutMs: MAX_WAIT_MS + IDLE_MS });
  const text = await response.text();
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  } catch {
    // refused below
  }
  throw new AgentRunRefused(route, response.status, "bad_answer", undefined, `The server's answer to ${route} is not a JSON object.`);
}

/** Long-polls the timeline from change to change and reads the run when a page says it ended or waits on a person. */
export async function waitRun(send: Send, runId: string, options: WaitOptions = {}): Promise<Run> {
  const id = segmentOf(runId, "runId", false);
  const { timeoutMs, signal } = options;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new AgentRunUsage("timeoutMs must be a number of milliseconds above 0.");
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + wholeMs(timeoutMs);
  let after = 0;
  let last: Run | undefined;
  const late = async (): Promise<never> => {
    try {
      last = await getJson<Run>(send, `/runs/${id}`, RUN, Date.now() + LAST_READ_MS, signal);
    } catch (error) {
      if (error !== LATE && !(error instanceof AgentRunUnreachable)) throw error;
    }
    throw new AgentRunTimeout(runId, wholeMs(timeoutMs!), last);
  };
  const ended = (status: string, final: boolean) => (TERMINAL.has(status) && final) || PERSON.has(status);
  try {
    for (let first = true; ; first = false) {
      const left = deadline - Date.now();
      if (left <= 0) return await late();
      const waitMs = first ? 0 : Math.min(MAX_WAIT_MS, Math.ceil(left));
      const page = await getJson<TimelinePage>(send, `/runs/${id}/timeline?after=${after}&wait_ms=${waitMs}`, TIMELINE, deadline, signal);
      if (!Number.isInteger(page.next_after) || typeof page.status !== "string") throw new AgentRunRefused(TIMELINE, 200, "bad_answer", undefined, `The server's answer to ${TIMELINE} is not a timeline page.`);
      after = page.next_after;
      if (ended(page.status, page.final === true)) {
        const run = await getJson<Run>(send, `/runs/${id}`, RUN, deadline, signal);
        last = run;
        // A message can reopen the run between the two reads: then it is waited for again.
        if (ended(run.status, true)) return run;
      }
      if (page.unchanged && !page.has_more) await pause(Math.min(page.poll_after_ms ?? 1000, Math.max(1, deadline - Date.now())), signal);
    }
  } catch (error) {
    if (error === LATE) return late();
    throw error;
  }
}

interface Event {
  event: string;
  data: string;
  id: string | undefined;
  retry: number | undefined;
}

/** The events of a `text/event-stream` body as the HTML standard parses them, each once its blank line came, so an
 *  event cut off midway is never seen. `id` is the last id field seen, carried from event to event; only digits, the
 *  route's change numbers, are kept, so nothing else is ever sent back as a header. */
async function* events(body: ReadableStream<Uint8Array>, heard: () => void): AsyncGenerator<Event> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: { event: string; data: string[]; retry?: number } = { event: "", data: [] };
  let id: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      heard();
      let text = buffer + decoder.decode(value, { stream: true });
      // A CR at the end may be the first half of a CRLF still to come.
      const held = text.endsWith("\r") ? "\r" : "";
      if (held) text = text.slice(0, -1);
      const lines = text.split(/\r\n|\r|\n/);
      buffer = lines.pop()! + held;
      for (const line of lines) {
        if (line === "") {
          if (event.data.length || event.retry !== undefined) yield { event: event.data.length ? event.event || "message" : "", data: event.data.join("\n"), id, retry: event.retry };
          event = { event: "", data: [] };
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event.event = value;
          else if (field === "data") event.data.push(value);
          else if (field === "id" && /^\d+$/.test(value)) id = value;
          else if (field === "retry" && /^\d+$/.test(value)) event.retry = Number(value);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const objectOf = (data: string, what: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(data) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // refused below
  }
  throw new AgentRunRefused(TIMELINE, 200, "bad_answer", undefined, `The server sent a ${what} event that is not a JSON object.`);
};

/** The timeline's event stream, each `rows` event's page as the server sent it (its rows, its drops, `reset` when the
 *  rows held go first). A dropped connection, an `end` with `reason: reconnect`, or a stream silent past three
 *  keepalives reconnects with Last-Event-ID; tries that get no event back off, never under the server's `retry`, and
 *  give up after a few in a row (AgentRunUnreachable). It ends at the server's `end` with `reason: terminal`. */
export async function* followRun(send: Send, baseUrl: string, runId: string, options: FollowOptions = {}): AsyncGenerator<TimelinePage, void, undefined> {
  const id = segmentOf(runId, "runId", false);
  const { after, signal } = options;
  if (after !== undefined && (!Number.isInteger(after) || after < 0)) throw new AgentRunUsage("after must be a whole number, 0 or more.");
  const idleMs = wholeMs(options.idleMs ?? IDLE_MS);
  if (options.idleMs !== undefined && !(Number.isFinite(options.idleMs) && options.idleMs > 0)) throw new AgentRunUsage("idleMs must be a number of milliseconds above 0.");
  if (options.lastEventId !== undefined && !/^\d+$/.test(options.lastEventId)) throw new AgentRunUsage("lastEventId must be an event id the server sent: digits only.");
  const path = `/runs/${id}/timeline${after !== undefined ? `?after=${after}` : ""}`;
  let last = options.lastEventId;
  let retryMs = 0;
  let reached = false;
  for (let tries = 0; ; ) {
    let progress = false;
    let reconnect = false;
    let cause = "stream_closed";
    const silent = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      clearTimeout(timer);
      timer = setTimeout(() => silent.abort(new Error("stream_silent")), idleMs);
    };
    heard();
    try {
      let response: Response | undefined;
      try {
        // No try timeout of its own: the idle timer bounds it.
        response = await send({ method: "GET", path, route: TIMELINE, retryable: false, signal: signal ? AbortSignal.any([signal, silent.signal]) : silent.signal, timeoutMs: 2 ** 31 - 1, headers: { accept: "text/event-stream", ...(last !== undefined ? { "last-event-id": last } : {}) } });
        reached = true;
      } catch (error) {
        // A server that never answered is unreachable now; once it has, a dropped connection, silence or a gateway's
        // 502, 503 or 504 reconnects. Every other refusal is the call's outcome.
        if (signal?.aborted) throw signal.reason;
        const gateway = error instanceof AgentRunRefused && [502, 503, 504].includes(error.status);
        if (!gateway && !(error instanceof AgentRunUnreachable && reached) && !silent.signal.aborted) throw error;
        reached = true;
        cause = gateway ? `http_${(error as AgentRunRefused).status}` : error instanceof AgentRunUnreachable ? error.cause : "stream_silent";
      }
      if (response && !/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel().catch(() => undefined);
        throw new AgentRunRefused(TIMELINE, response.status, "bad_answer", undefined, `The server answered ${TIMELINE} with ${response.headers.get("content-type") ?? "no content type"}, not an event stream.`);
      }
      if (response) {
        for await (const { event, data, id: seen, retry } of events(response.body!, heard)) {
          if (retry !== undefined) retryMs = retry;
          if (seen !== undefined) last = seen;
          if (event === "rows") {
            progress = true;
            yield objectOf(data, "rows") as unknown as TimelinePage;
          }
          if (event === "end") {
            if (objectOf(data, "end").reason === "terminal") return;
            reconnect = true;
            break;
          }
        }
      }
    } catch (error) {
      // What broke while the stream was read is a dropped connection; an outcome of this client's is the call's.
      if (signal?.aborted) throw signal.reason;
      if (error instanceof AgentRunError) throw error;
      cause = silent.signal.aborted ? "stream_silent" : "stream_broken";
    } finally {
      clearTimeout(timer);
      silent.abort();
    }
    if (reconnect) {
      tries = 0;
      if (retryMs) await pause(retryMs, signal);
      continue;
    }
    // The stream ended with no `end`, or broke: the connection dropped.
    tries = progress ? 1 : tries + 1;
    if (tries > RETRIES) throw new AgentRunUnreachable(baseUrl, cause);
    await pause(backoff(tries, retryMs), signal);
  }
}
