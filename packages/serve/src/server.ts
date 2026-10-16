// The /v2 API over agent homes in a data directory: the contract agentrun.v2/0, served on loopback with a bearer token.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { agentView, Agents, etagOf, type AgentEntry } from "./agents.js";
import { BOUND_TOOLS } from "./app.js";
import { ApiError, invalid, unsupported } from "./errors.js";
import { EFFORTS, FAUX_ENV, modelSource } from "./model.js";
import { type Run, Runs } from "./runs.js";
import { checkAgentCreate, DEFAULT_INPUT_SCHEMA, ID, inputIssues, isObject, type Json } from "./validate.js";

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
  /** The directory of agent homes. */
  data: string;
  host?: string;
  /** Default 7340; 0 is any free port. */
  port?: number;
  /** A faux model module (no key, no network): see the README. */
  faux?: string;
  /** Extra `Host` names to accept besides the loopback ones. */
  allowHosts?: string[];
  drainTimeout?: string;
};

export type Serve = { url: string; baseUrl: string; port: number; token: string; tokenFile: string; close(): Promise<void> };

const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);

/** A private token in `file` (0600), made once and kept. */
async function tokenIn(file: string): Promise<string> {
  const known = await readFile(file, "utf8").then((text) => text.trim(), () => "");
  if (known && !/\s/.test(known)) {
    await chmod(file, 0o600);
    return known;
  }
  const token = `ar_local_${randomBytes(24).toString("base64url")}`;
  await writeFile(file, `${token}\n`, { mode: 0o600, flag: "w" });
  await chmod(file, 0o600);
  return token;
}

const digest = (text: string) => createHash("sha256").update(text).digest();
const stable = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(stable).join(",")}]` : isObject(value) ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value);

type Route = { method: string; pattern: RegExp; name: string; capability?: string };
const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/capabilities$/, name: "capabilities" },
  { method: "POST", pattern: /^\/agents$/, name: "createAgent" },
  { method: "GET", pattern: /^\/agents$/, name: "listAgents" },
  { method: "GET", pattern: /^\/agents\/([^/]+)$/, name: "getAgent" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/definition$/, name: "updateDefinition", capability: "agents.update" },
  { method: "POST", pattern: /^\/agents\/([^/]+)\/runs$/, name: "createRun" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/runs$/, name: "listRuns" },
  { method: "GET", pattern: /^\/agents\/([^/]+)\/home$/, name: "exportHome", capability: "home.export" },
  { method: "PUT", pattern: /^\/agents\/([^/]+)\/home$/, name: "importHome", capability: "home.import" },
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
    ...(models ? { models } : {}),
    features: {
      agents: { create: true, list: true, update: false },
      home: { export: false, import: false, check: false },
      runs: { stop: true, cancel: true, kill: false },
      messages: { steer: true, answer: true, follow_up: true, steer_workflow_runs: false },
      timeline: { long_poll: true, sse: true, live_rows: true },
      files: { upload: false, read: true, range: false, during_run: true },
      quotes: false,
      usage: { basis: "estimate", meters: ["tokens"] },
      efforts: [...EFFORTS],
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

export async function startServe(options: ServeOptions): Promise<Serve> {
  const data = resolve(options.data);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const tokenFile = join(data, TOKEN_FILE);
  const token = await tokenIn(tokenFile);
  const doorTokenFile = join(data, DOOR_TOKEN_FILE);
  const doorToken = await tokenIn(doorTokenFile);
  const env = { ...process.env, ...(options.faux ? { [FAUX_ENV]: resolve(options.faux) } : {}) };
  const caps = capabilities(env);
  const agents = new Agents(data);
  const runs = new Runs({ agents, doorTokenFile, doorToken, ...(options.faux ? { faux: resolve(options.faux) } : {}), ...(options.drainTimeout ? { drainTimeout: options.drainTimeout } : {}) });
  const expected = digest(`Bearer ${token}`);
  // Answered keys are kept in the data directory for the retention capabilities state, and written before the answer
  // is sent, so a client that retries after a restart gets the first answer back.
  type Kept = { fingerprint: string; at: number; answer?: { status: number; body: unknown; headers: Record<string, string> } };
  const keptFile = join(data, IDEMPOTENCY_FILE);
  const kept = JSON.parse(await readFile(keptFile, "utf8").catch(() => "null")) as { entries?: [string, Kept][] } | null;
  const idempotency = new Map<string, Kept>((kept?.entries ?? []).filter(([, v]) => v?.answer && Date.now() - v.at <= IDEMPOTENCY_TTL_S * 1000));
  let saving: Promise<void> = Promise.resolve();
  const keep = () =>
    (saving = saving.then(async () => {
      const entries = [...idempotency].filter(([, v]) => v.answer);
      await writeFile(`${keptFile}.partial`, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      await rename(`${keptFile}.partial`, keptFile);
    }));
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new Error(`agentrun-serve binds loopback only; ${host} is not loopback`);
  // Runs an earlier server left: supervised again, or carried back when they already ended.
  void agents.list().then((entries) => runs.recover(entries)).catch((error: Error) => void process.stderr.write(`agentrun-serve: recovery: ${error.message}\n`));

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
    try {
      const answer = await work();
      idempotency.set(slot, { fingerprint, at: now, answer: { status: answer.status, body: answer.body, headers: answer.headers ?? {} } });
      await keep();
      return answer;
    } catch (error) {
      idempotency.delete(slot);
      throw error;
    }
  }

  // ---- runs -----------------------------------------------------------------------------------------------------------

  /** What keeps the agent from running here, checked before anything starts. */
  function runnable(entry: AgentEntry): void {
    const { definition, skills } = entry.state;
    const unbound = definition.tools.filter((name) => !(BOUND_TOOLS as readonly string[]).includes(name));
    const why = !caps.models
      ? "No model is bound: start agentrun-serve with --faux MODULE, or set AGENT_MODEL_BASE_URL and AGENT_MODEL."
      : definition.workflow
        ? "agentrun-serve runs agents, not workflows: this definition has a workflow."
        : unbound.length
          ? `agentrun-serve binds the tools ${BOUND_TOOLS.join(", ")}; this definition also names ${unbound.join(", ")}.`
          : definition.skills.filter((name) => !Object.hasOwn(skills, `${name}/SKILL.md`)).map((name) => `The definition names the skill ${name}, and the home has no ${name}/SKILL.md.`)[0];
    if (why) throw new ApiError("agent_not_runnable", why, { details: { unbound } });
  }

  async function createRun(req: IncomingMessage, agentId: string) {
    const entry = await needAgent(agentId);
    const body = await bodyOf(req);
    return idempotent(req, `/agents/${agentId}/runs`, body, async () => {
      const issues = Object.keys(body).filter((k) => !["input", "file_ids", "effort", "max_cost_usd", "quote_id"].includes(k)).map((k) => ({ field: k, reason: "not_allowed", message: `The body keeps no field ${k}.` }));
      if (!isObject(body.input)) issues.push({ field: "input", reason: body.input === undefined ? "missing" : "wrong_type", message: "input is an object" });
      if (body.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(body.effort)) issues.push({ field: "effort", reason: "not_an_option", message: `effort is one of ${EFFORTS.join(", ")}` });
      if (body.max_cost_usd !== undefined && !(typeof body.max_cost_usd === "number" && body.max_cost_usd > 0)) issues.push({ field: "max_cost_usd", reason: "wrong_type", message: "max_cost_usd is a number above 0" });
      if (body.file_ids !== undefined && !Array.isArray(body.file_ids)) issues.push({ field: "file_ids", reason: "wrong_type", message: "file_ids is a list of file ids" });
      if (issues.length) throw invalid(issues);
      if (body.quote_id !== undefined) throw unsupported("quotes", "This server has no billing, so it takes no quotes.");
      if (Array.isArray(body.file_ids) && body.file_ids.length) throw unsupported("files.upload", "This server takes no uploads, so a run names no files.");
      const input = body.input as Json;
      const schema = entry.state.definition.input_schema ?? DEFAULT_INPUT_SCHEMA;
      const wrong = inputIssues(input, schema as Json);
      if (wrong.length) throw invalid(wrong);
      runnable(entry);
      const content = entry.state.definition.input_schema ? (typeof input.content === "string" && Object.keys(input).length === 1 ? input.content : JSON.stringify(input)) : (input.content as string);
      const title = typeof input.content === "string" ? input.content : (Object.values(input).find((v): v is string => typeof v === "string") ?? JSON.stringify(input));
      const cap = typeof body.max_cost_usd === "number" ? body.max_cost_usd : entry.state.definition.max_cost_usd;
      const run = await runs.create(entry, { content, title, ...(typeof body.effort === "string" ? { effort: body.effort } : {}), ...(cap !== undefined ? { maxCostUsd: cap } : {}) });
      return { status: 202, body: await runs.view(run), headers: { location: `/v2/runs/${run.id}` } };
    });
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
    const lines = new Map<string, number | null>();
    let total: number | null = 0;
    for (const entry of await agents.list()) {
      for (const run of await runs.of(entry)) {
        const at = Date.parse(run.meta.created_at);
        if (!(at >= from && at < to)) continue;
        const usd = runs.cost(run).usd;
        const key = group === "agent" ? run.agentId : group === "day" ? run.meta.created_at.slice(0, 10) : group === "meter" ? "tokens" : "local";
        const before = lines.has(key) ? lines.get(key)! : 0;
        lines.set(key, before === null || usd === null ? null : before + usd);
        total = total === null || usd === null ? null : total + usd;
      }
    }
    const round = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);
    return {
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), currency: "USD", basis: "estimate", group_by: group, total_usd: round(total),
      lines: [...lines].map(([key, usd]) => ({ group: key, ...(group === "meter" ? { meter: "tokens" } : {}), usd: round(usd) })),
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
    if (!timingSafeEqual(digest(String(req.headers.authorization ?? "")), expected)) throw new ApiError("unauthenticated", "this route needs Authorization: Bearer <the token in the data directory>", {}, { "www-authenticate": "Bearer" });
    if (found.capability) {
      const off: Record<string, string> = {
        "agents.update": "This server does not update a definition yet.",
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
          const { definition, skills } = checkAgentCreate(body);
          const entry = await agents.create(definition, skills);
          return { status: 201, body: agentView(entry), headers: { location: `/v2/agents/${entry.home.identity.id}`, etag: etagOf(entry) } };
        });
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listAgents": {
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const all = await agents.list();
        return send(res, 200, { agents: all.slice(offset, offset + limit).map((entry) => agentView(entry)), next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "getAgent": {
        const entry = await needAgent(id);
        return send(res, 200, agentView(entry), { etag: etagOf(entry) });
      }
      case "createRun": {
        const answer = await createRun(req, id);
        return send(res, answer.status, answer.body, answer.headers);
      }
      case "listRuns": {
        const entry = await needAgent(id);
        const limit = limitOf(url.searchParams.get("limit"));
        const offset = cursorOf(url.searchParams.get("cursor"));
        const status = url.searchParams.get("status");
        if (status !== null && !["queued", "working", "input_required", "completed", "failed", "cancelled"].includes(status)) throw new ApiError("bad_request", "status is one of the six run statuses");
        const all = (await Promise.all((await runs.of(entry)).map((run) => runs.summary(run)))).filter((s) => status === null || s.status === status).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.run_id.localeCompare(a.run_id));
        return send(res, 200, { runs: all.slice(offset, offset + limit), next_cursor: nextCursor(offset + limit, all.length) });
      }
      case "getRun":
        return send(res, 200, await runs.view(await needRun(id)));
      case "getTimeline":
        return timeline(req, res, url, await needRun(id));
      case "sendMessage": {
        const run = await needRun(id);
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
    // A Host that is not a loopback name is a page that rebound a name of its own to this address.
    if (names && !names.has(String(req.headers.host ?? "").toLowerCase())) return fail(new ApiError("forbidden", "unexpected Host header"));
    // Routed on the path as sent: a parsed URL folds `..` and `%2E%2E` segments away, and a file path must see them.
    const raw = (req.url ?? "/").split("?")[0]!;
    if (!raw.startsWith("/v2/")) return fail(new ApiError("not_found", `no route ${raw}; the API is under /v2`));
    route(req, res, url, raw.slice(3)).catch(fail);
  });
  const port = options.port ?? DEFAULT_PORT;
  await new Promise<void>((done, reject) => (server.once("error", reject), server.listen(port, host, () => done())));
  const address = server.address() as AddressInfo;
  names = new Set(["localhost", "127.0.0.1", "[::1]", host, ...(options.allowHosts ?? [])].map((h) => `${h.toLowerCase()}:${address.port}`));
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    url,
    baseUrl: `${url}/v2`,
    port: address.port,
    token,
    tokenFile,
    async close() {
      await runs.close();
      await new Promise((done) => (server.close(done), server.closeAllConnections()));
    },
  };
}
