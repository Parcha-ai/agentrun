// The run's recording, when `RECORD_DIR` names a new or empty directory: agentrun.recording/1
// (apps/viewer/RECORDING.md), written by the reference package's recorder inside the run. It holds the store's lines
// (pi's messages and every document, none dropped) and pi's live events, each at the time it was seen, and the frames
// the browser showed while nobody else drove it. Before any line is written: the Browserbase key and project id, the
// browser profile's id (a context id, or a Chrome profile's path), each live view and each word `RECORD_REDACT` names
// become `[redacted]`, each browser session's id a label of its hash (a session's lines and its frames still read as
// one session), any `token=` value `[redacted]`, every `liveView` in a document null, and the run's own machine is
// scrubbed (#733). The ids are learned where they arise, from the provider and the profile, before anything commits
// them. When the run lets go, each session's frames become a WebM (`frame.track`); start-run.mjs finishes the recording
// once the run has exited (`finishRunRecording`): the run's `report/` as `manifest.artifact` (the host's "What I
// remember" page its entry), the manifest, and the scans.
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { codeOf, cost, finishRecording, openRecorder, openSupervisor, packageCommitRecorder, redactorOf, runScrub, scanPlaced, scanRecording, type Secret, type Supervisor } from "@parcha/agentrun-reference";
import type { BrowserProvider, LeaseRef, LiveView } from "@parcha/pi-browser";
import { exportFrameTracks, type FrameLine } from "@parcha/pi-browser/recorder";
import { openAgentHome, readAgentHome } from "@parcha/pi-durable-agent";
import type { BeforeResume } from "@parcha/pi-durable-disk";
import { browserIds, idsRedaction, readBrowserIds, withoutLiveViews, type BrowserIds } from "./redact.ts";
import { REMEMBER_PAGE } from "./remember.ts";

/** Written beside the run when the run's own scan finds a value in what it placed; finishing then refuses the recording. */
export const REFUSED_FILE = "recording-refused";
/** The shortest key value that counts as a secret (the reference's own rule): a short string is a word. */
const MIN_KEY = 12;
const TEXT_FILE = /\.(?:html?|css|csv|md|txt|json|svg)$/i;
/** The longest the frames' export may hold the run's last step (ffmpeg, per session). */
const TRACK_MS = 120_000;
/** The track's pace: the frame recorder's own (app.ts captures at most 2 a second), so a long session encodes few frames. */
const TRACK_FPS = 2;

/** The values a recording takes out: the key, live views and words as `[redacted]` (the reference's redactor), and the
 *  browser's ids by redact.ts's rules. */
type Ids = { secrets: Map<string, Secret>; browser: BrowserIds };
type Redact = (text: string) => string;
type CommitRecorder = NonNullable<Parameters<typeof openRecorder>[0]["commits"]>;

const idsOf = (env: NodeJS.ProcessEnv): Ids => {
  const ids: Ids = { secrets: new Map(), browser: browserIds() };
  for (const name of ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]) {
    const value = env[name];
    if (value && value.length >= MIN_KEY) ids.secrets.set(value, { key: name, value });
  }
  // Words the person types that a page may also print (a practice site's shared account).
  const words: unknown = env.RECORD_REDACT ? JSON.parse(env.RECORD_REDACT) : [];
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string" && word.length > 0)) throw new Error("RECORD_REDACT is a JSON array of strings");
  for (const word of words as string[]) ids.secrets.set(word, { key: "a word RECORD_REDACT names", value: word });
  return ids;
};
const secretsOf = (ids: Ids): Secret[] => [
  ...ids.secrets.values(),
  ...[...ids.browser.profiles].map((value) => ({ key: "the browser profile's id", value })),
  ...[...ids.browser.sessions].map((value) => ({ key: "a browser session id", value })),
];

/** The redaction over values that grow as the run learns them: the exact values first (a live view holds its session's
 *  id), then the browser's ids and any token, then the machine. */
function redactionOf(ids: Ids, scrub: Redact | undefined): Redact {
  const browser = idsRedaction(ids.browser);
  let size = -1;
  let values: Redact | undefined;
  return (text) => {
    if (size !== ids.secrets.size) {
      size = ids.secrets.size;
      values = redactorOf([...ids.secrets.values()]);
    }
    const out = browser(values ? values(text) : text);
    return scrub ? scrub(out) : out;
  };
}

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
  const seen = (ref: LeaseRef) => (ids.browser.sessions.add(ref.id), ref);
  return {
    provider: (provider) => Object.assign(Object.create(provider) as BrowserProvider, {
      create: async (...args: Parameters<BrowserProvider["create"]>) => seen(await provider.create(...args)),
      findByTag: async (...args: Parameters<BrowserProvider["findByTag"]>) => (await provider.findByTag(...args)).map(seen),
      attach: (ref: LeaseRef, signal?: AbortSignal) => provider.attach(seen(ref), signal),
      ...(provider.liveView ? { liveView: async (ref: LeaseRef) => view(await provider.liveView!(seen(ref))) } : {}),
    }),
    profile: (ref) => void (ref && ids.browser.profiles.add(ref)),
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
          for (const track of await exportFrameTracks({ lines, readBlob: (sha) => readFileSync(join(root, "frames", "blobs", `${sha}.jpg`)), fps: TRACK_FPS, timeoutMs: TRACK_MS })) {
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

/** The first thing the person asked, the job, from the run's store. Read-only. */
async function jobOf(storePath: string): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
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
  await readBrowserIds(store, ids.browser);
  const task = (await jobOf(store)) || "a run of the site reporter";
  const redact = redactionOf(ids, scrubFor(env, dir, home));
  // Blobs only: every line of the recording is the run process's or its supervisor's.
  const recorder = openRecorder({ dir, redact });
  // The artifact is the host's "What I remember" page, with the agent's own report beside it when it wrote one.
  const report = join(run, "work", "report");
  const artifact = existsSync(join(report, REMEMBER_PAGE)) ? { title: "What I remember", entry: REMEMBER_PAGE, files: reportFiles(report, (bytes, extension) => recorder.blob(bytes, extension)) } : undefined;
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
  // What the scan looked for, by name only: each is in no file of the recording.
  const scanned = [...new Set(secretsOf(ids).map((secret) => secret.key))];
  return { lines, frames: kinds.filter((kind) => kind === "frame").length, tracks: kinds.filter((kind) => kind === "frame.track").length, artifact: artifact ? Object.keys(artifact.files) : [], scanned };
}
