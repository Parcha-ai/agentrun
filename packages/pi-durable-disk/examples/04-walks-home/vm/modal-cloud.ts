// The Modal VM as an environment of the switcher. A VM sandbox of a cached image (image.ts) runs the agent the way the
// tab does, through the pipe (remote-host.ts of 03-tab-to-cloud): the server's pipe holds the claim and the disk, the VM
// holds the agent, its tools on its own filesystem, and the model calls go back through the pipe. The server reaches the VM
// (a tunnel to the host's port, bearer token), not the other way round; the first frame it sends is the invitation, which
// carries the switch id, so the host admits the durable "you are now running in a Modal VM" notice before it resumes.
//
// The transport is a setting, because only a measurement decides it. "mount" (the default for the VM runtime, which kept 10 of
// 10 fsyncs through a daemon kill): the VM mounts the disk itself and the package's supervisor starts the instance there
// through `modalHost`, as for any cloud host; the environment is kind "cloud". "pipe": the VM runs the agent through the pipe,
// the only way where fsync is not durable (gVisor, GPU); the environment is kind "remote". Moving between them is
// `transport`, which changes the environment's kind and so which of start/startRemote the server calls.
//
// Every sandbox is named `<prefix><run>-<stamp>`, tagged `pda-fleet`, recorded in the ledger before its create call returns,
// and deleted when the run leaves it (stopRemote), on close, and by Modal itself at its timeout.
//   MODAL_TOKEN_ID, MODAL_TOKEN_SECRET in the server's environment; the boxes never get them.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ensureRunning, LABEL_FLEET, LABEL_RUN, modalHost, modalSandboxes, removeMountToken, sandboxName } from "@parcha/pi-durable-disk";
import type { DaytonaClient, HostDriver, HostHandle, ModalSandbox, ModalSdk, RunRef, SandboxInfo } from "@parcha/pi-durable-disk";
import { warmTrain, type WarmTrain } from "../universes/warm-train.ts";
import { creatureWarmer, type CreatureWarmer } from "./warm-creature.ts";
import { appBundle, boxSetupScript, prepareScript, BOX_APP_DIR, BOX_LINK_PORT, BOX_MOUNT_ROOT, BOX_NODE, BOX_PACKAGE, BOX_SERVE_PORT } from "../../03-tab-to-cloud/pipe/daytona.ts";
import { CLOUD_LEASE, moveEnv, relayViewer } from "../../03-tab-to-cloud/pipe/cloud.ts";
import { archilControl, type DemoControl } from "../../03-tab-to-cloud/pipe/control.ts";
import { dialLink, type LinkDialer } from "../../03-tab-to-cloud/pipe/link.ts";
import type { ModelOptions, ModelProxy } from "../../03-tab-to-cloud/pipe/model-proxy.ts";
import type { CloudHost, Invite, ServerApi } from "../../03-tab-to-cloud/pipe/server.ts";
import type { Environment, Move } from "../../03-tab-to-cloud/wire.ts";
import { DESKTOP_DISPLAY, DESKTOP_PORT, desktopScript, novncUrl, SCREENSHOT_COMMAND } from "./desktop.ts";
import { GpuPool, type PoolStatus } from "./gpu-pool.ts";
import { vmImageCommands } from "./image.ts";
import type { GpuProcess, GpuServer } from "../../03-tab-to-cloud/pipe/gpu-rpc.ts";

const BOX_ETC = "/etc/pda-demo";
const BOX_REMOTE_LOG = "/var/tmp/pda-remote.log";
const BOX_EVENTS = "/var/tmp/pda-demo-events.log";
const STAGE = "/tmp/pda-demo-stage";
/** The pipe host's workspace in the VM: the agent's tools run here, owned by the run user. */
const BOX_WORK = "/var/tmp/pda-work";

type Log = (event: string, data?: Record<string, unknown>) => void;
type LedgerLike = { open(kind: string, id: string, note?: string): void; close(kind: string, id: string, note?: string): void };
type Tunnels = Record<number, { url: string }>;
type TunnelSandbox = ModalSandbox & { tunnels(timeoutMs?: number): Promise<Tunnels> };
/** The package's view of the Modal SDK, with the one call this file adds: the tunnels of a sandbox. */
type FullSdk = Omit<ModalSdk, "sandboxes"> & { sandboxes: Omit<ModalSdk["sandboxes"], "fromId"> & { fromId(id: string): Promise<TunnelSandbox> } };

export interface ModalCloudOptions {
  readonly disk: string;
  readonly region: string;
  readonly model: ModelOptions;
  readonly log: Log;
  readonly ledger?: LedgerLike;
  readonly control?: DemoControl;
  /** The Modal app the sandboxes live in. Default "pda-demo". */
  readonly appName?: string;
  /** Sandbox names are `<prefix><run>-<stamp>`. Default "pda-demo-". */
  readonly namePrefix?: string;
  /** Tag value of `pda-fleet`. Default "demo". */
  readonly fleet?: string;
  /** A prebuilt Modal image id (`im-...`); default: image.ts's commands on ubuntu:24.04, built once by Modal. */
  readonly image?: string;
  /** Default "vm". */
  readonly runtime?: "vm" | "gvisor";
  /** "mount": the VM mounts the disk and the supervisor runs the instance there. "pipe": the agent runs through the pipe. Default: mount on "vm", pipe otherwise. */
  readonly transport?: "mount" | "pipe";
  readonly cpu?: number;
  readonly memoryMiB?: number;
  /** Where Modal may place the sandboxes (`["us-east"]`, near the disk). */
  readonly regions?: string[];
  /** Start a desktop in the VM (a virtual display, a window manager, noVNC to watch it) and give the agent the computer tool. Mount transport only. */
  readonly desktop?: boolean;
  /**
   * A second environment, "modal-gpu": one gVisor sandbox with a GPU, running the agent through the pipe (gVisor does not give
   * a durable fsync, so the disk is never mounted there). `image` is a prebuilt Modal image (your training image with
   * image.ts's layer, without archil); `note` goes into the agent's notice there (what to run, where the output goes).
   */
  readonly gpu?: {
    readonly image: string;
    readonly type?: string;
    readonly cpu?: number;
    readonly memoryMiB?: number;
    readonly note?: string;
    readonly placementTimeoutMs?: number;
    readonly ttlMinutes?: number;
    /**
     * With `warm: "gpu"`: the trainer's compile-only lines ({mjcf} and {body} stand for the creature's files), run on the warm box
     * once the tab's drawing has landed in the run, so the agent's train command starts from a compiled program (warm-train.ts).
     */
    readonly warmCommands?: readonly string[];
    readonly warmEnv?: Readonly<Record<string, string>>;
    /**
     * Programs started at box creation, in the background as the run user (a large model's server that stays up for the agent's commands).
     * `startEnv` names variables of THIS process's environment forwarded to them: their values travel in a root-only file that is deleted
     * once the programs started, never in a command line. The box counts as ready only when `readyCommand` succeeds (polled every 5 s).
     */
    readonly startCommands?: readonly string[];
    readonly startEnv?: readonly string[];
    readonly readyCommand?: string;
    readonly readyTimeoutMs?: number;
    /** Modal Volumes to mount in the box, by path: `{ "/vol": "name" }`. */
    readonly volumes?: Readonly<Record<string, string>>;
    /** How long the creature's files stay unchanged before the warm-up starts. Default 1.5 s (the tab has already waited 1.5 s after the pen rested). */
    readonly warmDelayMs?: number;
  };
  /**
   * Keep one box ready for a run while a tab runs it (it costs while it waits): `true` a pipe VM, `"gpu"` the GPU box
   * (the take opens the tab right before the user draws, so the machine is up by the time the agent asks for it). Default off.
   */
  readonly warm?: boolean | "gpu";
  /**
   * With `warm`: warm the next box when a tab takes the run back from the one that was used, so a second task in the same session finds
   * a box on its way (live mode). Default off: a take ends after one task and must not pay for a box nobody will use.
   */
  readonly rewarm?: boolean;
  /** How long close() waits for boxes still being made to land and remove themselves (default 60 s). */
  readonly closeWaitMs?: number;
  /** The session on the VM teaches skills on the cluster: the cloud app gets `teach_skills`, `train_skill` and the per-thread environments (robot-extra.ts). Needs `cluster` and the link. */
  readonly robot?: boolean;
  /**
   * The robot cluster beat: N GPU boxes created in parallel as soon as this cloud exists (so they are warm when someone asks), lent one per
   * thread to the session on the VM through its link (gpu-rpc.ts). The boxes run commands only for the thread that holds them; the VM never
   * sees a Modal key or id it can use. Every box is removed on close (a box still being created lands, finds the pool closing, and goes).
   */
  readonly cluster?: {
    readonly size: number;
    readonly image: string;
    readonly type?: string;
    readonly cpu?: number;
    readonly memoryMiB?: number;
    readonly ttlMinutes?: number;
    /**
     * Run in each box as the readiness check (polled every 5 s until it exits 0). `{skill}` is replaced by the box's own skill (see `skills`), `{index}` by its
     * number. Absent: a box is ready when it answers an exec. `/workspace` is made on every box first.
     */
    readonly readyCommand?: string;
    /** The skill each box warms for, box 0 first (a box beyond the list wraps around). */
    readonly skills?: readonly string[];
    readonly readyTimeoutMs?: number;
    readonly placementTimeoutMs?: number;
    /** When the boxes start: "attach" (default: when the first page takes the run, so a server nobody opens costs nothing) or "now" (when this cloud is made). */
    readonly start?: "attach" | "now";
  };
  /** Offer the VM environment (default true). Without it the only place the agent can go is the GPU box; needs `gpu`. */
  readonly offerVm?: boolean;
  /** Where each stopped host's log lines are appended (the demo's evidence file). */
  readonly eventsLog?: string;
  /** The Modal SDK; default the `modal` package's client. */
  readonly sdk?: FullSdk;
}

/** The robot's extra of the cloud app: published path in the box's bundle to its source. robot-extra.ts imports ../cluster/teach-skills.ts, so both keep that relative place. */
const ROBOT_BUNDLE_FILES: Readonly<Record<string, string>> = {
  "robot/vm/robot-extra.ts": fileURLToPath(new URL("./robot-extra.ts", import.meta.url)),
  "robot/cluster/teach-skills.ts": fileURLToPath(new URL("../cluster/teach-skills.ts", import.meta.url)),
};

/** A GPU sandbox's own lifetime unless the caller says otherwise: the backstop when nothing else removes it (a killed server). */
export const DEFAULT_GPU_TTL_MINUTES = 20;

export const modalVmEnvironment = (transport: "mount" | "pipe"): Environment => ({
  id: "modal-vm",
  label: "Modal VM",
  phrase: "a Modal VM",
  kind: transport === "mount" ? "cloud" : "remote",
  detail: "2 vCPU, 4 GiB, its own Linux kernel",
});

export const modalGpuEnvironment = (type: string): Environment => ({
  id: "modal-gpu",
  label: `a cloud GPU (Modal ${type})`,
  phrase: "a Modal GPU machine",
  kind: "remote",
  detail: `1x ${type}, a Linux sandbox that runs the agent through your server`,
});

interface Placed {
  driver: HostDriver;
  dialer: LinkDialer;
  serve: { url: string; token: string };
  desktop?: { url: string };
  handle: HostHandle;
  token: string;
  box: string;
}

/** The demo server's CloudHost, and what only this cloud has: the run's desktop. */
export type ModalCloud = CloudHost & {
  hostLabel: string;
  desktop(ref: RunRef): { url: string; screenshot(): Promise<Uint8Array> } | undefined;
  /** The cluster's boxes (with `cluster`): their state now, and a promise that settles when every box has come up or failed. */
  cluster?: { status(): PoolStatus; /** Start the boxes (once) and resolve when each has come up or failed. */ start(): Promise<void>; /** What the session on the VM may ask of the boxes (the link serves it); exposed for a smoke test that talks to the boxes without a VM. */ gpu: GpuServer };
};

export async function modalCloud(options: ModalCloudOptions): Promise<ModalCloud> {
  const base: FullSdk = options.sdk ?? (new (await import("modal")).ModalClient() as unknown as FullSdk);
  const appName = options.appName ?? "pda-demo";
  const prefix = options.namePrefix ?? "pda-demo-";
  const fleet = options.fleet ?? "demo";
  const runtime = options.runtime ?? "vm";
  const transport = options.transport ?? (runtime === "vm" ? "mount" : "pipe");
  const control = options.control ?? (await archilControl({ disk: options.disk, region: options.region, apiKey: process.env.ARCHIL_API_KEY ?? "" }));
  const env = modalVmEnvironment(transport);
  const uid = process.getuid!();
  const gid = process.getgid!();
  const image = options.image ?? (() => (base.images.fromRegistry("ubuntu:24.04") as unknown as { dockerfileCommands(c: string[]): unknown }).dockerfileCommands(vmImageCommands(uid, gid, { desktop: options.desktop })));
  // Every sandbox is in the ledger by its name before the create call returns, and by its id after.
  const sdk: FullSdk = {
    apps: base.apps,
    images: base.images,
    ...(base.volumes ? { volumes: base.volumes } : {}),
    sandboxes: {
      create: async (app, img, params) => {
        options.ledger?.open("modal-sandbox", params.name, "create");
        try {
          const box = await base.sandboxes.create(app, img, params);
          options.ledger?.open("modal-sandbox", box.sandboxId, params.name);
          return box;
        } finally {
          options.ledger?.close("modal-sandbox", params.name, "create returned");
        }
      },
      fromId: (id) => base.sandboxes.fromId(id),
      fromName: (a, n) => base.sandboxes.fromName(a, n),
      list: (p) => base.sandboxes.list(p),
    },
  };
  const ports = [BOX_SERVE_PORT, BOX_LINK_PORT, ...(options.desktop ? [DESKTOP_PORT] : [])];
  const vncPasswords = new Map<string, string>();
  const client: DaytonaClient = modalSandboxes(sdk, { appName, image, runtime, cpu: options.cpu ?? 2, memoryMiB: options.memoryMiB ?? 4096, ...(options.regions ? { regions: options.regions } : {}), encryptedPorts: ports });
  const gpuType = options.gpu?.type ?? "H100";
  const gpuEnv = options.gpu ? modalGpuEnvironment(gpuType) : undefined;
  const gpuClient: DaytonaClient | undefined = options.gpu
    ? modalSandboxes(sdk, { appName, image: options.gpu.image, runtime: "gvisor", gpu: gpuType, cpu: options.gpu.cpu ?? 4, memoryMiB: options.gpu.memoryMiB ?? 16384, ...(options.regions ? { regions: options.regions } : {}), encryptedPorts: [BOX_SERVE_PORT], ...(options.gpu.volumes ? { volumes: { ...options.gpu.volumes } } : {}) })
    : undefined;
  // ---- the robot cluster: a pool of GPU boxes lent to the session's threads ------------------------------------------------------
  const clusterClient: DaytonaClient | undefined = options.cluster
    ? modalSandboxes(sdk, { appName, image: options.cluster.image, runtime: "gvisor", gpu: options.cluster.type ?? "H100", cpu: options.cluster.cpu ?? 8, memoryMiB: options.cluster.memoryMiB ?? 65536, ...(options.regions ? { regions: options.regions } : {}) })
    : undefined;
  const pool: GpuPool | undefined =
    options.cluster && clusterClient
      ? new GpuPool({
          size: options.cluster.size,
          log: options.log,
          closeWaitMs: options.closeWaitMs ?? 60_000,
          create: async (index) => {
            const cluster = options.cluster!;
            const t0 = Date.now();
            const name = sandboxName(`${prefix}gpu${index}-`, "cluster", t0);
            const body = { name, snapshot: "image", labels: { [LABEL_FLEET]: fleet, [LABEL_RUN]: "cluster" }, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: cluster.ttlMinutes ?? DEFAULT_GPU_TTL_MINUTES };
            const timeoutMs = cluster.placementTimeoutMs ?? 360_000;
            const creating = clusterClient.create(body);
            let box: SandboxInfo;
            let placeTimer: NodeJS.Timeout | undefined;
            const outcome = await Promise.race([creating.then((b) => ({ b })), new Promise<{ timedOut: true }>((r) => (placeTimer = setTimeout(() => r({ timedOut: true }), timeoutMs)))]).finally(() => clearTimeout(placeTimer));
            if ("timedOut" in outcome) {
              // Modal may still place it: it is removed when it lands, and its own TTL bounds it if this process is gone.
              void reclaimLate(name, creating);
              throw new Error(`GPU box ${index} did not place in ${Math.round(timeoutMs / 1000)} s`);
            }
            box = outcome.b;
            const poolBox = { id: box.id, name, index };
            // A box whose readiness fails is removed here, so a failed box never keeps charging behind a pool that has given up on it.
            try {
              const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
              const deadline = Date.now() + (cluster.readyTimeoutMs ?? 300_000);
              for (;;) {
                const skill = (cluster.skills ?? ["walk"])[index % (cluster.skills ?? ["walk"]).length]!;
                const ready = cluster.readyCommand?.replaceAll("{skill}", skill).replaceAll("{index}", String(index));
                const r = await clusterClient.exec(box, `mkdir -p /workspace && ${ready ? `bash -c ${q(ready)}` : "true"}`, 180).catch((e: Error) => ({ exitCode: 1, result: e.message }));
                if (r.exitCode === 0) break;
                if (Date.now() > deadline) throw new Error(`GPU box ${index} was not ready in ${Math.round((cluster.readyTimeoutMs ?? 300_000) / 1000)} s: ${r.result.trim().slice(-200)}`);
                await new Promise((res) => setTimeout(res, 5_000));
              }
            } catch (error) {
              await drop(box);
              throw error;
            }
            options.log("cluster.box-up", { index, box: name, ms: Date.now() - t0 });
            return poolBox;
          },
          remove: async (box) => drop({ id: box.id, name: box.name }),
        })
      : undefined;
  const asIterable = (stream: unknown): AsyncIterable<Uint8Array> => {
    const s = stream as { [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>; readBytes?: () => Promise<Uint8Array> };
    if (s[Symbol.asyncIterator]) return s as AsyncIterable<Uint8Array>;
    return (async function* () {
      const all = await s.readBytes!();
      if (all.length > 0) yield all;
    })();
  };
  /** What the session on the VM may do with the boxes: ask for one per thread, and run commands in the box it holds. */
  const gpuServer: GpuServer | undefined = pool
    ? {
        acquire: async (thread) => (await pool.acquire(thread)).id,
        release: (thread) => pool.release(thread),
        holds: (box) => pool.status().boxes.some((b) => b.id === box && b.state === "busy"),
        exec: async (box, argv, o) => {
          const sb = await sdk.sandboxes.fromId(box);
          const proc = await sb.exec(argv, { mode: "binary", ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) });
          return { stdin: proc.stdin, stdout: asIterable(proc.stdout), stderr: asIterable(proc.stderr), wait: () => proc.wait() } satisfies GpuProcess;
        },
        poll: async (box) => {
          const sb = await sdk.sandboxes.fromId(box);
          return sb.poll();
        },
      }
    : undefined;
  let clusterStarted: Promise<void> | undefined;
  const startCluster = (): Promise<void> => {
    if (!pool) return Promise.resolve();
    clusterStarted ??= pool.start();
    clusterStarted.catch(() => undefined);
    return clusterStarted;
  };
  if (options.cluster?.start === "now") void startCluster();

  /** What a pipe host of each environment is made of. */
  const classOf = (envId: string) =>
    envId === gpuEnv?.id && gpuClient && options.gpu
      ? { env: gpuEnv, client: gpuClient, archil: false, cpus: options.gpu.cpu ?? 4, memoryMiB: options.gpu.memoryMiB ?? 16384, ttlMinutes: options.gpu.ttlMinutes ?? DEFAULT_GPU_TTL_MINUTES, className: "modal-gpu", liveFlushMs: 1000, bashMaxSeconds: 150, note: `The run's disk is not mounted here: your conversation and workspace reach this machine through your user's server. ${options.gpu.note ?? ""}`.trim() }
      : { env, client, archil: true, cpus: 0, memoryMiB: 0, ttlMinutes: 120, className: "modal-vm", liveFlushMs: 0, bashMaxSeconds: 0, note: "The run's disk is not mounted here: your conversation and workspace reach this machine through your user's server." };
  let bundle: Uint8Array | undefined;
  const remotes = new Map<string, SandboxInfo>();
  const warm = new Map<string, Promise<SandboxInfo>>();
  /** The creature warmer of each run, and the compile-only runner of each warm box. */
  const warmers = new Map<string, CreatureWarmer>();
  const trainers = new Map<string, WarmTrain>();
  const serveTokens = new Map<string, string>();
  const live = new Set<string>();
  const placed = new Map<string, Placed>();
  const models = new Map<string, ModelProxy>();
  const running = new Set<string>();
  /** Set when close() begins: no sandbox is made after it, and one that lands from a create already in flight is removed at once. */
  let closing = false;
  /** The sandbox creates in flight (no id yet, so close()'s sweep cannot see them): close() waits for them, bounded, so none lands after its sweep. */
  const creates = new Set<Promise<unknown>>();
  let server: ServerApi | undefined;

  /**
   * Remove a sandbox. A removal that fails leaves it in `live` (and its token), so a later try, such as close()'s, still finds it:
   * a sandbox forgotten while it runs costs by the minute. True when it is gone.
   */
  async function drop(box: { id: string; name: string }): Promise<boolean> {
    const removed = await client.remove(box.id).then(
      () => {
        options.ledger?.close("modal-sandbox", box.id, "deleted");
        return true;
      },
      (error: Error) => {
        options.log("modal.delete-failed", { box: box.name, error: error.message });
        return false;
      },
    );
    if (removed) {
      live.delete(box.id);
      serveTokens.delete(box.id);
    }
    return removed;
  }

  /** The app bundle and this box's serve token: once per box (the image holds the runtime and the app's dependencies). */
  async function prepare(box: SandboxInfo, c: DaytonaClient = client, host: { archil?: boolean; desktop?: boolean } = {}): Promise<void> {
    const started = Date.now();
    live.add(box.id);
    bundle ??= appBundle(options.robot ? ROBOT_BUNDLE_FILES : {});
    await c.upload(box, "/tmp/pda-demo-app.tar.gz", bundle);
    const r = await c.exec(box, prepareScript(uid, gid, { archil: host.archil ?? true }), 900);
    if (r.exitCode !== 0) throw new Error(`preparing ${box.name} failed (${r.exitCode}): ${r.result.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    const mk = await c.exec(box, `umask 077 && mkdir -p ${STAGE} && chmod 700 ${STAGE}`, 30);
    if (mk.exitCode !== 0) throw new Error(`staging in ${box.name} failed: ${mk.result.trim().slice(0, 200)}`);
    const token = randomBytes(24).toString("base64url");
    await c.upload(box, `${STAGE}/serve.token`, new TextEncoder().encode(`${token}\n`));
    const setup = await c.exec(box, boxSetupScript(STAGE), 60);
    if (setup.exitCode !== 0) throw new Error(`setting up ${box.name} failed (${setup.exitCode}): ${setup.result.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
    serveTokens.set(box.id, token);
    // Only a mounted VM has a desktop: a pipe box (the GPU one) runs another image, with no X server in it.
    if (host.desktop) {
      const password = randomBytes(9).toString("base64url");
      await c.upload(box, `${STAGE}/vnc.txt`, new TextEncoder().encode(password));
      const started = Date.now();
      const d = await c.exec(box, desktopScript(STAGE), 120);
      if (d.exitCode !== 0) throw new Error(`starting the desktop in ${box.name} failed (${d.exitCode}): ${d.result.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
      vncPasswords.set(box.id, password);
      options.log("desktop.started", { box: box.name, ms: Date.now() - started });
    }
    options.log("modal.prepared", { box: box.name, ms: Date.now() - started, steps: r.result.split("\n").filter((l) => l.startsWith("step")).map((l) => l.split("\t").slice(1).join("=")) });
  }

  async function tunnelsOf(boxId: string): Promise<Tunnels> {
    return (await sdk.sandboxes.fromId(boxId)).tunnels(30_000);
  }

  async function dropToken(run: string, token: string): Promise<void> {
    try {
      await removeMountToken(control, token);
      options.ledger?.close("token-user", token);
    } catch (error) {
      options.log("cloud.token-remove-failed", { run, error: (error as Error).message });
    }
  }

  // ---- pipe transport: a VM sandbox that runs the agent through the pipe ----------------------------------------------------

  /** A create that outlived its caller: when it places the sandbox after all, terminate it (looked up by name, up to 20 minutes). */
  async function reclaimLate(name: string, creating: Promise<SandboxInfo>): Promise<void> {
    const landed = await creating.then((b) => b, () => undefined);
    if (landed) {
      await drop(landed);
      return;
    }
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 15_000));
      const found = await sdk.sandboxes.fromName(appName, name).catch(() => undefined);
      if (found) {
        await found.terminate().catch(() => undefined);
        options.ledger?.close("modal-sandbox", found.sandboxId, "terminated: placed after its start gave up");
        return;
      }
    }
  }

  /**
   * A sandbox of environment `envId` for `ref`, set up, with remote-host.ts listening as the run user. A GPU is not always
   * there to place: a create that has not returned in `placementTimeoutMs` fails the start, and the sandbox it may still place
   * later (untagged, since the tags are set after create) is found by its name and terminated.
   */
  /** The box's own programs (see `startCommands`): started in the background, secrets by file, then the ready check. */
  async function startOnBox(box: SandboxInfo, name: string, c: DaytonaClient, gpu: NonNullable<ModalCloudOptions["gpu"]>): Promise<void> {
    const t0 = Date.now();
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    const names = (gpu.startEnv ?? []).filter((n) => process.env[n] !== undefined);
    if (names.length > 0) await c.upload(box, "/root/.pda-start.env", new TextEncoder().encode(names.map((n) => `${n}=${q(process.env[n]!)}`).join("\n") + "\n"));
    const pass = names.map((n) => `${n}="$${n}"`).join(" ");
    for (const cmd of gpu.startCommands ?? []) {
      const script = [
        names.length > 0 ? "set -a; . /root/.pda-start.env; set +a" : "true",
        `sudo -n -u pda -H env ${pass} bash -c ${q(`cd ${BOX_WORK} && setsid -f bash -c ${q(cmd)} > /dev/null 2>&1 < /dev/null`)}`,
      ].join(" && ");
      const r = await c.exec(box, script, 60);
      if (r.exitCode !== 0) throw new Error(`starting a program in ${name} failed (${r.exitCode}): ${r.result.trim().slice(0, 200)}`);
    }
    if (names.length > 0) await c.exec(box, "rm -f /root/.pda-start.env", 15).catch(() => undefined);
    options.log("box.started", { box: name, programs: gpu.startCommands?.length ?? 0 });
    if (!gpu.readyCommand) return;
    const deadline = Date.now() + (gpu.readyTimeoutMs ?? 600_000);
    for (;;) {
      const r = await c.exec(box, `sudo -n -u pda -H bash -c ${q(gpu.readyCommand)}`, 30).catch(() => ({ exitCode: 1, result: "" }));
      if (r.exitCode === 0) break;
      if (Date.now() > deadline) throw new Error(`${name} was not ready in ${Math.round((gpu.readyTimeoutMs ?? 600_000) / 1000)} s`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    options.log("box.ready", { box: name, ms: Date.now() - t0 });
  }

  function remoteBox(ref: RunRef, envId: string): Promise<SandboxInfo> {
    if (closing) return Promise.reject(new Error("the Modal cloud is closing: no new box"));
    return makeBox(ref, envId);
  }

  async function makeBox(ref: RunRef, envId: string): Promise<SandboxInfo> {
    const t0 = Date.now();
    const cls = classOf(envId);
    const name = sandboxName(prefix, ref.id, t0);
    const body = { name, snapshot: "image", labels: { [LABEL_FLEET]: fleet, [LABEL_RUN]: ref.id }, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: cls.ttlMinutes };
    const timeoutMs = cls.env.id === gpuEnv?.id ? (options.gpu?.placementTimeoutMs ?? 180_000) : 0;
    const creating = cls.client.create(body);
    creates.add(creating);
    const landed = () => void creates.delete(creating);
    creating.then(landed, landed);
    let box: SandboxInfo;
    if (timeoutMs > 0) {
      let placeTimer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([creating.then((b) => ({ b })), new Promise<{ timedOut: true }>((r) => (placeTimer = setTimeout(() => r({ timedOut: true }), timeoutMs)))]).finally(() => clearTimeout(placeTimer));
      if ("timedOut" in outcome) {
        options.log("remote.placement-timeout", { run: ref.id, name, env: cls.env.id, timeoutMs });
        void reclaimLate(name, creating);
        throw new Error(`${cls.env.label} did not place in ${Math.round(timeoutMs / 1000)} s: no capacity right now`);
      }
      box = outcome.b;
    } else box = await creating;
    // The cloud closed while this box was being created: its sweep has passed, so this one is removed here.
    if (closing) {
      await drop(box);
      throw new Error("the Modal cloud closed while this box was being made");
    }
    live.add(box.id);
    try {
      const startedMs = Date.now() - t0;
      await prepare(box, cls.client, { archil: cls.archil });
      const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
      // Its own session (setsid -f), so the end of the exec does not end it.
      const launch = [
        "setsid -f sudo -n -u pda -H env",
        `PATH=${q(`${dirname(BOX_NODE)}:/usr/local/bin:/usr/bin:/bin`)}`,
        `DEMO_ENV_LABEL=${q(cls.env.phrase)}`,
        `DEMO_ENV_CLASS=${q(cls.className)}`,
        ...(cls.cpus ? [`DEMO_ENV_CPUS=${cls.cpus}`, `DEMO_ENV_MEMORY_GB=${Math.round(cls.memoryMiB / 1024)}`] : []),
        `DEMO_ENV_NOTE=${q(cls.note)}`,
        // A GPU box trains while the agent waits on one command: its files reach the disk, and the tab, every second, not only when the call ends.
        ...(cls.liveFlushMs ? [`DEMO_LIVE_FLUSH_MS=${cls.liveFlushMs}`] : []),
        // No single command of the agent runs past this on a GPU box: a hung one fails back to the agent, which can recover.
        ...(cls.bashMaxSeconds ? [`DEMO_BASH_MAX_S=${cls.bashMaxSeconds}`] : []),
        `${BOX_NODE} ${BOX_APP_DIR}/remote-host.ts --port ${BOX_SERVE_PORT} --token-file ${BOX_ETC}/serve.token --work ${BOX_WORK}`,
        `>> ${BOX_REMOTE_LOG} 2>&1 < /dev/null`,
      ].join(" ");
      const r = await cls.client.exec(box, `install -d -o pda -g pda -m 0755 ${BOX_WORK} && install -o pda -g pda -m 0644 /dev/null ${BOX_REMOTE_LOG} && ${launch}`, 30);
      if (r.exitCode !== 0) throw new Error(`launching the remote host in ${name} failed (${r.exitCode}): ${r.result.trim().slice(0, 300)}`);
      if (cls.env.id === gpuEnv?.id && options.gpu?.startCommands?.length) await startOnBox(box, name, cls.client, options.gpu);
      options.log("remote.ready", { run: ref.id, box: name, env: cls.env.id, startedMs, ms: Date.now() - t0 });
      return box;
    } catch (error) {
      await drop(box);
      throw error;
    }
  }

  // ---- mount transport: the supervisor starts the instance in a VM that mounts the disk ---------------------------------------

  /** Start the run in a VM; with `demand` false, only replace a holder that is lost. */
  async function startMount(ref: RunRef, run: { model: ModelProxy; move: Move }, demand: boolean): Promise<boolean> {
    const linkToken = randomBytes(24).toString("base64url");
    const driver = modalHost({
      sdk,
      appName,
      image,
      runtime,
      cpu: options.cpu ?? 2,
      memoryMiB: options.memoryMiB ?? 4096,
      ...(options.regions ? { regions: options.regions } : {}),
      encryptedPorts: ports,
      fleet,
      namePrefix: prefix,
      mountRoot: BOX_MOUNT_ROOT,
      node: BOX_NODE,
      packageDir: BOX_PACKAGE,
      user: "pda",
      group: "pda",
      runArgs: [
        "--app", `${BOX_APP_DIR}/cloud-app.ts`, ...CLOUD_LEASE,
        // Every address, for the tunnel; the address it advertises is the box's own (clients use the tunnel's URL).
        "--serve", String(BOX_SERVE_PORT), "--serve-host", "0.0.0.0", "--serve-url", `http://127.0.0.1:${BOX_SERVE_PORT}`, "--serve-token-file", `${BOX_ETC}/serve.token`,
      ],
      // The box cannot reach the model: its calls come back through the server's link.
      env: {
        DEMO_MODEL: options.model.model,
        DEMO_LINK_PORT: String(BOX_LINK_PORT),
        DEMO_LINK_HOST: "0.0.0.0",
        DEMO_LINK_TOKEN: linkToken,
        DEMO_EVENTS_LOG: BOX_EVENTS,
        ...(options.robot ? { DEMO_APP_EXTRA: `${BOX_APP_DIR}/robot/vm/robot-extra.ts` } : {}),
        ...(options.desktop
          ? {
              DEMO_DISPLAY: DESKTOP_DISPLAY,
              DEMO_ENV_NOTE: `A desktop runs here (1280x720, display ${DESKTOP_DISPLAY}, a window manager) and Chromium is installed: use your computer tool to see and drive it. Start GUI programs from bash detached, on the display: setsid -f env DISPLAY=${DESKTOP_DISPLAY} chromium URL.`,
            }
          : {}),
        ...moveEnv(env, run.move, "modal-vm"),
      },
      stopTimeoutMs: 15_000,
      ttlMinutes: 120,
      startTimeoutMs: 600_000,
      prepare: (box, c) => prepare(box, c, { desktop: options.desktop }),
    });
    const started = Date.now();
    const result = await ensureRunning(ref, driver, { control, demand, tokenPrefix: "pda-demo-", leaseExpiryMs: 10_000, startGraceMs: 60_000 });
    if (result.action !== "started") {
      if (demand) throw new Error(`the supervisor did not start the run: ${result.action}`);
      return false;
    }
    options.log("cloud.ensure", { run: ref.id, action: result.action, reason: result.reason, revoked: result.revoked.length, startMs: result.startMs, ms: Date.now() - started, box: result.handle.name });
    options.ledger?.open("token-user", result.token.identifier, result.token.nickname);
    const box = String(result.handle.sandboxId);
    live.add(box);
    const tunnels = await tunnelsOf(box);
    const linkTunnel = tunnels[BOX_LINK_PORT];
    const serveTunnel = tunnels[BOX_SERVE_PORT];
    const desktopTunnel = options.desktop ? tunnels[DESKTOP_PORT] : undefined;
    const vnc = vncPasswords.get(box);
    if (!linkTunnel || !serveTunnel) throw new Error(`${result.handle.name} has no tunnels for ports ${BOX_SERVE_PORT} and ${BOX_LINK_PORT}`);
    const dialer = dialLink({ url: linkTunnel.url.replace(/^http/, "ws"), token: linkToken, proxy: run.model,
      // The agent in the VM asked to move (switch_environment): the server runs the handover.
      onSwitch: (to, reason) => (server ? server.requestSwitch(ref, to, reason) : Promise.reject(new Error("the server cannot move agents"))),
      onSwitched: (switchId) => server?.switched(ref, switchId),
      ...(gpuServer ? { gpu: gpuServer } : {}),
      log: (e, d) => options.log(e, { run: ref.id, ...d }),
    });
    const previous = placed.get(ref.id);
    placed.set(ref.id, { driver, dialer, serve: { url: serveTunnel.url.replace(/\/+$/, ""), token: serveTokens.get(box) ?? "" }, handle: result.handle, token: result.token.identifier, box, ...(desktopTunnel && vnc ? { desktop: { url: novncUrl(desktopTunnel.url, vnc) } } : {}) });
    if (desktopTunnel) options.log("desktop.url", { run: ref.id, base: desktopTunnel.url });
    if (previous) await retire(ref, previous, "now");
    return true;
  }

  /** Wait for a fenced instance to exit by itself (when asked), keep its event lines, delete its sandbox. */
  async function retire(ref: RunRef, at: Placed, how: "fenced" | "now"): Promise<void> {
    const started = Date.now();
    let status = await at.driver.status(at.handle).catch(() => "unknown" as const);
    while (how === "fenced" && status === "running" && Date.now() - started < 15_000) {
      await new Promise((r) => setTimeout(r, 500));
      status = await at.driver.status(at.handle).catch(() => "unknown" as const);
    }
    options.log("cloud.exited", { run: ref.id, how, status, ms: Date.now() - started, box: at.handle.name });
    if (options.eventsLog) {
      const r = await client.exec({ id: at.box, name: String(at.handle.name) }, `cat ${BOX_EVENTS} 2>/dev/null; true`, 30).catch(() => null);
      if (r?.result) writeFileSync(options.eventsLog, r.result.endsWith("\n") ? r.result : `${r.result}\n`, { flag: "a" });
    }
    at.dialer.close();
    let stopped = true;
    await at.driver.stop(at.handle).catch((error: Error) => {
      stopped = false;
      options.log("cloud.stop-failed", { run: ref.id, error: error.message });
    });
    // A VM whose stop failed may still be running: delete its sandbox directly, and if that fails too keep it in `live` (and its ledger entry)
    // so that close() tries again. It is forgotten only once it is gone.
    if (stopped) {
      options.ledger?.close("modal-sandbox", at.box, "stopped");
      live.delete(at.box);
      serveTokens.delete(at.box);
    } else await drop({ id: at.box, name: String(at.handle.name) });
    await dropToken(ref.id, at.token);
    options.log("cloud.stopped", { run: ref.id, ms: Date.now() - started });
  }

  const host: ModalCloud = {
    hostLabel: "a Modal VM",
    // The VM's instance tells the server over its link when its agent's notice is committed, so the move is timed to that moment.
    notifiesSwitched: true,
    ...(options.rewarm && options.warm ? { rewarm: true as const } : {}),
    ...(pool && gpuServer ? { cluster: { status: () => pool.status(), start: startCluster, gpu: gpuServer } } : {}),
    environments: [...(options.offerVm === false && gpuEnv ? [] : [env]), ...(gpuEnv ? [gpuEnv] : [])] as readonly Environment[],

    bind(api) {
      server = api;
    },

    /** The picture of the run's desktop now, for the server's live view (undefined without a desktop). */
    async desktopFrame(ref) {
      return host.desktop(ref)?.screenshot();
    },

    /** The run's desktop while a VM with one runs it: the noVNC address (it carries the VNC password) and a screenshot of it. */
    desktop(ref: RunRef): { url: string; screenshot(): Promise<Uint8Array> } | undefined {
      const at = placed.get(ref.id);
      if (!at?.desktop) return undefined;
      return {
        url: at.desktop.url,
        async screenshot() {
          const r = await client.exec({ id: at.box, name: String(at.handle.name) }, `${SCREENSHOT_COMMAND} | base64 -w0`, 30);
          if (r.exitCode !== 0) throw new Error(`screenshot failed: ${r.result.trim().slice(-200)}`);
          return Buffer.from(r.result.trim(), "base64");
        },
      };
    },

    async start(ref, run) {
      if (transport !== "mount") throw new Error("a Modal environment on the pipe is started by a switch (startRemote), not by a lost tab");
      models.set(ref.id, run.model);
      await startMount(ref, run, true);
      running.add(ref.id);
      return { host: "a Modal VM" };
    },

    /** One supervisor tick: a VM that died (orphaned) or froze (lease expired) is replaced. */
    async supervise(ref) {
      const model = models.get(ref.id);
      if (transport !== "mount" || !model || !running.has(ref.id)) return undefined;
      const move: Move = { id: `sw-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, from: env.phrase, planned: false };
      if (!(await startMount(ref, { model, move }, false))) return undefined;
      options.log("cloud.replaced", { run: ref.id, host: "a Modal VM" });
      return { host: "a Modal VM" };
    },

    /** Power off the VM that runs the run (SIGKILL of the whole sandbox). */
    async kill(ref) {
      const at = placed.get(ref.id);
      const box = at?.box ?? remotes.get(ref.id)?.id;
      if (!box) return;
      await client.stop(box, true);
      options.log("cloud.killed", { run: ref.id, box });
    },

    attachViewer: (ref, send) =>
      relayViewer({ control, ref, send, log: options.log, label: () => "a Modal VM", env: () => env.id, dialer: () => placed.get(ref.id)?.dialer, serve: () => placed.get(ref.id)?.serve }),

    async submit(ref, text, requestId) {
      const serve = placed.get(ref.id)?.serve;
      if (!serve) throw new Error("the VM serves nothing yet");
      const res = await fetch(`${serve.url}/submit`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serve.token}` }, body: JSON.stringify({ requestId, content: text }), signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`submit: ${res.status}`);
    },

    async stop(ref, how = "now") {
      running.delete(ref.id);
      const at = placed.get(ref.id);
      if (!at) return;
      placed.delete(ref.id);
      await retire(ref, at, how);
    },

    /** The tab's drawing landed: with a warm GPU box and the trainer's compile-only lines, compile the creature's program there ahead of the agent. */
    onTabWrite(ref, path, data) {
      const commands = options.gpu?.warmCommands;
      if (options.warm !== "gpu" || !commands || !gpuClient || !gpuEnv) return;
      let warmer = warmers.get(ref.id);
      if (!warmer) {
        warmer = creatureWarmer({
          delayMs: options.gpu?.warmDelayMs ?? 1_500,
          log: options.log,
          // A newer drawing supersedes the compile in flight: kill it on the box (only warm-ups use --compile-only; the pattern's bracket keeps it from matching its own shell).
          cancel: async () => {
            const pending = warm.get(ref.id);
            if (!pending) return;
            const info = await pending;
            await gpuClient.exec(info, "pkill -f -- '[-]-compile-only'; true", 15);
          },
          warm: async (creature) => {
            const pending = warm.get(ref.id);
            if (!pending) throw new Error("no warm GPU box for this run");
            const info = await pending;
            let trainer = trainers.get(info.id);
            if (!trainer) {
              trainer = warmTrain({ exec: (cmd, sec) => gpuClient.exec(info, cmd, sec), upload: (p, bytes) => gpuClient.upload(info, p, bytes) }, { commands, ...(options.gpu?.warmEnv ? { env: options.gpu.warmEnv } : {}), log: options.log });
              trainers.set(info.id, trainer);
            }
            const report = await trainer.warm(creature);
            options.log("warm.report", { run: ref.id, box: info.name, creature: report.creature, ms: report.ms });
          },
        });
        warmers.set(ref.id, warmer);
      }
      warmer.write(path, data);
    },

    /** While a tab runs the run, with `warm` set (pipe transport): get a VM ready, so a switch only dials it. */
    prewarm(ref) {
      // The robot cluster warms with the first page that takes the run (its boxes cost by the minute from then on).
      if (options.cluster?.start !== "now" && !closing) void startCluster();
      const warmEnv = options.warm === "gpu" ? gpuEnv : options.warm && transport === "pipe" ? env : undefined;
      if (closing || !warmEnv || warm.has(ref.id) || remotes.has(ref.id)) return;
      const ready = remoteBox(ref, warmEnv.id);
      ready.catch((error: Error) => {
        warm.delete(ref.id);
        options.log("remote.warm-failed", { run: ref.id, error: error.message });
      });
      warm.set(ref.id, ready);
    },

    /** Take the warm sandbox (or make one), dial its host through the tunnel with its bearer token, and send it `invite`. */
    async startRemote(ref, envId, invite, signal) {
      const t0 = Date.now();
      // The warm box belongs to the environment `warm` named: a switch anywhere else leaves it where it is.
      const warmEnvId = options.warm === "gpu" ? gpuEnv?.id : env.id;
      const warmBox = envId === warmEnvId ? warm.get(ref.id) : undefined;
      if (envId === warmEnvId) warm.delete(ref.id);
      const box = (warmBox && (await warmBox.catch(() => undefined))) || (await remoteBox(ref, envId));
      // The server stopped waiting while the box was being made: nothing is left running for a move that already failed.
      const cancelled = () => new Error(`the start of ${box.name} was cancelled: the server stopped waiting for it`);
      if (signal?.aborted) {
        await drop(box);
        throw cancelled();
      }
      remotes.set(ref.id, box);
      let socket: WebSocket | undefined;
      try {
        const tunnel = (await tunnelsOf(box.id))[BOX_SERVE_PORT];
        if (!tunnel) throw new Error(`${box.name} has no tunnel for port ${BOX_SERVE_PORT}`);
        const url = tunnel.url.replace(/^http/, "ws");
        const token = serveTokens.get(box.id)!;
        for (let attempt = 0; !socket; attempt++) {
          if (signal?.aborted) throw cancelled();
          socket = await new Promise<WebSocket | undefined>((resolve) => {
            const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, maxPayload: 64 * 1024 * 1024 });
            ws.once("open", () => resolve(ws));
            ws.once("error", () => resolve(undefined));
          });
          if (!socket) {
            if (attempt >= 60) throw new Error(`the remote host in ${box.name} did not answer`);
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        if (signal?.aborted) throw cancelled();
        socket.send(JSON.stringify(invite));
      } catch (error) {
        socket?.close();
        // A start that was given up on (or failed) leaves no box charging; the server's own stopRemote finds nothing to remove.
        if (remotes.get(ref.id) === box) remotes.delete(ref.id);
        await drop(box);
        throw error;
      }
      options.log("remote.dialed", { run: ref.id, box: box.name, warm: Boolean(warmBox), ms: Date.now() - t0 });
      return { socket, host: classOf(envId).env.phrase };
    },

    /** Delete the run's pipe sandbox, keeping its host's log lines. */
    async stopRemote(ref) {
      const box = remotes.get(ref.id);
      if (!box) return;
      remotes.delete(ref.id);
      if (options.eventsLog) {
        const r = await client.exec(box, `cat ${BOX_REMOTE_LOG} 2>/dev/null; true`, 30).catch(() => null);
        if (r?.result) writeFileSync(options.eventsLog, r.result.endsWith("\n") ? r.result : `${r.result}\n`, { flag: "a" });
      }
      await drop(box);
    },

    /** Stop what runs and delete every sandbox this cloud made and still holds (warm ones, a crashed start's). */
    async close() {
      closing = true;
      const poolClosing = pool?.close();
      for (const w of warmers.values()) w.close();
      warmers.clear();
      trainers.clear();
      // Every step runs although an earlier one failed: a sandbox left behind costs by the minute.
      const failures: string[] = [];
      const attempt = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (error) {
          failures.push(`${what}: ${(error as Error).message}`);
        }
      };
      for (const id of [...running]) await attempt(`stop ${id}`, () => host.stop({ disk: options.disk, region: options.region, id }, "now"));
      for (const id of [...placed.keys()]) await attempt(`stop ${id}`, () => host.stop({ disk: options.disk, region: options.region, id }, "now"));
      // A box whose create is still in flight lands, finds the cloud closing and removes itself; wait for that (bounded) before the sweep below.
      // (A box past its create is in `live` and is swept; its own steps then fail on the removed sandbox and it cleans up after itself.)
      if (creates.size > 0) {
        const waitMs = options.closeWaitMs ?? 60_000;
        let timer: NodeJS.Timeout | undefined;
        const settled = await Promise.race([Promise.allSettled([...creates]).then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), waitMs)))]);
        clearTimeout(timer);
        if (!settled) failures.push(`${creates.size} sandbox create(s) still in flight after ${Math.round(waitMs / 1000)} s (they expire by themselves at their lifetime)`);
      }
      // A removal that failed is tried again: Modal's errors are mostly transient, and what is left running is billed.
      for (let round = 0; round < 3 && live.size > 0; round++) {
        for (const id of [...live]) {
          await attempt(`drop ${id}`, async () => {
            if (!(await drop({ id, name: id }))) throw new Error(`${id} was not removed`);
          });
        }
        if (live.size > 0) await new Promise((r) => setTimeout(r, 500));
      }
      remotes.clear();
      warm.clear();
      if (poolClosing) {
        const { left } = await poolClosing;
        if (left > 0) failures.push(`${left} cluster box(es) could not be removed`);
      }
      if (failures.length > 0) options.log("close.failures", { failures, left: live.size });
    },
  };
  return host;
}
