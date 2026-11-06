// `runs start --wait`, `runs wait` and `runs timeline --follow`: wait for a run and follow it live. Hand-written on top of
// the generated table (cli.mjs), from the timeline route's two forms: the long-polled JSON page and the event stream.
// `client` is cli.mjs's: `fetch(path, init)` with the token, `refused(response, bytes)` (the error on stderr, its exit
// code), `unreachable(error)` (exit 3, naming only the error's cause code, never its message) and `print(value)`.

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
// What moves only once a person acts: input_required (a question, the spend cap, a stopped turn), and a workflow run's
// `paused` (this server's own status), which no wait ends until someone resumes it.
const PERSON = new Set(["input_required", "paused"]);
/** Exit codes, gh's: 8 is its "pending". */
const EXIT = { completed: 0, failed: 1, cancelled: 1, person: 8 };
const MAX_WAIT_MS = 25_000; // the route's wait_ms maximum
const RETRIES = 5; // tries in a row that get nothing before giving up, exit 3
const BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const RETRIABLE = new Set([502, 503, 504]);
const IDLE_MS = 45_000; // three of the stream's 15 s keepalives missed: the connection is gone

/** The flags these add to a generated command (by its operationId), and their help lines. */
export const FLAGS = {
  createRun: {
    options: { wait: { type: "boolean" }, timeout: { type: "string" } },
    help: [
      ["--wait", "then wait until the run ends or waits on a person, and print it as runs wait does"],
      ["--timeout SECONDS", "with --wait: stop waiting after this long, exit 1 (the run goes on)"],
    ],
  },
  getTimeline: {
    options: { follow: { type: "boolean" } },
    help: [["--follow", "the timeline as it changes, one page per line (NDJSON), until the run ends; resumes a dropped connection"]],
  },
};

/** The one command with no route of its own. */
export const WAIT = {
  command: ["runs", "wait"],
  pathParams: ["run_id"],
  summary: "Wait until the run ends or waits on a person, and print it",
  help: [["--timeout SECONDS", "stop waiting after this long, exit 1 (the run goes on)"]],
};

/** An error for `client.unreachable` that names what happened by its code alone. */
const failure = (code) => Object.assign(new Error(code), { cause: { code } });
/** A count of milliseconds as timers take it: a whole number, at least 1 (AbortSignal.timeout throws on a fraction). */
const wholeMs = (ms) => Math.max(1, Math.ceil(ms));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, wholeMs(ms)));
/** The wait before try `tries + 1`: the client's own delay, doubling up to its cap, and never under the server's `retry`
 *  (`floor`), which may be above that cap. */
export const backoff = (tries, floor = 0) => Math.max(floor, Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (tries - 1)));
// The final read of a wait past its --timeout, which prints the run as it is: bounded too.
const LAST_READ_MS = 1_000;

/** GET `path` as JSON: `{ value }`, `{ code }` once the server refused (its error on stderr), or `{ late: true }` once
 *  `deadline` passed: every try and every wait between tries ends by it. Once the server answered (`reached`), a dropped
 *  connection or a gateway's 502/503/504 is tried again a few times with backoff, then exit 3 (a 5xx, 1); a server never
 *  reached is exit 3 at once. */
async function getJson(client, path, reached, deadline) {
  for (let tries = 1; ; tries++) {
    const left = deadline - Date.now();
    if (left <= 0) return { late: true };
    let response;
    let bytes;
    try {
      // A long poll answers within its wait_ms: one silent well past it is a connection gone.
      response = await client.fetch(path, { signal: AbortSignal.timeout(wholeMs(Math.min(MAX_WAIT_MS + IDLE_MS, left))) });
      bytes = Buffer.from(await response.arrayBuffer());
      reached.yes = true;
    } catch (error) {
      if (Date.now() >= deadline) return { late: true };
      if (!reached.yes || tries >= RETRIES) throw client.unreachable(error);
      await pause(Math.min(backoff(tries), deadline - Date.now()));
      continue;
    }
    if (RETRIABLE.has(response.status) && tries < RETRIES) {
      await pause(Math.min(backoff(tries), deadline - Date.now()));
      continue;
    }
    if (!response.ok) return { code: client.refused(response, bytes) };
    try {
      return { value: JSON.parse(bytes.toString("utf8")) };
    } catch {
      client.io.stderr.write(`The server's answer to GET ${path.split("?")[0]} is not JSON.\n`);
      return { code: 1 };
    }
  }
}

/** The run printed, a line on stderr for one that waits on a person, and its exit code. */
function settle(client, run, id) {
  client.print(run);
  if (!PERSON.has(run.status)) return EXIT[run.status];
  const go = `then \`agentrun runs wait ${id}\``;
  const why = run.status === "paused" ? `is paused: resume it with \`agentrun runs resume ${id}\``
    : run.pending?.kind === "question" ? `asked a question: answer it with \`agentrun runs message ${id} --content TEXT\``
    : run.pending?.kind === "budget" ? `stopped at its spend cap: raise the cap`
    : run.pending?.kind ? `waits on a person (${run.pending.kind})`
    : `was stopped by a person: send it a message with \`agentrun runs message ${id} --content TEXT\``;
  client.io.stderr.write(`Run ${id} ${why}, ${go}.\n`);
  return EXIT.person;
}

/** Waits until the run ends (completed, failed or cancelled, with every row in) or waits on a person, and prints it: exit
 *  0 completed, 1 failed or cancelled, 8 waits on a person. It long-polls the timeline from change to change and reads
 *  the run when the page says it is there. `timeoutMs` bounds every request and every wait between them; past it, it
 *  prints the run as it is (read once more, briefly; else as last read, if it was) and exits 1, the run going on. */
export async function waitRun(client, runId, timeoutMs) {
  const id = encodeURIComponent(runId);
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + wholeMs(timeoutMs);
  const reached = { yes: false };
  let after = 0;
  let last;
  const late = async () => {
    const run = await getJson(client, `/runs/${id}`, reached, Date.now() + LAST_READ_MS);
    if (run.code !== undefined) return run.code;
    const seen = run.value ?? last;
    if (seen !== undefined) client.print(seen);
    client.io.stderr.write(`Run ${runId} is still ${seen?.status ?? "going"} after ${wholeMs(timeoutMs) / 1000} s; it goes on: wait again with \`agentrun runs wait ${runId}\`.\n`);
    return 1;
  };
  for (let first = true; ; first = false) {
    const left = deadline - Date.now();
    if (left <= 0) return late();
    const waitMs = first ? 0 : Math.min(MAX_WAIT_MS, Math.ceil(left));
    const got = await getJson(client, `/runs/${id}/timeline?after=${after}&wait_ms=${waitMs}`, reached, deadline);
    if (got.late) return late();
    if (got.code !== undefined) return got.code;
    const page = got.value;
    after = page.next_after;
    const ended = (status) => (TERMINAL.has(status) && page.final) || PERSON.has(status);
    if (ended(page.status)) {
      const run = await getJson(client, `/runs/${id}`, reached, deadline);
      if (run.late) return late();
      if (run.code !== undefined) return run.code;
      last = run.value;
      // A message can reopen the run between the two reads: then it is waited for again.
      if (ended(run.value.status)) return settle(client, run.value, runId);
    }
    if (page.unchanged && !page.has_more) await pause(Math.min(page.poll_after_ms ?? 1000, deadline - Date.now()));
  }
}

/** The events of a `text/event-stream` body, as the HTML standard parses them: `{ event, data, id, retry }` once its
 *  blank line came, so an event cut off mid-way is never seen. `id` is the last id field seen, carried from event to event. */
async function* events(body, heard) {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = { event: "", data: [] };
  let id;
  for await (const chunk of body) {
    heard();
    let text = buffer + decoder.decode(chunk, { stream: true });
    // A CR at the end may be the first half of a CRLF still to come.
    const held = text.endsWith("\r") ? "\r" : "";
    if (held) text = text.slice(0, -1);
    const lines = text.split(/\r\n|\r|\n/);
    buffer = lines.pop() + held;
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
        // The route's ids are change numbers; anything else is never sent back as a header.
      else if (field === "id" && /^\d+$/.test(value)) id = value;
        else if (field === "retry" && /^\d+$/.test(value)) event.retry = Number(value);
      }
    }
  }
}

/** `runs timeline RUN_ID --follow`: the route's event stream, each `rows` event's page as one line of JSON on stdout, as
 *  the server sent it (its rows, its drops, `reset` when the rows held are to go first). A dropped connection, or the
 *  server's `end` with `reason: reconnect`, or a stream silent past three keepalives, reconnects with `Last-Event-ID`, so
 *  no change comes twice; tries that get no event back off (the server's `retry` the least wait) and give up after a few
 *  in a row, exit 3. It ends with the server's `end` with `reason: terminal`, which comes right after the first page with
 *  `final: true`: exit 0 when the run completed, 1 when it failed or was cancelled. A run that waits on a person keeps
 *  the stream open, as the server does. `path` is the route with its query (`after` is where it starts), and `headers`
 *  the command's (its `--last-event-id` wins over `after`, as the route says). */
export async function followTimeline(client, path, headers = {}) {
  const { "Last-Event-ID": from, ...rest } = headers;
  let reached = false;
  let last = from;
  let retryMs = 0;
  let status;
  for (let tries = 0; ; ) {
    let progress = false;
    let reconnect = false;
    let cause;
    const silent = new AbortController();
    let timer;
    const heard = () => (clearTimeout(timer), (timer = setTimeout(() => silent.abort(failure("stream_silent")), IDLE_MS)));
    heard();
    try {
      const response = await client.fetch(path, { headers: { ...rest, accept: "text/event-stream", ...(last !== undefined ? { "last-event-id": last } : {}) }, signal: silent.signal });
      reached = true;
      if (RETRIABLE.has(response.status)) throw failure(`http_${response.status}`);
      if (!response.ok) return client.refused(response, Buffer.from(await response.arrayBuffer()));
      if (!/^text\/event-stream\b/.test(response.headers.get("content-type") ?? "")) {
        client.io.stderr.write(`The server answered ${response.headers.get("content-type") ?? "with no content type"}, not an event stream.\n`);
        return 1;
      }
      for await (const { event, data, id, retry } of events(response.body, heard)) {
        if (retry !== undefined) retryMs = retry;
        if (event === "rows") {
          const page = JSON.parse(data);
          client.io.stdout.write(`${JSON.stringify(page)}\n`);
          status = page.status;
          progress = true;
        }
        if (id !== undefined) last = id;
        if (event === "end") {
          if (JSON.parse(data).reason === "terminal") return EXIT[status] ?? 1;
          reconnect = true;
          break;
        }
      }
    } catch (error) {
      if (!reached) throw client.unreachable(error);
      cause = error;
    } finally {
      clearTimeout(timer);
    }
    if (reconnect) {
      tries = 0;
      if (retryMs) await pause(retryMs);
      continue;
    }
    // The stream ended with no `end`, or broke: the connection dropped.
    tries = progress ? 1 : tries + 1;
    if (tries > RETRIES) throw client.unreachable(cause ?? failure("stream_closed"));
    await pause(backoff(tries, retryMs));
  }
}
