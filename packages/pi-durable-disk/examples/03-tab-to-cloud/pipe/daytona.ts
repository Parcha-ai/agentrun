// The cloud host on Daytona: a sandbox per run, with the archil client, Node, the package and the agent's app, started
// by the package's supervisor through the package's `daytonaHost` driver. A sandbox cannot reach this server or its
// model endpoint, so the app listens for the server's link (cloud-link.ts) and the server dials in through a signed
// preview URL of that one port, with a bearer token on top.
//
// A sandbox takes 10 to 15 s to install at boot, so a run gets a warm one while a tab runs it: created and prepared
// ahead (no claim, no mount), and handed to the driver when the run moves. Every sandbox carries `pda-fleet=<fleet>` and
// the run's id, is recorded in the ledger before its create call returns, and is deleted when the run leaves it.
//   DAYTONA_API_KEY, DAYTONA_API_URL, DAYTONA_TARGET in the server's environment.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daytonaHost, daytonaRest, ensureRunning, LABEL_FLEET, LABEL_RUN, removeMountToken } from "@parcha/pi-durable-disk";
import type { CreateSandboxBody, DaytonaClient, HostDriver, HostHandle, RunRef, SandboxInfo } from "@parcha/pi-durable-disk";
import type { DemoControl } from "./control.ts";
import { dialLink, type LinkDialer } from "./link.ts";
import type { ModelOptions, ModelProxy } from "./model-proxy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DEMO = join(here, "..");
const PACKAGE = join(DEMO, "..", "..");
export const BOX_APP_DIR = "/usr/local/lib/pda-demo";
export const BOX_PACKAGE = `${BOX_APP_DIR}/node_modules/@parcha/pi-durable-disk`;
export const BOX_NODE = "/opt/node24/bin/node";
export const BOX_MOUNT_ROOT = "/mnt/archil";
export const BOX_LINK_PORT = 8795;
const BOX_EVENTS = "/var/tmp/pda-demo-events.log";
const RATE_PER_HOUR = 2 * 0.0504 + 4 * 0.0162; // daytona-medium: 2 vCPU, 4 GiB
const NODE_URL = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz";
const NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
const ARCHIL_URL = "https://s3.amazonaws.com/archil-client/pkg/archil_0.8.42-1790378297_amd64.deb";
const ARCHIL_SHA256 = "ee593dde01f1c2cbd4ff9cba7852aa87b45f58b97dc328e66e03ced98d9c60d3";

type Log = (event: string, data?: Record<string, unknown>) => void;
type LedgerLike = { open(kind: string, id: string, note?: string): void; close(kind: string, id: string, note?: string): void };

/** The app as a box installs it: the package (npm pack of this checkout), the agent's three modules, their manifest. */
export function appBundle(): Uint8Array {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-demo-bundle-"));
  try {
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", dir], { cwd: PACKAGE, encoding: "utf8" });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const tgz = packed.stdout.trim().split("\n").at(-1)!;
    for (const file of ["agent.ts", "cloud-app.ts", "cloud-link.ts"]) copyFileSync(join(DEMO, file), join(dir, file));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "pda-demo-cloud",
        private: true,
        type: "module",
        dependencies: {
          "@parcha/pi-durable-disk": `file:./${tgz}`,
          "@earendil-works/pi-durable": "1.0.4",
          "@earendil-works/chord": "1.0.4",
          "@earendil-works/pi-ai": "1.0.4",
          ws: "8.21.3",
        },
      }),
    );
    const tar = spawnSync("tar", ["-czf", "-", "-C", dir, "."], { maxBuffer: 64 << 20 });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    return new Uint8Array(tar.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Install the pinned runtime (Node, archil, both sha256-checked), the app, the run user and its sudoers line. */
export function prepareScript(uid: number, gid: number): string {
  return String.raw`
set -euo pipefail
t0=$(date +%s%N)
step() { printf 'step\t%s\t%s\n' "$1" $(( ($(date +%s%N) - t0) / 1000000 )); }
cd /tmp
curl -fsSLo node.tar.xz ${NODE_URL}
echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c - >/dev/null
sudo -n install -d -m 0755 /opt/node24
sudo -n tar -xJf node.tar.xz -C /opt/node24 --strip-components=1
sudo -n chmod -R a+rX /opt/node24
rm -f node.tar.xz
step node
curl -fsSLo archil.deb ${ARCHIL_URL}
echo "${ARCHIL_SHA256}  archil.deb" | sha256sum -c - >/dev/null
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libfuse2t64 fuse3 /tmp/archil.deb >/dev/null
rm -f archil.deb
step archil
getent group pda >/dev/null || sudo -n groupadd -o --gid ${gid} pda
id pda >/dev/null 2>&1 || sudo -n useradd -o --uid ${uid} --gid ${gid} --create-home --shell /bin/bash pda
sudo -n install -d -m 0755 ${BOX_APP_DIR}
sudo -n tar -xzf /tmp/pda-demo-app.tar.gz -C ${BOX_APP_DIR} --no-same-owner
rm -f /tmp/pda-demo-app.tar.gz
sudo -n env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root npm install --prefix ${BOX_APP_DIR} --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
sudo -n chown -R root:root ${BOX_APP_DIR}
sudo -n chmod -R a+rX,go-w ${BOX_APP_DIR}
step app
sudo -n install -o root -g root -m 0755 ${BOX_PACKAGE}/bin/archil-scoped /usr/local/sbin/archil-scoped
printf '%s\n' 'pda ALL=(root) NOPASSWD: /usr/local/sbin/archil-scoped, /usr/bin/fusermount -u ${BOX_MOUNT_ROOT}/runs/*' | sudo -n tee /etc/sudoers.d/pi-durable-disk >/dev/null
sudo -n chmod 0440 /etc/sudoers.d/pi-durable-disk
sudo -n visudo -cf /etc/sudoers.d/pi-durable-disk >/dev/null
sudo -n install -d -m 0755 ${BOX_MOUNT_ROOT}
sudo -n install -d -o pda -g pda -m 0755 ${BOX_MOUNT_ROOT}/runs
sudo -n install -o pda -g pda -m 0644 /dev/null ${BOX_EVENTS}
sudo -n touch ${BOX_APP_DIR}/.prepared
step done
`;
}

/** A Daytona client that only touches this fleet's sandboxes, records each one, and can hand out a warm one. */
function fleetClient(inner: DaytonaClient, fleet: string, prefix: string, ledger: LedgerLike | undefined, log: Log) {
  const ours = new Set<string>();
  const warm = new Map<string, Promise<SandboxInfo>>();
  const created = new Map<string, number>();
  const check = (box: SandboxInfo | null) => {
    if (box && (box.labels?.[LABEL_FLEET] !== fleet || !box.name.startsWith(prefix) || !ours.has(box.id))) throw new Error(`refusing to touch sandbox ${box.id}: not this demo's`);
    return box;
  };
  const client: DaytonaClient & { spendUsd(): number; takeWarm(run: string, box: Promise<SandboxInfo>): void; hasWarm(run: string): boolean } = {
    async create(body: CreateSandboxBody) {
      if (body.labels[LABEL_FLEET] !== fleet || !body.name.startsWith(prefix)) throw new Error("a demo sandbox carries the demo's fleet label and name prefix");
      const run = body.labels[LABEL_RUN];
      const ready = run ? warm.get(run) : undefined;
      if (ready) {
        warm.delete(run!);
        const box = await ready.catch(() => undefined);
        if (box) {
          log("daytona.warm-used", { run, box: box.name });
          return box;
        }
      }
      ledger?.open("daytona-box", body.name, run ? `run ${run}` : undefined);
      const box = await inner.create(body);
      ours.add(box.id);
      created.set(box.id, Date.now());
      return box;
    },
    get: async (id) => check(await inner.get(id)),
    list: async (labels) => (await inner.list({ ...labels, [LABEL_FLEET]: fleet })).filter((b) => b.name.startsWith(prefix)),
    async stop(id, force) {
      check(await inner.get(id));
      await inner.stop(id, force);
    },
    async remove(id) {
      const box = check(await inner.get(id));
      await inner.remove(id);
      if (box) {
        ledger?.close("daytona-box", box.name, "deleted");
        const at = created.get(id);
        if (at) log("daytona.deleted", { box: box.name, minutes: Number(((Date.now() - at) / 60_000).toFixed(2)) });
      }
    },
    exec: async (box, command, timeoutSec) => inner.exec(check(box)!, command, timeoutSec),
    upload: async (box, path, content) => inner.upload(check(box)!, path, content),
    spendUsd() {
      let hours = 0;
      for (const at of created.values()) hours += (Date.now() - at) / 3_600_000;
      return hours * RATE_PER_HOUR;
    },
    takeWarm(run, box) {
      warm.set(run, box);
    },
    hasWarm(run) {
      return warm.has(run);
    },
  };
  return client;
}

interface Placed {
  driver: HostDriver;
  dialer: LinkDialer;
  handle: HostHandle;
  token: string;
  box: string;
}

export interface DaytonaCloudOptions {
  readonly disk: string;
  readonly region: string;
  readonly model: ModelOptions;
  readonly control: DemoControl;
  readonly log: Log;
  readonly ledger?: LedgerLike;
  /** Appends the boxes' own event lines (open, commits) when a box is stopped. */
  readonly eventsLog?: string;
  readonly fleet?: string;
  readonly snapshot?: string;
}

export async function daytonaCloud(options: DaytonaCloudOptions) {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("DAYTONA_API_KEY is needed for the Daytona host");
  const apiUrl = (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, "");
  const target = process.env.DAYTONA_TARGET || "us";
  const fleet = options.fleet ?? "demo";
  const prefix = "pda-demo-";
  const snapshot = options.snapshot ?? "daytona-medium";
  const client = fleetClient(daytonaRest({ apiKey, apiUrl }), fleet, prefix, options.ledger, options.log);
  const uid = process.getuid!();
  const gid = process.getgid!();
  let bundle: Uint8Array | undefined;
  const prepared = new Set<string>();
  const placed = new Map<string, Placed>();

  async function prepare(box: SandboxInfo): Promise<void> {
    if (prepared.has(box.id)) return;
    const started = Date.now();
    bundle ??= appBundle();
    await client.upload(box, "/tmp/pda-demo-app.tar.gz", bundle);
    const r = await client.exec(box, prepareScript(uid, gid), 900);
    if (r.exitCode !== 0) throw new Error(`preparing ${box.name} failed (${r.exitCode}): ${r.result.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    prepared.add(box.id);
    options.log("daytona.prepared", { box: box.name, ms: Date.now() - started, steps: r.result.split("\n").filter((l) => l.startsWith("step")).map((l) => l.split("\t").slice(1).join("=")) });
  }

  /** A signed preview URL for the box's link port (bound to that port, expiring), as a WebSocket URL. */
  async function linkUrl(box: string): Promise<string> {
    const res = await fetch(`${apiUrl}/sandbox/${encodeURIComponent(box)}/ports/${BOX_LINK_PORT}/signed-preview-url?expiresInSeconds=7200`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string };
    if (!res.ok || !body.url) throw new Error(`signed preview URL for ${box}: ${res.status}`);
    return body.url.replace(/^http/, "ws");
  }

  async function dropToken(run: string, token: string): Promise<void> {
    try {
      await removeMountToken(options.control, token);
      options.ledger?.close("token-user", token);
    } catch (error) {
      options.log("cloud.token-remove-failed", { run, error: (error as Error).message });
    }
  }

  return {
    hostLabel: `a Daytona sandbox (${target})`,

    /** Create and prepare a sandbox for `ref` now, so a later start only launches the instance. */
    prewarm(ref: RunRef): void {
      if (client.hasWarm(ref.id)) return;
      const name = `${prefix}${ref.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}`;
      const ready = (async () => {
        const started = Date.now();
        let box = await client.create({ name, snapshot, target, labels: { [LABEL_FLEET]: fleet, [LABEL_RUN]: ref.id }, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 120 });
        for (let i = 0; box.state !== "started" && i < 300; i++) {
          await new Promise((r) => setTimeout(r, 1_000));
          box = (await client.get(box.id))!;
        }
        await prepare(box);
        options.log("daytona.warm", { run: ref.id, box: box.name, ms: Date.now() - started });
        return box;
      })();
      ready.catch((error) => options.log("daytona.warm-failed", { run: ref.id, error: (error as Error).message }));
      client.takeWarm(ref.id, ready);
    },

    /** Start the run in a sandbox (a warm one when ready); with `demand` false, only replace a holder that is lost. */
    async start(ref: RunRef, run: { model: ModelProxy }, demand = true): Promise<boolean> {
      const token = randomBytes(24).toString("base64url");
      const driver = daytonaHost({
        client,
        snapshot,
        target,
        fleet,
        namePrefix: prefix,
        mountRoot: BOX_MOUNT_ROOT,
        node: BOX_NODE,
        packageDir: BOX_PACKAGE,
        user: "pda",
        group: "pda",
        runArgs: ["--app", `${BOX_APP_DIR}/cloud-app.ts`, "--heartbeat-ms", "2000", "--lease-expiry-ms", "10000", "--lease-margin-ms", "3000"],
        env: { DEMO_MODEL: options.model.model, DEMO_LINK_PORT: String(BOX_LINK_PORT), DEMO_LINK_HOST: "0.0.0.0", DEMO_LINK_TOKEN: token, DEMO_EVENTS_LOG: BOX_EVENTS },
        ttlMinutes: 120,
        startTimeoutMs: 600_000,
        prepare: (box) => prepare(box),
      });
      const started = Date.now();
      const result = await ensureRunning(ref, driver, { control: options.control, demand, tokenPrefix: "pda-demo-", leaseExpiryMs: 10_000, startGraceMs: 60_000 });
      if (result.action !== "started") {
        if (demand) throw new Error(`the supervisor did not start the run: ${result.action}`);
        return false;
      }
      options.log("cloud.ensure", { run: ref.id, action: result.action, reason: result.reason, revoked: result.revoked.length, startMs: result.startMs, ms: Date.now() - started, box: result.handle.name });
      options.ledger?.open("token-user", result.token.identifier, result.token.nickname);
      const box = String(result.handle.sandboxId);
      const dialer = dialLink({ url: await linkUrl(box), token, proxy: run.model, log: (e, d) => options.log(e, { run: ref.id, ...d }) });
      const previous = placed.get(ref.id);
      placed.set(ref.id, { driver, dialer, handle: result.handle, token: result.token.identifier, box });
      if (previous) await this.retire(ref, previous, "now");
      return true;
    },

    /** Power off the sandbox that runs the run (SIGKILL of the whole box). */
    async kill(ref: RunRef): Promise<void> {
      const at = placed.get(ref.id);
      if (!at) return;
      await client.stop(at.box, true);
      options.log("cloud.killed", { run: ref.id, box: at.handle.name });
    },

    placed(run: string): Placed | undefined {
      return placed.get(run);
    },

    async stop(ref: RunRef, how: "fenced" | "now" = "now"): Promise<void> {
      const at = placed.get(ref.id);
      if (!at) return;
      placed.delete(ref.id);
      await this.retire(ref, at, how);
    },

    /** Wait for a fenced instance to exit by itself (when asked), keep its event lines, delete its sandbox. */
    async retire(ref: RunRef, at: Placed, how: "fenced" | "now"): Promise<void> {
      const started = Date.now();
      let status = await at.driver.status(at.handle).catch(() => "unknown" as const);
      while (how === "fenced" && status === "running" && Date.now() - started < 15_000) {
        await new Promise((r) => setTimeout(r, 500));
        status = await at.driver.status(at.handle).catch(() => "unknown" as const);
      }
      options.log("cloud.exited", { run: ref.id, status, ms: Date.now() - started, box: at.handle.name });
      if (options.eventsLog) {
        const box = await client.get(at.box).catch(() => null);
        if (box?.state === "started") {
          const r = await client.exec(box, `cat ${BOX_EVENTS} 2>/dev/null; true`, 30).catch(() => null);
          if (r?.result) writeFileSync(options.eventsLog, r.result.endsWith("\n") ? r.result : `${r.result}\n`, { flag: "a" });
        }
      }
      at.dialer.close();
      await at.driver.stop(at.handle).catch((error) => options.log("cloud.stop-failed", { run: ref.id, error: (error as Error).message }));
      await dropToken(ref.id, at.token);
      options.log("cloud.stopped", { run: ref.id, ms: Date.now() - started, spendUsd: Number(client.spendUsd().toFixed(4)) });
    },

    /** Delete every sandbox of the fleet that is left (warm ones, a crashed start's). */
    async sweep(): Promise<number> {
      const left = await client.list({});
      for (const box of left) await client.remove(box.id).catch((error) => options.log("daytona.sweep-failed", { box: box.name, error: (error as Error).message }));
      return left.length;
    },
  };
}
