// `agentrun-serve runner --check`: the runner's environment contract, checked and printed by name, never by value. A
// runner on a disk of its own (disk-free.ts) gets everything it needs from its environment and its store, so a name its
// launcher dropped is a run that fails at its claim, or a model request that goes to the wrong place. The check says
// each gap before that, and fails closed: any gap exits 1. What it reads:
//
// - the store: AGENTRUN_STORE_URL opens, at a schema this runner knows (else a SQLite store in --data, the server's own);
// - the seal key: AGENTRUN_SEAL_KEY (else the key file in --data) is the one the store's secrets are sealed under;
// - the server's run-facing names: every one the server held at its last start (it keeps their names, never their values,
//   in the store: RUN_ENV_KEY), the runner holds too. These are what a run's claim reads from its runner's environment:
//   model, tool and box keys, the Archil settings, each box provider's settings, the tiers' models (AGENT_MODEL,
//   AGENT_MODEL_FAST, AGENT_MODEL_STRONG), AGENTRUN_BOX_ALLOW and the upstreams a model or a tool is sent to
//   (*_BASE_URL, *_API_URL). A server older than this release says none: then that part is skipped, said, and fails
//   nothing;
// - forwarder targets: each upstream the runner holds that names this machine's loopback (a forwarder beside the runner,
//   such as a model gateway's) answers a TCP connect.
//
// A runner that holds the server's own secrets (its API tokens and key) is warned: a runner never needs them.
import { CODE_STORAGE_ENV } from "../learn/store.js";
import { connect } from "node:net";
import { PROVIDERS } from "@parcha/agentrun-computer";
import { ARCHIL_SETTINGS_ENV } from "../archil-settings.js";
import { BOX_ALLOW_ENV } from "../box-settings.js";
import { TOOL_KEY_ROWS } from "../key-words.js";
import { PRIVATE_HOSTS_ENV } from "../mcp-private-hosts.js";
import { HARNESS_MODULES_SETTING, HARNESS_RECIPES_SETTING } from "../harness-table.js";
import { GATEWAY_IDS_ENV } from "../model-gateway.js";
import { BOX_CPUS_ENV, BOX_MEMORY_ENV, BOX_PIDS_ENV, MCP_ALLOW_LOOPBACK_ENV } from "../start-switches.js";
import { DOCKER_IMAGE_ENV } from "../box-image.js";
import { bootSealKey } from "../seal-key.js";
import { SECRET_NAMES } from "../secrets.js";
import type { Settings, Store } from "../store/store.js";
import { SEAL_KEY_ENV } from "../tool-keys.js";
import { LAUNCH_HOOK_SECRET_ENV } from "../trigger-launch-hook.js";

/** The store.settings key a server keeps the names of its run-facing environment under at each start: `{ v: 1, names }`. */
export const RUN_ENV_KEY = "server.run_env";
export const STORE_URL_ENV = "AGENTRUN_STORE_URL";
/** The most connections a Postgres store holds at once; its start refuses a value that is no size (store/open.ts). */
const POOL_SIZE_ENV = "AGENTRUN_STORE_POOL_SIZE";

/** The server's own secrets: never a runner's (runner/main.ts RUNNER_ONLY keeps them from its runs, too). */
const SERVER_ONLY: readonly string[] = ["AGENTRUN_TOKEN", "AGENTRUN_TOKENS", "AGENTRUN_API_KEY", LAUNCH_HOOK_SECRET_ENV];
/** Names that are neither the server's run-facing environment nor the runner's: its own store and key (checked on their
 *  own), the server's secrets, and a client's address of the server. */
const NOT_RUN_FACING = new Set([...SERVER_ONLY, STORE_URL_ENV, SEAL_KEY_ENV, "AGENTRUN_BASE_URL"]);
/** An upstream a model or a tool is sent to, by its name's end. */
const UPSTREAM = /_(?:BASE_URL|API_URL)$/;

/** The fixed run-facing names: every secret the launcher hands over but the server's own, each tool key, each box
 *  provider's keys and settings by their environment names, the Archil settings, the default model and the boxes'
 *  network allow-list, and the operator's bound on owners' private hosts (each dial reads it from the process that dials). */
const FIXED: ReadonlySet<string> = new Set([
  ...SECRET_NAMES,
  ...TOOL_KEY_ROWS.flatMap((row) => row.fields as readonly string[]),
  ...PROVIDERS.flatMap((provider) => provider.keys.map((key) => key.name)),
  ...Object.values(ARCHIL_SETTINGS_ENV),
  // Where learning is (learn/store.ts): a runner without code.storage's settings its server has learns into a folder
  // its server never reads.
  ...Object.values(CODE_STORAGE_ENV),
  // The model of each tier (model.ts TIER_ENV): the default, and the fast and strong ones a subagent may pick.
  "AGENT_MODEL",
  "AGENT_MODEL_FAST",
  "AGENT_MODEL_STRONG",
  BOX_ALLOW_ENV,
  PRIVATE_HOSTS_ENV,
  // How a gateway is sent a model id (model-gateway.ts), and whether runs may reach an MCP server on loopback: each read
  // from the environment of the process that runs the run.
  GATEWAY_IDS_ENV,
  MCP_ALLOW_LOOPBACK_ENV,
  // The harness modules a server loads (harness-table.ts): a runner without them claims their runs and has no harness to
  // run them on.
  HARNESS_MODULES_SETTING,
  // And the harness recipes it runs (harness-table.ts), for the same reason.
  HARNESS_RECIPES_SETTING,
  // A Docker computer's image and size (box-image.ts, workspace/computer-deps.ts dockerLimitsOf): read where the run's
  // computer starts, the runner.
  DOCKER_IMAGE_ENV,
  BOX_CPUS_ENV,
  BOX_MEMORY_ENV,
  BOX_PIDS_ENV,
].filter((name) => !NOT_RUN_FACING.has(name)));

/** Whether `name` is one a run's claim reads from its runner's environment (FIXED, or an upstream's address). */
export const runFacing = (name: string): boolean => !NOT_RUN_FACING.has(name) && (FIXED.has(name) || UPSTREAM.test(name));

/** The run-facing names `read` holds, sorted: of FIXED and of `listed` (the environment's own names, for its upstreams). */
export function runFacingNames(read: (name: string) => string | undefined, listed: Iterable<string>): string[] {
  const names = new Set([...FIXED, ...[...listed].filter(runFacing)]);
  return [...names].filter((name) => Boolean(read(name)?.trim())).sort();
}

/** The server's start: the names of its run-facing environment, replacing the last start's. Names only, never a value. */
export async function recordRunEnv(store: { settings: Pick<Settings, "put"> }, names: readonly string[]): Promise<void> {
  await store.settings.put(RUN_ENV_KEY, { v: 1, names: [...names] });
}

/** The names the server kept at its last start (recordRunEnv), or undefined when it kept none (a server older than this). */
export async function serverRunEnv(store: { settings: Pick<Settings, "get"> }): Promise<string[] | undefined> {
  const kept = await store.settings.get(RUN_ENV_KEY);
  const names = typeof kept === "object" && kept !== null ? (kept as { names?: unknown }).names : undefined;
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : undefined;
}

/** One line of the check: a name (or what it checked, for the heartbeat) and its state, with why. Never a value. */
export type CheckRow = { readonly state: "ok" | "missing" | "bad" | "skipped" | "warn"; readonly name: string; readonly why: string };
/** States that fail the check. */
export const failing = (row: CheckRow): boolean => row.state === "missing" || row.state === "bad";

export interface RunnerEnvCheckOptions {
  /** --data, when given: a SQLite store and the seal key's file are read there when the environment names neither. */
  readonly dataDir?: string;
  /** The runner's environment (AGENTRUN_STORE_SCHEMA and every name it lists). */
  readonly env: NodeJS.ProcessEnv;
  /** A name's value as the runner would read it: its secret handed over by the launcher, else its environment's. */
  readonly read: (name: string) => string | undefined;
  /** Whether a TCP connect to `host`:`port` is answered within `ms` (a test's stand-in). */
  readonly answers?: (host: string, port: number, ms: number) => Promise<boolean>;
}

/** How long a forwarder has to answer the check's connect. */
export const FORWARDER_MS = 2_000;

/** Whether `host`:`port` takes a TCP connection within `ms`. */
export function tcpAnswers(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** `value`'s host and port when it is an http(s) URL on this machine's loopback, else undefined. */
export function loopbackTarget(value: string): { host: string; port: number } | undefined {
  const url = URL.parse(value.trim());
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK_HOST.test(url.hostname)) return undefined;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

/** `text` with the store URL and its password taken out: a driver's error may quote what it was given. */
function withoutUrl(text: string, url: string | undefined): string {
  if (!url) return text;
  let out = text.split(url).join(`<${STORE_URL_ENV}>`);
  const password = URL.parse(url)?.password;
  if (password) for (const form of new Set([password, decodeURIComponent(password)])) if (form.length >= 4) out = out.split(form).join("<password>");
  return out;
}

/** The runner's environment checked (the header's contract), one row per name. The store is opened as a runner, with a
 *  pool of one, and closed before this returns. */
export async function checkRunnerEnv(options: RunnerEnvCheckOptions): Promise<CheckRow[]> {
  const { env, read } = options;
  const answers = options.answers ?? tcpAnswers;
  const rows: CheckRow[] = [];
  const url = read(STORE_URL_ENV)?.trim() || undefined;
  const dataDir = options.dataDir ?? process.cwd();
  let store: Store | undefined;
  if (!url && options.dataDir === undefined) {
    rows.push({ state: "missing", name: STORE_URL_ENV, why: "the store's URL: unset, and no --data to find a SQLite store in" });
  } else {
    // The check opens its store with a pool of one, so a pool size the runner's own start refuses (open.ts, on either
    // store) is checked as given first: a runner whose start would fail never passes this check.
    const { storePoolSize } = await import("../store/open.js");
    try {
      storePoolSize(env);
    } catch (error) {
      rows.push({ state: "bad", name: POOL_SIZE_ENV, why: `the runner's store does not open with it: ${(error as Error)?.message ?? String(error)}` });
    }
    try {
      // Read when the check runs: the server imports this module for its names alone, never the runner's start.
      const { openRunnerStore } = await import("./main.js");
      const opened = await openRunnerStore(dataDir, { ...env, [POOL_SIZE_ENV]: "1" }, () => {}, url);
      store = opened.store;
      rows.push({ state: "ok", name: STORE_URL_ENV, why: url ? `the store opens: ${opened.kind}, schema v${opened.schema}` : "unset: the store is SQLite in the data directory, which is the server's" });
    } catch (error) {
      const why = withoutUrl((error as Error)?.message ?? String(error), url);
      rows.push({ state: url ? "bad" : "missing", name: STORE_URL_ENV, why: url ? `the store does not open: ${why}` : `unset, and the data directory holds no store a runner can open: ${why}` });
    }
  }
  try {
    const given = read(SEAL_KEY_ENV)?.trim() || undefined;
    if (store) {
      try {
        const seal = await bootSealKey(store, dataDir, { given, role: "runner", write: false, say: () => {} });
        seal?.release();
        rows.push(seal ? { state: "ok", name: SEAL_KEY_ENV, why: given ? "the store's seal key" : "unset: the store's seal key is the one in the data directory" } : { state: "missing", name: SEAL_KEY_ENV, why: "the seal key: unset, and none in the data directory" });
      } catch (error) {
        rows.push({ state: given ? "bad" : "missing", name: SEAL_KEY_ENV, why: (error as Error)?.message ?? String(error) });
      }
    } else rows.push(given ? { state: "skipped", name: SEAL_KEY_ENV, why: "set, and not checked against the store, which did not open" } : { state: "missing", name: SEAL_KEY_ENV, why: "the seal key the store's secrets are sealed under: unset" });

    const names = store ? await serverRunEnv(store) : undefined;
    if (!store) rows.push({ state: "skipped", name: RUN_ENV_KEY, why: "the server's run-facing names are read from the store, which did not open" });
    else if (names === undefined) rows.push({ state: "skipped", name: RUN_ENV_KEY, why: "the server has not said its run-facing names in this store (a server older than this runner): start the server of this release first" });
    else for (const name of names) rows.push(read(name)?.trim() ? { state: "ok", name, why: "the server holds it, and so does this runner" } : { state: "missing", name, why: "the server holds it and a run's claim reads it here: hand it to this runner too" });
  } finally {
    await store?.close().catch(() => undefined);
  }

  const listed = Object.keys(env);
  for (const name of [...new Set(listed)].filter((one) => runFacing(one) && UPSTREAM.test(one)).sort()) {
    const value = read(name);
    const target = value ? loopbackTarget(value) : undefined;
    if (!target) continue;
    rows.push((await answers(target.host, target.port, FORWARDER_MS)) ? { state: "ok", name, why: "on this machine's loopback, and a forwarder answers there" } : { state: "bad", name, why: `on this machine's loopback, and nothing answers there within ${FORWARDER_MS / 1000} s: start its forwarder` });
  }
  for (const name of SERVER_ONLY) if (read(name)?.trim()) rows.push({ state: "warn", name, why: "the server's own secret: a runner never needs it, so leave it off the runner" });
  return rows;
}

/** The check's lines: one per row (its state, its name, why), then the outcome. */
export function checkLines(rows: readonly CheckRow[]): { lines: string[]; ok: boolean } {
  const width = Math.max(0, ...rows.map((row) => row.name.length));
  const lines = rows.map((row) => `${row.state.padEnd(7)} ${row.name.padEnd(width)}  ${row.why}`);
  const gaps = rows.filter(failing);
  lines.push(gaps.length === 0 ? `Runner environment: complete (${rows.filter((row) => row.state === "ok").length} ok)` : `Runner environment: ${gaps.length} gap${gaps.length === 1 ? "" : "s"}: ${gaps.map((row) => row.name).join(", ")}`);
  return { lines, ok: gaps.length === 0 };
}
