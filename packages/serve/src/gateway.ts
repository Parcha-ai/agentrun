// A run's gateway, written for AgentRun: what a run inside a box calls for its model and its network tools, so the box
// holds no key. serve starts one per run, and it holds:
//  - the providers' credentials, each behind the model proxy's core (@parcha/agentrun-adapters/host), mounted under a path
//    segment of its own (`/anthropic/v1/messages`, `/openai/v1/responses`). A client speaks the provider's own protocol
//    with the run's token where that protocol carries a key; the proxy checks it, adds serve's credential and forwards.
//    What a request may carry is the mount's policy (./gateway-policies.ts, or a harness's own);
//  - the run's network tools, called as `POST /tools/<name>` with `{ callId, args }` and answered `{ text, isError }`, the
//    shape of a host tool's call. A replay-safe tool runs once per call id (a repeat gets the first answer); one that runs at
//    most once refuses a repeat, which never runs it again;
//  - one token, 32 random bytes minted when it starts, compared in constant time, never written to its log or into an
//    answer, and kept off the gateway object's enumerable fields. `revoke()`, when the run settles, refuses every later
//    request and aborts the ones in flight.
// It listens on a unix socket of mode 0600 in a directory serve names (what a box that mounts it reaches), or on the
// loopback interface. It books nothing: a run's spend is booked where the run is (its session proxy, or pi). It keeps
// nothing on disk: a serve that restarts starts a new gateway, with a new token.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { HostTool } from "@parcha/agentrun-adapters";
import { listenLocal, modelProxyHandler, parseStrict, ProxyRefusal, sameKey, type ModelProxyHandler, type ModelProxyHooks, type ProviderPolicy } from "@parcha/agentrun-adapters/host";

/** The socket's name in the directory serve names. */
export const GATEWAY_SOCKET = "gateway.sock";
/** A provider's mount: one lowercase path segment. `tools` is the tools' own. */
const MOUNT = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/** A call id as harnesses write them (`toolu_…`, `call_…|fc_…`): printable, no space. */
const CALL_ID = /^[\x21-\x7e]{1,256}$/;
const MAX_TOOL_BODY = 8 * 1024 * 1024;
/** The answers kept for repeats of replay-safe calls. Past it the oldest goes, and a repeat of it runs again, as `safe` allows. */
const KEPT_ANSWERS = 1024;
/** The gateway books nothing: a run's spend is booked where the run is. */
const UNBOOKED: ModelProxyHooks = { beforeRequest: async () => undefined, afterRequest: async () => {} };

export interface GatewayUpstream {
  /** What the provider's API may carry, and where its client puts a key (which, here, is the run's token). */
  policy: ProviderPolicy;
  /** The provider's base, as the model proxy takes it (`https://api.anthropic.com`, a gateway's base with its path). */
  origin: string;
  /** serve's credential for it, read for each request. */
  credential: () => string | Promise<string>;
  /** Headers serve adds to every request it forwards (a gateway's spend tags). */
  headers?: Readonly<Record<string, string>>;
}

export interface RunGatewayOptions {
  /** The directory its socket is made in (`<socketDir>/gateway.sock`, mode 0600, removed on close). Absent: the loopback
   *  interface, at a free port. */
  socketDir?: string;
  /** Each provider, by the path segment it is mounted under (`anthropic`: `/anthropic/v1/messages`). */
  upstreams?: Readonly<Record<string, GatewayUpstream>>;
  /** The run's network tools, each at `/tools/<name>`. */
  tools?: readonly HostTool[];
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** For tests: the fetch the providers are called with. */
  fetch?: typeof fetch;
}

export interface RunGateway {
  /** Its origin on the loopback interface, or the origin a request over its socket names. */
  readonly url: string;
  /** Its socket, when it listens on one. */
  readonly socketPath?: string;
  /** The run's token, which every request presents. Not an enumerable field: the gateway logged or serialized omits it. */
  readonly token: string;
  readonly revoked: boolean;
  /** Refuse every later request (401), and abort every one in flight. */
  revoke(): void;
  /** Revoke, stop listening, and remove the socket. */
  close(): Promise<void>;
}

type Answer = { text: string; isError: boolean; images?: unknown };

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const messageOf = (error: unknown): string => String((error as Error)?.message ?? error);

/** The token a request presents on the gateway's own routes: a bearer token, or `x-api-key`. */
function tokenOf(headers: IncomingHttpHeaders): string {
  const auth = String(headers.authorization ?? "");
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const key = headers["x-api-key"];
  return typeof key === "string" ? key : "";
}

/** Start a run's gateway, with a token of its own. */
export async function startRunGateway(options: RunGatewayOptions): Promise<RunGateway> {
  const token = randomBytes(32).toString("base64url");
  /** Text with the token taken out: a client may send it anywhere (its path, a header), and nothing here repeats it. */
  const scrub = (text: string): string => text.split(token).join("[run token]");
  const say = (message: string, detail?: Record<string, unknown>) => {
    try {
      options.log?.(scrub(message), detail && Object.fromEntries(Object.entries(detail).map(([name, value]) => [name, typeof value === "string" ? scrub(value) : value])));
    } catch { /* the host's log failed; the request goes on */ }
  };
  const upstreams = new Map<string, ModelProxyHandler>();
  for (const [name, upstream] of Object.entries(options.upstreams ?? {})) {
    if (!MOUNT.test(name) || name === "tools") throw new Error(`agentrun-serve: a gateway's provider is mounted under one lowercase segment other than tools, not ${JSON.stringify(name.slice(0, 40))}`);
    upstreams.set(name, modelProxyHandler({
      policy: upstream.policy, origin: upstream.origin, credential: upstream.credential, model: name, hooks: UNBOOKED, log: say,
      ...(upstream.headers ? { headers: upstream.headers } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }, token));
  }
  const tools = new Map<string, HostTool>();
  for (const tool of options.tools ?? []) {
    if (!TOOL_NAME.test(tool.name) || tools.has(tool.name)) throw new Error(`agentrun-serve: a gateway's tool needs a name of its own, of letters, digits, _, . or - (${JSON.stringify(tool.name.slice(0, 40))})`);
    tools.set(tool.name, tool);
  }
  /** Replay-safe calls by call id, with their answers (the newest KEPT_ANSWERS); calls of tools that run at most once. */
  const answers = new Map<string, { name: string; answer: Promise<Answer> }>();
  const once = new Map<string, string>();
  const inflight = new Set<AbortController>();
  let revoked = false;

  const refuse = (req: IncomingMessage, res: ServerResponse, status: number, message: string) => {
    say("run gateway: refused", { status, method: String(req.method ?? "").slice(0, 16), path: String(req.url ?? "").slice(0, 200), reason: message });
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: { message, type: "agentrun_gateway" } }));
  };

  const run = async (tool: HostTool, args: unknown, callId: string): Promise<Answer> => {
    const controller = new AbortController();
    inflight.add(controller);
    try {
      const out = await tool.call(args, { callId, signal: controller.signal });
      return { text: String(out?.text ?? ""), isError: out?.isError === true, ...(out?.images?.length ? { images: out.images } : {}) };
    } catch (error) {
      say("run gateway: a tool threw", { tool: tool.name, error: messageOf(error).slice(0, 200) });
      return { text: scrub(`the tool failed: ${messageOf(error).slice(0, 2000)}`), isError: true };
    } finally {
      inflight.delete(controller);
    }
  };

  /** `POST /tools/<name>`: `rest` is what follows `/tools`. The token was checked. */
  const callTool = async (req: IncomingMessage, res: ServerResponse, rest: string) => {
    const name = rest.startsWith("/") ? rest.slice(1) : "";
    const tool = TOOL_NAME.test(name) ? tools.get(name) : undefined;
    if (!tool) return refuse(req, res, 404, "the run has no such tool");
    if (req.method !== "POST") return refuse(req, res, 405, "a tool is called with POST");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_TOOL_BODY) return refuse(req, res, 413, "the body is too large");
      chunks.push(chunk as Buffer);
    }
    let callId: string;
    let args: unknown;
    try {
      const body = parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (!isPlain(body) || Object.keys(body).some((key) => key !== "callId" && key !== "args")) throw new ProxyRefusal(400, "a tool call's body is { callId, args }");
      if (typeof body.callId !== "string" || !CALL_ID.test(body.callId)) throw new ProxyRefusal(400, "a tool call's callId is 1 to 256 printable characters, no space");
      callId = body.callId;
      args = body.args ?? {};
    } catch (error) {
      return refuse(req, res, 400, error instanceof ProxyRefusal ? error.message : "the body is not JSON in UTF-8");
    }
    if (revoked) return refuse(req, res, 401, "this run's token is required");
    const ran = answers.get(callId)?.name ?? once.get(callId);
    if (ran !== undefined && ran !== name) return refuse(req, res, 409, "this call id is another tool's call");
    let answer: Answer;
    if (tool.replay === "never") {
      if (ran !== undefined) return refuse(req, res, 409, "this call was made already, and its tool runs at most once: it is not run again");
      once.set(callId, name);
      answer = await run(tool, args, callId);
    } else {
      let kept = answers.get(callId);
      if (!kept) {
        kept = { name, answer: run(tool, args, callId) };
        answers.set(callId, kept);
        if (answers.size > KEPT_ANSWERS) answers.delete(answers.keys().next().value!);
      }
      answer = await kept.answer;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    // A request refused before its body is read is drained, so its client gets the answer instead of a reset.
    res.once("finish", () => { if (!req.complete) req.resume(); });
    const url = req.url ?? "";
    if (revoked) return refuse(req, res, 401, "this run's token is required");
    const head = /^\/([^/?]*)/.exec(url)?.[1];
    const upstream = head === undefined ? undefined : upstreams.get(head);
    // The provider's policy reads the token from where its protocol carries a key, and matches what follows the mount.
    if (upstream && head !== undefined) return upstream.handle(req, res, url.slice(head.length + 1));
    // Without the token every other request gets the same answer, so what the gateway serves can't be mapped.
    if (!sameKey(tokenOf(req.headers), token)) return refuse(req, res, 401, "this run's token is required");
    if (head !== "tools") return refuse(req, res, 404, "nothing is served at this path");
    void callTool(req, res, url.slice("/tools".length)).catch((error: unknown) => {
      say("run gateway: a tool call failed", { error: messageOf(error).slice(0, 200) });
      if (!res.headersSent) refuse(req, res, 500, "the tool call failed");
      else res.destroy();
    });
  };

  const listener = await listenLocal(createServer(handle), options.socketDir === undefined ? undefined : join(options.socketDir, GATEWAY_SOCKET));
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    for (const upstream of upstreams.values()) upstream.close();
    for (const controller of inflight) controller.abort();
  };
  const gateway = {
    url: listener.url,
    ...(listener.socketPath === undefined ? {} : { socketPath: listener.socketPath }),
    get revoked() { return revoked; },
    revoke,
    close: async () => {
      revoke();
      await listener.close();
    },
  };
  Object.defineProperty(gateway, "token", { value: token, enumerable: false });
  return gateway as RunGateway;
}
