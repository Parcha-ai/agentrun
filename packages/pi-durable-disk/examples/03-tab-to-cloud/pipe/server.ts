// The demo's server: the page, one WebSocket per tab, and per run the pipe that holds the run's claim while a tab runs
// the agent. It also decides where a run goes when its tab is gone (the cloud host, through the package's supervisor)
// and takes a run back from the cloud when a tab asks to run it here.
//
// A run's link carries its secret (`/run/<id>#<secret>`): the fragment never reaches a log, and every WebSocket hello
// must present it. The server listens on loopback by default; reaching it from elsewhere is a deployment choice.
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { createRunDir, mintMountToken, removeMountToken, takeOver, unmountClaim, acquire as plainAcquire } from "@parcha/pi-durable-disk";
import type { AcquireOptions, ArchilHost, Claim, ControlApi, OpenRunLeaseOptions, RunRef } from "@parcha/pi-durable-disk";
import { ModelProxy, type ModelOptions } from "./model-proxy.ts";
import { RunPipe, type PipeSocket } from "./run-pipe.ts";
import type { PipeFrame, Placement, TabFrame } from "../wire.ts";

/** Where a run goes when no tab runs it, and how it is taken back. Optional: without it a run parks. */
export interface CloudHost {
  /** Start the run on the cloud host (the run is released and sealed). Resolves once the host was asked. */
  start(ref: RunRef, run: { model: ModelProxy }): Promise<{ host: string }>;
  /** The cloud's own view of the run, for viewers while it runs there. Optional. */
  attachViewer?(ref: RunRef, send: (frame: PipeFrame) => void): Promise<() => void>;
  /** Forward a viewer's message to the cloud's conversation. Optional. */
  submit?(ref: RunRef, text: string, requestId: string): Promise<void>;
  /**
   * Stop whatever the cloud runs for the run. After a takeover (`fenced`: its claim is already revoked) it first waits
   * for the instance to exit by itself, which is the fence observed; otherwise it stops it at once.
   */
  stop(ref: RunRef, how?: "fenced" | "now"): Promise<void>;
  /** Stop and remove everything the cloud host started. */
  close?(): Promise<void>;
}

export interface DemoServerOptions {
  readonly disk: string;
  readonly region: string;
  /** The disk's control API (holds the Archil key). Null with `acquire` for tests on a local directory. */
  readonly control: ControlApi | null;
  readonly mountRoot: string;
  readonly host?: ArchilHost;
  readonly lease?: OpenRunLeaseOptions["lease"];
  readonly model: ModelOptions;
  readonly cloud?: CloudHost;
  /** Static files of the page. */
  readonly pageDir?: string;
  /** Extra static roots, by URL prefix (for example the Wasmer SDK's files). */
  readonly staticRoots?: Readonly<Record<string, string>>;
  readonly writerGraceMs?: number;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
  /** Records every disk resource the server creates (run directories, token users, mounts) and its removal. */
  readonly ledger?: { open(kind: string, id: string, note?: string): void; close(kind: string, id: string, note?: string): void };
  /** Test seams. */
  readonly acquire?: (options: AcquireOptions, takeover: boolean) => Promise<Claim>;
  readonly claimDir?: OpenRunLeaseOptions["claimDir"];
  readonly scratchStores?: boolean;
}

interface RunState {
  readonly ref: RunRef;
  readonly secret: string;
  pipe: RunPipe | undefined;
  opening: Promise<RunPipe> | undefined;
  placement: Placement;
  /** The run's model access and budget, wherever it runs. */
  model: ModelProxy;
  tokenUser: string | undefined;
  attempt: number;
  viewers: Set<PipeSocket>;
  cloudViewers: Map<PipeSocket, () => void>;
  createdAt: number;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".webc": "application/octet-stream",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

const sameSecret = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export interface DemoServer {
  readonly http: Server;
  readonly runs: ReadonlyMap<string, RunState>;
  listen(port: number, host?: string): Promise<number>;
  /** Create a run directory on the disk and return its id and secret. */
  createRun(id?: string): Promise<{ id: string; secret: string }>;
  /** Release every run the server holds (barrier, seal, unmount) and remove their token users. */
  close(): Promise<void>;
  /** Placement changes, for scripts. */
  on(event: "placement", listener: (id: string, placement: Placement) => void): void;
}

export function createDemoServer(options: DemoServerOptions): DemoServer {
  const runs = new Map<string, RunState>();
  const listeners: ((id: string, placement: Placement) => void)[] = [];
  const log = (event: string, data: Record<string, unknown> = {}) => options.log?.(event, data);

  const setPlacement = (state: RunState, placement: Placement) => {
    state.placement = placement;
    const frame: PipeFrame = { t: "placement", placement };
    for (const viewer of state.viewers) viewer.send(frame);
    state.pipe?.broadcast(frame);
    for (const listener of listeners) listener(state.ref.id, placement);
    log("placement", { run: state.ref.id, ...placement });
  };

  async function mint(state: RunState): Promise<string> {
    if (!options.control) return "local";
    const minted = await mintMountToken(options.control, { run: { id: state.ref.id, attempt: ++state.attempt }, prefix: "pda-demo-", ttl: "6h" });
    state.tokenUser = minted.identifier;
    options.ledger?.open("token-user", minted.identifier, minted.nickname);
    log("token.minted", { run: state.ref.id, nickname: minted.nickname });
    return minted.token;
  }

  async function dropToken(state: RunState): Promise<void> {
    if (!options.control || !state.tokenUser) return;
    const identifier = state.tokenUser;
    state.tokenUser = undefined;
    try {
      await removeMountToken(options.control, identifier);
      options.ledger?.close("token-user", identifier);
      log("token.removed", { run: state.ref.id });
    } catch (error) {
      log("token.remove-failed", { run: state.ref.id, error: (error as Error).message });
    }
  }

  /** Claim the run for a tab: plainly when it is parked, by revoking the cloud's claim when it runs there. */
  function openPipe(state: RunState, takeover: boolean): Promise<RunPipe> {
    state.opening ??= (async () => {
      const token = await mint(state);
      const acquire = (opts: AcquireOptions): Promise<Claim> => {
        if (options.acquire) return options.acquire(opts, takeover);
        return takeover ? takeOver(options.control!, opts) : plainAcquire(opts);
      };
      try {
        const pipe = await RunPipe.open({
          ref: state.ref,
          mountToken: token,
          mountRoot: options.mountRoot,
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(options.lease === undefined ? {} : { lease: options.lease }),
          model: state.model,
          ...(options.writerGraceMs === undefined ? {} : { writerGraceMs: options.writerGraceMs }),
          acquire,
          ...(options.claimDir === undefined ? {} : { claimDir: options.claimDir }),
          ...(options.scratchStores ? { scratchStores: true } : {}),
          ...(options.log === undefined ? {} : { log: options.log }),
          onWriterGone: (p) => void writerGone(state, p),
          onLost: (p) => void pipeLost(state, p),
        });
        state.pipe = pipe;
        options.ledger?.open("mount", pipe.lease.claim.root, `generation ${pipe.generation}`);
        for (const viewer of state.viewers) pipe.addViewer(viewer);
        state.viewers.clear();
        return pipe;
      } catch (error) {
        await dropToken(state);
        throw error;
      } finally {
        state.opening = undefined;
      }
    })();
    return state.opening;
  }

  async function releasePipe(state: RunState): Promise<void> {
    const pipe = state.pipe;
    if (!pipe) return;
    try {
      await pipe.release();
      options.ledger?.close("mount", pipe.lease.claim.root, "released");
    } finally {
      state.pipe = undefined;
      for (const viewer of pipe.takeViewers()) state.viewers.add(viewer);
      await dropToken(state);
    }
  }

  async function writerGone(state: RunState, pipe: RunPipe): Promise<void> {
    if (state.pipe !== pipe) return;
    await toCloud(state, "the tab is gone");
  }

  /** Release the run from the pipe and, with a cloud host, start it there. */
  async function toCloud(state: RunState, why: string): Promise<void> {
    const started = Date.now();
    setPlacement(state, { where: "moving", to: "cloud", detail: why });
    try {
      await releasePipe(state);
    } catch (error) {
      log("release.failed", { run: state.ref.id, error: (error as Error).message });
      setPlacement(state, { where: "parked", detail: `release failed: ${(error as Error).message}` });
      return;
    }
    log("released", { run: state.ref.id, ms: Date.now() - started });
    if (!options.cloud) {
      setPlacement(state, { where: "parked", detail: why });
      return;
    }
    try {
      const { host } = await options.cloud.start(state.ref, { model: state.model });
      setPlacement(state, { where: "cloud", host, generation: null, detail: why });
      log("cloud.started", { run: state.ref.id, host, ms: Date.now() - started });
      // Whoever watched the tab now watches the cloud.
      for (const viewer of state.viewers) await attachCloudViewer(state, viewer);
    } catch (error) {
      log("cloud.start-failed", { run: state.ref.id, error: (error as Error).message });
      setPlacement(state, { where: "parked", detail: `cloud start failed: ${(error as Error).message}` });
    }
  }

  async function pipeLost(state: RunState, pipe: RunPipe): Promise<void> {
    if (state.pipe !== pipe) return;
    state.pipe = undefined;
    for (const viewer of pipe.takeViewers()) state.viewers.add(viewer);
    // The claim is gone. Its mount is useless (every write fails) but still listed: it is cleaned, never trusted.
    if (options.control) {
      await pipe.lease.fenceSettled();
      const via = await unmountClaim(pipe.lease.claim.root, options.host).catch((error: Error) => `failed: ${error.message}`);
      options.ledger?.close("mount", pipe.lease.claim.root, `fenced, unmount ${via}`);
    }
    await dropToken(state);
    setPlacement(state, { where: "parked", detail: "the claim was taken by another host" });
  }

  function adapt(ws: WebSocket, id: string): PipeSocket {
    return {
      id,
      send: (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      },
      close: (code, reason) => ws.close(code, reason),
    };
  }

  async function onHello(ws: WebSocket, socket: PipeSocket, frame: Extract<TabFrame, { t: "hello" }>): Promise<RunState | undefined> {
    const state = runs.get(frame.run);
    if (!state || typeof frame.token !== "string" || !sameSecret(frame.token, state.secret)) {
      socket.send({ t: "error", message: "unknown run or wrong secret" });
      ws.close(4003, "UNAUTHORIZED");
      return undefined;
    }
    if (frame.mode === "view") {
      await addViewer(state, socket);
      return state;
    }
    // A tab asks to run the agent here.
    try {
      const fromCloud = state.placement.where === "cloud";
      if (fromCloud && !frame.takeover) {
        await addViewer(state, socket);
        return state;
      }
      if (fromCloud) setPlacement(state, { where: "moving", to: "tab", detail: "a tab took the run back" });
      const pipe = state.pipe ?? (await openPipe(state, fromCloud));
      if (fromCloud) void options.cloud?.stop(state.ref, "fenced").catch((error) => log("cloud.stop-failed", { run: state.ref.id, error: (error as Error).message }));
      const role = await pipe.attach(socket, frame.tab, frame.takeover === true);
      if (role === "viewer") socket.send(await viewingFrame(state));
      else {
        for (const [viewer, detach] of state.cloudViewers) {
          detach();
          pipe.addViewer(viewer);
        }
        state.cloudViewers.clear();
        state.placement = { where: "tab", tab: frame.tab, epoch: pipe.epoch, generation: pipe.generation };
        for (const listener of listeners) listener(state.ref.id, state.placement);
      }
    } catch (error) {
      log("attach.failed", { run: state.ref.id, error: (error as Error).message });
      socket.send({ t: "lost", code: "ATTACH_FAILED", message: (error as Error).message });
      ws.close(4004, "ATTACH_FAILED");
    }
    return state;
  }

  async function viewingFrame(state: RunState): Promise<PipeFrame> {
    const files = state.pipe ? await state.pipe.restoreManifest().catch(() => []) : [];
    return { t: "viewing", placement: state.placement, files, events: state.pipe ? [...state.pipe.events] : [] };
  }

  async function addViewer(state: RunState, socket: PipeSocket): Promise<void> {
    if (state.pipe) state.pipe.addViewer(socket);
    else state.viewers.add(socket);
    socket.send(await viewingFrame(state));
    if (state.placement.where === "cloud") await attachCloudViewer(state, socket);
  }

  async function attachCloudViewer(state: RunState, socket: PipeSocket): Promise<void> {
    if (!options.cloud?.attachViewer || state.cloudViewers.has(socket)) return;
    const detach = await options.cloud.attachViewer(state.ref, (frame) => socket.send(frame));
    state.cloudViewers.set(socket, detach);
  }

  async function onFrame(ws: WebSocket, socket: PipeSocket, state: RunState, frame: TabFrame): Promise<void> {
    const pipe = state.pipe;
    switch (frame.t) {
      case "rpc":
        if (pipe) await pipe.rpc(socket, frame.id, frame.method, frame.args);
        else socket.send({ t: "res", id: frame.id, ok: false, error: { name: "PipeLostError", code: "NO_PIPE", message: "no pipe holds the run" } });
        return;
      case "files":
        if (pipe) await pipe.files(socket, frame.id, frame.changes);
        else socket.send({ t: "res", id: frame.id, ok: false, error: { name: "PipeLostError", code: "NO_PIPE", message: "no pipe holds the run" } });
        return;
      case "model":
        if (pipe) await pipe.model(socket, frame.id, frame.path, frame.body);
        else socket.send({ t: "model-end", id: frame.id, status: 409, error: "no pipe holds the run" });
        return;
      case "model-abort":
        pipe?.modelAbort(socket, frame.id);
        return;
      case "view":
        pipe?.view(socket, frame.event);
        return;
      case "ping":
        if (pipe) pipe.ping(socket, frame.at);
        else socket.send({ t: "pong", at: frame.at, now: Date.now() });
        return;
      case "cloud":
        if (pipe && pipe.writerTab !== undefined) await toCloud(state, "moved to the cloud from the tab");
        return;
      case "submit":
        // A viewer's message: to the writer tab when a tab runs the run, to the cloud when it runs there.
        if (pipe) pipe.broadcast({ t: "submit", text: frame.text, requestId: frame.requestId });
        else if (state.placement.where === "cloud") await options.cloud?.submit?.(state.ref, frame.text, frame.requestId);
        return;
      case "bye":
        ws.close(1000, "bye");
        return;
      case "hello":
        return;
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  wss.on("connection", (ws) => {
    const socket = adapt(ws, randomBytes(6).toString("hex"));
    let state: RunState | undefined;
    // Set synchronously on the first frame: every later frame waits behind the hello, never races it.
    let hello: Promise<void> | undefined;
    let queue: Promise<void> = Promise.resolve();
    ws.on("message", (data) => {
      let frame: TabFrame;
      try {
        frame = JSON.parse(String(data)) as TabFrame;
      } catch {
        ws.close(4000, "BAD_FRAME");
        return;
      }
      if (frame.t === "hello") {
        if (hello) return;
        hello = queue = queue.then(async () => {
          state = await onHello(ws, socket, frame as Extract<TabFrame, { t: "hello" }>);
        });
        return;
      }
      if (!hello) {
        ws.close(4003, "HELLO_FIRST");
        return;
      }
      const handle = () => (state ? onFrame(ws, socket, state, frame) : Promise.resolve());
      const failed = (error: unknown) => log("frame.failed", { error: (error as Error).message });
      // Storage calls and write-throughs run in arrival order; model streams and pings must not wait behind them.
      if (frame.t === "model" || frame.t === "ping" || frame.t === "model-abort") void hello.then(handle).catch(failed);
      else queue = queue.then(handle).catch(failed);
    });
    ws.on("close", () => {
      if (!state) return;
      state.viewers.delete(socket);
      state.cloudViewers.get(socket)?.();
      state.cloudViewers.delete(socket);
      state.pipe?.detach(socket);
    });
  });

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    let path = decodeURIComponent(url.pathname);
    let root = options.pageDir;
    for (const [prefix, dir] of Object.entries(options.staticRoots ?? {})) {
      if (path.startsWith(prefix)) {
        root = dir;
        path = path.slice(prefix.length - 1);
      }
    }
    if (path === "/" || path.startsWith("/run/")) path = "/index.html";
    if (!root) {
      res.writeHead(404).end();
      return;
    }
    const file = normalize(join(root, path));
    if (!file.startsWith(resolve(root)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      // Cross-origin isolation: the in-tab runtime needs SharedArrayBuffer.
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "same-origin",
    });
    createReadStream(file).pipe(res);
  }

  const http = createHttpServer((req, res) => {
    if (req.method === "GET") serveStatic(req, res);
    else res.writeHead(405).end();
  });
  http.on("upgrade", (req, sock, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") {
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
  });

  return {
    http,
    runs,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolveListen) => http.listen(port, host, () => resolveListen((http.address() as { port: number }).port))),
    async createRun(id?: string) {
      const runId = id ?? `demo-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
      if (options.control) {
        await createRunDir(options.control, runId, { uid: process.getuid!(), gid: process.getgid!() });
        options.ledger?.open("run-dir", runId);
      }
      const secret = randomBytes(24).toString("base64url");
      runs.set(runId, {
        ref: { disk: options.disk, region: options.region, id: runId },
        secret,
        pipe: undefined,
        opening: undefined,
        placement: { where: "parked", detail: "new run" },
        model: new ModelProxy(options.model, 0, log),
        tokenUser: undefined,
        attempt: 0,
        viewers: new Set(),
        cloudViewers: new Map(),
        createdAt: Date.now(),
      });
      log("run.created", { run: runId });
      return { id: runId, secret };
    },
    async close() {
      for (const state of runs.values()) {
        if (state.opening) await state.opening.catch(() => undefined);
        if (state.pipe && !state.pipe.lost) await releasePipe(state).catch((error) => log("release.failed", { run: state.ref.id, error: (error as Error).message }));
        else await dropToken(state);
      }
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
    on(_event, listener) {
      listeners.push(listener);
    },
  };
}

