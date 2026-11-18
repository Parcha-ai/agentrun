// Anonymous usage counts (docs/telemetry.md): that a server started, that it is still running a day later, and that its
// first run completed. Each event holds a random id made for this data directory, the server's version, the platform,
// and how many runs ended here as a range. It never holds a prompt, a workflow, a key, a name, a path or an address.
//
// Off with AGENTRUN_TELEMETRY=0 or DO_NOT_TRACK=1, in CI, and under --faux. The start that first could send prints one
// notice and sends nothing at its start, so a person reads how to turn it off before anything leaves the machine.
// AGENTRUN_TELEMETRY=debug prints every event and sends none; it never stands in for that notice.
// Sending never delays a start, a run or a stop, and a send that fails is dropped without a word. A run's end is counted
// in memory and written behind it, one write at a time, so no request or run waits on the disk.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempOf, writeDurableSync } from "./server-fs.js";

/** Where events go: PostHog's capture route, behind this project's own name. */
export const TELEMETRY_URL = "https://telemetry.agentrun.ai/i/v0/e/";
/** The PostHog project's write-only key, public by design: that project holds these counts and nothing else. Empty, a build sends nothing and prints no notice. */
export const TELEMETRY_KEY = "phc_kz3ieB34X89r2bv6gLbdeXDiNNn78KiAPRCZCxMzUBuA";
/** The file in the data directory that keeps the id, when the notice was printed and how many runs ended. */
export const TELEMETRY_FILE = ".telemetry.json";
/** How often a running server says it still runs. */
export const HEARTBEAT_MS = 24 * 60 * 60 * 1000;
/** How long one send may take before it is dropped. */
const SEND_TIMEOUT_MS = 3_000;
const ownVersion = (): string => (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export const TELEMETRY_NOTICE =
  "AgentRun sends anonymous usage counts (a random id, the version, the platform, how many runs as a range): never prompts, files, keys or names. Nothing was sent at this start. Turn it off with AGENTRUN_TELEMETRY=0 or DO_NOT_TRACK=1. Every field: https://github.com/Parcha-ai/agentrun/blob/main/docs/telemetry.md";

export type TelemetryEventName = "server_started" | "heartbeat" | "first_run_completed";
/** One event, as sent. `runs` is a range, never a count. */
export interface TelemetryEvent {
  event: TelemetryEventName;
  distinct_id: string;
  timestamp: string;
  properties: { version: string; os: string; arch: string; node: number; runs: RunsRange; $process_person_profile: false; $geoip_disable: true };
}
export type RunsRange = "0" | "1-10" | "11-100" | "101+";

/** Why nothing is sent, or "on" / "debug" (events printed to stderr, none sent). */
export type TelemetryMode = "on" | "debug" | "off_setting" | "off_do_not_track" | "off_ci" | "off_faux" | "off_no_key";

const OFF = new Set(["0", "false", "off", "no"]);

/** What this start does, from its environment: the operator's own setting first, then DO_NOT_TRACK, CI and --faux. */
export function telemetryMode(env: NodeJS.ProcessEnv, o: { faux?: boolean; key?: string } = {}): TelemetryMode {
  const setting = (env.AGENTRUN_TELEMETRY ?? "").trim().toLowerCase();
  if (OFF.has(setting)) return "off_setting";
  const dnt = (env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt !== "" && !OFF.has(dnt)) return "off_do_not_track";
  if (env.CI) return "off_ci";
  if (o.faux) return "off_faux";
  if (setting === "debug") return "debug";
  return (o.key ?? TELEMETRY_KEY) === "" ? "off_no_key" : "on";
}

export const runsRange = (runs: number): RunsRange => (runs <= 0 ? "0" : runs <= 10 ? "1-10" : runs <= 100 ? "11-100" : "101+");

interface State {
  id: string;
  noticed_at?: string;
  runs: number;
  first_run_sent?: boolean;
  /** The first run completed during the start that printed the notice: said at the next start or that start's heartbeat. */
  first_run_held?: boolean;
}

/** The kept state, or a new one when the file is missing or not what this wrote. */
function readState(file: string): State {
  try {
    const kept = JSON.parse(readFileSync(file, "utf8")) as Partial<State> | null;
    if (kept && typeof kept.id === "string" && /^[0-9a-f-]{36}$/.test(kept.id)) {
      return {
        id: kept.id,
        runs: typeof kept.runs === "number" && Number.isInteger(kept.runs) && kept.runs >= 0 ? kept.runs : 0,
        ...(typeof kept.noticed_at === "string" ? { noticed_at: kept.noticed_at } : {}),
        ...(kept.first_run_sent === true ? { first_run_sent: true } : {}),
        ...(kept.first_run_held === true ? { first_run_held: true } : {}),
      };
    }
  } catch {
    // Missing or unreadable: a new id, and the notice again.
  }
  return { id: randomUUID(), runs: 0 };
}

export interface Telemetry {
  mode: TelemetryMode;
  /** The line to print once, at the start that first could send; undefined at every other. */
  notice?: string;
  /** A run reached its end here. `status` is the runner's (`ended` is a completed run). */
  runEnded(status: string): void;
  /** Stops the heartbeat and waits for the count's last write. Sends nothing. */
  close(): Promise<void>;
}

export interface TelemetryOptions {
  data: string;
  /** The server's version (default: this package's). */
  version?: string;
  env?: NodeJS.ProcessEnv;
  faux?: boolean;
  /** For tests: the key, the route, the sender, the clock, the heartbeat's period and where debug lines go. */
  key?: string;
  url?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  heartbeatMs?: number;
  say?: (line: string) => void;
}

/** Starts the counts for a server on `data`. Never throws: a data directory it cannot write turns it off. */
export function startTelemetry(o: TelemetryOptions): Telemetry {
  const env = o.env ?? process.env;
  const key = o.key ?? TELEMETRY_KEY;
  const mode = telemetryMode(env, { ...(o.faux ? { faux: true } : {}), key });
  const idle: Telemetry = { mode, runEnded: () => {}, close: () => Promise.resolve() };
  if (mode !== "on" && mode !== "debug") return idle;

  const file = join(o.data, TELEMETRY_FILE);
  const now = o.now ?? (() => new Date());
  const say = o.say ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const send = o.fetch ?? fetch;
  const state = readState(file);
  const version = o.version ?? ownVersion();
  const text = (): string => `${JSON.stringify(state)}\n`;
  // The start's one write, durable before anything is sent: the id, and the notice's time when this start prints it.
  const keepNow = (): boolean => {
    try {
      writeDurableSync(file, text());
      return true;
    } catch {
      return false;
    }
  };
  // Every later write (a run's end) goes behind the caller: one at a time, the latest state each time, so ends that come
  // together make one write and none waits on the disk. A write that fails is dropped; the next end writes again.
  // Each goes through a temporary file of its own: a server that takes this data directory while this one still stops
  // never shares one with it. The two can still each write the file whole, last one kept, so a restart that overlaps a
  // run's end may count a few runs short: the count is sent as a range, and nothing else is kept here.
  const whole = async (): Promise<void> => {
    const temp = tempOf(file);
    try {
      await writeFile(temp, text(), { mode: 0o600 });
      await rename(temp, file);
    } catch {
      await unlink(temp).catch(() => {});
    }
  };
  let stale = false;
  let writing: Promise<void> | undefined;
  const keepLater = (): void => {
    stale = true;
    writing ??= (async () => {
      while (stale) {
        stale = false;
        await whole();
      }
      writing = undefined;
    })();
  };

  // The start that first could send: the notice, kept before anything is sent. If it cannot be kept, the next start would
  // print it again and still send nothing, so this one stays quiet too. Debug sends nothing and prints no notice, so it
  // never marks the notice as read: a start that can send after it still prints the notice and holds its first event.
  const first = mode === "on" && state.noticed_at === undefined;
  if (first) state.noticed_at = now().toISOString();
  if (!keepNow()) return { ...idle, mode: "off_setting" };

  const emit = (event: TelemetryEventName): void => {
    const body: TelemetryEvent = {
      event,
      distinct_id: state.id,
      timestamp: now().toISOString(),
      properties: { version, os: process.platform, arch: process.arch, node: Number(process.versions.node.split(".")[0]), runs: runsRange(state.runs), $process_person_profile: false, $geoip_disable: true },
    };
    if (mode === "debug") return say(`agentrun-serve telemetry (debug, not sent): ${JSON.stringify(body)}`);
    void send(o.url ?? TELEMETRY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: key, ...body }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }).then(
      () => {},
      () => {},
    );
  };

  // The start that printed the notice sends nothing until its first heartbeat, a day later: a first run that completes
  // before then is kept as held and said with that heartbeat, or at the next start, whichever comes first.
  let holding = first;
  const sayHeld = (): void => {
    if (!state.first_run_held || state.first_run_sent) return;
    state.first_run_sent = true;
    delete state.first_run_held;
    keepLater();
    emit("first_run_completed");
  };
  if (!first) {
    emit("server_started");
    sayHeld();
  }
  // A server that stays up is counted by its heartbeat, the first start's too: a day after the notice.
  const beat = setInterval(() => {
    holding = false;
    emit("heartbeat");
    sayHeld();
  }, o.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref();

  return {
    mode,
    ...(first ? { notice: TELEMETRY_NOTICE } : {}),
    runEnded(status) {
      state.runs += 1;
      const completed = status === "ended" && !state.first_run_sent && !state.first_run_held;
      const held = completed && holding;
      if (held) state.first_run_held = true;
      else if (completed) state.first_run_sent = true;
      keepLater();
      if (completed && !held) emit("first_run_completed");
    },
    close: () => (clearInterval(beat), writing ?? Promise.resolve()),
  };
}
