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
import { tag, toBase64, type FileEntry, type PipeFrame } from "../wire.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const CLOUD_APP = join(here, "..", "cloud-app.ts");
/** The lease every cloud instance runs with: short, so a frozen host is replaced in seconds. */
export const CLOUD_LEASE = ["--heartbeat-ms", "2000", "--lease-expiry-ms", "10000", "--lease-margin-ms", "3000"];

type Log = (event: string, data?: Record<string, unknown>) => void;
type LedgerLike = { open(kind: string, id: string, note?: string): void; close(kind: string, id: string, note?: string): void };

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
}

interface Placed {
  driver: HostDriver;
  dialer?: LinkDialer;
  linkFile?: string;
  handle: HostHandle;
  token: string;
  host: string;
  startedAt: number;
}

/** Server-sent events from `url`, as (event, data) pairs, until `signal` aborts or the stream ends. */
async function sse(url: string, signal: AbortSignal, onEvent: (event: string, data: string) => void): Promise<void> {
  const response = await fetch(url, { signal, headers: { accept: "text/event-stream" } });
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
        const serve = typeof record?.holder?.serve === "string" ? record.holder.serve : undefined;
        const dialer = opts.dialer();
        if (record && record.generation !== generation && record.status === "running" && (serve || dialer)) {
          generation = record.generation;
          send({ t: "placement", placement: { where: "cloud", host: opts.label(), generation } });
          streaming?.abort();
          const stream = (streaming = new AbortController());
          abort.signal.addEventListener("abort", () => stream.abort(), { once: true });
          if (dialer) {
            const off = dialer.subscribe((e) => send({ t: "event", event: tag(e.kind === "snapshot" ? { kind: "snapshot", event: e.data } : { kind: "events", events: e.data }) }));
            stream.signal.addEventListener("abort", off, { once: true });
          } else {
            void sse(`${serve}/events`, stream.signal, (event, data) => {
              if (event === "snapshot") send({ t: "event", event: tag({ kind: "snapshot", event: JSON.parse(data) }) });
              else if (event === "events") send({ t: "event", event: tag({ kind: "events", events: JSON.parse(data) }) });
            }).catch((error) => opts.log("cloud.events-ended", { run: ref.id, error: (error as Error).message }));
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
      await new Promise((r) => setTimeout(r, 1_500));
    }
  })();
  return () => abort.abort();
}

export async function cloudHost(kind: "local" | "daytona", options: CloudOptions): Promise<CloudHost> {
  const control = options.control ?? (await archilControl({ disk: options.disk, region: options.region, apiKey: process.env.ARCHIL_API_KEY ?? "" }));
  if (kind === "daytona") {
    const { daytonaCloud } = await import("./daytona.ts");
    const d = await daytonaCloud({ disk: options.disk, region: options.region, model: options.model, control, log: options.log, ...(options.ledger ? { ledger: options.ledger } : {}), ...(options.eventsLog ? { eventsLog: options.eventsLog } : {}) });
    const running = new Set<string>();
    const daytona: CloudHost = {
      async start(ref, run) {
        const started = Date.now();
        await d.start(ref, run);
        running.add(ref.id);
        options.log("cloud.ensure", { run: ref.id, action: "started", ms: Date.now() - started });
        return { host: d.hostLabel };
      },
      attachViewer: (ref, send) => relayViewer({ control, ref, send, log: options.log, label: () => d.hostLabel, dialer: () => d.placed(ref.id)?.dialer }),
      async stop(ref, how) {
        running.delete(ref.id);
        await d.stop(ref, how);
      },
      prewarm: (ref) => d.prewarm(ref),
      async close() {
        for (const id of [...running]) await daytona.stop({ disk: options.disk, region: options.region, id }, "now");
        const swept = await d.sweep();
        options.log("daytona.swept", { boxes: swept });
      },
    };
    return daytona;
  }
  const hostLabel = "a second machine (local FUSE client)";
  const localDriver = (env: Record<string, string>) =>
    localHost({
      mode: "systemd",
      mountRoot: "/mnt/pda/demo/b",
      unitPrefix: "pda-demo-",
      hostName: "demo-local-b",
      parkThresholdMs: null,
      runArgs: ["--app", CLOUD_APP, ...CLOUD_LEASE, "--serve", "0"],
      env: { DEMO_MODEL: options.model.model, ...(options.eventsLog ? { DEMO_EVENTS_LOG: options.eventsLog } : {}), ...env },
    });
  const placed = new Map<string, Placed>();

  async function dropToken(id: string, token: string): Promise<void> {
    try {
      await removeMountToken(control, token);
      options.ledger?.close("token-user", token);
    } catch (error) {
      options.log("cloud.token-remove-failed", { run: id, error: (error as Error).message });
    }
  }

  const host: CloudHost = {
    async start(ref: RunRef, run: { model: ModelProxy }) {
      const started = Date.now();
      let link: { token: string; file: string } | undefined;
      if (options.link) {
        const dir = options.linkDir ?? "/tmp/pda-demo-links";
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        link = { token: randomBytes(24).toString("base64url"), file: join(dir, `${ref.id}.token`) };
        writeFileSync(link.file, `${link.token}\n`, { mode: 0o600 });
      }
      const driver = localDriver(
        link ? { DEMO_LINK_PORT: String(LINK_PORT), DEMO_LINK_TOKEN_FILE: link.file } : { DEMO_MODEL_URL: options.model.baseUrl },
      );
      const result = await ensureRunning(ref, driver, { control, demand: true, tokenPrefix: "pda-demo-", leaseExpiryMs: 10_000, startGraceMs: 20_000 });
      options.log("cloud.ensure", { run: ref.id, action: result.action, ms: Date.now() - started, ...(result.action === "started" ? { reason: result.reason, startMs: result.startMs } : {}) });
      if (result.action !== "started") throw new Error(`the supervisor did not start the run: ${result.action}`);
      options.ledger?.open("token-user", result.token.identifier, result.token.nickname);
      options.ledger?.open("cloud-instance", `${ref.id}:${JSON.stringify(result.handle)}`, hostLabel);
      const dialer = link ? dialLink({ url: `ws://127.0.0.1:${LINK_PORT}/`, token: link.token, proxy: run.model, log: (e, d) => options.log(e, { run: ref.id, ...d }) }) : undefined;
      placed.set(ref.id, { driver, ...(dialer ? { dialer } : {}), ...(link ? { linkFile: link.file } : {}), handle: result.handle, token: result.token.identifier, host: hostLabel, startedAt: started });
      return { host: hostLabel };
    },

    attachViewer: (ref: RunRef, send: (frame: PipeFrame) => void) => relayViewer({ control, ref, send, log: options.log, label: () => placed.get(ref.id)?.host ?? hostLabel, dialer: () => placed.get(ref.id)?.dialer }),

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
      const started = Date.now();
      // The claim is already revoked: the instance's next commit or heartbeat fails and it exits 75 by itself. Wait for
      // that (the fence, observed), then let the driver clean up whatever is left.
      const driver = at.driver;
      let status = await driver.status(at.handle).catch(() => "unknown" as const);
      while (how === "fenced" && status === "running" && Date.now() - started < 15_000) {
        await new Promise((r) => setTimeout(r, 250));
        status = await driver.status(at.handle).catch(() => "unknown" as const);
      }
      const unit = typeof at.handle.unit === "string" ? at.handle.unit : undefined;
      const show = unit ? spawnSync("/usr/bin/systemctl", ["show", `${unit}.service`, "-p", "ExecMainStatus", "-p", "Result", "-p", "NRestarts"], { encoding: "utf8" }).stdout.trim().split("\n").join(" ") : null;
      options.log("cloud.exited", { run: ref.id, status, ms: Date.now() - started, ...(show ? { unit: show } : {}) });
      await driver.stop(at.handle).catch((error) => options.log("cloud.stop-failed", { run: ref.id, error: (error as Error).message }));
      at.dialer?.close();
      if (at.linkFile) rmSync(at.linkFile, { force: true });
      options.ledger?.close("cloud-instance", `${ref.id}:${JSON.stringify(at.handle)}`, "stopped");
      await dropToken(ref.id, at.token);
      options.log("cloud.stopped", { run: ref.id, ms: Date.now() - started });
    },

    async close() {
      for (const id of [...placed.keys()]) await host.stop({ disk: options.disk, region: options.region, id }, "now");
    },
  };
  return host;
}
