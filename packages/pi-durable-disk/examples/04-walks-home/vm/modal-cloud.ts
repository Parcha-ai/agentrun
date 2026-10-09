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
import { appBundle, boxSetupScript, prepareScript, BOX_APP_DIR, BOX_LINK_PORT, BOX_MOUNT_ROOT, BOX_NODE, BOX_PACKAGE, BOX_SERVE_PORT } from "../../03-tab-to-cloud/pipe/daytona.ts";
import { CLOUD_LEASE, moveEnv, relayViewer } from "../../03-tab-to-cloud/pipe/cloud.ts";
import { archilControl, type DemoControl } from "../../03-tab-to-cloud/pipe/control.ts";
import { dialLink, type LinkDialer } from "../../03-tab-to-cloud/pipe/link.ts";
import type { ModelOptions, ModelProxy } from "../../03-tab-to-cloud/pipe/model-proxy.ts";
import type { CloudHost, Invite } from "../../03-tab-to-cloud/pipe/server.ts";
import type { Environment, Move } from "../../03-tab-to-cloud/wire.ts";
import { vmImageCommands } from "./image.ts";

const BOX_ETC = "/etc/pda-demo";
const BOX_REMOTE_LOG = "/var/tmp/pda-remote.log";
const BOX_EVENTS = "/var/tmp/pda-demo-events.log";
const STAGE = "/tmp/pda-demo-stage";

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
  /** Keep one VM ready for a run while a tab runs it (it costs while it waits). Pipe transport only. Default off. */
  readonly warm?: boolean;
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

interface Placed {
  driver: HostDriver;
  dialer: LinkDialer;
  serve: { url: string; token: string };
  handle: HostHandle;
  token: string;
  box: string;
}

export async function modalCloud(options: ModalCloudOptions): Promise<CloudHost & { hostLabel: string }> {
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
  const image = options.image ?? (() => (base.images.fromRegistry("ubuntu:24.04") as unknown as { dockerfileCommands(c: string[]): unknown }).dockerfileCommands(vmImageCommands(uid, gid)));
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
  const ports = [BOX_SERVE_PORT, BOX_LINK_PORT];
  const client: DaytonaClient = modalSandboxes(sdk, { appName, image, runtime, cpu: options.cpu ?? 2, memoryMiB: options.memoryMiB ?? 4096, encryptedPorts: ports });
  let bundle: Uint8Array | undefined;
  const remotes = new Map<string, SandboxInfo>();
  const warm = new Map<string, Promise<SandboxInfo>>();
  const serveTokens = new Map<string, string>();
  const live = new Set<string>();
  const placed = new Map<string, Placed>();
  const models = new Map<string, ModelProxy>();
  const running = new Set<string>();

  async function drop(box: { id: string; name: string }): Promise<void> {
    await client.remove(box.id).then(
      () => void options.ledger?.close("modal-sandbox", box.id, "deleted"),
      (error: Error) => options.log("modal.delete-failed", { box: box.name, error: error.message }),
    );
    live.delete(box.id);
    serveTokens.delete(box.id);
  }

  /** The app bundle and this box's serve token: once per box (the image holds the runtime and the app's dependencies). */
  async function prepare(box: SandboxInfo, c: DaytonaClient = client): Promise<void> {
    const started = Date.now();
    live.add(box.id);
    bundle ??= appBundle();
    await c.upload(box, "/tmp/pda-demo-app.tar.gz", bundle);
    const r = await c.exec(box, prepareScript(uid, gid), 900);
    if (r.exitCode !== 0) throw new Error(`preparing ${box.name} failed (${r.exitCode}): ${r.result.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    const mk = await c.exec(box, `umask 077 && mkdir -p ${STAGE} && chmod 700 ${STAGE}`, 30);
    if (mk.exitCode !== 0) throw new Error(`staging in ${box.name} failed: ${mk.result.trim().slice(0, 200)}`);
    const token = randomBytes(24).toString("base64url");
    await c.upload(box, `${STAGE}/serve.token`, new TextEncoder().encode(`${token}\n`));
    const setup = await c.exec(box, boxSetupScript(STAGE), 60);
    if (setup.exitCode !== 0) throw new Error(`setting up ${box.name} failed (${setup.exitCode}): ${setup.result.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
    serveTokens.set(box.id, token);
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

  /** A VM sandbox for `ref`, set up, with remote-host.ts listening as the run user. */
  async function remoteBox(ref: RunRef): Promise<SandboxInfo> {
    const t0 = Date.now();
    const name = sandboxName(prefix, ref.id, t0);
    const box = await client.create({ name, snapshot: "image", labels: { [LABEL_FLEET]: fleet, [LABEL_RUN]: ref.id }, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 120 });
    live.add(box.id);
    try {
      const startedMs = Date.now() - t0;
      await prepare(box);
      const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
      // Its own session (setsid -f), so the end of the exec does not end it.
      const launch = [
        "setsid -f sudo -n -u pda -H env",
        `PATH=${q(`${dirname(BOX_NODE)}:/usr/local/bin:/usr/bin:/bin`)}`,
        `DEMO_ENV_LABEL=${q(env.phrase)}`,
        `DEMO_ENV_CLASS=${q("modal-vm")}`,
        `DEMO_ENV_NOTE=${q("The run's disk is not mounted here: your conversation and workspace reach this machine through your user's server.")}`,
        `${BOX_NODE} ${BOX_APP_DIR}/remote-host.ts --port ${BOX_SERVE_PORT} --token-file ${BOX_ETC}/serve.token --work /home/pda/work`,
        `>> ${BOX_REMOTE_LOG} 2>&1 < /dev/null`,
      ].join(" ");
      const r = await client.exec(box, `install -o pda -g pda -m 0644 /dev/null ${BOX_REMOTE_LOG} && ${launch}`, 30);
      if (r.exitCode !== 0) throw new Error(`launching the remote host in ${name} failed (${r.exitCode}): ${r.result.trim().slice(0, 300)}`);
      options.log("remote.ready", { run: ref.id, box: name, startedMs, ms: Date.now() - t0 });
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
      env: { DEMO_MODEL: options.model.model, DEMO_LINK_PORT: String(BOX_LINK_PORT), DEMO_LINK_HOST: "0.0.0.0", DEMO_LINK_TOKEN: linkToken, DEMO_EVENTS_LOG: BOX_EVENTS, ...moveEnv(env, run.move, "modal-vm") },
      stopTimeoutMs: 15_000,
      ttlMinutes: 120,
      startTimeoutMs: 600_000,
      prepare: (box, c) => prepare(box, c),
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
    if (!linkTunnel || !serveTunnel) throw new Error(`${result.handle.name} has no tunnels for ports ${BOX_SERVE_PORT} and ${BOX_LINK_PORT}`);
    const dialer = dialLink({ url: linkTunnel.url.replace(/^http/, "ws"), token: linkToken, proxy: run.model, log: (e, d) => options.log(e, { run: ref.id, ...d }) });
    const previous = placed.get(ref.id);
    placed.set(ref.id, { driver, dialer, serve: { url: serveTunnel.url.replace(/\/+$/, ""), token: serveTokens.get(box) ?? "" }, handle: result.handle, token: result.token.identifier, box });
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

  const host: CloudHost & { hostLabel: string } = {
    hostLabel: "a Modal VM",
    environments: [env] as readonly Environment[],

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

    /** While a tab runs the run, with `warm` set (pipe transport): get a VM ready, so a switch only dials it. */
    prewarm(ref) {
      if (transport !== "pipe" || !options.warm || warm.has(ref.id) || remotes.has(ref.id)) return;
      const ready = remoteBox(ref);
      ready.catch((error: Error) => {
        warm.delete(ref.id);
        options.log("remote.warm-failed", { run: ref.id, error: error.message });
      });
      warm.set(ref.id, ready);
    },

    /** Take the warm sandbox (or make one), dial its host through the tunnel with its bearer token, and send it `invite`. */
    async startRemote(ref, _env, invite) {
      const t0 = Date.now();
      const warmBox = warm.get(ref.id);
      warm.delete(ref.id);
      const box = (warmBox && (await warmBox.catch(() => undefined))) || (await remoteBox(ref));
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
      return { socket, host: "a Modal VM" };
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
