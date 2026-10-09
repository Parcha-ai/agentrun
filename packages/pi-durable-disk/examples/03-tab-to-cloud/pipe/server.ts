// The demo's server: the page, one WebSocket per tab, and per run the pipe that holds the run's claim while a tab runs
// the agent. It moves a run between environments: the tab and the cloud host's environments, on a switch a page asks
// for (planned: the current host drains to the end of its step and releases, the target claims, admits the notice of
// the move and continues), and to the cloud when the tab is gone (unplanned).
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
import type { Environment, Move, PipeFrame, Placement, TabFrame } from "../wire.ts";

/** The tab as an environment; the cloud host lists its own. */
export const TAB_ENVIRONMENT: Environment = { id: "tab", label: "This tab", phrase: "your user's browser tab", kind: "tab", detail: "Wasmer in the page: bash, coreutils, node" };

/** Where a run goes when no tab runs it, and how it is taken back. Optional: without it a run parks. */
export interface CloudHost {
  /** The environments this host runs runs in, as the switcher offers them. The first is where a run goes unplanned. */
  readonly environments: readonly Environment[];
  /**
   * Start the run in environment `env` (the run is released and sealed). `move` is the move that brings it there: the
   * instance admits its notice before it resumes. Resolves once the host was asked.
   */
  start(ref: RunRef, run: { model: ModelProxy; env: string; move: Move }): Promise<{ host: string }>;
  /** The cloud's own view of the run, for viewers while it runs there. Optional. */
  attachViewer?(ref: RunRef, send: (frame: PipeFrame) => void): Promise<() => void>;
  /** Forward a viewer's message to the cloud's conversation. Optional. */
  submit?(ref: RunRef, text: string, requestId: string): Promise<void>;
  /**
   * Stop whatever the cloud runs for the run. After a takeover (`fenced`: its claim is already revoked) it first waits
   * for the instance to exit by itself, which is the fence observed; otherwise (`now`) it stops it, and the instance
   * drains and releases the run before it exits.
   */
  stop(ref: RunRef, how?: "fenced" | "now"): Promise<void>;
  /** Stop and remove everything the cloud host started. */
  close?(): Promise<void>;
  /** A tab runs the run now: get a host ready for when it leaves (no claim is taken). */
  prewarm?(ref: RunRef): void;
  /** One supervisor tick while the run is in the cloud: replace a host that died or froze (the new host's label). */
  supervise?(ref: RunRef): Promise<{ host: string } | undefined>;
  /** Power off the host that runs the run (a fault for the demo). */
  kill?(ref: RunRef): Promise<void>;
  /**
   * For an environment of kind "remote": start a host there that runs the run through the pipe, dial it and send it
   * `invite` (its hello answers it). Resolves with the open socket, which the server then serves as a tab's.
   */
  startRemote?(ref: RunRef, env: string, invite: Invite): Promise<{ socket: WebSocket; host: string }>;
  /** Stop and remove the run's remote host (it left the run, or was taken from). */
  stopRemote?(ref: RunRef): Promise<void>;
}

/** The server's first frame to a remote host (remote-host.ts). */
export type Invite = { t: "invite"; run: string; token: string; tab: string; switchId?: string };

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
  /** Bearer token of the loopback admin route (`POST /admin/kill-cloud?run=ID`, a fault for the demo); absent, no route. */
  readonly adminToken?: string;
  /** How often a run in the cloud is supervised. Default 2 s. */
  readonly superviseMs?: number;
  /** How long a tab gets to finish its current step on a switch before it is released anyway. Default 10 s. */
  readonly drainMs?: number;
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
  /** The cloud host was asked to get ready while a tab runs the run; asked again after the cloud took it. */
  prewarmed: boolean;
  /** The supervisor's timer while the run is in the cloud. */
  supervising: NodeJS.Timeout | undefined;
  tokenUser: string | undefined;
  attempt: number;
  viewers: Set<PipeSocket>;
  cloudViewers: Map<PipeSocket, () => void>;
  createdAt: number;
  /** The switch in progress: one at a time. */
  switching: { move: Move; to: string; started: number } | undefined;
  /** The remote host that runs the run through the pipe, by its tab id. */
  remote: { tab: string; env: string } | undefined;
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
  const environments: Environment[] = [TAB_ENVIRONMENT, ...(options.cloud?.environments ?? [])];
  const environment = (id: string) => environments.find((e) => e.id === id);
  /** Where the run is, as an environment id; undefined while it moves or is parked. */
  const currentEnv = (p: Placement) => (p.where === "tab" || p.where === "cloud" ? p.env : undefined);
  const phraseOf = (p: Placement) => environment(currentEnv(p) ?? "")?.phrase ?? (p.where === "cloud" ? p.host : "the disk");
  const newMove = (from: string, planned: boolean): Move => ({ id: `sw-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, from, planned });

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

  /** The remote host the run left: stopped and removed, out of the run's way. */
  async function dropRemote(state: RunState): Promise<void> {
    if (!state.remote) return;
    state.remote = undefined;
    await options.cloud?.stopRemote?.(state.ref).catch((error) => log("remote.stop-failed", { run: state.ref.id, error: (error as Error).message }));
  }

  /** The writer stopped pinging (a tab closed, a remote host died): the run goes to the cloud's first environment, unplanned. */
  async function writerGone(state: RunState, pipe: RunPipe): Promise<void> {
    if (state.pipe !== pipe || state.switching) return;
    const target = options.cloud?.environments.find((e) => e.kind === "cloud");
    const started = Date.now();
    const move = newMove(phraseOf(state.placement), false);
    setPlacement(state, target ? { where: "moving", to: target.label, env: target.id, switchId: move.id, since: started, detail: "the tab is gone" } : { where: "parked", detail: "the tab is gone" });
    try {
      await releasePipe(state);
    } catch (error) {
      log("release.failed", { run: state.ref.id, error: (error as Error).message });
      setPlacement(state, { where: "parked", detail: `release failed: ${(error as Error).message}` });
      return;
    }
    log("released", { run: state.ref.id, ms: Date.now() - started });
    void dropRemote(state);
    if (!target) setPlacement(state, { where: "parked", detail: "the tab is gone" });
    else await startCloud(state, target, move, "the tab is gone", started);
  }

  /** Start the released run in a cloud environment; on failure it stays parked on the disk. */
  async function startCloud(state: RunState, target: Environment, move: Move, why: string, started: number): Promise<boolean> {
    try {
      const { host } = await options.cloud!.start(state.ref, { model: state.model, env: target.id, move });
      state.prewarmed = false;
      supervise(state);
      setPlacement(state, { where: "cloud", host, generation: null, env: target.id, detail: why });
      log("cloud.started", { run: state.ref.id, host, env: target.id, switchId: move.id, ms: Date.now() - started });
      // Whoever watched the tab now watches the cloud.
      for (const viewer of state.viewers) await attachCloudViewer(state, viewer);
      return true;
    } catch (error) {
      log("cloud.start-failed", { run: state.ref.id, error: (error as Error).message });
      setPlacement(state, { where: "parked", detail: `cloud start failed: ${(error as Error).message}` });
      return false;
    }
  }

  /**
   * A planned switch to environment `to`, asked by `socket`: the current host finishes its step and releases the run,
   * then the target claims it, admits the notice of the move and continues. A tab target is the asking page, told to
   * run it here (its hello carries the switch id).
   */
  async function switchTo(state: RunState, socket: PipeSocket, to: string): Promise<void> {
    const target = environment(to);
    const p = state.placement;
    const from = currentEnv(p);
    const refuse = (message: string) => socket.send({ t: "switch-refused", to, message });
    if (!target) return refuse(`no environment ${to}`);
    if (state.switching || state.opening) return refuse("a move is already in progress");
    if (from === undefined) return refuse(`the run is ${p.where}`);
    if (from === to) return refuse("the run is already there");
    if (target.kind !== "tab" && !options.cloud) return refuse("no cloud host");
    const started = Date.now();
    const move = newMove(phraseOf(p), true);
    state.switching = { move, to, started };
    setPlacement(state, { where: "moving", to: target.label, env: target.id, switchId: move.id, since: started, detail: `leaving ${environment(from)?.label ?? from}` });
    log("switch.start", { run: state.ref.id, switchId: move.id, from, to });
    try {
      if (p.where === "tab") {
        const drained = await state.pipe!.drainWriter(move.id, options.drainMs ?? 10_000);
        log("switch.drained", { run: state.ref.id, switchId: move.id, drained, ms: Date.now() - started });
        await releasePipe(state);
        void dropRemote(state);
      } else {
        unsupervise(state);
        await options.cloud!.stop(state.ref, "now");
      }
      log("switch.released", { run: state.ref.id, switchId: move.id, ms: Date.now() - started });
      if (target.kind === "remote") {
        // The host is started for this switch and answers it as a tab would; the timer below also covers its start.
        setPlacement(state, { where: "moving", to: target.label, env: target.id, switchId: move.id, since: started, detail: "starting the host" });
        const remoteTab = `remote-${target.id}-${move.id}`;
        state.remote = { tab: remoteTab, env: target.id };
        const { socket: remote, host } = await options.cloud!.startRemote!(state.ref, target.id, { t: "invite", run: state.ref.id, token: state.secret, tab: remoteTab, switchId: move.id });
        log("remote.started", { run: state.ref.id, env: target.id, host, switchId: move.id, ms: Date.now() - started });
        setPlacement(state, { where: "moving", to: target.label, env: target.id, switchId: move.id, since: started, detail: "the host is attaching" });
        accept(remote);
      } else if (target.kind === "tab") {
        setPlacement(state, { where: "moving", to: target.label, env: target.id, switchId: move.id, since: started, detail: "the tab is attaching" });
        socket.send({ t: "run-here", switchId: move.id });
      }
      if (target.kind !== "cloud") {
        // A page that never attaches leaves the run parked, sealed, for whoever opens it next.
        setTimeout(() => {
          if (state.switching?.move.id !== move.id) return;
          state.switching = undefined;
          if (!state.pipe && !state.opening) setPlacement(state, { where: "parked", detail: `${target.label} did not attach` });
        }, target.kind === "remote" ? 120_000 : 30_000).unref();
        return;
      }
      state.switching = undefined;
      await startCloud(state, target, move, `switched from ${environment(from)?.label ?? from}`, started);
    } catch (error) {
      state.switching = undefined;
      log("switch.failed", { run: state.ref.id, switchId: move.id, error: (error as Error).message });
      void dropRemote(state);
      setPlacement(state, { where: "parked", detail: `switch failed: ${(error as Error).message}` });
    }
  }

  /** The tab that took the run reports its notice committed and its run resumed: the switch is done. */
  function switched(state: RunState, switchId: string): void {
    const s = state.switching;
    if (!s || s.move.id !== switchId) return;
    state.switching = undefined;
    const ms = Date.now() - s.started;
    log("switch.done", { run: state.ref.id, switchId, to: s.to, ms });
    const frame: PipeFrame = { t: "switched", switchId, to: s.to, ms };
    for (const viewer of state.viewers) viewer.send(frame);
    state.pipe?.broadcast(frame);
  }

  /** While the run is in the cloud, a supervisor tick every few seconds replaces a host that died or froze. */
  function supervise(state: RunState): void {
    const cloud = options.cloud;
    if (!cloud?.supervise || state.supervising) return;
    let busy = false;
    state.supervising = setInterval(() => {
      if (busy || state.placement.where !== "cloud") return;
      busy = true;
      void cloud
        .supervise!(state.ref)
        .then((replaced) => {
          if (replaced && state.placement.where === "cloud") setPlacement(state, { where: "cloud", host: replaced.host, generation: null, env: state.placement.env, detail: "the previous host was lost" });
        })
        .catch((error) => log("supervise.failed", { run: state.ref.id, error: (error as Error).message }))
        .finally(() => (busy = false));
    }, options.superviseMs ?? 2_000);
  }

  function unsupervise(state: RunState): void {
    clearInterval(state.supervising);
    state.supervising = undefined;
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
    // A tab asks to run the agent here: after a switch it asked for (its hello names the switch), on a takeover of a run
    // the cloud holds, or when nothing holds the run.
    try {
      const placement = state.placement;
      const fromCloud = placement.where === "cloud";
      const switching = state.switching;
      const ours = switching !== undefined && environment(switching.to)?.kind !== "cloud" && frame.switchId === switching.move.id && state.pipe === undefined;
      const writerEnv = ours ? switching.to : "tab";
      if ((fromCloud && !frame.takeover) || (switching && !ours)) {
        await addViewer(state, socket);
        return state;
      }
      let move: Move | undefined = ours ? switching.move : undefined;
      if (fromCloud) {
        unsupervise(state);
        move = newMove(phraseOf(placement), true);
        setPlacement(state, { where: "moving", to: TAB_ENVIRONMENT.label, env: "tab", switchId: move.id, since: Date.now(), detail: "a tab took the run back" });
      }
      const pipe = state.pipe ?? (await openPipe(state, fromCloud));
      if (fromCloud) void options.cloud?.stop(state.ref, "fenced").catch((error) => log("cloud.stop-failed", { run: state.ref.id, error: (error as Error).message }));
      const role = await pipe.attach(socket, frame.tab, frame.takeover === true, { environments, env: writerEnv, ...(move ? { move } : {}) });
      if (role === "viewer") socket.send(await viewingFrame(state));
      else {
        for (const [viewer, detach] of state.cloudViewers) {
          detach();
          pipe.addViewer(viewer);
        }
        state.cloudViewers.clear();
        state.placement = { where: "tab", tab: frame.tab, epoch: pipe.epoch, generation: pipe.generation, env: writerEnv };
        // A writer that took the run from a remote host: that host is done.
        if (state.remote && state.remote.tab !== frame.tab) void dropRemote(state);
        for (const listener of listeners) listener(state.ref.id, state.placement);
        if (!state.prewarmed) {
          state.prewarmed = true;
          options.cloud?.prewarm?.(state.ref);
        }
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
    return { t: "viewing", placement: state.placement, files, events: state.pipe ? [...state.pipe.events] : [], environments };
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
      case "switch":
        // Not queued behind the switch: the writer's drained and switched frames arrive while it runs.
        void switchTo(state, socket, frame.to).catch((error) => log("switch.failed", { run: state.ref.id, error: (error as Error).message }));
        return;
      case "drained":
        pipe?.drained(socket, frame.switchId);
        return;
      case "switched":
        switched(state, frame.switchId);
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
  /** Serve a socket as a tab's: one that connected, or one the server dialed into a remote host. */
  const accept = (ws: WebSocket) => wss.emit("connection", ws);
  wss.on("connection", (ws: WebSocket) => {
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

  async function admin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const auth = String(req.headers.authorization ?? "");
    const remote = req.socket.remoteAddress ?? "";
    if (!options.adminToken || !(remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") || !auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), options.adminToken)) {
      res.writeHead(404).end();
      return;
    }
    const state = runs.get(url.searchParams.get("run") ?? "");
    if (url.pathname === "/admin/kill-cloud" && state?.placement.where === "cloud" && options.cloud?.kill) {
      await options.cloud.kill(state.ref);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ killed: state.ref.id }));
      return;
    }
    res.writeHead(409).end();
  }

  const http = createHttpServer((req, res) => {
    if (req.method === "GET") serveStatic(req, res);
    else if (req.method === "POST" && (req.url ?? "").startsWith("/admin/")) void admin(req, res).catch(() => res.writeHead(500).end());
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
        prewarmed: false,
        supervising: undefined,
        tokenUser: undefined,
        attempt: 0,
        viewers: new Set(),
        cloudViewers: new Map(),
        createdAt: Date.now(),
        switching: undefined,
        remote: undefined,
      });
      log("run.created", { run: runId });
      return { id: runId, secret };
    },
    async close() {
      for (const state of runs.values()) {
        unsupervise(state);
        if (state.opening) await state.opening.catch(() => undefined);
        if (state.pipe && !state.pipe.lost) await releasePipe(state).catch((error) => log("release.failed", { run: state.ref.id, error: (error as Error).message }));
        else await dropToken(state);
        await dropRemote(state);
      }
      // Open pages keep their sockets: end them, or the close waits on them forever.
      for (const client of wss.clients) client.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
    on(_event, listener) {
      listeners.push(listener);
    },
  };
}

