// The /v2 API over the agent store in a data directory: the contract agentrun.v2/0, served on loopback with a bearer
// token.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { NewRevision, Revision } from "@parcha/pi-durable-agent";
import { agentView, Agents, etagOf, homeBusy, revisionView, storeBusy, type AgentEntry } from "./agents.js";
import { WORKFLOW_ADAPTERS } from "./app.js";
import { DECISION_ADAPTER, decisionsOf, jevRoute } from "./decisions.js";
import { NODE_TOOLS, toolsView } from "./tools.js";
import { ApiError, type InputIssue, invalid, unsupported } from "./errors.js";
import { EFFORTS, FAUX_ENV, MODEL_NODES, modelSource, THINKING_LEVELS } from "./model.js";
import { FAUX_HARNESS_ENV, harnessesOf, type HarnessOffer, harnessOffers } from "./harness.js";
import { healthOf, maxRunsOf, MIN_FREE_MIB } from "./host.js";
import { openapiDocument, UNSUPPORTED } from "./openapi.js";
import { Owner, passwordProblem, SESSION_MS } from "./owner.js";
import { answerPage, isJson, ownerCookie, ownOrigin, signedIn } from "./page.js";
import { durationMs, logLine } from "./print.js";
import { type CarryBackRetry, type Run, Runs, STATUSES, type Status } from "./runs.js";
import { blockersOf, issueOf, type RevisionShape } from "./runnable.js";
import { SECRET_NAMES, withSecrets } from "./secrets.js";
import { checkDefinitionBody, DEFAULT_INPUT_SCHEMA, ID, inputIssues, isObject, type Json, stable } from "./validate.js";
import { openWorkFile, walkWork, WorkRefused } from "./workspace.js";

export const CONTRACT = "agentrun.v2/0";
export const DEFAULT_PORT = 7340;
const VERSION: string = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const TOKEN_FILE = ".token";
const DOOR_TOKEN_FILE = ".door-token";
const IDEMPOTENCY_FILE = ".idempotency.json";
const MAX_BODY = 1 << 20;
const MAX_MESSAGE = 20_000;
const MAX_WAIT_MS = 25_000;
const PAGE_ROWS = 500;
const IDEMPOTENCY_TTL_S = 86_400;
const FILE_LIST_CAP = 2_000;
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; form-action 'none'";
const TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json", jsonl: "application/x-ndjson",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
};
const INLINE = new Set(["text/plain; charset=utf-8", "text/markdown; charset=utf-8", "text/csv; charset=utf-8", "application/json", "application/x-ndjson", "image/png", "image/jpeg", "image/gif", "image/webp", "text/html; charset=utf-8"]);

export type ServeOptions = {
  /** The data directory: the agent store (`store.sqlite`) and its runs (`runs/<id>/`). */
  data: string;
  /** The owner, signed in with a password (owner.ts): the page asks for it, and the token stays for scripts and the CLI. */
  accounts?: boolean;
  /** With accounts: the first visit sets the password with no setup code (a server with no public address). Off, setup
   *  takes the code this server prints, or the token. */
  openSetup?: boolean;
  /** With accounts: the address people open (AGENTRUN_PUBLIC_URL), which the printed setup link uses. */
  publicUrl?: string;
  /** With accounts: the most addresses the sign-in limit keeps at once (default 10,000); a new one past it is a 429. */
  signInAddresses?: number;
  /** The address to listen on (default 127.0.0.1). On any other address every `Host` name is served and the token is
   *  the only lock: put TLS in front of it. */
  host?: string;
  /** The token to require in place of the one `DIR/.token` keeps: 32 characters or more, no whitespace. */
  token?: string;
  /** Default 7340; 0 is any free port. */
  port?: number;
  /** A faux model module (no key, no network): see the README. */
  faux?: string;
  /** With `faux` only: a module whose default export gives the `browser` tool's `{ provider, driver }` (the tests' fake
   *  backend), in place of Browserbase's. */
  fauxBrowser?: string;
  /** With `faux` only: a module whose default export gives `fetch_page` its `{ lookup, fetchImpl }` (the tests' fake
   *  network), in place of the system's resolver and undici. */
  fauxWeb?: string;
  /** With `faux` only: a module whose default export is the fetch Jev's runner sends through (the tests' fake), in place
   *  of TypeSafe's API. */
  fauxJev?: string;
  /** A module scripting the faux harness (`script(spec)`): every harness but pi runs on it (harness.ts). */
  fauxHarness?: string;
  /** Extra `Host` names to accept besides the loopback ones. */
  allowHosts?: string[];
  /** How long a run's process may finish its turn after SIGTERM (default 30s): `8s`, `500ms`, `1m`. */
  drainTimeout?: string;
  /** The most runs at once (default: AGENTRUN_MAX_RUNS, else from this host's memory: host.ts); over it, 429. */
  maxRuns?: number;
  /** Free disk under the data directory below which GET /v2/health fails (default 64 MiB, or AGENTRUN_MIN_FREE_MB). */
  minFreeBytes?: number;
  /** How often a carry back the store refused is tried again while the server lives (default 30 s). */
  settleRetryMs?: number;
  /** Where the log lines go (print.ts); none without it. AGENTRUN_LOG=quiet leaves out the request lines. */
  log?: (line: string) => void;
  /** The waits between carry backs that found the store held by another writer (default 0.5, 1, 2, 4 and 8 s), and a
   *  hook called at each such refusal. */
  carryBackRetry?: CarryBackRetry;
  /** How long a request waits for a run's door, its process coming up or a settle in progress (default 45 s). */
  readyTimeoutMs?: number;
};

/** `tokenFile` is null when `options.token` gave the token; `tokenMade` says this start made the token in it. */
/** `setupUrl`: with accounts and no password yet, the page that sets it (with its code when setup needs one). */
export type Serve = { url: string; baseUrl: string; port: number; token: string; tokenFile: string | null; tokenMade: boolean; setupUrl?: string; close(): Promise<void> };

const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);

/** A private token in `file` (0600), made once and kept; `made` when this call made it. */
async function tokenIn(file: string): Promise<{ token: string; made: boolean }> {
  const known = await readFile(file, "utf8").then((text) => text.trim(), () => "");
  if (known && !/\s/.test(known)) {
    await chmod(file, 0o600);
    return { token: known, made: false };
  }
  const token = `ar_local_${randomBytes(24).toString("base64url")}`;
  await writeFile(file, `${token}\n`, { mode: 0o600, flag: "w" });
  await chmod(file, 0o600);
  return { token, made: true };
}

const digest = (text: string) => createHash("sha256").update(text).digest();
const SESSION_S = SESSION_MS / 1000;

/** A route: `name` is its operationId in the OpenAPI document (openapi.ts); `capability`, when this server turns it off. */
export type Route = { method: string; pattern: RegExp; name: string; capability?: string };
export const ROUTES: readonly Route[] = [
  { method: "GET", pattern: /^\/capabilities$/, name: "getCapabilities" },
  { method: "GET", pattern: /^\/openapi\.json$/, name: "getOpenapi" },
  { method: "GET", pattern: /^\/health$/, name: "getHealth" },
  { method: "POST", pattern: /^\/agents$/, name: "createAgent" },
  { method: "GET", pattern: /^\/agents$/, name: "listAgents" },
  { method: "GET", pattern: /^\/agents\/([^/]+)$/, name: "getAgent" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/definition$/, name: "updateDefinition" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/revisions$/, name: "listRevisions" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/current$/, name: "setCurrent" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/archive$/, name: "archiveAgent" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/unarchive$/, name: "unarchiveAgent" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/runs$/, name: "createRun" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/runs$/, name: "listRuns" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/home$/, name: "exportHome", capability: "home.export" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/home$/, name: "importHome", capability: "home.import" },
  { method: "GET", pattern: /^\/runs$/, name: "listAllRuns" },
  { method: "GET", pattern: /^\/runs\/([^/]+)$/, name: "getRun" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/timeline$/, name: "getTimeline" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/messages$/, name: "sendMessage" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/stop$/, name: "stopRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/cancel$/, name: "cancelRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/archive$/, name: "archiveRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/unarchive$/, name: "unarchiveRun" },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/kill$/, name: "killRun", capability: "runs.kill" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/files$/, name: "listRunFiles" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/files\/(.+)$/, name: "readRunFile" },
  { method: "POST", pattern: /^\/files$/, name: "createFile", capability: "files.upload" },
  { method: "PUT", pattern: /^\/files\/([^/]+)$/, name: "uploadFile", capability: "files.upload" },
  { method: "POST", pattern: /^\/quotes$/, name: "createQuote", capability: "quotes" },
  { method: "GET", pattern: /^\/usage$/, name: "getUsage" },
];

/** What this server offers. Every flag is present; an off one answers 501 naming it. */
export function capabilities(env: NodeJS.ProcessEnv = withSecrets(process.env), maxRuns = maxRunsOf(env), harnesses: HarnessOffer[] = harnessesOf(env)) {
  const models = modelSource(env);
  return {
    backend: "local",
    contract: CONTRACT,
    server: { name: "@parcha/agentrun-serve", version: VERSION, platform: process.platform },
    runtimes: ["pi-durable-disk"],
    /** The harnesses a revision may name (`definition.harness`), and whether this server runs each. */
    harnesses,
    models,
    /** Every tool a revision may name (the closed table in tools.ts): available here, or the variables it is missing. */
    tools: toolsView(env),
    /** How this server holds its secrets (secrets.ts, the launcher), and what that does not cover. */
    secrets: {
      names: [...SECRET_NAMES],
      handoff: "pipe",
      condition: "Started by its launcher (the package's agentrun-serve, the image's entrypoint), the server takes each secret named here over a pipe and holds it in memory only, and every run's process gets all of them but the server's own token over a pipe of its own, whatever its harness and tools: none of them is in any process's environment or command line. The launcher runs before any run's process exists; the image starts it as PID 1. Started another way (node dist/cli.js), the server reads them from its environment, where a process of its user can read them.",
      limit: "In memory is not out of reach: a process of the same user can read another's memory (/proc/<pid>/mem) where the kernel lets it attach. Linux's Yama ptrace_scope of 1 or more refuses that to all but a process's own ancestors; a host at 0 exposes the secrets to a run's own code. A run's process holds its model keys in memory, since it calls the model itself. A harness's CLI (codex, claude-agent) holds a key of its own for its session's model proxy in its environment: not a provider's key, but one a process of the same user could spend through that run's proxy while the session lives. Started as the package's bin on a host, until it execs, the launcher and any subshell it forks show the caller's environment, secrets included, to a process of the same user (/proc keeps a process's environment as it was at its exec). A run's process gets its secrets over a socket, read and closed as it starts; another process can take a socket only through pidfd_getfd, which the same ptrace rule refuses.",
    },
    /** What a workflow revision's run gets: each model node runs on the model of its tier (`models.fast`,
     *  `models.default`, `models.strong`) with the tools it names of `node_tools`; a node that names no thinking level
     *  thinks at the run's effort, or medium. */
    workflows: { nodes: [...MODEL_NODES], node_tools: [...NODE_TOOLS], adapters: [...WORKFLOW_ADAPTERS, ...(jevRoute(env) ? [DECISION_ADAPTER] : [])], decisions: { providers: decisionsOf(env) } },
    features: {
      agents: { create: true, list: true, update: true, revisions: true },
      /** This server's own routes, outside the contract: an archived agent or run is hidden from the lists (`?archived=true`
       *  lists only those) and kept, with its history; a run of an archived agent is refused. */
      archive: { agents: true, runs: true, list_param: "archived", routes: ["POST /agents/{id}/archive", "POST /agents/{id}/unarchive", "POST /runs/{id}/archive", "POST /runs/{id}/unarchive"] },
      home: { export: false, import: false, check: false },
      runs: { stop: true, cancel: true, kill: false, list: true, kinds: ["agentic", "workflow"] },
      messages: { steer: true, answer: true, follow_up: true, steer_workflow_runs: false },
      timeline: { long_poll: true, sse: true, live_rows: true, live_workflow_rows: false },
      files: { upload: false, read: true, range: false, during_run: true },
      quotes: false,
      usage: { basis: "estimate", meters: ["tokens"] },
      efforts: [...EFFORTS],
      thinking: [...THINKING_LEVELS],
      browser: "none",
      sign_ins: false,
      vault: false,
      query: false,
    },
    regions: [{ id: "local", jurisdiction: null, state: "live" }],
    /** This server's own: where its OpenAPI document is, beside this one. */
    links: { openapi: "/v2/openapi.json" },
    limits: {
      max_body_bytes: MAX_BODY,
      max_upload_bytes: null,
      max_files_per_run: 0,
      max_message_chars: MAX_MESSAGE,
      max_concurrent_runs: maxRuns,
      timeline_max_wait_ms: MAX_WAIT_MS,
      timeline_page_rows: PAGE_ROWS,
      idempotency_ttl_s: IDEMPOTENCY_TTL_S,
      input_wait_s: null,
      max_cost_usd: null,
    },
  };
}

function cursorOf(value: string | null): number {
  if (value === null) return 0;
  const offset = Number(Buffer.from(value, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError("bad_request", "cursor is not one this server gave");
  return offset;
}
const nextCursor = (offset: number, total: number) => (offset < total ? Buffer.from(String(offset)).toString("base64url") : null);
function limitOf(value: string | null): number {
  if (value === null) return 20;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > 100) throw new ApiError("bad_request", "limit is an integer from 1 to 100");
  return n;
}
function integerParam(value: string | null, name: string, max: number): number {
  if (value === null) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new ApiError("bad_request", `${name} is an integer from 0 to ${max}`);
  return Number(value);
}

/** The agent homes 0.1.0-beta.26 and earlier kept in the data directory (`<data>/<agent>/agent.sqlite`, an agent named
 *  `runs` or a symlinked home included), which this version's store does not read: their agents and runs would not
 *  show. This version keeps no `agent.sqlite` under the data directory. */
async function oldHomes(data: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(data)) {
    const file = join(data, name, "agent.sqlite");
    if (await stat(file).then((info) => info.isFile(), () => false)) found.push(file);
  }
  return found.sort();
}

export async function startServe(options: ServeOptions): Promise<Serve> {
  const data = resolve(options.data);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const homes = await oldHomes(data);
  if (homes.length) {
    const named = homes.length > 5 ? [...homes.slice(0, 5), `and ${homes.length - 5} more`] : homes;
    throw new Error(`this data directory holds agent homes from AgentRun Server 0.1.0-beta.26 or earlier (${named.join(", ")}), which this version does not read: started here, it would show none of their agents or runs. Keep them with the earlier version, or move those directories out of ${data} to start this one; see "Upgrading from 0.1.0-beta.26" in the serve README.`);
  }
  if (options.token !== undefined && (options.token.length < 32 || /\s/.test(options.token))) throw new Error("the token must be 32 characters or more, with no whitespace");
  const tokenFile = options.token === undefined ? join(data, TOKEN_FILE) : null;
  const stored = options.token === undefined ? await tokenIn(tokenFile!) : undefined;
  const token = options.token ?? stored!.token;
  const doorTokenFile = join(data, DOOR_TOKEN_FILE);
  const { token: doorToken } = await tokenIn(doorTokenFile);
  if (options.drainTimeout !== undefined && durationMs(options.drainTimeout) === undefined) throw new Error(`the drain timeout ${options.drainTimeout} is not a duration such as 8s`);
  const log = options.log;
  const quiet = process.env.AGENTRUN_LOG === "quiet";
  const authFailed = (route: string, reason: string) => log?.(logLine("auth_failed", { route, reason }));
  const env = withSecrets({ ...process.env, ...(options.faux ? { [FAUX_ENV]: resolve(options.faux) } : {}), ...(options.fauxHarness ? { [FAUX_HARNESS_ENV]: resolve(options.fauxHarness) } : {}) });
  const maxRuns = maxRunsOf(process.env, options.maxRuns);
  const minFreeMib = process.env.AGENTRUN_MIN_FREE_MB ? Number(process.env.AGENTRUN_MIN_FREE_MB) : MIN_FREE_MIB;
  if (!(Number.isFinite(minFreeMib) && minFreeMib >= 0)) throw new Error("AGENTRUN_MIN_FREE_MB is a number of MiB, 0 or more");
  const minFreeBytes = options.minFreeBytes ?? minFreeMib * 2 ** 20;
  const caps = capabilities(env, maxRuns, await harnessOffers(env));
  const openapi = openapiDocument((operationId) => ROUTES.find((r) => r.name === operationId)?.capability);
  const agents = new Agents(data);
  const runs = new Runs({ agents, token, doorTokenFile, doorToken, ...(options.faux ? { faux: resolve(options.faux), ...(options.fauxBrowser ? { fauxBrowser: resolve(options.fauxBrowser) } : {}), ...(options.fauxWeb ? { fauxWeb: resolve(options.fauxWeb) } : {}), ...(options.fauxJev ? { fauxJev: resolve(options.fauxJev) } : {}) } : {}), ...(options.fauxHarness ? { fauxHarness: resolve(options.fauxHarness) } : {}), ...(options.drainTimeout ? { drainTimeout: options.drainTimeout } : {}), ...(options.carryBackRetry ? { carryBackRetry: options.carryBackRetry } : {}), maxRuns, ...(options.settleRetryMs ? { settleRetryMs: options.settleRetryMs } : {}), ...(options.readyTimeoutMs ? { readyTimeoutMs: options.readyTimeoutMs } : {}), ...(log ? { log: (event: string, fields: Record<string, string | number>) => log(logLine(event, fields)) } : {}) });
  const expected = digest(`Bearer ${token}`);
  // Answered keys are kept in the data directory for the retention capabilities state, and written before the answer
  // is sent, so a client that retries after a restart gets the first answer back.
  type Kept = { fingerprint: string; at: number; answer?: { status: number; body: unknown; headers: Record<string, string> } };
  const keptFile = join(data, IDEMPOTENCY_FILE);
  const kept = JSON.parse(await readFile(keptFile, "utf8").catch(() => "null")) as { entries?: [string, Kept][] } | null;
  const idempotency = new Map<string, Kept>((kept?.entries ?? []).filter(([, v]) => v?.answer && Date.now() - v.at <= IDEMPOTENCY_TTL_S * 1000));
  // A failed save rejects only its own caller: the next save starts from a settled chain and writes every kept key.
  let saving: Promise<void> = Promise.resolve();
  const keep = () =>
    (saving = saving
      .catch(() => undefined)
      .then(async () => {
        const entries = [...idempotency].filter(([, v]) => v.answer);
        await writeFile(`${keptFile}.partial`, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
        await rename(`${keptFile}.partial`, keptFile);
      }));
  const host = options.host ?? "127.0.0.1";
  const owner = options.accounts ? new Owner(data, options.openSetup === true, (line) => void process.stdout.write(`${line}\n`), options.signInAddresses) : undefined;
  // Runs an earlier server left: supervised again, carried back when they already ended, or opened again.
  void runs.recover().catch((error: Error) => void process.stderr.write(`agentrun-serve: recovery: ${error.message}\n`));

  // ---- helpers --------------------------------------------------------------------------------------------------------

  async function bodyOf(req: IncomingMessage): Promise<Json> {
    const type = String(req.headers["content-type"] ?? "");
    if (!type.startsWith("application/json")) throw new ApiError("unsupported_media_type", "the body must be application/json");
    const chunks: Buffer[] = [];
    let size = 0;
    // An oversized body is read to its end before the refusal, so the client gets the answer and not a reset.
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size <= MAX_BODY) chunks.push(chunk as Buffer);
    }
    if (size > MAX_BODY) throw new ApiError("payload_too_large", `the body is over ${MAX_BODY} bytes`, { details: { limit: "max_body_bytes" } });
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    } catch {
      throw new ApiError("bad_request", "the body is not JSON");
    }
    if (!isObject(value)) throw new ApiError("bad_request", "the body is not a JSON object");
    return value;
  }

  async function needAgent(id: string): Promise<AgentEntry> {
    const entry = ID.test(id) ? await agents.get(id) : null;
    if (!entry) throw new ApiError("not_found", `no agent ${id}`);
    return entry;
  }
  async function needRun(id: string): Promise<Run> {
    const run = ID.test(id) ? await runs.get(id) : null;
    if (!run) throw new ApiError("not_found", `no run ${id}`);
    return run;
  }

  /** Replays the first answer to a create with the same key and body; another body is a mismatch. */
  async function idempotent(req: IncomingMessage, path: string, body: Json, work: () => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>) {
    const key = req.headers["idempotency-key"];
    if (key === undefined) return work();
    if (typeof key !== "string" || key.length < 1 || key.length > 255) throw new ApiError("bad_request", "Idempotency-Key is 1 to 255 characters");
    const slot = `${path}\n${key}`;
    const fingerprint = stable(body);
    const now = Date.now();
    for (const [k, v] of idempotency) if (now - v.at > IDEMPOTENCY_TTL_S * 1000) idempotency.delete(k);
    const known = idempotency.get(slot);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new ApiError("idempotency_mismatch", "this Idempotency-Key was used with another body");
      if (!known.answer) throw new ApiError("idempotency_in_progress", "the first request with this Idempotency-Key is still in flight", { retry_after_ms: 500 });
      return { ...known.answer, headers: { ...known.answer.headers, "idempotent-replayed": "true" } };
    }
    idempotency.set(slot, { fingerprint, at: now });
    let answer: { status: number; body: unknown; headers?: Record<string, string> };
    try {
      answer = await work();
    } catch (error) {
      idempotency.delete(slot);
      throw error;
    }
    // The work happened, so the key keeps its answer in memory even when the file write fails: a retry replays it
    // instead of doing the work twice. Only a restart before the next good save loses it.
    idempotency.set(slot, { fingerprint, at: now, answer: { status: answer.status, body: answer.body, headers: answer.headers ?? {} } });
    await keep().catch((error: Error) => void process.stderr.write(`agentrun-serve: idempotency save: ${error.message}\n`));
    return answer;
  }

  // ---- runs -----------------------------------------------------------------------------------------------------------

  const shapeOf = (revision: Revision): RevisionShape => (revision.kind === "agentic" ? { kind: "agentic", ...revision.body } : { kind: "workflow", workflow: revision.body.workflow, ...(revision.body.harness ? { harness: revision.body.harness } : {}) });

  /** What keeps `revision` from running here, checked before anything starts with the checks a save makes
   *  (runnable.ts): one a save refused, or one a setting of this host fixes that it does not have yet. */
  async function runnable(revision: Revision): Promise<void> {
    const blockers = await blockersOf(env, shapeOf(revision));
    if (!blockers.length) return;
    const message = blockers.map((b) => b.message).join(" ");
    const unbound = blockers.flatMap((b) => (b.tool ? [b.tool] : []));
    const missing = Object.fromEntries(blockers.flatMap((b) => (b.missing ? [[b.missing.tool, b.missing.vars]] : [])));
    const harness = blockers.find((b) => b.harness)?.harness;
    const named = harness ? { harness } : {};
    if (revision.kind === "agentic") throw new ApiError("agent_not_runnable", message, { details: { unbound, missing, ...named } });
    const tier = blockers.find((b) => b.tier)?.tier;
    const decisions = Object.fromEntries(blockers.flatMap((b) => (b.decision ? [[b.decision.provider, { reason: b.reason, needs: b.decision.needs }]] : [])));
    throw new ApiError("agent_not_runnable", message, { details: { adapters: blockers.flatMap((b) => (b.adapter ? [b.adapter] : [])), unbound, missing, code: blockers.some((b) => b.code), ...(tier ? { tier } : {}), ...(Object.keys(decisions).length ? { decisions } : {}), ...named } });
  }

  /** A definition being saved: refused (422 by field) when it can never run here; else what this host still lacks. */
  async function saveable(revision: NewRevision): Promise<InputIssue[]> {
    const blockers = await blockersOf(env, revision.kind === "agentic" ? revision : { kind: "workflow", workflow: revision.workflow, ...(revision.harness ? { harness: revision.harness } : {}) });
    const never = blockers.filter((b) => !b.host);
    if (never.length) throw invalid(never.map(issueOf));
    return blockers.map(issueOf);
  }

  /** A run's input: an agentic run's `{content: string}`, a workflow run's what its workflow's input schema takes. */
  async function inputIssuesOf(revision: Revision, input: Json) {
    if (revision.kind === "agentic") return inputIssues(input, DEFAULT_INPUT_SCHEMA as Json);
    const { validateWorkflow } = await import("@parcha/agentrun-dsl");
    const checked = validateWorkflow(revision.body.workflow, { executeCode: false, input });
    return checked.ok ? [] : checked.issues.map((i) => ({ field: `input${i.path ? ` at ${i.path}` : ""}`, reason: "invalid", message: `the workflow does not take this input: ${i.code}${i.path ? ` at ${i.path}` : ""}` }));
  }

  async function createRun(req: IncomingMessage, agentId: string) {
    const entry = await needAgent(agentId);
    if (entry.agent.archivedAt) throw new ApiError("agent_not_runnable", `The agent ${agentId} is archived: unarchive it to run it.`, { details: { archived_at: entry.agent.archivedAt } });
    const body = await bodyOf(req);
    return idempotent(req, `/agents/${agentId}/runs`, body, async () => {
      const issues = Object.keys(body).filter((k) => !["input", "revision", "file_ids", "effort", "max_cost_usd", "quote_id"].includes(k)).map((k) => ({ field: k, reason: "not_allowed", message: `The body keeps no field ${k}.` }));
      if (!isObject(body.input)) issues.push({ field: "input", reason: body.input === undefined ? "missing" : "wrong_type", message: "input is an object" });
      if (body.revision !== undefined && (typeof body.revision !== "string" || !ID.test(body.revision))) issues.push({ field: "revision", reason: "wrong_type", message: "revision is a revision id of this agent" });
      if (body.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(body.effort)) issues.push({ field: "effort", reason: "not_an_option", message: `effort is one of ${EFFORTS.join(", ")}` });
      if (body.max_cost_usd !== undefined && !(typeof body.max_cost_usd === "number" && body.max_cost_usd > 0)) issues.push({ field: "max_cost_usd", reason: "wrong_type", message: "max_cost_usd is a number above 0" });
      if (body.file_ids !== undefined && !Array.isArray(body.file_ids)) issues.push({ field: "file_ids", reason: "wrong_type", message: "file_ids is a list of file ids" });
      if (issues.length) throw invalid(issues);
      if (body.quote_id !== undefined) throw unsupported("quotes", "This server has no billing, so it takes no quotes.");
      if (Array.isArray(body.file_ids) && body.file_ids.length) throw unsupported("files.upload", "This server takes no uploads, so a run names no files.");
      const pinned = typeof body.revision === "string" ? await agents.revision(entry.agent.id, body.revision) : entry.revision && { revision: entry.revision, version: entry.version };
      if (!pinned) throw invalid([{ field: "revision", reason: "not_an_option", message: typeof body.revision === "string" ? `${body.revision} is not a revision of the agent ${entry.agent.id}` : `the agent ${entry.agent.id} has no current revision` }]);
      const { revision, version } = pinned;
      if (revision.kind === "workflow" && body.max_cost_usd !== undefined) throw invalid([{ field: "max_cost_usd", reason: "not_allowed", message: "A workflow run's spend is not capped here: its cost shows once it ends." }]);
      const input = body.input as Json;
      const wrong = await inputIssuesOf(revision, input);
      if (wrong.length) throw invalid(wrong);
      await runnable(revision);
      const title = typeof input.content === "string" ? input.content : (Object.values(input).find((v): v is string => typeof v === "string") ?? JSON.stringify(input));
      const run = await runs.create(entry, revision, version, { input, title, ...(typeof body.effort === "string" ? { effort: body.effort } : {}), ...(typeof body.max_cost_usd === "number" ? { maxCostUsd: body.max_cost_usd } : {}) });
      return { status: 202, body: await runs.view(run), headers: { location: `/v2/runs/${run.id}` } };
    });
  }

  /** A page of runs from the store, newest first: `agent`, `revision` and `status` narrow it. */
  /** A list's `archived`: true lists only what is archived, false (the default) only what is not. */
  function archivedParam(url: URL): boolean {
    const value = url.searchParams.get("archived");
    if (value !== null && value !== "true" && value !== "false") throw new ApiError("bad_request", "archived is true or false");
    return value === "true";
  }

  async function runsPage(url: URL, filter: { agent?: string; revision?: string }) {
    const limit = limitOf(url.searchParams.get("limit"));
    const offset = cursorOf(url.searchParams.get("cursor"));
    const status = url.searchParams.get("status");
    if (status !== null && !(STATUSES as readonly string[]).includes(status)) throw new ApiError("bad_request", `status is one of ${STATUSES.join(", ")}`);
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && !ID.test(value)) throw new ApiError("bad_request", `${key} is an id`);
    const archived = archivedParam(url);
    let rows = (await agents.request(() => agents.store.listRuns(filter))).filter((row) => Boolean(row.archivedAt) === archived);
    if (status !== null) {
      const statuses = await Promise.all(rows.map((row) => runs.statusOfRow(row)));
      rows = rows.filter((_, i) => statuses[i] === (status as Status));
    }
    const versions = new Map<string, number>();
    for (const agent of new Set(rows.slice(offset, offset + limit).map((row) => row.agent))) for (const r of await agents.revisions(agent)) versions.set(r.id, r.version);
    const page = await Promise.all(rows.slice(offset, offset + limit).map((row) => runs.summaryOfRow(row, versions)));
    return { runs: page, next_cursor: nextCursor(offset + limit, rows.length) };
  }

  async function timeline(req: IncomingMessage, res: ServerResponse, url: URL, run: Run): Promise<void> {
    const after = integerParam(url.searchParams.get("after"), "after", Number.MAX_SAFE_INTEGER);
    const waitMs = integerParam(url.searchParams.get("wait_ms"), "wait_ms", MAX_WAIT_MS);
    const pageOf = async (from: number, wait: number) => {
      const page = await runs.page(run, from, wait, PAGE_ROWS);
      return { run_id: run.id, status: page.status, state: page.state, reset: page.reset, rows: page.rows, drop: page.drop, next_after: page.next_after, unchanged: page.unchanged, has_more: page.has_more, final: page.final, cost: runs.cost(run) };
    };
    if (!String(req.headers.accept ?? "").includes("text/event-stream")) {
      const page = await pageOf(after, waitMs);
      return send(res, 200, { ...page, poll_after_ms: page.final || page.has_more ? 0 : 1000 });
    }
    const last = req.headers["last-event-id"];
    if (last !== undefined && !/^[0-9]+$/.test(String(last))) throw new ApiError("bad_request", "Last-Event-ID is a change number");
    let cursor = last !== undefined ? Number(last) : after;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-content-type-options": "nosniff" });
    const beat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    let open = true;
    res.once("close", () => void (open = false));
    try {
      for (let first = true; open; first = false) {
        const page = await pageOf(cursor, first ? 0 : 15_000);
        if (!open) break;
        if (first || !page.unchanged || page.final) res.write(`event: rows\nid: ${page.next_after}\ndata: ${JSON.stringify(page)}\n\n`);
        cursor = page.next_after;
        if (page.final && !page.has_more) {
          res.write(`event: end\ndata: ${JSON.stringify({ reason: "terminal" })}\n\n`);
          break;
        }
      }
    } finally {
      clearInterval(beat);
      res.end();
    }
  }

  // ---- files ----------------------------------------------------------------------------------------------------------

  /** The run's files, through no link (workspace.ts): each regular file's own size and time, a dot-name left out. */
  async function walk(base: string): Promise<{ path: string; size_bytes: number; modified_at: string; content_type: string | null; unreadable?: true }[]> {
    const out: { path: string; size_bytes: number; modified_at: string; content_type: string | null; unreadable?: true }[] = [];
    if (!(await lstat(base).catch(() => null))?.isDirectory()) return out;
    // work/ unreadable as a whole lists nothing; what the walk could not read in it is left out.
    await walkWork(base, (path, st, readable) => {
      if (st.isFile()) out.push({ path, size_bytes: st.size, modified_at: new Date(st.mtimeMs).toISOString(), content_type: TYPES[extname(path).slice(1).toLowerCase()] ?? null, ...(readable ? {} : { unreadable: true }) });
      return out.length <= FILE_LIST_CAP;
    }, { skip: (name) => name.startsWith(".") }).catch((error) => {
      if (!(error instanceof WorkRefused)) throw error;
    });
    return out;
  }

  async function readFileRoute(req: IncomingMessage, res: ServerResponse, url: URL, run: Run, raw: string): Promise<void> {
    let rel: string;
    try {
      rel = raw.split("/").map(decodeURIComponent).join("/");
    } catch {
      throw new ApiError("invalid_file_path", "the path is not percent-encoded right");
    }
    const parts = rel.split("/");
    if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0") || parts.some((p) => p === "" || p === "." || p === "..")) throw new ApiError("invalid_file_path", "the path has an empty, . or .. segment, a backslash, a NUL or a leading /");
    if (parts.some((p) => p.startsWith("."))) throw new ApiError("system_file_forbidden", "a path segment that starts with . is the run's own, not a file it wrote");
    const work = join(run.dir, "work");
    if (!(await lstat(work).catch(() => null))?.isDirectory()) throw new ApiError("not_found", "no such file");
    // Through no link, held from the open to the last byte (workspace.ts): a name swapped for one is refused, not followed.
    const opened = await openWorkFile(work, rel).catch((error) => {
      if (error instanceof WorkRefused && error.reason === "unreadable") throw new ApiError("system_file_forbidden", "This file was created private by a tool in the run's box: this server cannot read it.", { details: { reason: "unreadable" } });
      return null;
    });
    if (!opened) throw new ApiError("not_found", "no such file");
    const { handle, stats: st } = opened;
    const type = TYPES[extname(rel).slice(1).toLowerCase()] ?? "application/octet-stream";
    const download = url.searchParams.get("download") === "1" || !INLINE.has(type);
    const name = parts.at(-1)!.replace(/[^\w.-]/g, "_");
    res.writeHead(200, {
      "content-type": type,
      "content-length": st.size,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      ...(type.startsWith("text/html") ? { "content-security-policy": FILE_CSP } : {}),
      ...(download ? { "content-disposition": `attachment; filename="${name}"` } : {}),
    });
    if (req.method === "HEAD" || st.size === 0) {
      await handle.close();
      return void res.end();
    }
    await pipeline(handle.createReadStream(), res).catch(() => undefined);
    await handle.close().catch(() => undefined);
  }

  // ---- usage ----------------------------------------------------------------------------------------------------------

  async function usage(url: URL) {
    const now = new Date();
    const fromText = url.searchParams.get("from");
    const toText = url.searchParams.get("to");
    const from = fromText === null ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) : Date.parse(fromText);
    const to = toText === null ? now.getTime() : Date.parse(toText);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ApiError("bad_request", "from and to are RFC 3339 times");
    const group = url.searchParams.get("group_by") ?? "meter";
    if (!["meter", "agent", "key", "day", "region"].includes(group)) throw new ApiError("bad_request", "group_by is meter, agent, key, day or region");
    const lines = new Map<string, { usd: number; unpriced: number }>();
    const total = { usd: 0, unpriced: 0 };
    for (const row of await agents.request(() => agents.store.listRuns())) {
      const at = Date.parse(row.startedAt);
      if (!(at >= from && at < to)) continue;
      const live = row.state === "running" ? await runs.get(row.id) : null;
      const usd = live ? runs.cost(live).usd : (row.costUsd ?? null);
      const key = group === "agent" ? row.agent : group === "day" ? row.startedAt.slice(0, 10) : group === "meter" ? "tokens" : "local";
      // A run whose cost is unknown adds no dollars, so no sum turns unknown; it is counted as unpriced instead, so it
      // never passes as $0.
      const line = lines.get(key) ?? lines.set(key, { usd: 0, unpriced: 0 }).get(key)!;
      for (const sum of [line, total]) {
        if (usd === null) sum.unpriced++;
        else sum.usd += usd;
      }
    }
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    return {
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), currency: "USD", basis: "estimate", group_by: group, total_usd: round(total.usd), unpriced_runs: total.unpriced,
      lines: [...lines].map(([key, line]) => ({ group: key, ...(group === "meter" ? { meter: "tokens" } : {}), usd: round(line.usd), unpriced_runs: line.unpriced })),
      account: null,
    };
  }

  // ---- the owner ------------------------------------------------------------------------------------------------------

  /** A write from the page: this server's own origin and a JSON body. A cookie never makes one from anywhere else. */
  function fromPage(req: IncomingMessage): void {
    if (req.headers.origin?.toLowerCase() !== ownOrigin(req)) throw new ApiError("forbidden", "this write must come from this server's page");
    if (!isJson(req)) throw new ApiError("unsupported_media_type", "the body must be application/json");
  }

  /** The body's one field `name`, a password: 422 on any other field, or on one the rules refuse. */
  async function passwordIn(req: IncomingMessage, allowed: readonly string[], check = true): Promise<{ password: string; body: Json }> {
    const body = await bodyOf(req);
    const issues: InputIssue[] = Object.keys(body).filter((key) => !allowed.includes(key)).map((key) => ({ field: key, reason: "not_allowed", message: `The body keeps no field ${key}.` }));
    const problem = check ? passwordProblem(body.password) : typeof body.password === "string" && Buffer.byteLength(body.password) <= 1024 ? undefined : "password is text, at most 1024 bytes";
    if (problem) issues.push({ field: "password", reason: body.password === undefined ? "missing" : "invalid", message: problem });
    if (issues.length) throw invalid(issues);
    return { password: body.password as string, body };
  }

  /** POST /v2/setup, POST /v2/auth/sign-in, POST /v2/auth/sign-out and GET /v2/auth/session, answered before any
   *  credential: their own checks are the setup code (or the token), the password, and the session. */
  async function ownerRoute(req: IncomingMessage, res: ServerResponse, path: string, me: Owner): Promise<void> {
    const method = path === "/auth/session" ? "GET" : "POST";
    if (req.method !== method) throw new ApiError("method_not_allowed", `${req.method} is not a method of /v2${path}`, {}, { allow: method });
    switch (path) {
      case "/setup": {
        const byToken = req.headers.authorization !== undefined;
        if (byToken && !timingSafeEqual(digest(String(req.headers.authorization)), expected)) throw new ApiError("unauthenticated", "the Bearer here is the server's token, or none", {}, { "www-authenticate": "Bearer" });
        if (!byToken) fromPage(req);
        const { password, body } = await passwordIn(req, ["password", "code"]);
        const made = await me.setFirst(password, body.code, byToken);
        if (made === "exists") throw new ApiError("forbidden", "this server has its owner, or is being set up: sign in");
        if (made === "code") throw new ApiError("forbidden", "that is not the setup code in the server's log, or it has expired");
        return send(res, 201, { signed_in: true }, { "set-cookie": ownerCookie(req, me.session(), SESSION_S) });
      }
      case "/auth/sign-in": {
        fromPage(req);
        const allowed = me.allow(req.socket.remoteAddress ?? "unknown");
        if (allowed === "full") authFailed("/v2/auth/sign-in", "sign_in_table_full");
        if (allowed !== "ok") throw new ApiError("rate_limited", "too many sign-ins; try again later", { retry_after_ms: 900_000 }, { "retry-after": "900" });
        const { password } = await passwordIn(req, ["password"], false);
        if (!me.hasPassword()) throw new ApiError("forbidden", "this server has no password yet: set it on the setup page");
        if (!(await me.check(password))) {
          authFailed("/v2/auth/sign-in", "wrong_password");
          throw new ApiError("unauthenticated", "that is not the password");
        }
        return send(res, 200, { signed_in: true }, { "set-cookie": ownerCookie(req, me.session(), SESSION_S) });
      }
      case "/auth/sign-out": {
        fromPage(req);
        if (!signedIn(req, me)) throw new ApiError("unauthenticated", "this browser is not signed in");
        me.signOutEverywhere();
        return send(res, 200, { signed_out: true }, { "set-cookie": ownerCookie(req, "", 0) });
      }
      case "/auth/session":
        return send(res, 200, { password_set: me.hasPassword(), signed_in: signedIn(req, me) });
    }
    throw new ApiError("not_found", `no route /v2${path}`);
  }

  // ---- routing --------------------------------------------------------------------------------------------------------

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
    const matching = ROUTES.filter((r) => r.pattern.test(path));
    if (!matching.length) throw new ApiError("not_found", `no route ${path}`);
    const found = matching.find((r) => r.method === req.method || (req.method === "HEAD" && r.method === "GET"));
    if (!found) throw new ApiError("method_not_allowed", `${req.method} is not a method of ${path}`, {}, { allow: [...new Set(matching.map((r) => r.method))].join(", ") });
    if (found.name === "getCapabilities") return send(res, 200, caps);
    if (found.name === "getOpenapi") return send(res, 200, openapi);
    if (found.name === "getHealth") {
      const health = await healthOf(data, minFreeBytes);
      return send(res, health.status === "ok" ? 200 : 503, health);
    }
    if (!timingSafeEqual(digest(String(req.headers.authorization ?? "")), expected)) {
      authFailed(`/v2${path}`, req.headers.authorization === undefined ? "no_credential" : "wrong_token");
      throw new ApiError("unauthenticated", "this route needs Authorization: Bearer <the token in the data directory>", {}, { "www-authenticate": "Bearer" });
    }
    if (found.capability) throw unsupported(found.capability, UNSUPPORTED[found.capability]!);
    const [, first, second] = found.pattern.exec(path)!;
    const id = first ? decodeURIComponent(first) : "";
    switch (found.name) {
      case "createAgent": {
        const body = await bodyOf(req);
        const answer = await idempotent(req, "/agents", body, async () => {
          let warnings: InputIssue[] = [];
          const entry = await agents.create(checkDefinitionBody(body), async (revision) => void (warnings = await saveable(revision)));
          return { status: 201, body: { ...agentView(entry), warnings }, headers: { location: `/v2/agents/${entry.agent.id}`, etag: etagOf(entry) } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listAgents": {
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const archived = archivedParam(url);
        const all = (await agents.list()).filter((entry) => Boolean(entry.agent.archivedAt) === archived);
        return send(res, 200, { agents: all.slice(offset, offset + limit).map((entry) => agentView(entry)), next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "getAgent": {
        const entry = await needAgent(id);
        return send(res, 200, agentView(entry), { etag: etagOf(entry) });
      }
      case "updateDefinition": {
        const entry = await needAgent(id);
        const match = req.headers["if-match"];
        if (match !== undefined && match !== etagOf(entry)) throw new ApiError("precondition_failed", `If-Match is ${match}, and the agent's current revision is ${etagOf(entry)}`);
        const body = await bodyOf(req);
        // The check above is a fast path; the store compares If-Match again inside the commit, so of two edits that read
        // the same revision exactly one lands.
        let warnings: InputIssue[] = [];
        const check = async (revision: NewRevision) => void (warnings = await saveable(revision));
        const edited = await agents.commit(entry, checkDefinitionBody(body, { creating: false }), { check, ...(match === undefined ? {} : { ifCurrent: entry.revision?.id ?? null }) });
        return send(res, 200, { ...agentView(edited), warnings }, { etag: etagOf(edited) });
      }
      case "listRevisions": {
        const entry = await needAgent(id);
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const all = await agents.revisions(id);
        const page = await agents.request(() => all.slice(offset, offset + limit).map((row) => revisionView(entry.agent, row, agents.store.readRevision(row.id))));
        return send(res, 200, { revisions: page, next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "setCurrent": {
        const entry = await needAgent(id);
        const body = await bodyOf(req);
        const extra = Object.keys(body).filter((k) => k !== "revision");
        if (extra.length) throw invalid(extra.map((k) => ({ field: k, reason: "not_allowed", message: `The body keeps no field ${k}.` })));
        const revision = body.revision;
        if (typeof revision !== "string" || !ID.test(revision)) throw invalid([{ field: "revision", reason: revision === undefined ? "missing" : "wrong_type", message: "revision is a revision id of this agent" }]);
        if (!(await agents.revision(id, revision))) throw invalid([{ field: "revision", reason: "not_an_option", message: `${revision} is not a revision of the agent ${id}` }]);
        const moved = await agents.setCurrent(entry, revision);
        return send(res, 200, agentView(moved), { etag: etagOf(moved) });
      }
      case "archiveAgent":
      case "unarchiveAgent": {
        await needAgent(id);
        await agents.setArchived("agent", id, found.name === "archiveAgent");
        const entry = await needAgent(id);
        return send(res, 200, agentView(entry), { etag: etagOf(entry) });
      }
      case "createRun": {
        const answer = await createRun(req, id);
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listRuns":
        await needAgent(id);
        return send(res, 200, await runsPage(url, { agent: id }));
      case "listAllRuns": {
        const agent = url.searchParams.get("agent") ?? undefined;
        const revision = url.searchParams.get("revision") ?? undefined;
        return send(res, 200, await runsPage(url, { ...(agent ? { agent } : {}), ...(revision ? { revision } : {}) }));
      }
      case "getRun":
        return send(res, 200, await runs.view(await needRun(id)));
      case "getTimeline":
        return timeline(req, res, url, await needRun(id));
      case "sendMessage": {
        const run = await needRun(id);
        if (run.kind === "workflow") throw unsupported("messages.steer_workflow_runs", "A workflow run takes no messages here: its workflow runs to its end, or a cancel ends it.");
        const body = await bodyOf(req);
        const answer = await idempotent(req, `/runs/${id}/messages`, body, async () => {
          const extra = Object.keys(body).filter((k) => k !== "content");
          if (extra.length) throw invalid(extra.map((k) => ({ field: k, reason: "not_allowed", message: `The body keeps no field ${k}.` })));
          const content = body.content;
          if (typeof content !== "string" || !/\S/.test(content)) throw invalid([{ field: "content", reason: content === undefined ? "missing" : "wrong_type", message: "content is a non-empty string" }]);
          if (content.length > MAX_MESSAGE) throw invalid([{ field: "content", reason: "too_long", message: `content is at most ${MAX_MESSAGE} characters` }]);
          const { mode, messageId } = await runs.message(run, content);
          const view = await runs.view(run);
          return { status: 202, body: { run_id: run.id, message_id: messageId, mode, status: view.status, state: view.state, poll_after_ms: 1000 } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "stopRun": {
        const run = await needRun(id);
        const stopped = await runs.stop(run);
        const view = await runs.view(run);
        return send(res, 200, { run_id: run.id, stopped, status: view.status, state: view.state });
      }
      case "cancelRun": {
        const run = await needRun(id);
        const requested = await runs.cancel(run);
        const view = await runs.view(run);
        return send(res, 202, { run_id: run.id, cancel_requested: requested, already_terminal: !requested, status: view.status });
      }
      case "archiveRun":
      case "unarchiveRun": {
        const run = await needRun(id);
        await agents.setArchived("run", run.id, found.name === "archiveRun");
        return send(res, 200, await runs.view(run));
      }
      case "listRunFiles": {
        const run = await needRun(id);
        const files = (await walk(join(run.dir, "work"))).sort((a, b) => a.path.localeCompare(b.path));
        return send(res, 200, { run_id: run.id, files: files.slice(0, FILE_LIST_CAP), complete: true, truncated: files.length > FILE_LIST_CAP });
      }
      case "readRunFile":
        return readFileRoute(req, res, url, await needRun(id), second!);
      case "getUsage":
        return send(res, 200, await usage(url));
    }
    throw new ApiError("not_found", `no route ${path}`);
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
    res.end(text);
  }

  let names: Set<string> | undefined;
  const server = createServer((req, res) => {
    const requestId = `req_${randomBytes(8).toString("hex")}`;
    res.setHeader("x-request-id", requestId);
    if (log && !quiet) {
      const started = performance.now();
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0]!;
      res.once("finish", () => log(logLine("request", { method, path, status: res.statusCode, ms: Math.round(performance.now() - started) })));
    }
    const fail = (error: unknown) => {
      if (res.headersSent) return void res.end();
      // A store still busy past a request's wait is home_busy, whichever read or write met it.
      const known = error instanceof ApiError ? error : storeBusy(error) ? homeBusy() : new ApiError("internal", (error as Error)?.message ?? String(error));
      if (!(error instanceof ApiError) && !storeBusy(error)) process.stderr.write(`agentrun-serve: ${(error as Error)?.stack ?? String(error)}\n`);
      send(res, known.status, known.body(requestId), known.headers);
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://serve");
    } catch {
      return fail(new ApiError("bad_request", "the request target is not a URL"));
    }
    // On loopback, a Host that is not a loopback name is a page that rebound a name of its own to this address.
    if (names && !names.has(String(req.headers.host ?? "").toLowerCase())) return fail(new ApiError("forbidden", "unexpected Host header"));
    // Routed on the path as sent: a parsed URL folds `..` and `%2E%2E` segments away, and a file path must see them.
    const raw = (req.url ?? "/").split("?")[0]!;
    // Before the page: its cookie must not stand in for the token on the owner's own routes.
    if (owner && (raw === "/v2/setup" || raw.startsWith("/v2/auth/"))) return void ownerRoute(req, res, raw.slice(3), owner).catch(fail);
    if (answerPage(req, res, raw, { token, dir: data, authFailed, ...(owner ? { owner } : {}) })) return;
    if (!raw.startsWith("/v2/")) return fail(new ApiError("not_found", `no route ${raw}; the API is under /v2`));
    route(req, res, url, raw.slice(3)).catch(fail);
  });
  const port = options.port ?? DEFAULT_PORT;
  await new Promise<void>((done, reject) => (server.once("error", reject), server.listen(port, host, () => done())));
  const address = server.address() as AddressInfo;
  if (isLoopback(host)) names = new Set(["localhost", "127.0.0.1", "[::1]", host, ...(options.allowHosts ?? [])].map((h) => `${h.toLowerCase()}:${address.port}`));
  // An address of every interface is reached on this machine at its loopback one.
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${shown.includes(":") ? `[${shown}]` : shown}:${address.port}`;
  owner?.attach(options.publicUrl ?? url);
  const setupUrl = owner && !owner.hasPassword() ? owner.setupLink() : undefined;
  return {
    url,
    baseUrl: `${url}/v2`,
    port: address.port,
    token,
    tokenFile,
    tokenMade: stored?.made ?? false,
    ...(setupUrl ? { setupUrl } : {}),
    async close() {
      await runs.close();
      await new Promise((done) => (server.close(done), server.closeAllConnections()));
      agents.close();
    },
  };
}
