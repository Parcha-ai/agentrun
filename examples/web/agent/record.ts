// The run's recording, when `RECORD_DIR` names a new or empty directory: agentrun.recording/1 (apps/viewer/RECORDING.md),
// written by the reference package's recorder inside the run. It holds the store's lines (pi's messages and every
// document, none dropped) and pi's live events, each at the time it was seen, and the frames the browser showed while
// nobody else drove it. Before any line is written: the Browserbase key, the browser profile's id (a context id, or a
// Chrome profile's path), each live view and each word `RECORD_REDACT` names become `[redacted]`, each browser
// session's id a label of its hash (a session's lines and its frames still read as one session), any `token=` value
// `[redacted]`, every `liveView` in a document null, and the run's own machine is scrubbed (#733). The ids are learned
// where they arise, from the provider and the profile, before anything commits them. When the run lets go, each
// session's frames become a WebM (`frame.track`); start-run.mjs finishes the recording once the run has exited
// (`finishRunRecording`): the agent's `report/` as `manifest.artifact`, the manifest, and the scans.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { codeOf, cost, finishRecording, openRecorder, openSupervisor, packageCommitRecorder, redactorOf, runScrub, scanPlaced, scanRecording, type Secret, type Supervisor } from "@parcha/agentrun-reference";
import type { BrowserProvider, LeaseRef, LiveView } from "@parcha/pi-browser";
import { exportFrameTracks, type FrameLine } from "@parcha/pi-browser/recorder";
import { openAgentHome, readAgentHome } from "@parcha/pi-durable-agent";
import type { BeforeResume } from "@parcha/pi-durable-disk";

export const REDACTED = "[redacted]";
/** Written beside the run when the run's own scan finds a value in what it placed; finishing then refuses the recording. */
export const REFUSED_FILE = "recording-refused";
/** The shortest key value that counts as a secret (the reference's own rule): a short string is a word. */
const MIN_KEY = 12;
/** Any `token=` value, a live view's or a debugger's, whatever site wrote it. */
const TOKEN = /([?&;]token=)[^&#\s"'\\]+/gi;
const TEXT_FILE = /\.(?:html?|css|csv|md|txt|json|svg)$/i;
/** The longest the frames' export may hold the run's last step (ffmpeg, per session). */
const TRACK_MS = 60_000;

/** How the recording shows a browser session's id: a label of its hash. */
export const sessionLabel = (id: string) => `session-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;

type Ids = { secrets: Map<string, Secret>; sessions: Set<string> };
type Redact = (text: string) => string;
type CommitRecorder = NonNullable<Parameters<typeof openRecorder>[0]["commits"]>;

const idsOf = (env: NodeJS.ProcessEnv): Ids => {
  const ids: Ids = { secrets: new Map(), sessions: new Set() };
  const key = env.BROWSERBASE_API_KEY;
  if (key && key.length >= MIN_KEY) ids.secrets.set(key, { key: "BROWSERBASE_API_KEY", value: key });
  // Words the person types that a page may also print (a practice site's shared account).
  const words: unknown = env.RECORD_REDACT ? JSON.parse(env.RECORD_REDACT) : [];
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string" && word.length > 0)) throw new Error("RECORD_REDACT is a JSON array of strings");
  for (const word of words as string[]) ids.secrets.set(word, { key: "a word RECORD_REDACT names", value: word });
  return ids;
};
const secretsOf = (ids: Ids): Secret[] => [...ids.secrets.values(), ...[...ids.sessions].map((value) => ({ key: "a browser session id", value }))];

/** The redaction over ids that grow as the run learns them: exact values first (a live view holds its session's id), then
 *  each session's id as its label, then any token, then the machine. */
function redactionOf(ids: Ids, scrub: Redact | undefined): Redact {
  let size = -1;
  let values: Redact | undefined;
  let labels: [string, string][] = [];
  return (text) => {
    if (size !== ids.secrets.size + ids.sessions.size) {
      size = ids.secrets.size + ids.sessions.size;
      values = redactorOf([...ids.secrets.values()]);
      labels = [...new Map([...ids.sessions].sort((a, b) => b.length - a.length).flatMap((id) => [[id, sessionLabel(id)], [JSON.stringify(id).slice(1, -1), sessionLabel(id)]] as [string, string][]))];
    }
    let out = values ? values(text) : text;
    for (const [id, label] of labels) if (out.includes(id)) out = out.split(id).join(label);
    out = out.replace(TOKEN, `$1${REDACTED}`);
    return scrub ? scrub(out) : out;
  };
}

/** A document as the recording keeps it: every `liveView` null, whatever wrote one (a live view is a token for the browser). */
const withoutLiveViews = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(withoutLiveViews)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, key === "liveView" ? null : withoutLiveViews(inner)]))
    : value;

const scrubFor = (env: NodeJS.ProcessEnv, dir: string, home: string) => runScrub({ ...env, DIR: home, RECORD_DIR: dir });

export type RunRecording = {
  /** The provider, with every session id and live view it gives learned before anything else sees it. */
  provider(provider: BrowserProvider): BrowserProvider;
  /** The browser profile's id, learned before its document is recorded or committed. */
  profile(ref: string | null | undefined): void;
  /** A frame or gap the frame store kept, with its JPEG. */
  frame(line: FrameLine, bytes?: Record<string, Uint8Array>): void;
  /** In `beforeResume`, before anything commits: the snapshot at the hook's head, then every commit. */
  attach(run: BeforeResume): Promise<void>;
  /** Writes each session's frames as a WebM (`frame.track`, when ffmpeg is on the PATH), stops recording, then scans what
   *  was placed for every id the run learned (its live views included). */
  detach(): Promise<void>;
};

/** The recording of the run at `root` in the agent home `home`, on the run's own clock (`started`, ISO). */
export async function openRunRecording(options: { dir: string; root: string; home: string; started: string; env: NodeJS.ProcessEnv }): Promise<RunRecording> {
  const { dir, root, env } = options;
  if (existsSync(join(dir, "manifest.json"))) throw new Error(`${dir} holds a finished recording: record a run into a new directory`);
  const ids = idsOf(env);
  const redact = redactionOf(ids, scrubFor(env, dir, options.home));
  const commits = await packageCommitRecorder();
  const documents: CommitRecorder = (input, write) => commits(input, (line) => write({ ...line, data: withoutLiveViews(line.data) }));
  // The recorder writes `process.started` through the supervisor, which opens after it, on the clock the recorder set.
  let supervisor: Supervisor | undefined;
  const recorder = openRecorder({ dir, started: options.started, redact, commits: documents, supervisor: { host: (kind, data, meta) => supervisor?.host(kind, data, meta) } });
  supervisor = openSupervisor({ dir, redact });
  const view = (live: LiveView | null) => {
    for (const url of [live?.fullscreen, live?.framed, ...(live?.pages ?? []).map((page) => page.fullscreen)]) if (url) ids.secrets.set(url, { key: "a live view", value: url });
    return live;
  };
  const seen = (ref: LeaseRef) => (ids.sessions.add(ref.id), ref);
  return {
    provider: (provider) => Object.assign(Object.create(provider) as BrowserProvider, {
      create: async (...args: Parameters<BrowserProvider["create"]>) => seen(await provider.create(...args)),
      findByTag: async (...args: Parameters<BrowserProvider["findByTag"]>) => (await provider.findByTag(...args)).map(seen),
      attach: (ref: LeaseRef, signal?: AbortSignal) => provider.attach(seen(ref), signal),
      ...(provider.liveView ? { liveView: async (ref: LeaseRef) => view(await provider.liveView!(seen(ref))) } : {}),
    }),
    profile: (ref) => void (ref && ids.secrets.set(ref, { key: "the browser profile's id", value: ref })),
    frame(line, bytes) {
      for (const [sha, blob] of Object.entries(bytes ?? {})) if (recorder.blob(Buffer.from(blob), "jpg") !== sha) return;
      recorder.live("browser", line.kind, line.data, { conv: line.conv, ...(line.kind === "frame" ? { blobs: line.blobs } : {}) });
    },
    async attach({ harness, storage, head, context, generation }) {
      recorder.generation(generation);
      await recorder.attach({ session: harness, storage, head, context, gen: generation });
    },
    async detach() {
      // Each session's frames as one WebM and its index, written while the recorder is still this process's.
      const framesFile = join(root, "frames", "frames.jsonl");
      if (existsSync(framesFile)) {
        const lines = readFileSync(framesFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(redact(line)) as FrameLine);
        try {
          for (const track of await exportFrameTracks({ lines, readBlob: (sha) => readFileSync(join(root, "frames", "blobs", `${sha}.jpg`)), timeoutMs: TRACK_MS })) {
            for (const [sha, extension] of [[track.files.webm, "webm"], [track.files.index, "json"]] as const) recorder.blob(Buffer.from(track.blobs[sha]!), extension);
            recorder.live("browser", "frame.track", track.line.data, { conv: track.line.conv, blobs: track.line.blobs });
          }
        } catch (error) {
          // The frames stay, as frame lines; only their WebM is missing.
          console.error(`the recording has no frame track: ${(error as Error).message}`);
        }
      }
      await recorder.detach();
      try {
        scanPlaced(dir, secretsOf(ids));
      } catch (error) {
        writeFileSync(join(root, REFUSED_FILE), `${(error as Error).message}\n`, { mode: 0o600 });
        throw error;
      }
    },
  };
}

/** A message's text: a string, or its text parts joined. */
const firstText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part?.type === "text" ? part.text : "")).join(" ") : "";

/** What the finish reads from the run's store, read-only: the ids its browser documents hold, from every revision of each
 *  (a delta names its path, whose last part is the key): profile and context ids (`ref`, `contextId`) and session ids
 *  (`resourceId`); and the first thing the person asked, the job. */
async function readStore(storePath: string, ids: Ids): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(storePath, { readOnly: true });
  const take = (key: unknown, value: unknown) => {
    if (typeof value !== "string" || !value) return;
    if (key === "ref" || key === "contextId") ids.secrets.set(value, { key: "the browser profile's id", value });
    else if (key === "resourceId") ids.sessions.add(value);
  };
  const walk = (value: unknown, key?: unknown): void => {
    if (Array.isArray(value)) value.forEach((inner) => walk(inner, key));
    else if (value !== null && typeof value === "object") for (const [name, inner] of Object.entries(value)) walk(inner, name);
    else take(key, value);
  };
  try {
    const rows = db.prepare("SELECT r.kind AS revision, r.content AS content FROM document_revisions r JOIN documents d ON d.id = r.document_id WHERE d.kind LIKE '%browser.%'").all() as { revision: string; content: string }[];
    for (const { revision, content } of rows) {
      const value = JSON.parse(content) as unknown;
      if (revision === "base") walk(value);
      else for (const [, path, ...rest] of value as [string, (string | number)[], ...unknown[]][]) for (const inner of rest) walk(inner, path.at(-1));
    }
    const entries = db.prepare("SELECT record FROM entries WHERE conversation_id = (SELECT MIN(conversation_id) FROM entries) ORDER BY id").all() as { record: string }[];
    const first = entries.map((row) => JSON.parse(row.record) as { kind?: string; model?: { content?: unknown }[] }).find((entry) => entry.kind === "pi.user");
    return firstText(first?.model?.[0]?.content).replace(/\s+/g, " ").trim().slice(0, 200);
  } finally {
    db.close();
  }
}

/** Every file of the agent's `report/` as a blob, by its path there: the entry and what it shows. No dotfile, no link. */
function reportFiles(dir: string, keep: (bytes: Buffer | string, extension: string) => string, at = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(dir, at)).sort()) {
    const path = at ? `${at}/${name}` : name;
    const stat = lstatSync(join(dir, path));
    if (name.startsWith(".") || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) Object.assign(files, reportFiles(dir, keep, path));
    else if (stat.isFile() && /\.[A-Za-z0-9]+$/.test(name)) {
      const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      const bytes = readFileSync(join(dir, path));
      files[path] = keep(TEXT_FILE.test(name) ? bytes.toString("utf8") : bytes, extension);
    }
  }
  return files;
}

/**
 * Finishes the recording in `dir` of the run in `run` once its process has exited: the agent's `report/` as
 * `manifest.artifact`, the merged lines and the manifest, then the record-time scan for every id the run's store holds and
 * the key. Refused when the run's own scan refused it, and when this scan finds a value (the manifest is removed, so the
 * directory is no finished recording).
 */
export async function finishRunRecording(options: { dir: string; run: string; env: NodeJS.ProcessEnv; providers: "real" | "scripted" }) {
  const { dir, env, providers } = options;
  const run = resolve(options.run);
  const home = resolve(run, "..", "..");
  if (existsSync(join(run, REFUSED_FILE))) throw new Error(`the run refused its recording: ${readFileSync(join(run, REFUSED_FILE), "utf8").trim()}`);
  const store = join(run, "store", "run.sqlite");
  const ids = idsOf(env);
  const task = (await readStore(store, ids)) || "a run of the site reporter";
  const redact = redactionOf(ids, scrubFor(env, dir, home));
  // Blobs only: every line of the recording is the run process's or its supervisor's.
  const recorder = openRecorder({ dir, redact });
  const report = join(run, "work", "report");
  const artifact = existsSync(join(report, "index.html")) ? { title: "Site report", entry: "index.html", files: reportFiles(report, (bytes, extension) => recorder.blob(bytes, extension)) } : undefined;
  const { definition } = await readAgentHome(await openAgentHome(home));

  const { lines } = finishRecording(dir, {
    title: definition.name, task, model: env.AGENT_MODEL || "unknown", kills: 0, providers, redact,
    code: codeOf(resolve(import.meta.dirname, "..", "..", "..")), cost, source: { run: basename(run), store },
    ...(artifact ? { extra: { artifact } } : {}),
  });
  try {
    scanRecording(dir, secretsOf(ids));
  } catch (error) {
    rmSync(join(dir, "manifest.json"), { force: true });
    throw error;
  }
  const kinds = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { kind: string }).kind);
  return { lines, frames: kinds.filter((kind) => kind === "frame").length, tracks: kinds.filter((kind) => kind === "frame.track").length, artifact: artifact ? Object.keys(artifact.files) : [] };
}
