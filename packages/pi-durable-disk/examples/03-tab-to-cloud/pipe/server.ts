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
import { createRunDir, mintMountToken, readRunStatus, removeMountToken, takeOver, unmountClaim, acquire as plainAcquire } from "@parcha/pi-durable-disk";
import type { AcquireOptions, ArchilHost, Claim, ControlApi, OpenRunLeaseOptions, RunRef } from "@parcha/pi-durable-disk";
import { ModelProxy, type ModelOptions } from "./model-proxy.ts";
import { RunPipe, type PipeSocket } from "./run-pipe.ts";
import { CHUNK_BYTES, toBase64, type Environment, type Move, type PipeFrame, type Placement, type TabFrame } from "../wire.ts";

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
  /** Reads an object of the disk (its S3 API): work/ of a run no pipe holds, and run.json when a run is adopted. */
  readonly readObject?: (key: string) => Promise<Uint8Array>;
  /**
   * The work/ paths the page of the tab that holds a run may write over HTTP (`PUT /api/runs/<id>/work/<path>`), exactly.
   * Default none.
   */
  readonly tabWritable?: readonly string[];
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
  /** Every connection to the run, with what its hello asked for, in the order they came. */
  clients: Map<PipeSocket, { mode: "write" | "view" | "operator"; canRun: boolean }>;
}

/** Base64 bytes of upload chunks a connection may have waiting for the disk before it stops reading, and resumes. */
const UPLOAD_QUEUE_HIGH = 8 * Math.ceil((CHUNK_BYTES * 4) / 3);
const UPLOAD_QUEUE_LOW = 2 * Math.ceil((CHUNK_BYTES * 4) / 3);

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

/** The largest body `PUT /api/runs/<id>/work/<path>` takes. */
const WORK_PUT_MAX = 48 * 1024 * 1024;

const sameSecret = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export interface DemoServer {
  readonly http: Server;
  readonly runs: ReadonlyMap<string, RunState>;
  listen(port: number, host?: string): Promise<number>;
  /** Create a run directory on the disk and return its id and secret. */
  createRun(id?: string): Promise<{ id: string; secret: string }>;
  /** Take on a run that is already on the disk (released and sealed elsewhere): its id and a new secret. */
  adoptRun(id: string): Promise<{ id: string; secret: string }>;
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
    // Into a tab: a page that can run the agent is told to, the asking one when it can. Checked before anything moves.
    const runner = target.kind === "tab" ? pickRunner(state, socket) : undefined;
    if (target.kind === "tab" && !runner) return refuse("no browser tab that can run the agent is open on this run");
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
        runner!.send({ t: "run-here", switchId: move.id });
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

  /**
   * The page to run the agent after a switch into a tab: the asker when it is a page that can and may control the run,
   * else the most recent such page; never the writer, which is the host being left.
   */
  function pickRunner(state: RunState, asker: PipeSocket): PipeSocket | undefined {
    const able = (socket: PipeSocket) => {
      const client = state.clients.get(socket);
      return client !== undefined && client.canRun && client.mode !== "view" && !state.pipe?.isWriter(socket);
    };
    if (able(asker)) return asker;
    return [...state.clients.keys()].reverse().find(able);
  }

  /** A connection that only watches may not move the run or send it messages. */
  const mayControl = (state: RunState, socket: PipeSocket) => (state.clients.get(socket)?.mode ?? "view") !== "view";

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
      bufferedAmount: () => ws.bufferedAmount,
      isOpen: () => ws.readyState === ws.OPEN,
    };
  }

  async function onHello(ws: WebSocket, socket: PipeSocket, frame: Extract<TabFrame, { t: "hello" }>): Promise<RunState | undefined> {
    const state = runs.get(frame.run);
    if (!state || typeof frame.token !== "string" || !sameSecret(frame.token, state.secret)) {
      socket.send({ t: "error", message: "unknown run or wrong secret" });
      ws.close(4003, "UNAUTHORIZED");
      return undefined;
    }
    if (frame.mode !== "write" && frame.mode !== "view" && frame.mode !== "operator") {
      socket.send({ t: "error", message: `no mode ${String(frame.mode)}` });
      ws.close(4000, "BAD_MODE");
      return undefined;
    }
    state.clients.set(socket, { mode: frame.mode, canRun: frame.canRun === true });
    if (frame.mode !== "write") {
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
    const files = state.pipe ? await state.pipe.viewerFiles().catch(() => []) : [];
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
      case "upload":
        // In order with the write-through that names it: each chunk is written before the next frame is handled.
        await pipe?.upload(socket, frame.id, frame.offset, frame.data);
        return;
      case "restored":
        pipe?.restored(socket, frame);
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
        if (!mayControl(state, socket)) {
          socket.send({ t: "switch-refused", to: frame.to, message: "this connection only watches the run (hello mode view)" });
          return;
        }
        // Not queued behind the switch: the writer's drained and switched frames arrive while it runs.
        void switchTo(state, socket, frame.to).catch((error) => log("switch.failed", { run: state.ref.id, error: (error as Error).message }));
        return;
      case "drained":
        pipe?.drained(socket, frame.switchId);
        return;
      case "switched":
        // Only the host that took the run says its notice is in.
        if (state.pipe?.isWriter(socket)) switched(state, frame.switchId);
        return;
      case "submit":
        if (!mayControl(state, socket)) {
          socket.send({ t: "submit-refused", requestId: frame.requestId, message: "this connection only watches the run (hello mode view)" });
          return;
        }
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
    // A frame over maxPayload, or a broken connection, is an error event before the close; unhandled it would end the
    // server. The close that follows detaches the socket as usual.
    ws.on("error", (error) => log("ws.error", { socket: socket.id, error: error.message }));
    let state: RunState | undefined;
    // Set synchronously on the first frame: every later frame waits behind the hello, never races it.
    let hello: Promise<void> | undefined;
    let queue: Promise<void> = Promise.resolve();
    // Upload chunks wait in `queue` for the disk; past UPLOAD_QUEUE_HIGH of them the socket stops reading, so the
    // connection (and the sender's own buffer) holds the rest instead of this process's memory.
    let queuedUpload = 0;
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
      state?.pipe?.heard(socket);
      const handle = () => (state ? onFrame(ws, socket, state, frame) : Promise.resolve());
      const failed = (error: unknown) => log("frame.failed", { error: (error as Error).message });
      // Storage calls and write-throughs run in arrival order; model streams and pings must not wait behind them.
      if (frame.t === "model" || frame.t === "ping" || frame.t === "model-abort") void hello.then(handle).catch(failed);
      else if (frame.t === "upload") {
        const size = String(frame.data).length;
        queuedUpload += size;
        if (queuedUpload > UPLOAD_QUEUE_HIGH && !ws.isPaused) ws.pause();
        queue = queue
          .then(handle)
          .catch(failed)
          .finally(() => {
            queuedUpload -= size;
            if (queuedUpload < UPLOAD_QUEUE_LOW && ws.isPaused) ws.resume();
          });
      } else queue = queue.then(handle).catch(failed);
    });
    ws.on("close", () => {
      if (!state) return;
      state.clients.delete(socket);
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

  /** Register a run with a new secret; returns the secret. */
  function addRun(runId: string, detail: string): string {
    const secret = randomBytes(24).toString("base64url");
    runs.set(runId, {
      ref: { disk: options.disk, region: options.region, id: runId },
      secret,
      pipe: undefined,
      opening: undefined,
      placement: { where: "parked", detail },
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
      clients: new Map(),
    });
    return secret;
  }

  /**
   * Take on a run that is on the disk already, released and sealed by whoever ran it (another server, a fork): it is
   * parked here, and the first page to open its link runs it. A run this server holds keeps its secret.
   */
  async function adoptRun(id: string): Promise<{ id: string; secret: string }> {
    RunPipe.segments(id);
    const known = runs.get(id);
    if (known) return { id, secret: known.secret };
    if (options.readObject) {
      const record = await readRunStatus({ getObject: options.readObject }, id).catch(() => null);
      if (!record) throw new Error(`no run ${id} on the disk`);
      if (record.status === "running") throw new Error(`run ${id} is running elsewhere`);
    }
    const secret = addRun(id, "adopted from the disk");
    log("run.adopted", { run: id });
    return { id, secret };
  }

  /** The bearer token of a request, when it is the run's secret. */
  const holdsSecret = (req: IncomingMessage, state: RunState) => {
    const auth = String(req.headers.authorization ?? "");
    return auth.startsWith("Bearer ") && sameSecret(auth.slice(7), state.secret);
  };

  const json = (res: ServerResponse, status: number, body: Record<string, unknown>): void =>
    void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

  /** Who holds a run now, as a viewer would name it. */
  const holderOf = (state: RunState) => {
    const p = state.placement;
    return p.where === "tab" ? (p.env === "tab" ? `tab ${p.tab}` : (environment(p.env)?.label ?? p.env)) : p.where === "cloud" ? p.host : p.where;
  };

  /**
   * `GET /api/runs/<id>/work/<path>`: a file of the run's work/, from the pipe's mount when it holds the run, else from
   * the disk. `PUT`: written for the tab that holds the run (header `x-pda-tab`), only at the paths in `tabWritable`,
   * through the pipe's write-through: the answer comes after the barrier. Both take the run's secret as a bearer token.
   */
  async function workRoute(req: IncomingMessage, res: ServerResponse, runId: string, path: string): Promise<void> {
    const state = runs.get(runId);
    if (!state || !holdsSecret(req, state)) return void res.writeHead(404).end();
    try {
      RunPipe.segments(path);
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
    if (req.method === "GET") {
      let data: Uint8Array | undefined;
      if (state.pipe && !state.pipe.lost) data = await state.pipe.readWork(path);
      else if (options.readObject) data = await options.readObject(`runs/${runId}/work/${path}`).catch(() => undefined);
      else return json(res, 503, { error: "the run's files cannot be read while no pipe holds it" });
      if (data === undefined) return json(res, 404, { error: `no file ${path}` });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(data.length), "cache-control": "no-store" }).end(Buffer.from(data));
      return;
    }
    if (!(options.tabWritable ?? []).includes(path)) return json(res, 403, { error: `the tab may not write ${path}` });
    const tab = String(req.headers["x-pda-tab"] ?? "");
    const pipe = state.pipe;
    if (!pipe || pipe.lost || !tab || pipe.writerTab !== tab) return json(res, 409, { error: "this tab does not hold the run", holder: holderOf(state) });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > WORK_PUT_MAX) return json(res, 413, { error: `more than ${WORK_PUT_MAX} bytes` });
      chunks.push(chunk);
    }
    try {
      const { ms } = await pipe.writeAsWriter(tab, [{ path, op: "write", data: toBase64(new Uint8Array(Buffer.concat(chunks))) }]);
      json(res, 200, { path, bytes: size, ms: Math.round(ms) });
    } catch (error) {
      json(res, 409, { error: (error as Error).message, holder: holderOf(state) });
    }
  }

  /** `POST /api/runs/<id>/attach` (loopback, the admin token): adopt a run on the disk; answers its link. */
  async function attachRoute(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const auth = String(req.headers.authorization ?? "");
    const remote = req.socket.remoteAddress ?? "";
    if (!options.adminToken || !(remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") || !auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), options.adminToken)) {
      return void res.writeHead(404).end();
    }
    try {
      const { id, secret } = await adoptRun(runId);
      json(res, 200, { run: id, link: `/run/${id}#${secret}` });
    } catch (error) {
      json(res, 409, { error: (error as Error).message });
    }
  }

  const http = createHttpServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const work = /^\/api\/runs\/([^/]+)\/work\/(.+)$/.exec(path);
    const attach = /^\/api\/runs\/([^/]+)\/attach$/.exec(path);
    const failed = (error: unknown) => {
      log("http.failed", { path: path.split("/").slice(0, 4).join("/"), error: (error as Error).message });
      if (!res.headersSent) res.writeHead(500).end();
    };
    if (work && (req.method === "GET" || req.method === "PUT")) void workRoute(req, res, decodeURIComponent(work[1]!), decodeURIComponent(work[2]!)).catch(failed);
    else if (attach && req.method === "POST") void attachRoute(req, res, decodeURIComponent(attach[1]!)).catch(failed);
    else if (req.method === "GET") serveStatic(req, res);
    else if (req.method === "POST" && path.startsWith("/admin/")) void admin(req, res).catch(() => res.writeHead(500).end());
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
      const secret = addRun(runId, "new run");
      log("run.created", { run: runId });
      return { id: runId, secret };
    },
    adoptRun,
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

