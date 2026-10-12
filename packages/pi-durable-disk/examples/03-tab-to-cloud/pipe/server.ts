// The demo's server: the page, one WebSocket per tab, and per run the pipe that holds the run's claim while a tab runs
// the agent. It moves a run between environments: the tab and the cloud host's environments, on a switch a page asks
// for (planned: the current host drains to the end of its step and releases, the target claims, admits the notice of
// the move and continues), and to the cloud when the tab is gone (unplanned).
//
// A run's link carries its secret (`/run/<id>#<secret>`): the fragment never reaches a log, and every WebSocket hello
// must present it. The server listens on loopback by default; reaching it from elsewhere is a deployment choice.
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { createRunDir, mintMountToken, readRunStatus, removeMountToken, takeOver, unmountClaim, acquire as plainAcquire } from "@parcha/pi-durable-disk";
import type { AcquireOptions, ArchilHost, Claim, ControlApi, OpenRunLeaseOptions, RunRef } from "@parcha/pi-durable-disk";
import { ModelProxy, type ModelOptions } from "./model-proxy.ts";
import { JUDGE_ANSWER_MAX, judgeAnswer, type JudgeOptions } from "./judge.ts";
import type { JudgeRunner } from "../brain-router.ts";
import { CHECKIN_RECEIPT, CHECKOUT_MARKER, CheckinRefused, CheckoutRefused, manifestDigest, RunPipe, type CheckinReceipt, type CheckoutMarker, type PipeSocket } from "./run-pipe.ts";
import { cleanReason } from "../switch-tool.ts";
import { compareEntries, readBack, type ReadbackSource } from "./readback.ts";
import { SERVER_TURN, type Placer, type PlacementDecision } from "../placement.ts";
import { CHUNK_BYTES, lazyPath, toBase64, untag, type Environment, type FileChange, type Move, type PipeFrame, type Placement, type TabFrame } from "../wire.ts";

/** The tab as an environment; the cloud host lists its own. */
export const TAB_ENVIRONMENT: Environment = { id: "tab", label: "your browser", phrase: "your user's browser tab", kind: "tab", detail: "Wasmer in the page: bash, coreutils, node" };

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
  /**
   * True when the host keeps a spare for the run's next move: the spare was used by the move to a remote host, so when a tab takes the run
   * back from that host, `prewarm` is called again (once for each return, never while a remote host runs the run).
   */
  readonly rewarm?: boolean;
  /** One supervisor tick while the run is in the cloud: replace a host that died or froze (the new host's label). */
  supervise?(ref: RunRef): Promise<{ host: string } | undefined>;
  /** Power off the host that runs the run (a fault for the demo). */
  kill?(ref: RunRef): Promise<void>;
  /**
   * For an environment of kind "remote": start a host there that runs the run through the pipe, dial it and send it
   * `invite` (its hello answers it). Resolves with the open socket, which the server then serves as a tab's.
   * `signal` aborts when the server gives up waiting (the move's bound): a host that is still starting then must not be left running, so
   * the cloud removes whatever its start produces after that and resolves or rejects as it likes.
   */
  startRemote?(ref: RunRef, env: string, invite: Invite, signal?: AbortSignal): Promise<{ socket: WebSocket; host: string }>;
  /** Stop and remove the run's remote host (it left the run, or was taken from). */
  stopRemote?(ref: RunRef): Promise<void>;
  /** The picture of the run's desktop right now (a JPEG), or undefined when the run's host has none. The page's live view of it. */
  desktopFrame?(ref: RunRef): Promise<Uint8Array | undefined>;
  /**
   * True when the host tells the server, through `ServerApi.switched`, that its agent's notice of a move is committed (as a tab
   * or a remote host does with its `switched` frame). The move is then timed to that moment; without it a cloud move ends when
   * the instance is started and the server cannot say how long the notice took.
   */
  readonly notifiesSwitched?: boolean;
  /** Called once by the server: what a cloud host may ask of it for the agent that runs there (a move the agent chose). */
  bind?(api: ServerApi): void;
  /** The tab wrote `path` of the run's work/ (only the paths in `tabWritable`): the cloud host may prepare for what it holds, never delaying the write. */
  onTabWrite?(ref: RunRef, path: string, data: Uint8Array): void;
}

/** What `serve.ts --cloud-module` passes a module's default export, which returns the CloudHost: the disk, the model, the logs and the module's own `--cloud-arg KEY=VALUE` pairs. */
export interface CloudModuleOptions {
  readonly disk: string;
  readonly region: string;
  readonly model: ModelOptions;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
  readonly ledger?: { open(kind: string, id: string, note?: string): void; close(kind: string, id: string, note?: string): void };
  readonly eventsLog?: string;
  readonly args: Readonly<Record<string, string>>;
}

/** What the server offers a cloud host: the agent's own request to move (switch_environment). */
export interface ServerApi {
  /** The run's agent asks to continue in environment `to`. Resolves with the switch's id once the move began; rejects with the reason it was refused. */
  requestSwitch(ref: RunRef, to: string, reason: string): Promise<{ switchId: string }>;
  /** The cloud host's agent has its notice of move `switchId` committed: the move is done (see CloudHost.notifiesSwitched). */
  switched(ref: RunRef, switchId: string): void;
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
  /**
   * Where the run should be, decided by a typed question (placement.ts) instead of the agent's own move: on a user's message
   * the run is placed before the agent sees it, and when the agent's turn ends it is asked again where the agent should run
   * now. Absent, a message goes to wherever the run is, and only the user or the agent's switch_environment moves it.
   */
  readonly placer?: Placer;
  /**
   * The typed-question client the page's brain router asks (POST /api/runs/<id>/brain-judge; the key stays here, never in the page). Only the router's one question is forwarded
   * (see `brainJudgeRoute`). Absent, the route is 404 and the page's router falls back to the cloud.
   */
  readonly brainJudge?: JudgeRunner;
  /** How long a remote host may take to answer a move before the move fails (default 240 s: above Modal's own 180 s limit for placing a GPU). */
  readonly remoteStartMs?: number;
  /** Prefixes of work/ no writer is sent on attach (see RunPipeOptions.noRestore). The caller names them; nothing here knows what they hold. */
  readonly noRestore?: readonly string[];
  /** An attach refuses a workspace larger than this (lazy prefixes not counted). Default 1 GiB. */
  readonly restoreLimitBytes?: number;
  /** Static files of the page. */
  readonly pageDir?: string;
  /** Extra static roots, by URL prefix (for example the Wasmer SDK's files). */
  readonly staticRoots?: Readonly<Record<string, string>>;
  readonly writerGraceMs?: number;
  /** How long a viewer of a host's desktop may stay backed up (its pictures dropped) before its stream is closed. Default 10 s. */
  readonly desktopStallMs?: number;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
  /** Records every disk resource the server creates (run directories, token users, mounts) and its removal. */
  readonly ledger?: { open(kind: string, id: string, note?: string): void; close(kind: string, id: string, note?: string): void };
  /**
   * The dark-content judge (`POST /api/runs/<id>/judge`, the run's secret as a bearer token): the page asks it about
   * every answer before showing it, and shows a refusal instead when the verdict is "refuse". Absent: no route.
   */
  readonly judge?: JudgeOptions;
  /** Bearer token of the loopback admin route (`POST /admin/kill-cloud?run=ID`, a fault for the demo); absent, no route. */
  readonly adminToken?: string;
  /** How often a run in the cloud is supervised. Default 2 s. */
  readonly superviseMs?: number;
  /** How long a tab gets to finish its current step on a switch before it is released anyway. Default 10 s. */
  readonly drainMs?: number;
  /** How long the server waits for the agent's closing turn at home (default 60 s) before it replays the requests queued during the move home anyway. */
  readonly homeTurnMs?: number;
  /** Reads an object of the disk (its S3 API): work/ of a run no pipe holds, and run.json when a run is adopted. */
  readonly readObject?: (key: string) => Promise<Uint8Array>;
  /** After a check-in the server holds the claim for the browser's tab to attach; none attaching within this releases it. Default 30 s. */
  readonly checkinGraceMs?: number;
  /** A test seam: runs after a check-in's store and files are in place and before the checkout mark is removed (a throw is a crash at that point). */
  readonly beforeCheckinMarkerRemoval?: () => Promise<void>;
  /**
   * The work/ paths the page of the tab that holds a run may write over HTTP (`PUT /api/runs/<id>/work/<path>`), exactly.
   * Default none.
   */
  readonly tabWritable?: readonly string[];
  /**
   * The opt-in durability check: after each release, read the run's work/ back from the disk's object store and compare
   * it with the pipe's kept digest and the leaving writer's acknowledged one (`pipe.readback`, and
   * `pipe.readback-mismatch` with the differing paths). Never on the handover path. Absent: off.
   */
  readonly evidenceReadback?: ReadbackSource;
  /** Test seams. */
  readonly acquire?: (options: AcquireOptions, takeover: boolean) => Promise<Claim>;
  readonly claimDir?: OpenRunLeaseOptions["claimDir"];
  readonly scratchStores?: boolean;
}

/** Who asked for a move: the user (a click), the agent (its tool), or the server's placement question. */
type Who = { by: "user" } | { by: "agent"; reason: string } | { by: "placement"; reason: string; probability?: number };

/**
 * The server's wait at home after a placement move: the home check, then the agent's closing turn. It is set before the check starts and cleared when the wait is over, and while it is set a new
 * request is queued (behind the earlier queued ones) instead of placed, so nothing starts a move that would release the pipe the check reads through or overtake an older request.
 */
interface HomeWait {
  /** The closing turn's message has gone: only then does the writer's run_end end the wait (an earlier turn's end must not). */
  armed: boolean;
  /** The bound on the closing turn, started when its message goes. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The wait is over (the turn ended, the bound passed, or it was cancelled). */
  finish: () => void;
  /** The server is closing: the wait ends without replaying anything. */
  cancelled: boolean;
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
  /** The messages a placement decision is moving the run for, delivered when the move is done, and any that arrived during that move, each placed then. */
  pendingSubmits: { text: string; requestId: string; task?: { text: string; sent: boolean }; /** Arrived during a move: it has not been placed yet, and is placed (asked again, where it belongs) once the move ends. */ queuedBy?: PipeSocket; /** The placement already decided for it (a message that waited for a turn is not asked about again). */ decided?: PlacementDecision }[];
  /** The placement of one message at a time: a later message waits for the earlier one's decision and move to start. */
  placing: Promise<void>;
  /** The task a placed run is working on; `sent` once its message reached the host that works on it (earlier turns' events do not end it). */
  placedTask: { text: string; sent: boolean } | undefined;
  /** The agent's closing turn at home, while the server waits for it to end (the writer's run_end) before it replays the requests queued during the move home. */
  homeTurn: HomeWait | undefined;
  /** When the agent was last given a message and has not yet ended its turn (the host's run_end): a placement move would release the pipe under a step that is starting, so a message that needs a move waits for it. */
  turnSince: number | undefined;
  /** Messages whose placement is in progress (asked of the placer, or waiting their turn behind another): the end of a turn must not send the agent home under them. */
  placingCount: number;
  /** Which cloud host's viewers are current: an end relayed from an earlier host (or a stale copy) is not this turn's. */
  cloudEpoch: number;
  /** The submissions whose run_end has been handled (a run_end names the inputs it covered): every viewer of a mounted host is sent its own copy of an end, and a copy of one already handled is ignored. */
  endsSeen: Set<string>;
  turnTimer: NodeJS.Timeout | undefined;
  /** The decisions taken, newest last, for a viewer that connects later. */
  decisions: PlacementDecision[];
  /** The run was checked out to a browser (`POST /api/runs/<id>/checkout`): its only live copy is there, so this server never runs it again. Set from the checkout, and from the mark on the disk (`store/checkout.json`, readMarker) on adopt, hello and the store and checkout routes, so a restarted server finds it too. */
  checkedOut: { at: number; head: number; tab: string } | undefined;
  /** After a check-in the claim is held for the browser's tab to attach: released if none does in time. */
  checkinTimer: NodeJS.Timeout | undefined;
  /** A check-in is being applied (one at a time). */
  checkingIn: boolean;
  /** A checkout is being decided (`POST .../checkout` is in the pipe): no move, attach or placement starts meanwhile, or the run could end up live in two places. */
  checkingOut: boolean;
}

/** Base64 bytes of upload chunks a connection may have waiting for the disk before it stops reading, and resumes. */
const UPLOAD_QUEUE_HIGH = 8 * Math.ceil((CHUNK_BYTES * 4) / 3);
const UPLOAD_QUEUE_LOW = 2 * Math.ceil((CHUNK_BYTES * 4) / 3);

/** The longest user message written to the request file (characters). */
const REQUEST_FILE_MAX = 4000;
/** The submissions a run_end covers, as a key (its `inputs`), or undefined when the event does not name them. */
function endKey(event: Parameters<typeof untag>[0]): string | undefined {
  const body = untag(event) as { kind?: unknown; events?: unknown } | null;
  const end = body?.kind === "events" && Array.isArray(body.events) ? (body.events as { type?: unknown; inputs?: unknown }[]).find((e) => e?.type === "run_end") : undefined;
  return end && Array.isArray(end.inputs) && end.inputs.length > 0 ? JSON.stringify(end.inputs) : undefined;
}

/** The longest a running agent turn holds back a message that needs a move (a host that never says its turn ended must not hold it for ever). */
const TURN_BUSY_MS = 120_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".webc": "application/octet-stream",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** What a checked-out run says to anything that would run it again. */
const CHECKED_OUT_MESSAGE = "this run is checked out to a browser: its live copy is there, and nothing here runs it any more";

/** The largest body `POST /api/runs/<id>/checkin` takes (the store and the changed files, base64 in JSON). */
const CHECKIN_MAX = 192 * 1024 * 1024;

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

/** The writer's event batch ends the agent's run (pi's run_end): the turn is over. */
function endsRun(event: Parameters<typeof untag>[0]): boolean {
  const body = untag(event) as { kind?: unknown; events?: unknown } | null;
  return body?.kind === "events" && Array.isArray(body.events) && body.events.some((e) => (e as { type?: unknown } | null)?.type === "run_end");
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
  const newMove = (from: string, planned: boolean, who?: Who): Move => ({
    id: `sw-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    from,
    planned,
    ...(who?.by === "agent" ? { by: "agent" as const, reason: cleanReason(who.reason) } : {}),
    ...(who?.by === "placement" ? { by: "placement" as const, reason: cleanReason(who.reason), ...(who.probability !== undefined ? { probability: who.probability } : {}) } : {}),
  });

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
          ...(options.noRestore?.length ? { noRestore: options.noRestore } : {}),
          ...(options.restoreLimitBytes === undefined ? {} : { restoreLimitBytes: options.restoreLimitBytes }),
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
      if (options.evidenceReadback) void readbackAfter(state, pipe, options.evidenceReadback);
    } finally {
      state.pipe = undefined;
      for (const viewer of pipe.takeViewers()) state.viewers.add(viewer);
      await dropToken(state);
    }
  }

  /** How a switch tells whoever asked for it: refused, or begun (with its id). `asker`: the connection that asked, when there is one. */
  interface SwitchReply {
    readonly asker?: PipeSocket;
    refuse(message: string): void;
    accepted(switchId: string): void;
  }

  /** The agent of a cloud host asks to move (its link carried the request): resolves once the move began. */
  function requestSwitch(ref: RunRef, to: string, reason: string): Promise<{ switchId: string }> {
    const state = runs.get(ref.id);
    if (!state) return Promise.reject(new Error("no such run"));
    return new Promise((resolve, reject) => {
      const reply: SwitchReply = { refuse: (m) => reject(new Error(m)), accepted: (switchId) => resolve({ switchId }) };
      void switchTo(state, reply, to, { by: "agent", reason }).catch(reject);
    });
  }
  options.cloud?.bind?.({ requestSwitch, switched: (ref, switchId) => void (runs.get(ref.id) && switched(runs.get(ref.id)!, switchId)) });
  /** Resolves once the run is no longer moving (its next holder has the claim, or it parked), or after `ms`. */
  const settled = (state: RunState, ms: number) =>
    new Promise<void>((resolve) => {
      if (state.placement.where !== "moving") return resolve();
      const finish = () => {
        clearTimeout(timer);
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
        resolve();
      };
      const listener = (id: string, placement: Placement) => id === state.ref.id && placement.where !== "moving" && finish();
      const timer = setTimeout(finish, ms);
      timer.unref();
      listeners.push(listener);
    });

  /**
   * The release's independent evidence: work/ read back from the object store, compared with what the pipe kept and
   * with what the leaving writer acknowledged. It starts once the next holder has the claim, so it never delays a move,
   * and may read while that holder writes: a differing file the object store dates after the release is named as such.
   */
  async function readbackAfter(state: RunState, pipe: RunPipe, source: ReadbackSource): Promise<void> {
    const evidence = pipe.releaseEvidence;
    if (!evidence) return;
    const releasedAt = Date.now();
    try {
      await settled(state, 60_000);
      const startedAfterMs = Date.now() - releasedAt;
      const [read, kept] = await Promise.all([readBack(source, state.ref.id), evidence.digest.catch(() => undefined)]);
      const match = kept !== undefined && read.digest === kept;
      // A writer's acknowledged digest leaves out the lazy prefixes it was never sent: compare over the same files.
      const ackedMatch = evidence.acked === undefined ? null : (options.noRestore?.length ? await manifestDigest(read.entries.filter((e) => !lazyPath(e.path, options.noRestore!))) : read.digest) === evidence.acked;
      log("pipe.readback", { run: state.ref.id, generation: evidence.generation, startedAfterMs, ms: read.ms, files: read.files, bytes: read.bytes, digest: read.digest, kept: kept ?? null, acked: evidence.acked ?? null, match, ackedMatch });
      if (!match && evidence.entries) {
        const { missing, extra, differ } = compareEntries(evidence.entries, read.entries);
        // The object store dates objects to the second: a write in the second before the release counts here too.
        const later = [...missing, ...extra, ...differ].filter((path) => (read.modified.get(path) ?? 0) > releasedAt - 1_000);
        const cap = (paths: string[]) => paths.slice(0, 50);
        log("pipe.readback-mismatch", { run: state.ref.id, generation: evidence.generation, missing: cap(missing), extra: cap(extra), differ: cap(differ), changedSinceRelease: cap(later) });
      }
    } catch (error) {
      log("pipe.readback-failed", { run: state.ref.id, generation: evidence.generation, error: (error as Error).message });
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
    if (state.pipe !== pipe || state.switching || state.checkingOut) return;
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
      state.cloudEpoch++;
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
  async function switchTo(state: RunState, reply: SwitchReply, to: string, who: Who = { by: "user" }): Promise<void> {
    const target = environment(to);
    const p = state.placement;
    const from = currentEnv(p);
    const refuse = reply.refuse;
    if (state.checkedOut) return refuse(CHECKED_OUT_MESSAGE);
    if (!target) return refuse(`no environment ${to}; the environments are ${environments.map((e) => e.id).join(", ")}`);
    if (state.switching || state.opening || state.checkingOut) return refuse(state.checkingOut ? "the run is being checked out to a browser" : "a move is already in progress");
    if (from === undefined) return refuse(`the run is ${p.where}`);
    if (from === to) return refuse("the run is already there");
    if (target.kind !== "tab" && !options.cloud) return refuse("no cloud host");
    // Into a tab: a page that can run the agent is told to, the asking one when it can. Checked before anything moves.
    const runner = target.kind === "tab" ? pickRunner(state, reply.asker) : undefined;
    if (target.kind === "tab" && !runner) return refuse("no browser tab that can run the agent is open on this run");
    const started = Date.now();
    const move = newMove(phraseOf(p), true, who);
    state.switching = { move, to, started };
    setPlacement(state, { where: "moving", to: target.label, env: target.id, switchId: move.id, since: started, detail: `leaving ${environment(from)?.label ?? from}` });
    log("switch.start", { run: state.ref.id, switchId: move.id, from, to, by: who.by });
    reply.accepted(move.id);
    try {
      if (p.where === "tab") {
        const drained = await state.pipe!.drainWriter(move.id, options.drainMs ?? 10_000);
        log("switch.drained", { run: state.ref.id, switchId: move.id, drained, ms: Date.now() - started });
        await releasePipe(state);
        void dropRemote(state);
        // The host that ran the run held the spare box: the next writer's attach asks for another.
        if (options.cloud?.rewarm && environment(from)?.kind === "remote") state.prewarmed = false;
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
        // A host that never answers must not hold the move forever (a box whose host died at start looks ready from outside).
        const remoteStartMs = options.remoteStartMs ?? 240_000;
        let startTimer: NodeJS.Timeout | undefined;
        const giveUp = new AbortController();
        const starting = options.cloud!.startRemote!(state.ref, target.id, { t: "invite", run: state.ref.id, token: state.secret, tab: remoteTab, switchId: move.id }, giveUp.signal);
        // A start that outlives the bound is cancelled, and a socket it still produces is closed: no box is left charging behind a parked run.
        starting.then(
          ({ socket }) => {
            if (giveUp.signal.aborted) socket.close();
          },
          () => undefined,
        );
        const { socket: remote, host } = await Promise.race([
          starting,
          new Promise<never>((_, reject) => {
            startTimer = setTimeout(() => {
              giveUp.abort();
              reject(new Error(`${target.label} did not answer in ${Math.round(remoteStartMs / 1000)} s`));
            }, remoteStartMs);
          }),
        ]).finally(() => clearTimeout(startTimer));
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
      if (options.cloud?.notifiesSwitched) {
        // The host reports its notice committed (ServerApi.switched), which ends the move and times it, as a tab's frame does.
        const started2 = await startCloud(state, target, move, `switched from ${environment(from)?.label ?? from}`, started);
        if (!started2) state.switching = undefined;
        else
          setTimeout(() => {
            if (state.switching?.move.id === move.id) state.switching = undefined;
          }, 60_000).unref();
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
  function pickRunner(state: RunState, asker?: PipeSocket): PipeSocket | undefined {
    const able = (socket: PipeSocket) => {
      const client = state.clients.get(socket);
      return client !== undefined && client.canRun && client.mode !== "view" && !state.pipe?.isWriter(socket);
    };
    if (asker && able(asker)) return asker;
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
    // The run is back in the browser by placement: the agent gets one turn to say, in a line, where it is and what happened. The requests that came in during the move wait for that turn
    // (the check can take up to two minutes for the browser's receipt, and a new move would release the pipe the check reads it through, and send the closing line nowhere): they are replayed,
    // each placed, once the check and the closing turn have finished. The message a move was for goes now.
    const home = options.placer?.homePrompt;
    const goingHome = home !== undefined && home !== "" && s.move.by === "placement" && s.to === TAB_ENVIRONMENT.id;
    void flushPending(state, goingHome ? "direct" : "all");
    if (home && goingHome) {
      // The wait starts before the check, so a request that arrives while the check runs, or during the closing turn, is queued too.
      let finish!: () => void;
      const ended = new Promise<void>((resolve) => (finish = resolve));
      const wait: HomeWait = { armed: false, timer: undefined, finish, cancelled: false };
      state.homeTurn = wait;
      void (async () => {
        // What the work was for, checked in code: the agent words this fact, it does not judge it.
        let checked = "";
        const check = options.placer?.homeCheck;
        if (check) {
          const result = await check(async (path) => (state.pipe && !state.pipe.lost ? state.pipe.readWork(path) : undefined)).catch((error: Error) => ({ ok: false, reason: `the check itself failed: ${error.message}` }));
          log("placement.home-check", { run: state.ref.id, ok: result.ok, reason: result.reason });
          checked = `\n\nChecked by the server just now: ${result.ok ? `yes. ${result.reason}` : `NO. ${result.reason}`}`;
        }
        if (wait.cancelled) return;
        // Bounded, so a browser that never ends its turn does not hold the queue forever; armed before the message goes, so a turn that ends at once is not missed.
        wait.timer = setTimeout(() => {
          log("placement.home-turn-timeout", { run: state.ref.id, switchId });
          finish();
        }, options.homeTurnMs ?? 60_000);
        wait.armed = true;
        await deliverSubmit(state, `${SERVER_TURN}${home}${checked}`, `server-${switchId}`);
        await ended;
      })()
        .catch((error) => log("submit.failed", { run: state.ref.id, error: (error as Error).message }))
        .finally(() => {
          clearTimeout(wait.timer);
          if (state.homeTurn === wait) state.homeTurn = undefined;
          // A server that is closing replays nothing.
          if (!wait.cancelled) void flushPending(state).catch((error) => log("placement.failed", { run: state.ref.id, error: (error as Error).message }));
        });
    }
  }

  /**
   * When a move ends: the message the move was for goes to the host the run now has, and each message that arrived during the move is
   * placed as a message of its own (a training request that came while the agent was on its way home belongs on the GPU, not in the browser).
   */
  async function flushPending(state: RunState, which: "all" | "direct" = "all"): Promise<void> {
    const now = state.pendingSubmits.filter((p) => which === "all" || !p.queuedBy);
    if (now.length === 0) return;
    state.pendingSubmits = state.pendingSubmits.filter((p) => !now.includes(p));
    const pending = now;
    for (const p of pending) {
      if (p.queuedBy) {
        // Through the one-at-a-time placement, in the order they came; not awaited here (this may run inside that very queue).
        void placeThenSubmit(state, p.queuedBy, p.text, p.requestId, p.decided).catch((error) => log("placement.failed", { run: state.ref.id, error: (error as Error).message }));
        continue;
      }
      await deliverSubmit(state, p.text, p.requestId).catch((error) => log("submit.failed", { run: state.ref.id, error: (error as Error).message }));
      if (p.task) p.task.sent = true;
    }
  }

  /** A user's message to the host that runs the run: the writer tab or remote host through the pipe, the cloud host through its link. */
  async function deliverSubmit(state: RunState, text: string, requestId: string): Promise<void> {
    const started = Date.now();
    if (state.pipe) {
      state.turnSince = started;
      state.pipe.broadcast({ t: "submit", text, requestId });
      log("submit.delivered", { run: state.ref.id, to: "pipe", requestId });
    } else if (state.placement.where === "cloud") {
      state.turnSince = started;
      await options.cloud?.submit?.(state.ref, text, requestId);
      log("submit.delivered", { run: state.ref.id, to: "cloud", requestId, ms: Date.now() - started });
    } else log("submit.undeliverable", { run: state.ref.id, where: state.placement.where, requestId });
  }

  /** Whether the agent is in the middle of a turn it was given (not ended, and not for longer than the bound). */
  const turnRunning = (state: RunState): boolean => state.turnSince !== undefined && Date.now() - state.turnSince < TURN_BUSY_MS;

  /** The host says its turn ended: what waited for it is placed now. */
  function turnEnded(state: RunState): void {
    state.turnSince = undefined;
    clearTimeout(state.turnTimer);
    state.turnTimer = undefined;
    // The home wait replays what queued behind it when it is over (in order, after the check and the closing turn): not twice.
    if (state.homeTurn) return;
    void flushPending(state).catch((error) => log("placement.failed", { run: state.ref.id, error: (error as Error).message }));
  }

  /**
   * Ask the placer where the run should be and announce the decision (before any move it starts). Undefined when there is no
   * placer, the run is not in an environment, or the question failed: the run then stays where it is.
   */
  async function decide(state: RunState, phase: "start" | "done", message: string, requestId?: string): Promise<PlacementDecision | undefined> {
    const current = currentEnv(state.placement);
    if (!options.placer || current === undefined) return undefined;
    try {
      const decision = await options.placer.decide({ phase, message, current, environments: environments.map((e) => e.id), read: async (path) => (state.pipe && !state.pipe.lost ? state.pipe.readWork(path) : undefined) });
      state.decisions.push(decision);
      if (state.decisions.length > 8) state.decisions.shift();
      const frame: PipeFrame = { t: "decision", decision, ...(requestId ? { requestId } : {}) };
      for (const viewer of state.viewers) viewer.send(frame);
      state.pipe?.broadcast(frame);
      log("placement.decision", { run: state.ref.id, phase, current, choice: decision.choice, latencyMs: decision.latency_ms, model: decision.model, probabilities: Object.fromEntries(decision.options.map((o) => [o.id, o.probability])) });
      return decision;
    } catch (error) {
      log("placement.failed", { run: state.ref.id, phase, error: (error as Error).message });
      return undefined;
    }
  }

  const placeWho = (decision: PlacementDecision): Who => {
    const probability = decision.options.find((o) => o.id === decision.choice)?.probability;
    return { by: "placement", reason: options.placer!.describe(decision.choice), ...(probability !== undefined ? { probability } : {}) };
  };

  /**
   * A user's message with a placer: place the run first, so the agent wakes up where the task belongs, then deliver the message there.
   * One message at a time per run: a second one waits for the first one's decision and for its move to start, so two quick messages never
   * ask for two placements at once and none is lost.
   */
  function placeThenSubmit(state: RunState, socket: PipeSocket, text: string, requestId: string, decided?: PlacementDecision): Promise<void> {
    state.placingCount++;
    const mine = state.placing.then(() => placeOne(state, socket, text, requestId, decided));
    state.placing = mine.catch(() => undefined);
    void state.placing.then(() => void state.placingCount--);
    return mine;
  }

  async function placeOne(state: RunState, socket: PipeSocket, text: string, requestId: string, decided?: PlacementDecision): Promise<void> {
    // An earlier message's move is still going: this one goes to the host the run has when it ends.
    // (and while the home check and the agent's closing turn run: a new move then would release the pipe the check reads through and overtake the requests already queued)
    if (state.switching || state.homeTurn) {
      state.pendingSubmits.push({ text, requestId, queuedBy: socket, ...(decided ? { decided } : {}) });
      log("placement.queued", { run: state.ref.id, requestId, behind: state.switching ? "the move" : "the home wait" });
      return;
    }
    if (state.opening) return deliverSubmit(state, text, requestId);
    const current = currentEnv(state.placement);
    if (!decided && options.placer) socket.send({ t: "placing", requestId });
    const decision = decided ?? (await decide(state, "start", text, requestId));
    // A message that needs a move waits while the agent's turn runs: a move then would release the pipe under a step that is about to start. One that stays where it is goes on at once.
    if (decision && decision.choice !== current && environment(decision.choice) && turnRunning(state)) {
      state.pendingSubmits.push({ text, requestId, queuedBy: socket, decided: decision });
      log("placement.queued", { run: state.ref.id, requestId, behind: "the running turn" });
      // A turn that never reports its end does not hold the message for ever.
      if (!state.turnTimer) {
        state.turnTimer = setTimeout(() => {
          state.turnTimer = undefined;
          if (state.turnSince !== undefined) log("placement.turn-timeout", { run: state.ref.id });
          turnEnded(state);
        }, TURN_BUSY_MS + 250);
        state.turnTimer.unref();
      }
      return;
    }
    const task = { text, sent: false };
    state.placedTask = task;
    // The request goes to the run's disk as bytes before the message goes anywhere, wherever the task will run (the same host included, or a program
    // there would read the previous task's request). A request that cannot be written stops the task.
    const file = options.placer?.requestFile;
    if (file && state.pipe && !state.pipe.lost && state.pipe.writerTab) {
      try {
        await state.pipe.writeAsWriter(state.pipe.writerTab, [{ path: file, op: "write", data: toBase64(new TextEncoder().encode(text.slice(0, REQUEST_FILE_MAX))) }]);
      } catch (error) {
        log("placement.request-file-failed", { run: state.ref.id, error: (error as Error).message });
        state.placedTask = undefined;
        socket.send({ t: "submit-refused", requestId, message: `the request could not be written for the task: ${(error as Error).message}` });
        return;
      }
    }
    if (!decision || decision.choice === current || !environment(decision.choice)) {
      await deliverSubmit(state, text, requestId);
      task.sent = true;
      return;
    }
    state.pendingSubmits.push({ text, requestId, task });
    // A move that is refused leaves the run where it is: the message goes there rather than nowhere.
    await switchTo(state, { asker: socket, refuse: () => void flushPending(state), accepted: () => undefined }, decision.choice, placeWho(decision));
    // A cloud host that does not report its notice has no later moment: the move is over when it was started.
    if (!state.switching) await flushPending(state);
  }

  /** The agent's turn ended in a placed run: ask where it should run now (the browser, once the task is done) and move it there. */
  async function placeAfterTurn(state: RunState): Promise<void> {
    const task = state.placedTask;
    if (!task || state.switching || state.opening || state.checkingOut) return;
    state.placedTask = undefined;
    if (currentEnv(state.placement) === TAB_ENVIRONMENT.id) return;
    const decision = await decide(state, "done", task.text);
    if (!decision || decision.choice === currentEnv(state.placement) || !environment(decision.choice)) return;
    await switchTo(state, { refuse: (message) => log("placement.move-refused", { run: state.ref.id, message }), accepted: () => undefined }, decision.choice, placeWho(decision));
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
    try {
      await refreshCheckedOut(state);
    } catch (error) {
      // Viewers may look; nothing that would run the run attaches while it is not known whether it was checked out.
      if (frame.mode === "write") {
        log("attach.refused", { run: state.ref.id, error: (error as Error).message });
        socket.send({ t: "lost", code: "CHECKOUT_UNKNOWN", message: (error as Error).message });
        ws.close(4006, "CHECKOUT_UNKNOWN");
        return state;
      }
    }
    // A run checked out to a browser has its one live copy there: nothing attaches to run it again (it would fork the run), and says why.
    if ((state.checkedOut || state.checkingOut) && frame.mode === "write") {
      socket.send({ t: "lost", code: "CHECKED_OUT", message: CHECKED_OUT_MESSAGE });
      ws.close(4005, "CHECKED_OUT");
      return state;
    }
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
      const role = await pipe.attach(socket, frame.tab, frame.takeover === true, { environments, env: writerEnv, ...(move ? { move } : {}), ...(options.placer ? { placed: true } : {}) });
      if (role === "writer") clearTimeout(state.checkinTimer);
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
    return { t: "viewing", placement: state.placement, files, events: state.pipe ? [...state.pipe.events] : [], environments, ...(state.decisions.length > 0 ? { decisions: [...state.decisions] } : {}), model: state.model.options.model };
  }

  async function addViewer(state: RunState, socket: PipeSocket): Promise<void> {
    if (state.pipe) state.pipe.addViewer(socket);
    else state.viewers.add(socket);
    socket.send(await viewingFrame(state));
    if (state.placement.where === "cloud") await attachCloudViewer(state, socket);
  }

  async function attachCloudViewer(state: RunState, socket: PipeSocket): Promise<void> {
    if (!options.cloud?.attachViewer || state.cloudViewers.has(socket)) return;
    const epoch = state.cloudEpoch;
    const detach = await options.cloud.attachViewer(state.ref, (frame) => {
      socket.send(frame);
      // A mounted cloud host's events reach the server through this relay, not through a tab's `view` frames: the end of the agent's turn there
      // is read here, once the task's message has reached it (the history a viewer is replayed on attach holds earlier turns' ends).
      // Only while the host it was attached for is still the run's host.
      if (frame.t !== "event" || state.placement.where !== "cloud" || !endsRun(frame.event)) return;
      if (epoch !== state.cloudEpoch) return;
      // Every viewer relays its own copy of the end: the first copy of an end for a turn counts, whichever viewer it came through (a viewer's stream can drop and
      // reconnect later, so no one viewer is the one to ask), and a copy of an end already handled is ignored.
      const key = endKey(frame.event);
      if (key !== undefined) {
        if (state.endsSeen.has(key)) return;
        state.endsSeen.add(key);
        if (state.endsSeen.size > 64) state.endsSeen.delete(state.endsSeen.values().next().value!);
      }
      // A message whose placement is being decided, or waits its turn, counts as waiting too: the finished task's done question would otherwise send the agent away from it.
      const waiting = state.pendingSubmits.some((p) => p.queuedBy) || state.placingCount > 0;
      if (options.placer && state.placedTask?.sent && !waiting) void placeAfterTurn(state).catch((error) => log("placement.failed", { run: state.ref.id, error: (error as Error).message }));
      if (state.turnSince !== undefined || waiting) turnEnded(state);
    });
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
        if (pipe?.isWriter(socket) && endsRun(frame.event) && state.homeTurn?.armed) state.homeTurn.finish();
        if (pipe?.isWriter(socket) && endsRun(frame.event)) {
          const waiting = state.pendingSubmits.some((p) => p.queuedBy) || state.placingCount > 0;
          if (options.placer && state.placedTask && !waiting) void placeAfterTurn(state).catch((error) => log("placement.failed", { run: state.ref.id, error: (error as Error).message }));
          // A message that came while the turn ran is placed now, as a message of its own (it, not the finished task, decides where the agent goes next).
          turnEnded(state);
        }
        return;
      case "ping":
        if (pipe) pipe.ping(socket, frame.at);
        else socket.send({ t: "pong", at: frame.at, now: Date.now() });
        return;
      case "switch": {
        if (!mayControl(state, socket)) {
          socket.send({ t: "switch-refused", to: frame.to, message: "this connection only watches the run (hello mode view)", ...(frame.ask ? { ask: frame.ask } : {}) });
          return;
        }
        // Not queued behind the switch: the writer's drained and switched frames arrive while it runs.
        const { to, ask } = frame;
        const reply: SwitchReply = {
          asker: socket,
          refuse: (message) => socket.send({ t: "switch-refused", to, message, ...(ask ? { ask } : {}) }),
          accepted: (switchId) => ask && socket.send({ t: "switch-accepted", to, switchId, ask }),
        };
        void switchTo(state, reply, to, frame.by === "agent" ? { by: "agent", reason: frame.reason ?? "" } : { by: "user" }).catch((error) => log("switch.failed", { run: state.ref.id, error: (error as Error).message }));
        return;
      }
      case "drained":
        pipe?.drained(socket, frame.switchId, frame.acked);
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
        if (state.checkedOut) {
          socket.send({ t: "submit-refused", requestId: frame.requestId, message: CHECKED_OUT_MESSAGE });
          return;
        }
        // A viewer's message: with a placer, the run is placed for it first; otherwise to the writer tab when a tab runs the run, to the cloud when it runs there.
        if (options.placer && !state.opening) {
          void placeThenSubmit(state, socket, frame.text, frame.requestId).catch((error) => log("placement.failed", { run: state.ref.id, error: (error as Error).message }));
          return;
        }
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
    const stat = (file === resolve(root) || file.startsWith(resolve(root) + sep)) && existsSync(file) ? statSync(file) : undefined;
    if (!stat?.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": String(stat.size), // a download knows its total (a model part is up to 209 MB)
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

  // ---- the live view of a host's desktop: screenshots as MJPEG, behind a short-lived ticket --------------------------------
  // The page holds the run's secret and asks for a ticket (POST /run/<id>/desktop-ticket with it as a bearer token); the ticket
  // is the only thing in the picture's URL. Nothing of the host's own access (a VNC password, a tunnel address) reaches a page.
  const tickets = new Map<string, { run: string; until: number }>();
  const TICKET_MS = 10 * 60_000;
  const FRAME_MS = 250;
  const DESKTOP_STALL_MS = options.desktopStallMs ?? 10_000;

  async function desktopTicket(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const state = runs.get(runId);
    const auth = String(req.headers.authorization ?? "");
    if (!state || !auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), state.secret) || !options.cloud?.desktopFrame || !(await options.cloud.desktopFrame(state.ref).catch(() => undefined))) {
      res.writeHead(404).end();
      return;
    }
    const ticket = randomBytes(18).toString("base64url");
    for (const [t, v] of tickets) if (v.until < Date.now()) tickets.delete(t);
    tickets.set(ticket, { run: runId, until: Date.now() + TICKET_MS });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ url: `/desktop/${ticket}.mjpeg`, ttlMs: TICKET_MS }));
  }

  // One poller per run, however many pages watch: the first viewer starts it, the last one's leaving stops it, and each picture
  // it takes goes to every viewer (a screenshot costs the host a call, so N viewers must not cost N).
  const pollers = new Map<string, { viewers: Set<(frame: Uint8Array) => void>; stop: () => void }>();

  function watchDesktop(state: RunState, onFrame: (frame: Uint8Array) => void): () => void {
    let poller = pollers.get(state.ref.id);
    if (!poller) {
      const viewers = new Set<(frame: Uint8Array) => void>();
      let running = true;
      const frameOf = options.cloud!.desktopFrame!.bind(options.cloud!);
      void (async () => {
        while (running) {
          const started = Date.now();
          const frame = await frameOf(state.ref).catch(() => undefined);
          if (frame && running) for (const send of viewers) send(frame);
          await new Promise((r) => setTimeout(r, Math.max(0, FRAME_MS - (Date.now() - started))));
        }
      })();
      poller = { viewers, stop: () => (running = false) };
      pollers.set(state.ref.id, poller);
    }
    poller.viewers.add(onFrame);
    const mine = poller;
    return () => {
      mine.viewers.delete(onFrame);
      if (mine.viewers.size === 0) {
        mine.stop();
        if (pollers.get(state.ref.id) === mine) pollers.delete(state.ref.id);
      }
    };
  }

  function desktopStream(req: IncomingMessage, res: ServerResponse, ticket: string): void {
    const entry = tickets.get(ticket);
    const state = entry && entry.until > Date.now() ? runs.get(entry.run) : undefined;
    if (!state || !options.cloud?.desktopFrame) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-store", "cross-origin-resource-policy": "same-origin" });
    let stalledSince: number | undefined;
    const unwatch = watchDesktop(state, (frame) => {
      if ((tickets.get(ticket)?.until ?? 0) <= Date.now()) {
        unwatch();
        res.end();
        return;
      }
      // A slow or stalled viewer must not make the server hold its pictures: while the socket is backed up the frames for this response are
      // dropped (the next one is fresher anyway), so at most one frame waits in memory; a viewer that stays backed up is cut off.
      if (res.writableNeedDrain) {
        stalledSince ??= Date.now();
        if (Date.now() - stalledSince > DESKTOP_STALL_MS) {
          unwatch();
          res.destroy();
        }
        return;
      }
      stalledSince = undefined;
      res.write(Buffer.concat([Buffer.from(`--frame\r\ncontent-type: image/jpeg\r\ncontent-length: ${frame.length}\r\n\r\n`), Buffer.from(frame), Buffer.from("\r\n")]));
    });
    req.on("close", unwatch);
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
      pendingSubmits: [],
      homeTurn: undefined,
      turnSince: undefined,
      placingCount: 0,
      cloudEpoch: 0,
      endsSeen: new Set(),
      turnTimer: undefined,
      placing: Promise.resolve(),
      placedTask: undefined,
      decisions: [],
      checkedOut: undefined,
      checkingOut: false,
      checkinTimer: undefined,
      checkingIn: false,
    });
    return secret;
  }

  /** A read that failed because the file or object is not there (a file system's ENOENT, an object store's NoSuchKey or 404), and for no other reason. */
  const isNotFound = (error: unknown): boolean => {
    const e = error as { code?: unknown; name?: unknown; status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } };
    return e?.code === "ENOENT" || e?.code === "NoSuchKey" || e?.code === "NotFound" || e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.status === 404 || e?.statusCode === 404 || e?.$metadata?.httpStatusCode === 404;
  };

  /** The run's checkout marker on the disk (the disk's object view, else the local run directory), when a checkout left one. */
  async function readMarker(runId: string): Promise<CheckoutMarker | undefined> {
    const key = `runs/${runId}/store/${CHECKOUT_MARKER}`;
    let bytes: Uint8Array;
    try {
      bytes = options.readObject ? await options.readObject(key) : readFileSync(join(options.mountRoot, key));
    } catch (error) {
      // Only a confirmed missing file is "no mark". Any other failure (the disk's object view down, a permission, an I/O error) means it is not known whether the run was checked out,
      // and the mark is the whole no-fork guarantee: nothing attaches until it can be read.
      if (isNotFound(error)) return undefined;
      throw Object.assign(new Error(`cannot tell whether run ${runId} was checked out to a browser: its mark could not be read (${(error as Error).message})`), { code: "MARKER_UNREADABLE" });
    }
    try {
      const m = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<CheckoutMarker>;
      return typeof m.head === "number" && typeof m.tab === "string" ? { head: m.head, at: Number(m.at) || 0, tab: m.tab, ...(typeof m.conversation === "number" ? { conversation: m.conversation } : {}) } : undefined;
    } catch {
      return undefined;
    }
  }

  /** What the last check-in of the run left on the disk, when one did (the receipt), read as the marker is. */
  async function readReceipt(runId: string): Promise<CheckinReceipt | undefined> {
    const key = `runs/${runId}/store/${CHECKIN_RECEIPT}`;
    let bytes: Uint8Array;
    try {
      bytes = options.readObject ? await options.readObject(key) : readFileSync(join(options.mountRoot, key));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw Object.assign(new Error(`cannot read run ${runId}'s check-in receipt (${(error as Error).message})`), { code: "MARKER_UNREADABLE" });
    }
    try {
      const r = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<CheckinReceipt>;
      return typeof r.sha256 === "string" && typeof r.head === "number" && typeof r.tab === "string" ? { sha256: r.sha256, head: r.head, files: Number(r.files) || 0, tab: r.tab, at: Number(r.at) || 0 } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Learn from the disk that the run was checked out (by this server before it restarted, or by another one), and say so to everyone watching. */
  async function refreshCheckedOut(state: RunState): Promise<void> {
    if (state.checkedOut || state.pipe || state.opening) return;
    const marker = await readMarker(state.ref.id);
    if (!marker) return;
    state.checkedOut = { at: marker.at, head: marker.head, tab: marker.tab };
    setPlacement(state, { where: "checked-out", detail: CHECKED_OUT_MESSAGE });
    log("checked-out.found", { run: state.ref.id, head: marker.head });
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
    try {
      await refreshCheckedOut(runs.get(id)!);
    } catch (error) {
      runs.delete(id); // not adopted: whether it is checked out is not known
      throw error;
    }
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
      if (state.pipe && !state.pipe.lost && !state.pipe.releasing) data = await state.pipe.readWork(path).catch((error: Error) => (state.pipe!.releasing && options.readObject ? options.readObject(`runs/${runId}/work/${path}`).catch(() => undefined) : Promise.reject(error)));
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
      try {
        options.cloud?.onTabWrite?.(state.ref, path, new Uint8Array(Buffer.concat(chunks)));
      } catch (error) {
        log("cloud.on-tab-write-failed", { run: runId, path, error: (error as Error).message });
      }
    } catch (error) {
      json(res, 409, { error: (error as Error).message, holder: holderOf(state) });
    }
  }

  /**
   * `GET /api/runs/<id>/store`: a consistent copy of the run's store (a SQLite file) while a tab holds the run, for the tab that checks the run out; its head is the
   * `x-store-head` header. The run's secret is the bearer token, as for work/. The copy is made under the run's own tmp/ and removed before the answer is sent.
   */
  async function storeRoute(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const state = runs.get(runId);
    if (!state || !holdsSecret(req, state)) return void res.writeHead(404).end();
    try {
      await refreshCheckedOut(state);
    } catch (error) {
      return json(res, 503, { error: (error as Error).message, code: "MARKER_UNREADABLE" });
    }
    if (state.checkedOut) return json(res, 409, { error: CHECKED_OUT_MESSAGE, code: "CHECKED_OUT" });
    const pipe = state.pipe;
    if (!pipe || pipe.lost || pipe.releasing || pipe.released) return json(res, 409, { error: "no tab holds the run: there is no store to copy", holder: holderOf(state) });
    let copy: { bytes: Uint8Array; head: number };
    try {
      copy = await pipe.snapshotStore();
    } catch (error) {
      return json(res, 503, { error: (error as Error).message });
    }
    log("store.snapshot", { run: runId, head: copy.head, bytes: copy.bytes.length });
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(copy.bytes.length), "x-store-head": String(copy.head), "cache-control": "no-store" }).end(Buffer.from(copy.bytes));
  }

  /**
   * `POST /api/runs/<id>/checkout`: body `{head}`, header `x-pda-tab` (the tab that runs the run), the run's secret as the bearer token. The tab holds a copy of the
   * store (`GET .../store`); this hands the run to it for good: the writer's storage calls stop, the copy's head must be the store's, the claim is released, and the
   * run is checked out (every later write attach is refused with CHECKED_OUT). Answers `{head}` once the claim is released, so the answer is the proof; a mismatch
   * is a 409 with the store's head, and nothing was released.
   */
  async function checkoutRoute(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const state = runs.get(runId);
    if (!state || !holdsSecret(req, state)) return void res.writeHead(404).end();
    try {
      await refreshCheckedOut(state);
    } catch (error) {
      return json(res, 503, { error: (error as Error).message, code: "MARKER_UNREADABLE" });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 1024) return json(res, 413, { error: "the body is {head}" });
      chunks.push(chunk);
    }
    let head: unknown;
    let conversation: unknown;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { head?: unknown; conversation?: unknown };
      head = body.head;
      conversation = body.conversation;
    } catch {
      return json(res, 400, { error: "the body is not JSON" });
    }
    if (typeof head !== "number" || !Number.isSafeInteger(head) || head < 0) return json(res, 400, { error: "the body needs head, the store's sequence the copy holds" });
    const tab = String(req.headers["x-pda-tab"] ?? "");
    // A retry of a checkout whose answer was lost: the same tab with the same head is answered as the first time, so the tab can learn the outcome.
    if (state.checkedOut) return state.checkedOut.tab === tab && state.checkedOut.head === head ? json(res, 200, { head, again: true }) : json(res, 409, { error: CHECKED_OUT_MESSAGE, code: "CHECKED_OUT" });
    const pipe = state.pipe;
    if (!pipe || pipe.lost || !tab || pipe.writerTab !== tab || state.switching || state.opening || state.checkingOut) return json(res, 409, { error: "this tab does not hold the run, or a move or another checkout is in progress", code: "NOT_WRITER", holder: holderOf(state) });
    state.checkingOut = true;
    try {
      const released = await pipe.checkout(tab, head, typeof conversation === "number" && Number.isSafeInteger(conversation) ? conversation : undefined);
      state.checkedOut = { at: Date.now(), head: released, tab };
      // What releasePipe does after a release: viewers move to the server, the token user goes.
      state.pipe = undefined;
      for (const viewer of pipe.takeViewers()) state.viewers.add(viewer);
      await dropToken(state);
      options.ledger?.close("mount", pipe.lease.claim.root, "checked out");
      unsupervise(state);
      setPlacement(state, { where: "checked-out", detail: CHECKED_OUT_MESSAGE });
      log("checked-out", { run: runId, head: released, tab });
      json(res, 200, { head: released });
    } catch (error) {
      if (error instanceof CheckoutRefused) return json(res, 409, { error: error.message, code: error.code, ...(error.head === undefined ? {} : { head: error.head }) });
      log("checkout.failed", { run: runId, error: (error as Error).message });
      // Before the release began the run is still the tab's (the pipe accepts its calls again); once it began the pipe cannot go on.
      if (pipe.releasing) setPlacement(state, { where: "parked", detail: `checkout failed: ${(error as Error).message}` });
      json(res, 500, { error: (error as Error).message });
    } finally {
      state.checkingOut = false;
    }
  }

  /**
   * `POST /api/runs/<id>/checkin`: body `{tab, store, changes}` (the browser's store as base64, and the work/ changes it made while it held the run as inline FileChanges), the run's secret as the
   * bearer token. The other half of a checkout: the pipe takes the claim, checks that the store extends the head the checkout released, puts store and files on the disk and removes the mark
   * last (RunPipe.checkIn). 409 CHECKIN_DIVERGED (nothing changed) when it does not extend it; 409 NOT_CHECKED_OUT when the run is not checked out; a failure after the check leaves the mark and the same
   * request can be sent again. On success the claim stays held, so the tab can attach as the writer at once (it is released if none does within `checkinGraceMs`).
   */
  async function checkinRoute(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const state = runs.get(runId);
    if (!state || !holdsSecret(req, state)) return void res.writeHead(404).end();
    try {
      await refreshCheckedOut(state);
    } catch (error) {
      return json(res, 503, { error: (error as Error).message, code: "MARKER_UNREADABLE" });
    }
    let receipt: CheckinReceipt | undefined;
    if (!state.checkedOut) {
      // Not checked out: either this is not a run that was, or the check-in went through and its reply was lost. The receipt tells which: the same store from the same tab is answered as the first time.
      try {
        receipt = await readReceipt(runId);
      } catch (error) {
        return json(res, 503, { error: (error as Error).message, code: "MARKER_UNREADABLE" });
      }
      if (!receipt) return json(res, 409, { error: "the run is not checked out", code: "NOT_CHECKED_OUT" });
    } else if (state.checkingIn || state.checkingOut || state.switching || state.opening) return json(res, 409, { error: "a check-in or a move is in progress", code: "CHECKIN_BUSY" });
    // Reserved in the same turn as the check above, before the body is awaited: a second request for the run finds it taken and is refused, never a second user of the pipe's one connection.
    const reserved = receipt === undefined;
    if (reserved) state.checkingIn = true;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > CHECKIN_MAX) return json(res, 413, { error: `more than ${CHECKIN_MAX} bytes` });
        chunks.push(chunk);
      }
      let body: { tab?: unknown; store?: unknown; changes?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        return json(res, 400, { error: "the body is not JSON" });
      }
      if (typeof body.tab !== "string" || typeof body.store !== "string" || !Array.isArray(body.changes)) return json(res, 400, { error: "the body needs tab, store (base64) and changes" });
      const changes = body.changes as FileChange[];
      if (changes.some((c) => typeof c?.path !== "string" || (c.op === "write" && "upload" in c))) return json(res, 400, { error: "changes are inline writes, mkdirs and deletes" });
      if (receipt) {
        // the check-in already went through: answered as it was the first time, and nothing is written
        const same = receipt.tab === body.tab && receipt.sha256 === createHash("sha256").update(Buffer.from(body.store, "base64")).digest("hex");
        if (!same) return json(res, 409, { error: "the run is not checked out, and this is not the store its last check-in took", code: "NOT_CHECKED_OUT" });
        log("checkin.replayed", { run: runId, head: receipt.head });
        return json(res, 200, { head: receipt.head, files: receipt.files, replayed: true });
      }
      const marker = await readMarker(runId);
      if (!marker) return json(res, 409, { error: "the run is not checked out", code: "NOT_CHECKED_OUT" });
      let pipe: RunPipe | undefined;
      try {
        pipe = state.pipe ?? (await openPipe(state, false));
        const done = await pipe.checkIn({ tab: body.tab, marker, storeBytes: new Uint8Array(Buffer.from(body.store, "base64")), changes, ...(options.beforeCheckinMarkerRemoval ? { beforeMarkerRemoval: options.beforeCheckinMarkerRemoval } : {}) });
        state.checkedOut = undefined;
        setPlacement(state, { where: "parked", detail: "checked in: the browser's copy is the run again" });
        // the tab attaches next; the claim is held for it, and let go if it does not come
        clearTimeout(state.checkinTimer);
        state.checkinTimer = setTimeout(() => {
          if (state.pipe && !state.pipe.writerTab && !state.switching && !state.opening) void releasePipe(state).catch((error) => log("release.failed", { run: runId, error: (error as Error).message }));
        }, options.checkinGraceMs ?? 30_000);
        state.checkinTimer.unref();
        log("checked-in", { run: runId, head: done.head, files: done.files });
        json(res, 200, done);
      } catch (error) {
        // the claim is let go: the run stays checked out (the mark is still there) for a retry
        if (state.pipe && !state.pipe.lost) await releasePipe(state).catch((e) => log("release.failed", { run: runId, error: (e as Error).message }));
        if (error instanceof CheckinRefused) return json(res, 409, { error: error.message, code: error.code, ...(error.table ? { table: error.table } : {}) });
        log("checkin.failed", { run: runId, error: (error as Error).message });
        json(res, 500, { error: (error as Error).message });
      }
    } finally {
      if (reserved) state.checkingIn = false;
    }
  }

  /**
   * `POST /api/runs/<id>/brain-judge`: body `{label: "brain", state: {message}, questions: {who: {type: "choice", instructions, criteria: {local, cloud}}}}`, the run's secret as the bearer token.
   * The page's brain router (brain-router.ts) asks who should answer a message; this runs that one question on the server's client and answers `{answers, model}`. Anything else is refused,
   * so the route is not a way to ask the client other things. The message is never logged.
   */
  async function brainJudgeRoute(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const state = runs.get(runId);
    if (!options.brainJudge || !state || !holdsSecret(req, state)) return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 64 * 1024) return json(res, 413, { error: "more than 64 KiB" });
      chunks.push(chunk);
    }
    let body: { label?: unknown; state?: { message?: unknown }; questions?: Record<string, { type?: unknown; instructions?: unknown; criteria?: Record<string, unknown> }> };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
    } catch {
      return json(res, 400, { error: "the body is not JSON" });
    }
    const q = body?.questions?.who;
    const criteria = q?.criteria;
    const message = body?.state?.message;
    if (body?.label !== "brain" || typeof message !== "string" || message.length === 0 || message.length > 8000 || Object.keys(body.questions ?? {}).join() !== "who" || q?.type !== "choice" || typeof q.instructions !== "string" || q.instructions.length > 200 || !criteria || Object.keys(criteria).sort().join() !== "cloud,local" || Object.values(criteria).some((c) => typeof c !== "string" || c.length > 400)) {
      return json(res, 400, { error: "only the brain router's question is answered" });
    }
    const started = Date.now();
    try {
      const result = await options.brainJudge({ label: "brain", kind: "judge", state: { message }, questions: { who: { type: "choice", instructions: q.instructions, criteria: criteria as Record<string, string> } } });
      const who = result.answers.who as { choice?: string; probabilities?: Record<string, number> } | undefined;
      log("brain.judge", { run: runId, ms: Date.now() - started, message_chars: message.length, ...(result.model ? { model: result.model } : {}), ...(who?.choice ? { choice: who.choice } : {}), ...(who?.probabilities ? { probabilities: who.probabilities } : {}) });
      json(res, 200, result);
    } catch (error) {
      log("brain.judge.failed", { run: runId, ms: Date.now() - started, error: (error as Error).message });
      json(res, 502, { error: (error as Error).message });
    }
  }

  /**
   * `POST /api/runs/<id>/judge`: body `{prompt, answer, topic?}`; answers the judge's verdict (`show` or `refuse`). A judge that
   * times out or fails is a `refuse` too, so the page never shows an answer nobody judged. The text is never logged.
   * The route only answers; holding an answer back until its verdict is `show` is the page's part.
   */
  async function judgeRoute(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const state = runs.get(runId);
    if (!options.judge || !state || !holdsSecret(req, state)) return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 4 * JUDGE_ANSWER_MAX) return json(res, 413, { error: `more than ${4 * JUDGE_ANSWER_MAX} bytes` });
      chunks.push(chunk);
    }
    let body: { prompt?: unknown; answer?: unknown; topic?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
    } catch {
      return json(res, 400, { error: "the body is not JSON" });
    }
    if (body === null || typeof body !== "object" || typeof body.prompt !== "string" || typeof body.answer !== "string") {
      return json(res, 400, { error: "the body needs prompt and answer strings" });
    }
    if (body.answer.length > JUDGE_ANSWER_MAX) return json(res, 413, { error: `the answer is longer than ${JUDGE_ANSWER_MAX} characters` });
    if (body.topic !== undefined && (typeof body.topic !== "string" || body.topic.length > 200)) return json(res, 400, { error: "topic, when given, is a string of at most 200 characters" });
    const verdict = await judgeAnswer({ prompt: body.prompt, answer: body.answer, ...(typeof body.topic === "string" ? { topic: body.topic } : {}) }, options.judge);
    // A held answer says why: the judge's quote (a short excerpt it chose as evidence, capped) rides with the fields, and the answer's length lets a take pair the line with what the page held. The answer itself is never logged.
    log("judge", { run: runId, verdict: verdict.verdict, dark: verdict.dark, false_claim: verdict.false_claim, ...(verdict.verdict !== "show" && verdict.quote ? { quote: verdict.quote.slice(0, 200) } : {}), answer_chars: body.answer.length, ms: verdict.ms, ...(verdict.error ? { error: verdict.error } : {}) });
    json(res, 200, { ...verdict });
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
    const judge = /^\/api\/runs\/([^/]+)\/judge$/.exec(path);
    const brainJudge = /^\/api\/runs\/([^/]+)\/brain-judge$/.exec(path);
    const storeCopy = /^\/api\/runs\/([^/]+)\/store$/.exec(path);
    const checkout = /^\/api\/runs\/([^/]+)\/checkout$/.exec(path);
    const checkin = /^\/api\/runs\/([^/]+)\/checkin$/.exec(path);
    const failed = (error: unknown) => {
      log("http.failed", { path: path.split("/").slice(0, 4).join("/"), error: (error as Error).message });
      if (!res.headersSent) res.writeHead(500).end();
    };
    const desktopStreamOf = /^\/desktop\/([A-Za-z0-9_-]+)\.mjpeg$/.exec(path);
    const desktopTicketFor = /^\/run\/([^/]+)\/desktop-ticket$/.exec(path);
    if (req.method === "GET" && desktopStreamOf) desktopStream(req, res, desktopStreamOf[1]!);
    else if (req.method === "POST" && desktopTicketFor) void desktopTicket(req, res, decodeURIComponent(desktopTicketFor[1]!)).catch(failed);
    else if (work && (req.method === "GET" || req.method === "PUT")) void workRoute(req, res, decodeURIComponent(work[1]!), decodeURIComponent(work[2]!)).catch(failed);
    else if (attach && req.method === "POST") void attachRoute(req, res, decodeURIComponent(attach[1]!)).catch(failed);
    else if (brainJudge && req.method === "POST") void brainJudgeRoute(req, res, decodeURIComponent(brainJudge[1]!)).catch(failed);
    else if (judge && req.method === "POST") void judgeRoute(req, res, decodeURIComponent(judge[1]!)).catch(failed);
    else if (storeCopy && req.method === "GET") void storeRoute(req, res, decodeURIComponent(storeCopy[1]!)).catch(failed);
    else if (checkout && req.method === "POST") void checkoutRoute(req, res, decodeURIComponent(checkout[1]!)).catch(failed);
    else if (checkin && req.method === "POST") void checkinRoute(req, res, decodeURIComponent(checkin[1]!)).catch(failed);
    else if (req.method === "GET" && path === "/api/ping") res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("ok"); // the page's "can I reach the server" (tab/main.ts)
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
      for (const poller of pollers.values()) poller.stop();
      pollers.clear();
      for (const state of runs.values()) {
        clearTimeout(state.turnTimer);
        // A home wait still open ends here, replaying nothing and leaving no timer.
        if (state.homeTurn) {
          state.homeTurn.cancelled = true;
          clearTimeout(state.homeTurn.timer);
          state.homeTurn.finish();
          log("placement.home-wait-cancelled", { run: state.ref.id });
        }
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

