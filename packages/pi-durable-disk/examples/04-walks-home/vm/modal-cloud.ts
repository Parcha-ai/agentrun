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
import { vmImageCommands } from "./image.ts";

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
    /** How long the creature's files stay unchanged before the warm-up starts. Default 1.5 s (the tab has already waited 1.5 s after the pen rested). */
    readonly warmDelayMs?: number;
  };
  /**
   * Keep one box ready for a run while a tab runs it (it costs while it waits): `true` a pipe VM, `"gpu"` the GPU box
   * (the take opens the tab right before the user draws, so the machine is up by the time the agent asks for it). Default off.
   */
  readonly warm?: boolean | "gpu";
  /** Offer the VM environment (default true). Without it the only place the agent can go is the GPU box; needs `gpu`. */
  readonly offerVm?: boolean;
  /** Where each stopped host's log lines are appended (the demo's evidence file). */
  readonly eventsLog?: string;
  /** The Modal SDK; default the `modal` package's client. */
  readonly sdk?: FullSdk;
}

export const modalVmEnvironment = (transport: "mount" | "pipe"): Environment => ({
  id: "modal-vm",
  label: "Modal VM",
  phrase: "a Modal VM",
  kind: transport === "mount" ? "cloud" : "remote",
  detail: "2 vCPU, 4 GiB, its own Linux kernel",
});

export const modalGpuEnvironment = (type: string): Environment => ({
  id: "modal-gpu",
  label: "Modal GPU",
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
export type ModalCloud = CloudHost & { hostLabel: string; desktop(ref: RunRef): { url: string; screenshot(): Promise<Uint8Array> } | undefined };

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
    ? modalSandboxes(sdk, { appName, image: options.gpu.image, runtime: "gvisor", gpu: gpuType, cpu: options.gpu.cpu ?? 4, memoryMiB: options.gpu.memoryMiB ?? 16384, ...(options.regions ? { regions: options.regions } : {}), encryptedPorts: [BOX_SERVE_PORT] })
    : undefined;
  /** What a pipe host of each environment is made of. */
  const classOf = (envId: string) =>
    envId === gpuEnv?.id && gpuClient && options.gpu
      ? { env: gpuEnv, client: gpuClient, archil: false, cpus: options.gpu.cpu ?? 4, memoryMiB: options.gpu.memoryMiB ?? 16384, ttlMinutes: options.gpu.ttlMinutes ?? 45, className: "modal-gpu", liveFlushMs: 1000, note: `The run's disk is not mounted here: your conversation and workspace reach this machine through your user's server. ${options.gpu.note ?? ""}`.trim() }
      : { env, client, archil: true, cpus: 0, memoryMiB: 0, ttlMinutes: 120, className: "modal-vm", liveFlushMs: 0, note: "The run's disk is not mounted here: your conversation and workspace reach this machine through your user's server." };
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
  let server: ServerApi | undefined;

  async function drop(box: { id: string; name: string }): Promise<void> {
    await client.remove(box.id).then(
      () => void options.ledger?.close("modal-sandbox", box.id, "deleted"),
      (error: Error) => options.log("modal.delete-failed", { box: box.name, error: error.message }),
    );
    live.delete(box.id);
    serveTokens.delete(box.id);
  }

  /** The app bundle and this box's serve token: once per box (the image holds the runtime and the app's dependencies). */
  async function prepare(box: SandboxInfo, c: DaytonaClient = client, host: { archil?: boolean; desktop?: boolean } = {}): Promise<void> {
    const started = Date.now();
    live.add(box.id);
    bundle ??= appBundle();
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
  async function remoteBox(ref: RunRef, envId: string): Promise<SandboxInfo> {
    const t0 = Date.now();
    const cls = classOf(envId);
    const name = sandboxName(prefix, ref.id, t0);
    const body = { name, snapshot: "image", labels: { [LABEL_FLEET]: fleet, [LABEL_RUN]: ref.id }, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: cls.ttlMinutes };
    const timeoutMs = cls.env.id === gpuEnv?.id ? (options.gpu?.placementTimeoutMs ?? 180_000) : 0;
    const creating = cls.client.create(body);
    let box: SandboxInfo;
    if (timeoutMs > 0) {
      const outcome = await Promise.race([creating.then((b) => ({ b })), new Promise<{ timedOut: true }>((r) => setTimeout(() => r({ timedOut: true }), timeoutMs))]);
      if ("timedOut" in outcome) {
        options.log("remote.placement-timeout", { run: ref.id, name, env: cls.env.id, timeoutMs });
        void reclaimLate(name, creating);
        throw new Error(`${cls.env.label} did not place in ${Math.round(timeoutMs / 1000)} s: no capacity right now`);
      }
      box = outcome.b;
    } else box = await creating;
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
        `${BOX_NODE} ${BOX_APP_DIR}/remote-host.ts --port ${BOX_SERVE_PORT} --token-file ${BOX_ETC}/serve.token --work ${BOX_WORK}`,
        `>> ${BOX_REMOTE_LOG} 2>&1 < /dev/null`,
      ].join(" ");
      const r = await cls.client.exec(box, `install -d -o pda -g pda -m 0755 ${BOX_WORK} && install -o pda -g pda -m 0644 /dev/null ${BOX_REMOTE_LOG} && ${launch}`, 30);
      if (r.exitCode !== 0) throw new Error(`launching the remote host in ${name} failed (${r.exitCode}): ${r.result.trim().slice(0, 300)}`);
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
    await at.driver.stop(at.handle).catch((error: Error) => options.log("cloud.stop-failed", { run: ref.id, error: error.message }));
    options.ledger?.close("modal-sandbox", at.box, "stopped");
    live.delete(at.box);
    serveTokens.delete(at.box);
    await dropToken(ref.id, at.token);
    options.log("cloud.stopped", { run: ref.id, ms: Date.now() - started });
  }

  const host: ModalCloud = {
    hostLabel: "a Modal VM",
    // The VM's instance tells the server over its link when its agent's notice is committed, so the move is timed to that moment.
    notifiesSwitched: true,
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
      const warmEnv = options.warm === "gpu" ? gpuEnv : options.warm && transport === "pipe" ? env : undefined;
      if (!warmEnv || warm.has(ref.id) || remotes.has(ref.id)) return;
      const ready = remoteBox(ref, warmEnv.id);
      ready.catch((error: Error) => {
        warm.delete(ref.id);
        options.log("remote.warm-failed", { run: ref.id, error: error.message });
      });
      warm.set(ref.id, ready);
    },

    /** Take the warm sandbox (or make one), dial its host through the tunnel with its bearer token, and send it `invite`. */
    async startRemote(ref, envId, invite) {
      const t0 = Date.now();
      // The warm box belongs to the environment `warm` named: a switch anywhere else leaves it where it is.
      const warmEnvId = options.warm === "gpu" ? gpuEnv?.id : env.id;
      const warmBox = envId === warmEnvId ? warm.get(ref.id) : undefined;
      if (envId === warmEnvId) warm.delete(ref.id);
      const box = (warmBox && (await warmBox.catch(() => undefined))) || (await remoteBox(ref, envId));
      remotes.set(ref.id, box);
      const tunnel = (await tunnelsOf(box.id))[BOX_SERVE_PORT];
      if (!tunnel) throw new Error(`${box.name} has no tunnel for port ${BOX_SERVE_PORT}`);
      const url = tunnel.url.replace(/^http/, "ws");
      const token = serveTokens.get(box.id)!;
      let socket: WebSocket | undefined;
      for (let attempt = 0; !socket; attempt++) {
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
      socket.send(JSON.stringify(invite));
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
      for (const id of [...running]) await host.stop({ disk: options.disk, region: options.region, id }, "now");
      for (const id of [...placed.keys()]) await host.stop({ disk: options.disk, region: options.region, id }, "now");
      for (const id of [...live]) await drop({ id, name: id });
      remotes.clear();
      warm.clear();
    },
  };
  return host;
}
