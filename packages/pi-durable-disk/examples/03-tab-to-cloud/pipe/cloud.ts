// Where a run goes when its tab is gone: a host that mounts the disk and runs the same agent (`cloud-app.ts`) through
// the package's CLI, started by the package's supervisor (`ensureRunning` with a host driver). While it runs there,
// viewers get its agent events from its serve front and its files from the disk (S3 API, after its barriers).
//   "local": a systemd unit on this machine with its own FUSE client (a second machine as far as Archil can tell).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRunning, localHost, readRunStatus, removeMountToken } from "@parcha/pi-durable-disk";
import type { HostDriver, HostHandle, RunRef } from "@parcha/pi-durable-disk";
import { archilControl, type DemoControl } from "./control.ts";
import type { CloudHost } from "./server.ts";
import type { ModelOptions, ModelProxy } from "./model-proxy.ts";
import { dialLink, type LinkDialer } from "./link.ts";
import { tag, toBase64, type Environment, type FileEntry, type Move, type PipeFrame } from "../wire.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const CLOUD_APP = join(here, "..", "cloud-app.ts");
/** The lease every cloud instance runs with: short, so a frozen host is replaced in seconds. */
export const CLOUD_LEASE = ["--heartbeat-ms", "2000", "--lease-expiry-ms", "10000", "--lease-margin-ms", "3000"];

type Log = (event: string, data?: Record<string, unknown>) => void;
type LedgerLike = { open(kind: string, id: string, note?: string): void; close(kind: string, id: string, note?: string): void };

/** What an instance needs to admit the notice of `move` into `env` (cloud-app.ts reads it). */
export function moveEnv(env: Environment, move: Move, hostClass?: string): Record<string, string> {
  return {
    DEMO_SWITCH_ID: move.id,
    DEMO_SWITCH_FROM: move.from,
    DEMO_SWITCH_PLANNED: move.planned ? "1" : "0",
    DEMO_ENV_LABEL: env.phrase,
    ...(hostClass ? { DEMO_ENV_CLASS: hostClass } : {}),
  };
}

/** The port a cloud instance listens on for the server's link (cloud-link.ts). */
export const LINK_PORT = 8795;

export interface CloudOptions {
  /** Send the cloud's model calls through a link the server dials (for hosts that cannot reach the model endpoint). */
  readonly link?: boolean;
  /** Where link tokens are written for a local host (a 0700 directory of the instance's user). */
  readonly linkDir?: string;
  /** Passed to every instance as DEMO_EVENTS_LOG (see cloud-app.ts). */
  readonly eventsLog?: string;
  readonly disk: string;
  readonly region: string;
  readonly model: ModelOptions;
  readonly log: Log;
  readonly ledger?: LedgerLike;
  readonly control?: DemoControl;
  /** Daytona: the runtime snapshot boxes start from (scripts/daytona-snapshot.ts builds it). */
  readonly snapshot?: string;
  /** Daytona: the secret holding the model endpoint's key, for a box that calls the model itself. */
  readonly modelSecret?: string;
  /** Daytona: the runtime snapshot of the GPU class; without it there is no GPU environment. */
  readonly gpuSnapshot?: string;
  /** Daytona: keep a GPU sandbox ready while a tab runs the run, so a switch there takes seconds (it costs while it waits). */
  readonly warmGpu?: boolean;
}

interface Placed {
  machine?: string;
  driver: HostDriver;
  dialer?: LinkDialer;
  linkFile?: string;
  handle: HostHandle;
  token: string;
  host: string;
  startedAt: number;
}

/** Server-sent events from `url`, as (event, data) pairs, until `signal` aborts or the stream ends. */
async function sse(url: string, signal: AbortSignal, onEvent: (event: string, data: string) => void, token?: string): Promise<void> {
  const response = await fetch(url, { signal, headers: { accept: "text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok || !response.body) throw new Error(`${url}: ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      onEvent(event, data.join("\n"));
    }
  }
}

/**
 * What a page sees of a run while a cloud host runs it: the placement with the host's generation (from run.json over
 * S3), the run's agent events (over the host's link, or from its serve front), and work/ as the disk has it (S3).
 */
export async function relayViewer(opts: {
  control: DemoControl;
  ref: RunRef;
  send: (frame: PipeFrame) => void;
  log: Log;
  label: () => string;
  /** The environment id the run is in, for the placement. */
  env: () => string;
  /** How this server reaches the instance's serve front, when not at the address run.json carries. */
  serve?: () => { url: string; token: string } | undefined;
  dialer: () => LinkDialer | undefined;
}): Promise<() => void> {
  const { control, ref, send } = opts;
  const abort = new AbortController();
  void (async () => {
    let generation = 0;
    let lastFiles = "";
    let streaming: AbortController | undefined;
    while (!abort.signal.aborted) {
      try {
        const record = await readRunStatus(control, ref.id);
        const via = opts.serve?.();
        const serve = via?.url ?? (typeof record?.holder?.serve === "string" ? record.holder.serve : undefined);
        const dialer = opts.dialer();
        if (record && record.generation !== generation && record.status === "running" && (serve || dialer)) {
          generation = record.generation;
          send({ t: "placement", placement: { where: "cloud", host: opts.label(), generation, env: opts.env() } });
          streaming?.abort();
          const stream = (streaming = new AbortController());
          abort.signal.addEventListener("abort", () => stream.abort(), { once: true });
          if (dialer) {
            const off = dialer.subscribe((e) => send({ t: "event", event: tag(e.kind === "snapshot" ? { kind: "snapshot", event: e.data } : { kind: "events", events: e.data }) }));
            stream.signal.addEventListener("abort", off, { once: true });
          } else {
            void sse(
              `${serve}/events`,
              stream.signal,
              (event, data) => {
                if (event === "snapshot") send({ t: "event", event: tag({ kind: "snapshot", event: JSON.parse(data) }) });
                else if (event === "events") send({ t: "event", event: tag({ kind: "events", events: JSON.parse(data) }) });
              },
              via?.token,
            ).catch((error) => opts.log("cloud.events-ended", { run: ref.id, error: (error as Error).message }));
          }
        }
        const listing = await control.listObjects(`runs/${ref.id}/work/`, { recursive: true });
        const objects = listing.objects as { key: string; size?: number; etag?: string }[];
        const signature = JSON.stringify(objects.map((o) => [o.key, o.size, o.etag]));
        if (signature !== lastFiles) {
          lastFiles = signature;
          const files: FileEntry[] = [];
          for (const o of objects) {
            const path = o.key.slice(`runs/${ref.id}/work/`.length).replace(/\/$/, "");
            if (path === "") continue;
            if (o.key.endsWith("/")) files.push({ path, kind: "directory" });
            else {
              const data = (o.size ?? 0) <= 256 * 1024 ? await control.getObject(o.key) : new Uint8Array();
              files.push({ path, kind: "file", data: toBase64(data), mode: 0o644, mtimeMs: 0 });
            }
          }
          files.sort((a, b) => (a.path < b.path ? -1 : 1));
          send({ t: "files-changed", files });
        }
      } catch (error) {
        opts.log("cloud.view-failed", { run: ref.id, error: (error as Error).message });
      }
      // Faster until the host's events stream: a viewer waits for a new host to show up.
      await new Promise((r) => setTimeout(r, streaming ? 1_500 : 400));
    }
  })();
  return () => abort.abort();
}

export async function cloudHost(kind: "local" | "daytona", options: CloudOptions): Promise<CloudHost> {
  const control = options.control ?? (await archilControl({ disk: options.disk, region: options.region, apiKey: process.env.ARCHIL_API_KEY ?? "" }));
  if (kind === "daytona") {
    const { daytonaCloud } = await import("./daytona.ts");
    const d = await daytonaCloud({
      disk: options.disk,
      region: options.region,
      model: options.model,
      control,
      log: options.log,
      ...(options.ledger ? { ledger: options.ledger } : {}),
      ...(options.eventsLog ? { eventsLog: options.eventsLog } : {}),
      ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      ...(options.modelSecret ? { modelSecret: options.modelSecret } : {}),
      ...(options.gpuSnapshot ? { gpuSnapshot: options.gpuSnapshot } : {}),
    });
    const running = new Set<string>();
    const models = new Map<string, ModelProxy>();
    const daytona: CloudHost = {
      environments: d.environments,
      async start(ref, run) {
        models.set(ref.id, run.model);
        await d.start(ref, { model: run.model, move: run.move, env: run.env }, true);
        running.add(ref.id);
        // A spare basic sandbox, warm, for when this one is lost or the run moves on.
        d.prewarm(ref);
        return { host: d.label(run.env) };
      },
      async supervise(ref) {
        const model = models.get(ref.id);
        if (!model || !running.has(ref.id)) return undefined;
        // A lost box is replaced in its own class.
        const env = d.placed(ref.id)?.env ?? d.environments[0]!.id;
        const move: Move = { id: `sw-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, from: d.environments.find((e) => e.id === env)!.phrase, planned: false };
        if (!(await d.start(ref, { model, move, env }, false))) return undefined;
        options.log("cloud.replaced", { run: ref.id, host: d.label(env) });
        d.prewarm(ref);
        return { host: d.label(env) };
      },
      kill: (ref) => d.kill(ref),
      startRemote: (ref, env, invite) => d.startRemote(ref, env, invite),
      stopRemote: (ref) => d.stopRemote(ref),
      attachViewer: (ref, send) => {
        const env = () => d.placed(ref.id)?.env ?? d.environments[0]!.id;
        return relayViewer({ control, ref, send, log: options.log, label: () => d.label(env()), env, dialer: () => undefined, serve: () => d.placed(ref.id)?.serve });
      },
      async submit(ref, text, requestId) {
        const serve = d.placed(ref.id)?.serve;
        if (!serve) throw new Error("the sandbox serves nothing yet");
        const res = await fetch(`${serve.url}/submit`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serve.token}` }, body: JSON.stringify({ requestId, content: text }), signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`submit: ${res.status}`);
      },
      async stop(ref, how) {
        running.delete(ref.id);
        await d.stop(ref, how);
      },
      prewarm(ref) {
        d.prewarm(ref);
        if (options.warmGpu) d.prewarmRemote(ref);
      },
      async close() {
        for (const id of [...running]) await daytona.stop({ disk: options.disk, region: options.region, id }, "now");
        const swept = await d.sweep();
        options.log("daytona.swept", { boxes: swept });
      },
    };
    return daytona;
  }
  // Two "machines" on this host, each its own FUSE client and mount root: a run killed on one is resumed on the other.
  const machines = [
    { name: "machine B", root: "/mnt/pda/demo/b", hostName: "demo-local-b", linkPort: LINK_PORT },
    { name: "machine C", root: "/mnt/pda/demo/c", hostName: "demo-local-c", linkPort: LINK_PORT + 1 },
  ];
  const hostLabel = "a second machine (local FUSE client)";
  const local: Environment = { id: "local", label: "Second machine", phrase: "a second machine next to your user's server", kind: "cloud", detail: "a systemd unit with its own disk client" };
  const localDriver = (machine: (typeof machines)[number], env: Record<string, string>) =>
    localHost({
      mode: "systemd",
      mountRoot: machine.root,
      unitPrefix: "pda-demo-",
      hostName: machine.hostName,
      parkThresholdMs: null,
      runArgs: ["--app", CLOUD_APP, ...CLOUD_LEASE, "--serve", "0"],
      env: { DEMO_MODEL: options.model.model, ...(options.eventsLog ? { DEMO_EVENTS_LOG: options.eventsLog } : {}), ...env },
    });
  const placed = new Map<string, Placed>();
  const models = new Map<string, ModelProxy>();

  async function dropToken(id: string, token: string): Promise<void> {
    try {
      await removeMountToken(control, token);
      options.ledger?.close("token-user", token);
    } catch (error) {
      options.log("cloud.token-remove-failed", { run: id, error: (error as Error).message });
    }
  }

  /**
   * Start (or, with `demand` false, keep) the run on `machine`; the instance gets a link of its own when asked, and
   * admits the notice of `move` before it resumes.
   */
  async function place(ref: RunRef, machine: (typeof machines)[number], demand: boolean, move: Move): Promise<boolean> {
    const started = Date.now();
    let link: { token: string; file: string } | undefined;
    if (options.link) {
      const dir = options.linkDir ?? "/tmp/pda-demo-links";
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      link = { token: randomBytes(24).toString("base64url"), file: join(dir, `${ref.id}-${machine.hostName}.token`) };
      writeFileSync(link.file, `${link.token}\n`, { mode: 0o600 });
    }
    const driver = localDriver(machine, {
      ...(link ? { DEMO_LINK_PORT: String(machine.linkPort), DEMO_LINK_TOKEN_FILE: link.file } : { DEMO_MODEL_URL: options.model.baseUrl }),
      ...moveEnv(local, move, machine.name),
    });
    const result = await ensureRunning(ref, driver, { control, demand, tokenPrefix: "pda-demo-", leaseExpiryMs: 10_000, startGraceMs: 20_000 });
    if (result.action !== "started") {
      if (link) rmSync(link.file, { force: true });
      if (demand) throw new Error(`the supervisor did not start the run: ${result.action}`);
      return false;
    }
    options.log("cloud.ensure", { run: ref.id, action: result.action, machine: machine.name, ms: Date.now() - started, reason: result.reason, startMs: result.startMs, revoked: result.revoked.length, unit: result.handle.unit ?? null });
    options.ledger?.open("token-user", result.token.identifier, result.token.nickname);
    options.ledger?.open("cloud-instance", `${ref.id}:${JSON.stringify(result.handle)}`, `${hostLabel}, ${machine.name}`);
    const previous = placed.get(ref.id);
    const model = models.get(ref.id)!;
    const dialer = link ? dialLink({ url: `ws://127.0.0.1:${machine.linkPort}/`, token: link.token, proxy: model, log: (e, d) => options.log(e, { run: ref.id, ...d }) }) : undefined;
    placed.set(ref.id, { driver, ...(dialer ? { dialer } : {}), ...(link ? { linkFile: link.file } : {}), handle: result.handle, token: result.token.identifier, host: `${hostLabel}, ${machine.name}`, startedAt: started, machine: machine.name });
    // The one this start replaced (killed or frozen): clean up what is left of it.
    if (previous) await retire(ref, previous, "now");
    return true;
  }

  async function retire(ref: RunRef, at: Placed, how: "fenced" | "now"): Promise<void> {
    const started = Date.now();
    // After a takeover the claim is already revoked: the instance's next commit or heartbeat fails and it exits 75 by
    // itself. Wait for that (the fence, observed), then let the driver clean up whatever is left.
    const driver = at.driver;
    let status = await driver.status(at.handle).catch(() => "unknown" as const);
    while (how === "fenced" && status === "running" && Date.now() - started < 15_000) {
      await new Promise((r) => setTimeout(r, 250));
      status = await driver.status(at.handle).catch(() => "unknown" as const);
    }
    const unit = typeof at.handle.unit === "string" ? at.handle.unit : undefined;
    const show = unit ? spawnSync("/usr/bin/systemctl", ["show", `${unit}.service`, "-p", "ExecMainStatus", "-p", "Result", "-p", "NRestarts"], { encoding: "utf8" }).stdout.trim().split("\n").join(" ") : null;
    options.log("cloud.exited", { run: ref.id, how, status, ms: Date.now() - started, ...(show ? { unit: show } : {}) });
    await driver.stop(at.handle).catch((error) => options.log("cloud.stop-failed", { run: ref.id, error: (error as Error).message }));
    at.dialer?.close();
    if (at.linkFile) rmSync(at.linkFile, { force: true });
    options.ledger?.close("cloud-instance", `${ref.id}:${JSON.stringify(at.handle)}`, "stopped");
    await dropToken(ref.id, at.token);
    options.log("cloud.stopped", { run: ref.id, ms: Date.now() - started });
  }

  const otherMachine = (ref: RunRef) => {
    const now = placed.get(ref.id)?.machine;
    return machines.find((m) => m.name !== now) ?? machines[0]!;
  };

  const host: CloudHost = {
    environments: [local],

    async start(ref: RunRef, run: { model: ModelProxy; env: string; move: Move }) {
      models.set(ref.id, run.model);
      await place(ref, machines[0]!, true, run.move);
      return { host: placed.get(ref.id)!.host };
    },

    /** One supervisor tick: a holder that died (orphaned) or froze (lease expired) is replaced on the other machine. */
    async supervise(ref: RunRef) {
      const at = placed.get(ref.id);
      if (!at) return undefined;
      const move: Move = { id: `sw-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, from: `${local.phrase} (${at.machine})`, planned: false };
      if (!(await place(ref, otherMachine(ref), false, move))) return undefined;
      const host = placed.get(ref.id)!.host;
      options.log("cloud.replaced", { run: ref.id, host });
      return { host };
    },

    /** Power off the machine that runs the run: its instance and its FUSE daemon die together (SIGKILL). */
    async kill(ref: RunRef) {
      const at = placed.get(ref.id);
      const unit = typeof at?.handle.unit === "string" ? at.handle.unit : undefined;
      if (!unit) return;
      const scopes = spawnSync("/usr/bin/systemctl", ["list-units", "--plain", "--no-legend", "--type=scope", `${unit}-fuse-*`], { encoding: "utf8" }).stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u): u is string => Boolean(u));
      for (const u of [`${unit}.service`, ...scopes]) spawnSync("sudo", ["-n", "/usr/bin/systemctl", "kill", "-s", "SIGKILL", u]);
      // A machine without power does not restart its service in place: stop the unit before its restart delay ends.
      spawnSync("sudo", ["-n", "/usr/bin/systemctl", "stop", `${unit}.service`]);
      options.log("cloud.killed", { run: ref.id, units: 1 + scopes.length });
    },

    attachViewer: (ref: RunRef, send: (frame: PipeFrame) => void) => relayViewer({ control, ref, send, log: options.log, label: () => placed.get(ref.id)?.host ?? hostLabel, env: () => local.id, dialer: () => placed.get(ref.id)?.dialer }),

    async submit(ref: RunRef, text: string, requestId: string) {
      const record = await readRunStatus(control, ref.id);
      const serve = typeof record?.holder?.serve === "string" ? record.holder.serve : undefined;
      if (!serve) throw new Error("the cloud instance has no serve address yet");
      await fetch(`${serve}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, content: text }) });
    },

    async stop(ref: RunRef, how: "fenced" | "now" = "now") {
      const at = placed.get(ref.id);
      if (!at) return;
      placed.delete(ref.id);
      await retire(ref, at, how);
    },

    async close() {
      for (const id of [...placed.keys()]) await host.stop({ disk: options.disk, region: options.region, id }, "now");
    },
  };
  return host;
}
