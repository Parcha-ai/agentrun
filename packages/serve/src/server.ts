// The /v2 API over the agent store in a data directory: the contract agentrun.v2/0, served on loopback with a bearer
// token.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Revision } from "@parcha/pi-durable-agent";
import { agentView, Agents, etagOf, revisionView, type AgentEntry } from "./agents.js";
import { BOUND_TOOLS, NODE_TOOLS, WORKFLOW_ADAPTERS } from "./app.js";
import { ApiError, invalid, unsupported } from "./errors.js";
import { chooseModel, EFFORTS, FAUX_ENV, MODEL_NODES, modelSource, nodeTiers, THINKING_LEVELS } from "./model.js";
import { answerPage } from "./page.js";
import { durationMs, logLine } from "./print.js";
import { type CarryBackRetry, type Run, Runs, STATUSES, type Status } from "./runs.js";
import { checkDefinitionBody, DEFAULT_INPUT_SCHEMA, ID, inputIssues, isObject, type Json, stable } from "./validate.js";

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
  /** The address to listen on (default 127.0.0.1). On any other address every `Host` name is served and the token is
   *  the only lock: put TLS in front of it. */
  host?: string;
  /** The token to require in place of the one `DIR/.token` keeps: 32 characters or more, no whitespace. */
  token?: string;
  /** Default 7340; 0 is any free port. */
  port?: number;
  /** A faux model module (no key, no network): see the README. */
  faux?: string;
  /** Extra `Host` names to accept besides the loopback ones. */
  allowHosts?: string[];
  /** How long a run's process may finish its turn after SIGTERM (default 30s): `8s`, `500ms`, `1m`. */
  drainTimeout?: string;
  /** Where the log lines go (print.ts); none without it. AGENTRUN_LOG=quiet leaves out the request lines. */
  log?: (line: string) => void;
  /** The waits between carry backs that found the store held by another writer (default 0.5, 1, 2, 4 and 8 s), and a
   *  hook called at each such refusal. */
  carryBackRetry?: CarryBackRetry;
};

/** `tokenFile` is null when `options.token` gave the token; `tokenMade` says this start made the token in it. */
export type Serve = { url: string; baseUrl: string; port: number; token: string; tokenFile: string | null; tokenMade: boolean; close(): Promise<void> };

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

type Route = { method: string; pattern: RegExp; name: string; capability?: string };
const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/capabilities$/, name: "capabilities" },
  { method: "POST", pattern: /^\/agents$/, name: "createAgent" },
  { method: "GET", pattern: /^\/agents$/, name: "listAgents" },
  { method: "GET", pattern: /^\/agents\/([^/]+)$/, name: "getAgent" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/definition$/, name: "updateDefinition" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/revisions$/, name: "listRevisions" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/current$/, name: "setCurrent" },
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
  { method: "POST", pattern: /^\/runs\/([^/]+)\/kill$/, name: "killRun", capability: "runs.kill" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/files$/, name: "listRunFiles" },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/files\/(.+)$/, name: "readRunFile" },
  { method: "POST", pattern: /^\/files$/, name: "createFile", capability: "files.upload" },
  { method: "PUT", pattern: /^\/files\/([^/]+)$/, name: "uploadFile", capability: "files.upload" },
  { method: "POST", pattern: /^\/quotes$/, name: "createQuote", capability: "quotes" },
  { method: "GET", pattern: /^\/usage$/, name: "getUsage" },
];

/** What this server offers. Every flag is present; an off one answers 501 naming it. */
export function capabilities(env: NodeJS.ProcessEnv = process.env) {
  const models = modelSource(env);
  return {
    backend: "local",
    contract: CONTRACT,
    server: { name: "@parcha/agentrun-serve", version: VERSION, platform: process.platform },
    runtimes: ["pi-durable-disk"],
    models,
    /** The tools an agentic revision may name. */
    tools: [...BOUND_TOOLS],
    /** What a workflow revision's run gets: each model node runs on the model of its tier (`models.fast`,
     *  `models.default`, `models.strong`) with the file tools it names; a node that names no thinking level thinks at
     *  the run's effort, or medium. */
    workflows: { nodes: [...MODEL_NODES], node_tools: [...NODE_TOOLS], adapters: [...WORKFLOW_ADAPTERS] },
    features: {
      agents: { create: true, list: true, update: true, revisions: true },
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
    limits: {
      max_body_bytes: MAX_BODY,
      max_upload_bytes: null,
      max_files_per_run: 0,
      max_message_chars: MAX_MESSAGE,
      max_concurrent_runs: null,
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
  const env = { ...process.env, ...(options.faux ? { [FAUX_ENV]: resolve(options.faux) } : {}) };
  const caps = capabilities(env);
  const agents = new Agents(data);
  const runs = new Runs({ agents, token, doorTokenFile, doorToken, ...(options.faux ? { faux: resolve(options.faux) } : {}), ...(options.drainTimeout ? { drainTimeout: options.drainTimeout } : {}), ...(options.carryBackRetry ? { carryBackRetry: options.carryBackRetry } : {}), ...(log ? { log: (event: string, fields: Record<string, string | number>) => log(logLine(event, fields)) } : {}) });
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

  function needAgent(id: string): AgentEntry {
    const entry = ID.test(id) ? agents.get(id) : null;
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

  /** What keeps `revision` from running here, checked before anything starts: tools this host does not bind, workflow
   *  adapters it does not give, and a model it cannot reach. */
  async function runnable(revision: Revision): Promise<void> {
    if (revision.kind === "agentic") {
      const unbound = revision.body.tools.filter((name) => !(BOUND_TOOLS as readonly string[]).includes(name));
      if (unbound.length) throw new ApiError("agent_not_runnable", `agentrun-serve binds the tools ${BOUND_TOOLS.join(", ")}; this revision also names ${unbound.join(", ")}.`, { details: { unbound } });
      const chosen = await chooseModel(env, revision.body.model);
      if ("why" in chosen) throw new ApiError("agent_not_runnable", chosen.why, { details: { unbound: [] } });
      return;
    }
    const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
    const { requires } = inspectWorkflow(revision.body.workflow);
    const adapters = requires.adapters.filter((name) => !(WORKFLOW_ADAPTERS as readonly string[]).includes(name));
    const unbound = requires.tools.filter((name) => !(NODE_TOOLS as readonly string[]).includes(name));
    const why = adapters.length || requires.executableCode
      ? `agentrun-serve runs a workflow's model nodes (agent, decide, extract, report); this workflow also needs ${[...adapters, ...(requires.executableCode ? ["code"] : [])].join(", ")}.`
      : unbound.length
        ? `A workflow's model nodes get the tools ${NODE_TOOLS.join(", ")} here; this workflow also names ${unbound.join(", ")}.`
        : undefined;
    if (why) throw new ApiError("agent_not_runnable", why, { details: { adapters, unbound, code: requires.executableCode } });
    for (const tier of nodeTiers(revision.body.workflow)) {
      const chosen = await chooseModel(env, undefined, tier);
      if ("why" in chosen) throw new ApiError("agent_not_runnable", chosen.why, { details: { adapters: [], unbound: [], code: false, tier } });
    }
  }

  /** A run's input: an agentic run's `{content: string}`, a workflow run's what its workflow's input schema takes. */
  async function inputIssuesOf(revision: Revision, input: Json) {
    if (revision.kind === "agentic") return inputIssues(input, DEFAULT_INPUT_SCHEMA as Json);
    const { validateWorkflow } = await import("@parcha/agentrun-dsl");
    const checked = validateWorkflow(revision.body.workflow, { executeCode: false, input });
    return checked.ok ? [] : checked.issues.map((i) => ({ field: `input${i.path ? ` at ${i.path}` : ""}`, reason: "invalid", message: `the workflow does not take this input: ${i.code}${i.path ? ` at ${i.path}` : ""}` }));
  }

  async function createRun(req: IncomingMessage, agentId: string) {
    const entry = needAgent(agentId);
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
      const pinned = typeof body.revision === "string" ? agents.revision(entry.agent.id, body.revision) : entry.revision && { revision: entry.revision, version: entry.version };
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
  async function runsPage(url: URL, filter: { agent?: string; revision?: string }) {
    const limit = limitOf(url.searchParams.get("limit"));
    const offset = cursorOf(url.searchParams.get("cursor"));
    const status = url.searchParams.get("status");
    if (status !== null && !(STATUSES as readonly string[]).includes(status)) throw new ApiError("bad_request", `status is one of ${STATUSES.join(", ")}`);
    for (const [key, value] of Object.entries(filter)) if (value !== undefined && !ID.test(value)) throw new ApiError("bad_request", `${key} is an id`);
    let rows = agents.store.listRuns(filter);
    if (status !== null) {
      const statuses = await Promise.all(rows.map((row) => runs.statusOfRow(row)));
      rows = rows.filter((_, i) => statuses[i] === (status as Status));
    }
    const versions = new Map<string, number>();
    for (const agent of new Set(rows.slice(offset, offset + limit).map((row) => row.agent))) for (const r of agents.revisions(agent)) versions.set(r.id, r.version);
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

  async function walk(base: string, dir = "", out: { path: string; size_bytes: number; modified_at: string; content_type: string | null }[] = [], depth = 0): Promise<typeof out> {
    for (const d of await readdir(join(base, dir), { withFileTypes: true }).catch(() => [])) {
      if (d.name.startsWith(".") || d.isSymbolicLink() || out.length > FILE_LIST_CAP) continue;
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isDirectory()) depth < 16 && (await walk(base, rel, out, depth + 1));
      else if (d.isFile()) {
        const st = await stat(join(base, rel)).catch(() => null);
        if (st) out.push({ path: rel, size_bytes: st.size, modified_at: new Date(st.mtimeMs).toISOString(), content_type: TYPES[extname(rel).slice(1).toLowerCase()] ?? null });
      }
    }
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
    let path = join(run.dir, "work");
    if (!(await lstat(path).catch(() => null))?.isDirectory()) throw new ApiError("not_found", "no such file");
    for (const part of parts) {
      path = join(path, part);
      const st = await lstat(path).catch(() => null);
      if (!st || st.isSymbolicLink()) throw new ApiError("not_found", "no such file");
    }
    const st = await lstat(path);
    if (!st.isFile()) throw new ApiError("not_found", "no such file");
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
    if (req.method === "HEAD" || st.size === 0) return void res.end();
    await pipeline(createReadStream(path), res).catch(() => undefined);
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
    for (const row of agents.store.listRuns()) {
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

  // ---- routing --------------------------------------------------------------------------------------------------------

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
    const matching = ROUTES.filter((r) => r.pattern.test(path));
    if (!matching.length) throw new ApiError("not_found", `no route ${path}`);
    const found = matching.find((r) => r.method === req.method || (req.method === "HEAD" && r.method === "GET"));
    if (!found) throw new ApiError("method_not_allowed", `${req.method} is not a method of ${path}`, {}, { allow: [...new Set(matching.map((r) => r.method))].join(", ") });
    if (found.name === "capabilities") return send(res, 200, caps);
    if (!timingSafeEqual(digest(String(req.headers.authorization ?? "")), expected)) {
      authFailed(`/v2${path}`, req.headers.authorization === undefined ? "no_credential" : "wrong_token");
      throw new ApiError("unauthenticated", "this route needs Authorization: Bearer <the token in the data directory>", {}, { "www-authenticate": "Bearer" });
    }
    if (found.capability) {
      const off: Record<string, string> = {
        "home.export": "This server does not export a home yet.",
        "home.import": "This server does not import a home yet.",
        "runs.kill": "This server does not kill a run's process yet.",
        "files.upload": "This server takes no uploads yet.",
        quotes: "This server has no billing, so it gives no quotes.",
      };
      throw unsupported(found.capability, off[found.capability]!);
    }
    const [, first, second] = found.pattern.exec(path)!;
    const id = first ? decodeURIComponent(first) : "";
    switch (found.name) {
      case "createAgent": {
        const body = await bodyOf(req);
        const answer = await idempotent(req, "/agents", body, async () => {
          const entry = await agents.create(checkDefinitionBody(body));
          return { status: 201, body: agentView(entry), headers: { location: `/v2/agents/${entry.agent.id}`, etag: etagOf(entry) } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listAgents": {
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const all = agents.list();
        return send(res, 200, { agents: all.slice(offset, offset + limit).map((entry) => agentView(entry)), next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "getAgent": {
        const entry = needAgent(id);
        return send(res, 200, agentView(entry), { etag: etagOf(entry) });
      }
      case "updateDefinition": {
        const entry = needAgent(id);
        const match = req.headers["if-match"];
        if (match !== undefined && match !== etagOf(entry)) throw new ApiError("precondition_failed", `If-Match is ${match}, and the agent's current revision is ${etagOf(entry)}`);
        const body = await bodyOf(req);
        // The check above is a fast path; the store compares If-Match again inside the commit, so of two edits that read
        // the same revision exactly one lands.
        const edited = await agents.commit(entry, checkDefinitionBody(body, { creating: false }), match === undefined ? {} : { ifCurrent: entry.revision?.id ?? null });
        return send(res, 200, agentView(edited), { etag: etagOf(edited) });
      }
      case "listRevisions": {
        const entry = needAgent(id);
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const all = agents.revisions(id);
        const page = all.slice(offset, offset + limit).map((row) => revisionView(entry.agent, row, agents.store.readRevision(row.id)));
        return send(res, 200, { revisions: page, next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "setCurrent": {
        const entry = needAgent(id);
        const body = await bodyOf(req);
        const extra = Object.keys(body).filter((k) => k !== "revision");
        if (extra.length) throw invalid(extra.map((k) => ({ field: k, reason: "not_allowed", message: `The body keeps no field ${k}.` })));
        const revision = body.revision;
        if (typeof revision !== "string" || !ID.test(revision)) throw invalid([{ field: "revision", reason: revision === undefined ? "missing" : "wrong_type", message: "revision is a revision id of this agent" }]);
        if (!agents.revision(id, revision)) throw invalid([{ field: "revision", reason: "not_an_option", message: `${revision} is not a revision of the agent ${id}` }]);
        const moved = agents.setCurrent(entry, revision);
        return send(res, 200, agentView(moved), { etag: etagOf(moved) });
      }
      case "createRun": {
        const answer = await createRun(req, id);
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listRuns":
        needAgent(id);
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
      const known = error instanceof ApiError ? error : new ApiError("internal", (error as Error)?.message ?? String(error));
      if (!(error instanceof ApiError)) process.stderr.write(`agentrun-serve: ${(error as Error)?.stack ?? String(error)}\n`);
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
    if (answerPage(req, res, raw, { token, dir: data, authFailed })) return;
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
  return {
    url,
    baseUrl: `${url}/v2`,
    port: address.port,
    token,
    tokenFile,
    tokenMade: stored?.made ?? false,
    async close() {
      await runs.close();
      await new Promise((done) => (server.close(done), server.closeAllConnections()));
      agents.close();
    },
  };
}
