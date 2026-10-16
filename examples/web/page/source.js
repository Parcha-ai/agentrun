// Where the run page reads from. The page (run-page.js) reads only through a RunSource: `httpSource` is the runs
// server's routes, live; `staticSource` is a replay, files on any static host, which `writeReplay` (../replay.mjs)
// writes. A source without `start`, `submit`, `stop` and `live` is a replay, and the page shows no way to act.
// Plain JavaScript that runs in a browser and in Node, with no import: the page, the server and the replay writer share
// the rules below.

/**
 * One run, as the history lists it and the run page heads it.
 * @typedef {object} RunSummary
 * @property {string} id
 * @property {string} title
 * @property {string | null} [agent]
 * @property {string} status run.json's status (`running`, `sleeping`, `done`, ...), or `starting`, `lost`, `unknown`
 * @property {"working" | "waiting" | "idle" | null} [state] what the run is doing, as its page shows it
 * @property {boolean} live whether the run is up, so its timeline is followed
 * @property {"busy" | "idle" | null} [busy]
 * @property {number} [generation]
 * @property {string} startedAt ISO 8601
 * @property {string | null} [endedAt]
 * @property {string | null} [outcome]
 * @property {number | null} [costUsd]
 * @property {{ key: string } | null} [liveView] a live run's view, by a key that changes with its address; never in a replay
 * @property {string | null} [browser]
 * @property {string | null} [liveNote]
 * @property {string | null} [error]
 */

/**
 * One run, as the run page heads it: its summary and, in a replay of a recorded job, the input the job was given (a JSON
 * value), which the page shows in place of the run's first message. Never in the history's summaries.
 * @typedef {RunSummary & { input?: unknown }} Run
 */

/**
 * The timeline as the page draws it: the rows (Grep's TimelineEvent shape, from @parcha/pi-durable-agent/timeline) in
 * order, what the run is doing, and what it cost so far.
 * @typedef {{ rows: object[], state: "working" | "waiting" | "idle", costUsd: number | null }} TimelineView
 */

/** @typedef {{ path: string, size: number, mtime?: number }} FileEntry */
/** @typedef {{ runId: string, title: string, kind: "run" | "file" | "transcript", path?: string, snippet: string }} SearchHit */

/**
 * @typedef {object} RunSource
 * @property {() => Promise<RunSummary[]>} list newest first
 * @property {(id: string) => Promise<Run>} run
 * @property {(id: string, options?: { live?: boolean, signal?: AbortSignal }) => AsyncIterable<TimelineView> | Promise<TimelineView>} timeline
 *   a live run's timeline as it changes (each view whole; it ends when the run stops serving), or a released run's
 * @property {(id: string) => Promise<FileEntry[]>} files the run's workspace, dotfiles left out
 * @property {(id: string, path: string, options?: { download?: boolean }) => Promise<Response>} file one of those files:
 *   as the page shows it inline (a long text file may come back cut short, with `x-truncated: 1`), or, with `download`,
 *   all of it
 * @property {(q: string) => Promise<SearchHit[]>} search
 * @property {(text: string) => Promise<{ id: string }>} [start] a new run with a first message (live only)
 * @property {(id: string, text: string) => Promise<unknown>} [submit] a message to a run (live only)
 * @property {(id: string) => Promise<unknown>} [stop] abort a run's turn (live only)
 * @property {(id: string, run: Run) => { key: string, src: string } | null} [live] the run's live view frame (live only)
 */

/** A run id: what pi-durable-agent's `startRun` accepts, and never a dot first. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** A workspace path a page may ask for and a replay may hold: relative, `/` between segments, no empty, `.` or `..`
 *  segment, no dotfile, no backslash, no NUL. */
export function safePath(path) {
  if (typeof path !== "string" || path === "" || path.includes("\0") || path.includes("\\")) return false;
  return path.split("/").every((part) => part !== "" && !part.startsWith("."));
}

const QUIET = /:run:(start|end)$/;
/** The newest row that says what the run is doing: not cost, not the run's start or end, not a phase. */
export const lastRow = (rows) => rows.findLast((r) => r.kind !== "usage" && r.kind !== "phase" && !QUIET.test(r.id));

/**
 * working while a run is in flight. Otherwise waiting when the newest row is a wait for the person. A live run that
 * ended on a successful tool result is waiting too: a run that is not working and has no answer after its last result
 * was ended by that tool (request_sign_in does this). A released run's rows cannot tell that apart from a run parked
 * between steps, so there only a wait row counts.
 */
export function stateOf(rows, working, live = false) {
  if (working) return "working";
  const last = lastRow(rows);
  if (last?.kind === "waiting") return "waiting";
  return live && last?.kind === "tool_result" && last.tool_status === "success" ? "waiting" : "idle";
}

export const costOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage?.usd ?? null;

const pathUrl = (path) => path.split("/").map(encodeURIComponent).join("/");
const bySeq = (a, b) => a.seq - b.seq;

/** `fetch`, and its JSON body; a refusal is an Error with the server's message. */
async function json(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? `${res.status} ${res.statusText}`);
  return data;
}

/** Server-sent events as `{ event, data }`, from a response body. */
async function* events(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end; (end = buffer.indexOf("\n\n")) >= 0; ) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) continue;
        try {
          yield { event, data: JSON.parse(data.join("\n")) };
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The runs server's routes under `base` (an absolute URL ending in `/`, where the page is served): GET runs, runs/{id},
 * runs/{id}/timeline (server-sent events while live), runs/{id}/files[/{path}], search; POST runs, runs/{id}/messages,
 * runs/{id}/stop; a live view at runs/{id}/live.
 * @param {string} base
 * @returns {RunSource}
 */
export function httpSource(base) {
  const at = (path) => new URL(path, base).href;
  const post = (path, body) => json(at(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /** @param {string} id @param {AbortSignal | undefined} signal */
  async function* follow(id, signal) {
    const res = await fetch(at(`runs/${encodeURIComponent(id)}/timeline`), { headers: { accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new Error(`the run's timeline answered ${res.status}`);
    let rows = new Map();
    for await (const { event, data } of events(res.body)) {
      if (event === "end") return;
      if (event !== "rows") continue;
      if (data.reset) rows = new Map(data.rows.map((r) => [r.id, r]));
      else {
        for (const id of data.drop) rows.delete(id);
        for (const r of data.set) rows.set(r.id, r);
      }
      yield { rows: [...rows.values()].sort(bySeq), state: data.state, costUsd: data.costUsd };
    }
  }
  return {
    list: async () => (await json(at("runs"))).runs,
    run: (id) => json(at(`runs/${encodeURIComponent(id)}`)),
    timeline: (id, { live = false, signal } = {}) => (live ? follow(id, signal) : json(at(`runs/${encodeURIComponent(id)}/timeline`), { signal })),
    files: async (id) => (await json(at(`runs/${encodeURIComponent(id)}/files`))).files,
    file: (id, path, { download = false } = {}) => fetch(at(`runs/${encodeURIComponent(id)}/files/${pathUrl(path)}${download ? "?download=1" : ""}`)),
    search: async (q) => (await json(at(`search?q=${encodeURIComponent(q)}`))).results,
    start: (text) => post("runs", { content: text }),
    submit: (id, text) => post(`runs/${encodeURIComponent(id)}/messages`, { content: text }),
    stop: (id) => post(`runs/${encodeURIComponent(id)}/stop`, {}),
    live: (id, run) => (run?.liveView ? { key: run.liveView.key, src: at(`runs/${encodeURIComponent(id)}/live?v=${encodeURIComponent(run.liveView.key)}`) } : null),
  };
}

/**
 * A replay over the static layout `writeReplay` writes under `base` (an absolute URL ending in `/`):
 *   runs.json                      { version: 1, runs: RunSummary[] }, newest first
 *   runs/<id>.json                 the Run
 *   runs/<id>/timeline.json        the rows, in order
 *   runs/<id>/files.json           FileEntry[]
 *   runs/<id>/files/<path>         each file
 * It has no start, submit, stop or live: a replay never acts, and never carries a live view. Search looks at the runs'
 * titles, here in the page.
 * @param {string} base
 * @returns {RunSource}
 */
export function staticSource(base) {
  const at = (path) => new URL(path, base).href;
  const runOf = (id) => {
    if (!RUN_ID.test(id)) throw new Error(`no run ${id}`);
    return `runs/${encodeURIComponent(id)}`;
  };
  let index;
  const list = async () => (index ??= json(at("runs.json")).then((data) => data.runs, (error) => ((index = undefined), Promise.reject(error))));
  return {
    list,
    run: async (id) => json(at(`${runOf(id)}.json`)),
    timeline: async (id) => {
      const rows = await json(at(`${runOf(id)}/timeline.json`));
      return { rows, state: stateOf(rows, false), costUsd: costOf(rows) };
    },
    files: async (id) => json(at(`${runOf(id)}/files.json`)),
    file: async (id, path) => (safePath(path) ? fetch(at(`${runOf(id)}/files/${pathUrl(path)}`)) : new Response("", { status: 404 })),
    search: async (q) => {
      const needle = q.toLowerCase();
      return (await list()).filter((r) => `${r.title}\n${r.agent ?? ""}`.toLowerCase().includes(needle)).map((r) => ({ runId: r.id, title: r.title, kind: "run", snippet: r.title }));
    },
  };
}
