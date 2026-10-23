// `serveHome`: a local page over an agent home, read straight from its SQLite files. It listens on this machine's loopback
// only, answers GET and HEAD, and sends nothing a host keeps for itself (saved sign-ins, sessions, leases, bindings).
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { AGENT_STORE_FILE, ID_PATTERN } from "../home.js";
import { AgentHomeError } from "../store.js";
import { timelineOf } from "../timeline/index.js";
import { agentReader, readRunEntries } from "./read.js";

export type ServeOptions = {
  /** The loopback port; 0 (the default) takes a free one. */
  port?: number;
  /** Closes the server when it aborts. */
  signal?: AbortSignal;
};
export type ServeHandle = {
  /** `http://127.0.0.1:<port>/` */
  url: string;
  close(): Promise<void>;
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
const SECURITY = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
const PAGE_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "page.html", type: "text/html; charset=utf-8" },
  "/page.css": { file: "page.css", type: "text/css; charset=utf-8" },
  "/page.js": { file: "page.js", type: "text/javascript; charset=utf-8" },
};

function send(request: IncomingMessage, response: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  response.writeHead(status, { ...SECURITY, "content-type": type, "content-length": bytes.length, ...extra });
  response.end(request.method === "HEAD" ? undefined : bytes);
}
const json = (request: IncomingMessage, response: ServerResponse, status: number, value: unknown, extra?: Record<string, string>) =>
  send(request, response, status, "application/json; charset=utf-8", JSON.stringify(value), extra);

/** The status and the words for a read that failed: what the home is, never where it is on the disk. */
function failure(error: unknown): { status: number; message: string } {
  if (error instanceof AgentHomeError) return { status: error.code === "missing" ? 404 : 500, message: error.message };
  return { status: 500, message: "the agent home could not be read" };
}

/**
 * Serve the agent home at `home.dir` on 127.0.0.1: `GET /` is the page, `GET /api/agent`, `GET /api/runs` and
 * `GET /api/runs/:id` are its data. Reading takes no lock and opens the stores read-only, so a home a run is writing to can
 * be watched.
 * A request whose `Host` is not this server's own address is refused (a page on another origin cannot reach it through a
 * rebound name), and so is any method but GET and HEAD.
 */
export async function serveHome(home: { readonly dir: string }, options: ServeOptions = {}): Promise<ServeHandle> {
  const dir = path.resolve(home.dir);
  if (!existsSync(path.join(dir, AGENT_STORE_FILE))) throw new AgentHomeError("missing", `${path.basename(dir)} is not an agent home (no ${AGENT_STORE_FILE})`);
  const { port = 0, signal } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new AgentHomeError("invalid", `the port ${String(port)} is not 0 to 65535`);
  const assets = new Map<string, { type: string; body: Buffer }>();
  for (const [route, { file, type }] of Object.entries(PAGE_FILES)) {
    const body = await readFile(new URL(file, import.meta.url)).catch(() => undefined);
    if (body) assets.set(route, { type, body });
  }

  const readAgent = agentReader(dir);
  const handle = async (request: IncomingMessage, response: ServerResponse, address: AddressInfo): Promise<void> => {
    const host = (request.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`) return json(request, response, 421, { error: "this server answers only to its own address" });
    if (request.method !== "GET" && request.method !== "HEAD") return json(request, response, 405, { error: "this server is read-only: GET and HEAD only" }, { allow: "GET, HEAD" });
    const target = request.url ?? "";
    if (!target.startsWith("/") || target.startsWith("//")) return json(request, response, 400, { error: "the request target is not a path" });
    let pathname: string;
    try {
      ({ pathname } = new URL(target, "http://127.0.0.1"));
    } catch {
      return json(request, response, 400, { error: "the request target is not a path" });
    }
    const asset = assets.get(pathname);
    if (asset) return send(request, response, 200, asset.type, asset.body);
    try {
      if (pathname === "/api/agent") {
        const { runs, ...view } = await readAgent();
        const questions = view.prompts.filter((prompt) => prompt.role === "question").length;
        return json(request, response, 200, { ...view, counts: { skills: view.skills.length, prompts: view.prompts.length - questions, questions, runs: runs.length, live: runs.filter((run) => run.live).length } });
      }
      if (pathname === "/api/runs") return json(request, response, 200, (await readAgent()).runs);
      const match = /^\/api\/runs\/([^/]+)$/.exec(pathname);
      if (match) {
        const id = match[1]!;
        if (!ID_PATTERN.test(id)) return json(request, response, 400, { error: "the run id is not letters, digits, \".\", \"_\" or \"-\"" });
        const run = (await readAgent()).runs.find((candidate) => candidate.id === id);
        if (!run) return json(request, response, 404, { error: "no such run" });
        return json(request, response, 200, { run, rows: timelineOf(readRunEntries(dir, id, run.endedAt !== undefined), { settled: !run.live }) });
      }
      return json(request, response, 404, { error: "not found" });
    } catch (error) {
      const { status, message } = failure(error);
      return json(request, response, status, { error: message });
    }
  };

  const server: Server = createServer((request, response) => {
    handle(request, response, server.address() as AddressInfo).catch(() => {
      if (!response.headersSent) json(request, response, 500, { error: "the agent home could not be read" });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  if (signal?.aborted) await close();
  else signal?.addEventListener("abort", () => void close(), { once: true });
  return { url, close };
}
