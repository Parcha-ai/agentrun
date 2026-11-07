// The box relay: how a run's process reaches its Daytona box without Daytona's key. The key is the server's alone
// (BOX_KEYS, SERVER_ONLY in runs.ts), so a run's Daytona provider sends each of its calls here instead, on loopback with
// its run's own door token (RUN_DOOR_TOKEN, the token its door takes, handed to that run's process alone), and the relay
// sends it on with the key only when it is one of the calls a run's tools make of that run's own box: a read of the
// sandbox, its toolbox's address, and its toolbox's programs and files. Nothing else passes: no call for another run (its
// token is not this one), no create, listing, stop or delete (the server makes and seeds the box, pulls its work/ back
// and destroys it), no call to a sandbox that does not carry the run's label, and no redirect, ever followed: one would
// carry the key. The relay's address is a file in the data directory, read again at each call, so a run's process that
// outlives its server reaches the next one. A run in the VM box reaches it the same way, through the VM half
// (box-relay-vm.ts), which makes the calls with the server's own client.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { vmRelay } from "./box-relay-vm.js";
import { type DaytonaApi, daytonaCall, redirectRefusal } from "./daytona-api.js";
import { readJson, RUN_DOOR_TOKEN, writeWhole } from "./files.js";

/** The relay's address in the data directory: `{"url": "http://<loopback>:<port>"}`. */
export const BOX_RELAY_FILE = ".box-relay";
/** Where the relay listens: only this machine's runs reach it. */
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the relay listens on loopback only, for the runs of this machine
/** What a run's Daytona provider sends as its key: never a key. The relay sends the server's in its place. */
export const RELAYED_KEY = "relayed-by-the-server";
/** The header that names the Daytona URL a relayed call is for. */
const TARGET = "x-agentrun-target";
/** The label that names a box's run (run-box.ts RUN_LABEL), kept here so the run's process loads no more than it needs. */
const RUN_LABEL = "agentrun.run";
/** The most bytes one relayed call may send: a file a tool writes, or a program's input. */
const MAX_BODY_BYTES = 64 * 2 ** 20;
/** The toolbox calls a run's tools make, by their route after the sandbox's id, and the one method each takes. */
const TOOLBOX: Readonly<Record<string, string>> = { "process/execute": "POST", "files/upload-v2": "POST", "files/download": "GET", "files/permissions": "POST" };
/** The most sandboxes the relay remembers the run of; past it, it asks Daytona again. */
const KNOWN_MAX = 1024;

export type BoxRelayOptions = {
  /** The data directory: where the relay's address goes. */
  root: string;
  /** Run `runId`'s own door token, which a call for that run must carry; undefined for a run that has none. */
  tokenOf(runId: string): string | undefined;
  /** Daytona's API and the server's key for it; absent on a server with no Daytona box. */
  apiUrl?: string;
  apiKey?: string;
  /** For tests. Default the global `fetch`. */
  fetch?: typeof fetch;
  /** The VM half (box-relay-vm.ts), on a server with the VM box. */
  vm?: ReturnType<typeof vmRelay>;
  /** Whether `runId` is a run this server holds in a remote box that has not ended. */
  serves(runId: string): boolean;
  /** The run's box, found by its label or made with its work/ seeded (run-box.ts ensureRemoteBox): its id, and whether it is new. */
  ensure(runId: string): Promise<{ id: string; made: boolean; replaced?: boolean }>;
};

export type BoxRelay = { url: string; close(): Promise<void> };

const digest = (text: string) => createHash("sha256").update(text).digest();

/** Starts the relay on loopback and writes its address; `close` stops it and removes the address. */
export async function startBoxRelay(options: BoxRelayOptions): Promise<BoxRelay> {
  const base = (options.apiUrl ?? "").replace(/\/+$/, "");
  const upstream = options.fetch ?? fetch;
  const api: DaytonaApi = { apiUrl: base, apiKey: options.apiKey ?? "", ...(options.fetch ? { fetch: options.fetch } : {}) };
  // Each sandbox's run (its label) and its toolbox's address, as Daytona answered the server: neither changes.
  const known = new Map<string, { run: string | undefined; proxy?: string }>();
  const remember = (id: string, value: { run: string | undefined; proxy?: string }) => {
    if (known.size >= KNOWN_MAX) known.clear();
    known.set(id, value);
  };

  /** The run whose label sandbox `id` carries, as Daytona says; undefined for a sandbox that has none, or is not there. */
  const runOf = async (id: string): Promise<string | undefined> => {
    const held = known.get(id);
    if (held) return held.run;
    const answer = await daytonaCall(api, "GET", `/sandbox/${encodeURIComponent(id)}`);
    if (answer.status === 404) return undefined;
    if (!answer.ok) throw new Error(`Daytona answered ${answer.status} to the read of a sandbox`);
    const info = (await answer.json().catch(() => null)) as { labels?: Record<string, unknown>; toolboxProxyUrl?: unknown } | null;
    const run = typeof info?.labels?.[RUN_LABEL] === "string" ? (info.labels[RUN_LABEL] as string) : undefined;
    remember(id, { run, ...(typeof info?.toolboxProxyUrl === "string" ? { proxy: info.toolboxProxyUrl } : {}) });
    return run;
  };
  /** Sandbox `id`'s toolbox address, without a trailing slash. */
  const proxyOf = async (id: string): Promise<string | undefined> => {
    const held = known.get(id);
    if (held?.proxy) return held.proxy.replace(/\/+$/, "");
    const answer = await daytonaCall(api, "GET", `/sandbox/${encodeURIComponent(id)}/toolbox-proxy-url`);
    if (!answer.ok) return undefined;
    const url = ((await answer.json().catch(() => null)) as { url?: unknown } | null)?.url;
    if (typeof url !== "string") return undefined;
    if (held) held.proxy = url;
    return url.replace(/\/+$/, "");
  };

  /** The sandbox a relayed call is for, when it is one a run's tools make; else why not. */
  const sandboxOf = async (method: string, target: URL): Promise<{ id: string } | { refused: string }> => {
    const call = `${method} ${target.origin}${target.pathname}`;
    const refused = { refused: `the box relay does not send ${call}: a run's process reaches only its own box's programs and files` };
    const api = `${base}/sandbox/`;
    const whole = `${target.origin}${target.pathname}`;
    if (whole.startsWith(api)) {
      // A read of the sandbox (attach, status) or of its toolbox's address: GET, no query.
      const named = /^([^/]+)(\/toolbox-proxy-url)?$/.exec(whole.slice(api.length));
      if (!named || method !== "GET" || target.search) return refused;
      return { id: decodeURIComponent(named[1]!) };
    }
    const routed = /^(.+)\/([^/]+)\/(process\/execute|files\/upload-v2|files\/download|files\/permissions)$/.exec(whole);
    if (!routed || TOOLBOX[routed[3]!] !== method) return refused;
    const id = decodeURIComponent(routed[2]!);
    // The toolbox call goes only to the address Daytona gives that sandbox's toolbox: never to a host the call names.
    if ((await runOf(id)) === undefined || (await proxyOf(id)) !== routed[1]) return refused;
    return { id };
  };

  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const forward = async (runId: string, req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const target = URL.parse(String(req.headers[TARGET] ?? ""));
    if (!target) return answer(res, 400, { message: `a relayed call names its Daytona URL in ${TARGET}` });
    const named = await sandboxOf(method, target);
    if ("refused" in named) return answer(res, 403, { message: named.refused });
    // A sandbox of another run, or of none, is not there for this one: as Daytona answers a sandbox it does not have.
    if ((await runOf(named.id)) !== runId) return answer(res, 404, { statusCode: 404, message: "sandbox not found" });
    const body = method === "GET" ? undefined : await bytesOf(req);
    if (body === null) return answer(res, 413, { message: `a relayed call sends at most ${MAX_BODY_BYTES} bytes` });
    const abort = new AbortController();
    res.once("close", () => void (res.writableFinished || abort.abort()));
    const type = req.headers["content-type"];
    let sent: Response;
    try {
      sent = await upstream(target.href, {
        method,
        headers: { authorization: `Bearer ${options.apiKey}`, "x-daytona-source": "pi-transport", ...(type ? { "content-type": type } : {}) },
        ...(body ? { body: new Uint8Array(body) } : {}),
        // Never followed: a box that holds its toolbox's port could point the key at another run's sandbox.
        redirect: "error",
        signal: abort.signal,
      });
    } catch (error) {
      const refused = redirectRefusal(error);
      if (refused) return answer(res, 502, { message: `the box relay refuses ${method} ${target.pathname}: ${refused}` });
      throw error;
    }
    res.writeHead(sent.status, { "content-type": sent.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" });
    if (!sent.body) return void res.end();
    Readable.fromWeb(sent.body as never).on("error", () => res.destroy()).pipe(res);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = /^\/runs\/([^/]+)\/(box|daytona|vm\/.+)$/.exec(new URL(req.url ?? "/", "http://relay").pathname);
      const runId = path ? decodeURIComponent(path[1]!) : "";
      // The calling run's own token, and only for its own run: one run's process never speaks for another's.
      const token = path ? options.tokenOf(runId) : undefined;
      const auth = String(req.headers.authorization ?? "");
      if (!path || !token || !timingSafeEqual(digest(auth), digest(`Bearer ${token}`))) return answer(res, 401, { message: "the box relay takes a run's call only with that run's own door token" });
      if (!options.serves(runId)) return answer(res, 404, { message: "no run of this server is in a remote box by that id" });
      if (path[2] === "box") {
        if (req.method !== "POST") return answer(res, 405, { message: "POST asks for the run's box" });
        const box = await options.ensure(runId);
        remember(box.id, { run: runId });
        return answer(res, 200, { id: box.id, made: box.made, ...(box.replaced ? { replaced: true } : {}), ...(options.apiKey ? { api_url: base } : {}) });
      }
      if (path[2]!.startsWith("vm/")) return options.vm ? options.vm.handle(runId, path[2]!.slice(3), req, res) : answer(res, 404, { message: "this server has no Modal sandbox" });
      if (!options.apiKey) return answer(res, 404, { message: "this server has no Daytona box" });
      return forward(runId, req, res);
    })().catch((error: unknown) => {
      if (res.headersSent) return void res.destroy();
      // The cause's message only: no header, key or answer's body of Daytona's is in it.
      answer(res, 502, { message: `the box relay could not complete the call: ${(error as Error)?.message ?? String(error)}` });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => resolve());
  });
  const url = `http://${LOOPBACK}:${(server.address() as AddressInfo).port}`;
  await writeWhole(join(options.root, BOX_RELAY_FILE), `${JSON.stringify({ url })}\n`);
  return {
    url,
    close: async () => {
      await rm(join(options.root, BOX_RELAY_FILE), { force: true });
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** A request's body, or null past MAX_BODY_BYTES. */
async function bytesOf(req: IncomingMessage): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

/** The relay's address, from the data directory `root`, and the run's own door token, from its directory `runDir`: read
 *  at each call. */
export async function relayAddress(root: string, runDir: string): Promise<{ url: string; token: string }> {
  const [file, token] = await Promise.all([readJson(join(root, BOX_RELAY_FILE)), readFile(join(runDir, RUN_DOOR_TOKEN), "utf8").catch(() => "")]);
  const url = file && typeof file === "object" && !Array.isArray(file) && typeof file.url === "string" ? file.url : undefined;
  if (!url || !token.trim()) throw new Error("this server's box relay is not running, and a run reaches its remote box only through it");
  return { url, token: token.trim() };
}

/** The `fetch` a run's Daytona provider uses: each call goes to the relay, which sends it on with the key. */
export const relayFetch = (root: string, runDir: string, runId: string): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const { url, token } = await relayAddress(root, runDir);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set(TARGET, input instanceof Request ? input.url : String(input));
    return fetch(`${url}/runs/${encodeURIComponent(runId)}/daytona`, { ...init, headers });
  }) as typeof fetch;

/** Asks the relay for run `runId`'s box: made and seeded by the server when it has none. */
export async function relayedBox(root: string, runDir: string, runId: string, signal?: AbortSignal): Promise<{ id: string; made: boolean; replaced?: boolean; apiUrl?: string }> {
  const { url, token } = await relayAddress(root, runDir);
  const sent = await fetch(`${url}/runs/${encodeURIComponent(runId)}/box`, { method: "POST", headers: { authorization: `Bearer ${token}` }, redirect: "error", ...(signal ? { signal } : {}) });
  const body = (await sent.json().catch(() => null)) as { id?: unknown; made?: unknown; replaced?: unknown; api_url?: unknown; message?: unknown } | null;
  if (!sent.ok || typeof body?.id !== "string") {
    throw new Error(`the server did not give the run its box: ${typeof body?.message === "string" ? body.message : `it answered ${sent.status}`}`);
  }
  return { id: body.id, made: body.made === true, ...(body.replaced === true ? { replaced: true } : {}), ...(typeof body.api_url === "string" ? { apiUrl: body.api_url } : {}) };
}
