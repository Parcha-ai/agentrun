// The cloud host on Daytona: a sandbox per run, started by the package's supervisor through the package's `daytonaHost`
// driver, from the demo's runtime snapshot (Node, the archil client, the package, the agent's app and the run user;
// scripts/daytona-snapshot.ts builds it) or from a default one it installs all that into (10 to 15 s).
//   The model: with a model secret, the box calls the endpoint itself. Daytona gives the box only the secret's
//     placeholder (copied into a file the instance reads) and swaps in the key on requests to the secret's hosts.
//     Without one, the app listens for the server's link (cloud-link.ts) and its model calls come back through the pipe.
//   Events and messages: the instance serves them on BOX_SERVE_PORT, which the server reads through a signed preview URL
//     of that port, with the instance's bearer token on top.
//
// A run gets a warm sandbox while a tab runs it: created and set up ahead (no claim, no mount), and handed to the
// driver when the run moves. Every sandbox carries `pda-fleet=<fleet>` and the run's id, is recorded in the ledger
// before its create call returns, and is deleted when the run leaves it.
//   DAYTONA_API_KEY, DAYTONA_API_URL, DAYTONA_TARGET in the server's environment.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { daytonaHost, daytonaRest, ensureRunning, LABEL_FLEET, LABEL_RUN, removeMountToken, sandboxName } from "@parcha/pi-durable-disk";
import type { CreateSandboxBody, DaytonaClient, HostDriver, HostHandle, RunRef, SandboxInfo } from "@parcha/pi-durable-disk";
import type { DemoControl } from "./control.ts";
import { dialLink, type LinkDialer } from "./link.ts";
import type { ModelOptions, ModelProxy } from "./model-proxy.ts";
import { moveEnv } from "./cloud.ts";
import type { Environment, Move } from "../wire.ts";
import type { Invite } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DEMO = join(here, "..");
const PACKAGE = join(DEMO, "..", "..");
export const BOX_APP_DIR = "/usr/local/lib/pda-demo";
export const BOX_PACKAGE = `${BOX_APP_DIR}/node_modules/@parcha/pi-durable-disk`;
export const BOX_NODE = "/opt/node24/bin/node";
export const BOX_MOUNT_ROOT = "/mnt/archil";
export const BOX_LINK_PORT = 8795;
export const BOX_SERVE_PORT = 8080;
/** Per box, root-owned and readable by the run user: the serve token, the model credential's placeholder. */
const BOX_ETC = "/etc/pda-demo";
const MODEL_KEY_ENV = "OPENAI_API_KEY";
const BOX_EVENTS = "/var/tmp/pda-demo-events.log";
const BOX_REMOTE_LOG = "/var/tmp/pda-remote.log";
/** How long a warm GPU box waits for a switch before it is deleted. */
const REMOTE_WARM_MS = 10 * 60_000;
/** Daytona's on-demand list prices: per vCPU hour, per GiB hour, per GPU hour by type. */
const PRICE = { vcpu: 0.0504, gib: 0.0162, gpu: { "rtx-4090": 0.99, "rtx-5090": 1.29, "rtx-pro-6000": 3.03, h100: 3.95, h200: 4.54 } as Record<string, number> };
const rateOf = (cpu: number, gib: number, gpu?: string) => cpu * PRICE.vcpu + gib * PRICE.gib + (gpu ? (PRICE.gpu[gpu] ?? PRICE.gpu.h200!) : 0);
/** The GPU type a GPU runtime snapshot was built for (scripts/daytona-snapshot.ts names it `...-gpu-<type>-<digest>`). */
const gpuTypeOf = (snapshot: string) => /-gpu-([a-z0-9-]+)-[0-9a-f]{12}$/.exec(snapshot)?.[1] ?? "h100";
const NODE_URL = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz";
const NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
const ARCHIL_URL = "https://s3.amazonaws.com/archil-client/pkg/archil_0.8.42-1790378297_amd64.deb";
const ARCHIL_SHA256 = "ee593dde01f1c2cbd4ff9cba7852aa87b45f58b97dc328e66e03ced98d9c60d3";

type Log = (event: string, data?: Record<string, unknown>) => void;
type LedgerLike = { open(kind: string, id: string, note?: string): void; close(kind: string, id: string, note?: string): void };

/** The agent's modules a box runs: the cloud app (with a disk client) and the remote host (through the pipe). */
const APP_FILES = ["agent.ts", "cloud-app.ts", "cloud-link.ts", "environment.ts", "host-probe.ts", "host-fs.ts", "remote-host.ts", "wire.ts", "tab/pipe-client.ts", "tab/runtime.ts", "tab/workspace.ts"];

/**
 * The app as a box installs it: the package (npm pack of this checkout), the agent's modules, their manifest. `digest`
 * covers what it installs (npm pack is reproducible; the outer tar's times are not) and the install script.
 */
export function appBundle(): Uint8Array & { digest: string } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-demo-bundle-"));
  try {
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", dir], { cwd: PACKAGE, encoding: "utf8" });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const tgz = packed.stdout.trim().split("\n").at(-1)!;
    const hash = createHash("sha256").update(prepareScript(process.getuid!(), process.getgid!())).update(readFileSync(join(dir, tgz)));
    for (const file of APP_FILES) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      copyFileSync(join(DEMO, file), join(dir, file));
      hash.update(file).update(readFileSync(join(dir, file)));
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "pda-demo-cloud",
        private: true,
        type: "module",
        dependencies: { "@parcha/pi-durable-disk": `file:./${tgz}`, ...APP_DEPENDENCIES },
      }),
    );
    hash.update(readFileSync(join(dir, "package.json")));
    const tar = spawnSync("tar", ["-czf", "-", "-C", dir, "."], { maxBuffer: 64 << 20 });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    return Object.assign(new Uint8Array(tar.stdout), { digest: hash.digest("hex") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The app's dependencies from the registry; the package itself comes from this checkout. */
const APP_DEPENDENCIES = { "@earendil-works/pi-durable": "1.0.4", "@earendil-works/chord": "1.0.4", "@earendil-works/pi-ai": "1.0.4", ws: "8.21.3", disk: "1.7.0" };

/**
 * Install the pinned runtime (Node, archil, both sha256-checked), the app, the run user and its sudoers line. Each part
 * an image already has (gpuDockerfile's: the runtime and the app's dependencies) is skipped.
 */
export function prepareScript(uid: number, gid: number): string {
  // The run user's ids are this server's, so files the agent writes on the disk belong to the same user everywhere.
  return String.raw`
set -euo pipefail
t0=$(date +%s%N)
step() { printf 'step\t%s\t%s\n' "$1" $(( ($(date +%s%N) - t0) / 1000000 )); }
cd /tmp
if [ ! -x /opt/node24/bin/node ]; then
  curl -fsSLo node.tar.xz ${NODE_URL}
  echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c - >/dev/null
  sudo -n install -d -m 0755 /opt/node24
  sudo -n tar -xJf node.tar.xz -C /opt/node24 --strip-components=1
  sudo -n chmod -R a+rX /opt/node24
  rm -f node.tar.xz
fi
step node
if ! command -v archil >/dev/null; then
  curl -fsSLo archil.deb ${ARCHIL_URL}
  echo "${ARCHIL_SHA256}  archil.deb" | sha256sum -c - >/dev/null
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libfuse2t64 fuse3 /tmp/archil.deb >/dev/null
  rm -f archil.deb
fi
step archil
getent group pda >/dev/null || sudo -n groupadd -o --gid ${gid} pda
id pda >/dev/null 2>&1 || sudo -n useradd -o --uid ${uid} --gid ${gid} --create-home --shell /bin/bash pda
sudo -n install -d -m 0755 ${BOX_APP_DIR}
baked=no
[ -d ${BOX_APP_DIR}/node_modules/@earendil-works/pi-durable ] && baked=yes
sudo -n tar -xzf /tmp/pda-demo-app.tar.gz -C ${BOX_APP_DIR} --no-same-owner
rm -f /tmp/pda-demo-app.tar.gz
if [ "$baked" = yes ]; then
  # The dependencies are in the image, owned and readable as they should be (a recursive chown there would copy every
  # file up from the image's layers): only the package goes in, unpacked where npm would put it.
  sudo -n install -d -m 0755 ${BOX_PACKAGE}
  sudo -n tar -xzf "$(ls ${BOX_APP_DIR}/*.tgz | head -1)" -C ${BOX_PACKAGE} --strip-components=1 --no-same-owner
  sudo -n find ${BOX_APP_DIR} -path ${BOX_APP_DIR}/node_modules -prune -o -exec chown root:root {} + -exec chmod a+rX,go-w {} +
  sudo -n chown -R root:root ${BOX_PACKAGE}
  sudo -n chmod -R a+rX,go-w ${BOX_PACKAGE}
else
  sudo -n env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root npm install --prefix ${BOX_APP_DIR} --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
  sudo -n chown -R root:root ${BOX_APP_DIR}
  sudo -n chmod -R a+rX,go-w ${BOX_APP_DIR}
fi
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

/**
 * The GPU class's image: Daytona's default sandbox image with the runtime and the app's dependencies baked in (a GPU box
 * is ephemeral, so it cannot be prepared and snapshotted like the basic one); the package and the agent's modules go
 * in at setup (prepareScript, in a few seconds). The host provides the GPU driver and nvidia-smi.
 */
export function gpuDockerfile(uid: number, gid: number): string {
  return [
    "FROM daytonaio/sandbox:0.9.0",
    "USER root",
    `RUN curl -fsSLo /tmp/node.tar.xz ${NODE_URL} && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - && install -d -m 0755 /opt/node24 && tar -xJf /tmp/node.tar.xz -C /opt/node24 --strip-components=1 && chmod -R a+rX /opt/node24 && rm -f /tmp/node.tar.xz`,
    `RUN curl -fsSLo /tmp/archil.deb ${ARCHIL_URL} && echo "${ARCHIL_SHA256}  /tmp/archil.deb" | sha256sum -c - && apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libfuse2t64 fuse3 /tmp/archil.deb && rm -f /tmp/archil.deb && rm -rf /var/lib/apt/lists/*`,
    `RUN (getent group pda || groupadd -o --gid ${gid} pda) && (id pda || useradd -o --uid ${uid} --gid ${gid} --create-home --shell /bin/bash pda)`,
    `RUN install -d -m 0755 ${BOX_APP_DIR} && printf '%s' '${JSON.stringify({ name: "pda-demo-cloud", private: true, type: "module", dependencies: APP_DEPENDENCIES })}' > ${BOX_APP_DIR}/package.json && PATH=/opt/node24/bin:$PATH npm install --prefix ${BOX_APP_DIR} --omit=dev --no-audit --no-fund --loglevel=error && chmod -R a+rX,go-w ${BOX_APP_DIR}`,
    "",
  ].join("\n");
}

/**
 * What every box gets at setup, from the snapshot or not: the instance's serve token (uploaded to `stage`) and the
 * model credential's placeholder (the box's own environment variable), each in a file of `${BOX_ETC}`. Prints which
 * parts it found, and the names (never the values) of the proxy and CA variables the box carries.
 */
export function boxSetupScript(stage: string): string {
  const key = MODEL_KEY_ENV;
  return [
    "set -eu",
    `sudo -n install -d -m 0750 -o root -g pda ${BOX_ETC}`,
    `sudo -n install -m 0400 -o pda -g pda ${stage}/serve.token ${BOX_ETC}/serve.token`,
    `rm -f ${stage}/serve.token`,
    `if [ -n "\${${key}:-}" ]; then`,
    `  printf '%s' "\$${key}" | sudo -n sh -c 'umask 0337 && cat > ${BOX_ETC}/model.key && chgrp pda ${BOX_ETC}/model.key'`,
    `  echo "model-key=yes"`,
    "else",
    `  echo "model-key=no"`,
    "fi",
    `echo "env-names=$(env | cut -d= -f1 | grep -i -E 'proxy|ssl|cert|^node_' | sort | tr '\\n' ' ')"`,
    `test -f ${BOX_APP_DIR}/.prepared && echo "runtime=snapshot" || echo "runtime=installed"`,
    "",
  ].join("\n");
}

/** A Daytona client that only touches this fleet's sandboxes, records each one, and can hand out a warm one. */
function fleetClient(inner: DaytonaClient, fleet: string, prefix: string, ledger: LedgerLike | undefined, log: Log, secrets: Record<string, string>[], rates: (snapshot: string) => number) {
  const ours = new Set<string>();
  /** Deleted by this client: a listing shows a box for a while after its delete call returned. */
  const removed = new Set<string>();
  /** Warm boxes by run and snapshot. */
  const warm = new Map<string, Promise<SandboxInfo>>();
  const created = new Map<string, { at: number; rate: number; end?: number; name: string }>();
  const check = (box: SandboxInfo | null) => {
    if (box && (box.labels?.[LABEL_FLEET] !== fleet || !box.name.startsWith(prefix) || !ours.has(box.id))) throw new Error(`refusing to touch sandbox ${box.id}: not this demo's`);
    return box;
  };
  const client: DaytonaClient & { spendUsd(): number; takeWarm(run: string, snapshot: string, box: Promise<SandboxInfo>): void; hasWarm(run: string, snapshot: string): boolean } = {
    async create(body: CreateSandboxBody) {
      if (body.labels[LABEL_FLEET] !== fleet || !body.name.startsWith(prefix)) throw new Error("a demo sandbox carries the demo's fleet label and name prefix");
      const run = body.labels[LABEL_RUN];
      const key = `${run}:${body.snapshot}`;
      const ready = run ? warm.get(key) : undefined;
      if (ready) {
        warm.delete(key);
        const box = await ready.catch(() => undefined);
        if (box) {
          log("daytona.warm-used", { run, box: box.name });
          return box;
        }
      }
      ledger?.open("daytona-box", body.name, run ? `run ${run}` : undefined);
      // Secrets are mounted at creation (a box created without them would need a restart to get them).
      const box = await inner.create((secrets.length > 0 ? { ...body, secrets } : body) as CreateSandboxBody);
      ours.add(box.id);
      created.set(box.id, { at: Date.now(), rate: rates(body.snapshot), name: box.name });
      return box;
    },
    get: async (id) => check(await inner.get(id)),
    list: async (labels) => (await inner.list({ ...labels, [LABEL_FLEET]: fleet })).filter((b) => b.name.startsWith(prefix) && !removed.has(b.id)),
    async stop(id, force) {
      check(await inner.get(id));
      await inner.stop(id, force);
    },
    async remove(id) {
      if (removed.has(id)) return;
      const box = check(await inner.get(id));
      await inner.remove(id);
      removed.add(id);
      // A box that is already gone (powered off: it deletes itself when it stops) is recorded closed too.
      const life = created.get(id);
      const name = box?.name ?? life?.name;
      if (name) ledger?.close("daytona-box", name, box ? "deleted" : "gone");
      if (life && !life.end) {
        life.end = Date.now();
        log("daytona.deleted", { box: name, minutes: Number(((life.end - life.at) / 60_000).toFixed(2)), usd: Number(((life.rate * (life.end - life.at)) / 3_600_000).toFixed(4)) });
      }
    },
    exec: async (box, command, timeoutSec) => inner.exec(check(box)!, command, timeoutSec),
    upload: async (box, path, content) => inner.upload(check(box)!, path, content),
    spendUsd() {
      let usd = 0;
      for (const life of created.values()) usd += (life.rate * ((life.end ?? Date.now()) - life.at)) / 3_600_000;
      return usd;
    },
    takeWarm(run, snapshot, box) {
      warm.set(`${run}:${snapshot}`, box);
    },
    hasWarm(run, snapshot) {
      return warm.has(`${run}:${snapshot}`);
    },
  };
  return client;
}

interface Placed {
  driver: HostDriver;
  dialer?: LinkDialer;
  /** The instance's serve front, through a signed preview URL, and its bearer token. */
  serve: { url: string; token: string };
  handle: HostHandle;
  token: string;
  box: string;
  /** The environment it runs in. */
  env: string;
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
  /** The snapshot boxes start from: the demo's runtime snapshot, or a default one (then every box installs it all). */
  readonly snapshot?: string;
  /** The Daytona secret with the model endpoint's key; without it the box's model calls go through the link. */
  readonly modelSecret?: string;
  /** A runtime snapshot on a GPU class (scripts/daytona-snapshot.ts --from daytona-gpu): offers "Daytona GPU". */
  readonly gpuSnapshot?: string;
}

export async function daytonaCloud(options: DaytonaCloudOptions) {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("DAYTONA_API_KEY is needed for the Daytona host");
  const apiUrl = (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, "");
  const target = process.env.DAYTONA_TARGET || "us";
  const fleet = options.fleet ?? "demo";
  const prefix = "pda-demo-";
  const snapshot = options.snapshot ?? "daytona-medium";
  const viaLink = !options.modelSecret;
  // The basic class is the medium one (2 vCPU, 4 GiB); the GPU one is 4 vCPU, 16 GiB and one GPU.
  const gpuType = options.gpuSnapshot ? gpuTypeOf(options.gpuSnapshot) : undefined;
  const rates = (s: string) => (s === options.gpuSnapshot ? rateOf(4, 16, gpuType) : rateOf(2, 4));
  const client = fleetClient(daytonaRest({ apiKey, apiUrl }), fleet, prefix, options.ledger, options.log, options.modelSecret ? [{ [MODEL_KEY_ENV]: options.modelSecret }] : [], rates);
  const uid = process.getuid!();
  const gid = process.getgid!();
  let bundle: Uint8Array | undefined;
  const prepared = new Set<string>();
  const placed = new Map<string, Placed>();
  /** The GPU sandbox each run has, while a remote host there runs it; and one kept warm for it, when asked. */
  const remotes = new Map<string, SandboxInfo>();
  const warmRemotes = new Map<string, Promise<SandboxInfo>>();

  /** Install the runtime when the box's snapshot lacks it (a default snapshot). */
  async function install(box: SandboxInfo): Promise<void> {
    const started = Date.now();
    bundle ??= appBundle();
    await client.upload(box, "/tmp/pda-demo-app.tar.gz", bundle);
    const r = await client.exec(box, prepareScript(uid, gid), 900);
    if (r.exitCode !== 0) throw new Error(`preparing ${box.name} failed (${r.exitCode}): ${r.result.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    options.log("daytona.installed", { box: box.name, ms: Date.now() - started, steps: r.result.split("\n").filter((l) => l.startsWith("step")).map((l) => l.split("\t").slice(1).join("=")) });
  }

  /** Each box's serve token, minted at its setup. */
  const serveTokens = new Map<string, string>();

  /** The runtime (when missing), then this box's serve token and model credential. Once per box. */
  async function prepare(box: SandboxInfo): Promise<void> {
    if (prepared.has(box.id)) return;
    const started = Date.now();
    const has = await client.exec(box, `test -f ${BOX_APP_DIR}/.prepared`, 30);
    if (has.exitCode !== 0) await install(box);
    const stage = "/tmp/pda-demo-stage";
    const mk = await client.exec(box, `umask 077 && mkdir -p ${stage} && chmod 700 ${stage} && [ "$(stat -c %u ${stage})" = "$(id -u)" ]`, 30);
    if (mk.exitCode !== 0) throw new Error(`staging in ${box.name} failed: ${mk.result.trim().slice(0, 200)}`);
    const token = randomBytes(24).toString("base64url");
    await client.upload(box, `${stage}/serve.token`, new TextEncoder().encode(`${token}\n`));
    const r = await client.exec(box, boxSetupScript(stage), 60);
    if (r.exitCode !== 0) throw new Error(`setting up ${box.name} failed (${r.exitCode}): ${r.result.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
    const facts = Object.fromEntries(r.result.trim().split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
    if (!viaLink && facts["model-key"] !== "yes") throw new Error(`${box.name} has no ${MODEL_KEY_ENV}: is the secret ${options.modelSecret} attached?`);
    serveTokens.set(box.id, token);
    prepared.add(box.id);
    options.log("daytona.prepared", { box: box.name, ms: Date.now() - started, installed: has.exitCode !== 0, ...facts });
  }

  /** A signed preview URL for one port of the box (bound to that port, expiring). */
  async function previewUrl(box: string, port: number): Promise<string> {
    const res = await fetch(`${apiUrl}/sandbox/${encodeURIComponent(box)}/ports/${port}/signed-preview-url?expiresInSeconds=7200`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string };
    if (!res.ok || !body.url) throw new Error(`signed preview URL for ${box} port ${port}: ${res.status}`);
    return body.url.replace(/\/+$/, "");
  }

  async function dropToken(run: string, token: string): Promise<void> {
    try {
      await removeMountToken(options.control, token);
      options.ledger?.close("token-user", token);
    } catch (error) {
      options.log("cloud.token-remove-failed", { run, error: (error as Error).message });
    }
  }

  /** A sandbox of `cls` for `ref`, started, set up, with remote-host.ts listening as the run user. */
  async function remoteBox(ref: RunRef, cls: { env: Environment; snapshot: string }): Promise<SandboxInfo> {
    const t0 = Date.now();
    const name = sandboxName(prefix, ref.id, t0);
    let box = await client.create({ name, snapshot: cls.snapshot, target, labels: { [LABEL_FLEET]: fleet, [LABEL_RUN]: ref.id }, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 120 });
    try {
      for (let i = 0; box.state !== "started"; i++) {
        if (i >= 300) throw new Error(`${name} did not start in 5 min (last state ${box.state})`);
        await new Promise((r) => setTimeout(r, 1_000));
        box = (await client.get(box.id))!;
      }
      const startedMs = Date.now() - t0;
      await prepare(box);
      const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
      // Its own session (setsid -f), so the end of the toolbox command does not end it.
      const launch = [
        "setsid -f sudo -n -u pda -H env",
        `PATH=${q(`${dirname(BOX_NODE)}:/usr/local/bin:/usr/bin:/bin`)}`,
        `DEMO_ENV_LABEL=${q(cls.env.phrase)}`,
        `DEMO_ENV_CLASS=${q(cls.env.label)}`,
        `DEMO_ENV_NOTE=${q("The run's disk is not mounted here: your conversation and workspace reach this machine through your user's server.")}`,
        // As the run user (sudo -H): its workspace is work/ in that user's home.
        `${BOX_NODE} ${BOX_APP_DIR}/remote-host.ts --port ${BOX_SERVE_PORT} --token-file ${BOX_ETC}/serve.token`,
        `>> ${BOX_REMOTE_LOG} 2>&1 < /dev/null`,
      ].join(" ");
      // The toolbox's shell opens the log (the host inherits it): the log is the toolbox user's.
      const r = await client.exec(box, `sudo -n install -o "$(id -u)" -g "$(id -g)" -m 0644 /dev/null ${BOX_REMOTE_LOG} && ${launch}`, 30);
      if (r.exitCode !== 0) throw new Error(`launching the remote host in ${name} failed (${r.exitCode}): ${r.result.trim().slice(0, 300)}`);
      options.log("remote.ready", { run: ref.id, box: name, startedMs, ms: Date.now() - t0 });
      return box;
    } catch (error) {
      await client.remove(box.id).catch(() => undefined);
      throw error;
    }
  }

  const basic: Environment = { id: "daytona-basic", label: "Daytona basic", phrase: "a Daytona cloud sandbox", kind: "cloud", detail: `2 vCPU, 4 GiB, region ${target}` };
  // A GPU runner gives containers no FUSE: the GPU class runs the agent through the pipe (remote-host.ts).
  const gpu: Environment = { id: "daytona-gpu", label: "Daytona GPU", phrase: "a Daytona GPU sandbox", kind: "remote", detail: `1x ${(gpuType ?? "gpu").toUpperCase().replace("RTX-", "RTX ")}, 4 vCPU, 16 GiB, region ${target}` };
  const classes = new Map<string, { env: Environment; snapshot: string }>([[basic.id, { env: basic, snapshot }]]);
  if (options.gpuSnapshot) classes.set(gpu.id, { env: gpu, snapshot: options.gpuSnapshot });
  const classOf = (env: string) => classes.get(env) ?? classes.get(basic.id)!;
  return {
    hostLabel: `a Daytona sandbox (${target})`,
    environments: [...classes.values()].map((c) => c.env),
    label: (env: string) => `${classOf(env).env.label} sandbox (${target})`,

    /**
     * Create and set up a basic sandbox for `ref` now, so a later start only launches the instance. A GPU one is never
     * kept warm: it costs about forty times as much while it waits.
     */
    prewarm(ref: RunRef): void {
      if (client.hasWarm(ref.id, snapshot)) return;
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
      client.takeWarm(ref.id, snapshot, ready);
    },

    /** Get a GPU sandbox ready for `ref` (started, set up, its host listening), so a switch there only dials it. */
    prewarmRemote(ref: RunRef): void {
      const cls = classes.get(gpu.id);
      if (!cls || warmRemotes.has(ref.id) || remotes.has(ref.id)) return;
      const ready = remoteBox(ref, cls);
      ready.catch((error) => {
        warmRemotes.delete(ref.id);
        options.log("remote.warm-failed", { run: ref.id, error: (error as Error).message });
      });
      warmRemotes.set(ref.id, ready);
      // A GPU box costs while it waits: one nobody took within the bound is deleted.
      setTimeout(() => {
        if (warmRemotes.get(ref.id) !== ready) return;
        warmRemotes.delete(ref.id);
        void ready.then((box) => client.remove(box.id)).then(() => options.log("remote.warm-expired", { run: ref.id }), () => undefined);
      }, REMOTE_WARM_MS).unref();
    },

    /** Start the run in a sandbox (a warm one when ready); with `demand` false, only replace a holder that is lost. */
    async start(ref: RunRef, run: { model: ModelProxy; move: Move; env: string }, demand = true): Promise<boolean> {
      const token = randomBytes(24).toString("base64url");
      const cls = classOf(run.env);
      const model: Record<string, string> = viaLink
        ? { DEMO_LINK_PORT: String(BOX_LINK_PORT), DEMO_LINK_HOST: "0.0.0.0", DEMO_LINK_TOKEN: token }
        : // Node trusts the system's CAs too: the box's egress may be re-signed on the way to swap in the key.
          { DEMO_MODEL_URL: options.model.baseUrl, DEMO_MODEL_KEY_FILE: `${BOX_ETC}/model.key`, NODE_USE_SYSTEM_CA: "1" };
      const driver = daytonaHost({
        client,
        snapshot: cls.snapshot,
        target,
        fleet,
        namePrefix: prefix,
        mountRoot: BOX_MOUNT_ROOT,
        node: BOX_NODE,
        packageDir: BOX_PACKAGE,
        user: "pda",
        group: "pda",
        runArgs: [
          "--app", `${BOX_APP_DIR}/cloud-app.ts`, "--heartbeat-ms", "2000", "--lease-expiry-ms", "10000", "--lease-margin-ms", "3000",
          // Every address, for the preview proxy; the address it advertises is the box's own (clients use a signed URL).
          "--serve", String(BOX_SERVE_PORT), "--serve-host", "0.0.0.0", "--serve-url", `http://127.0.0.1:${BOX_SERVE_PORT}`, "--serve-token-file", `${BOX_ETC}/serve.token`,
        ],
        env: { DEMO_MODEL: options.model.model, ...model, DEMO_EVENTS_LOG: BOX_EVENTS, ...moveEnv(cls.env, run.move, cls.env.label) },
        stopTimeoutMs: 15_000,
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
      const dialer = viaLink ? dialLink({ url: (await previewUrl(box, BOX_LINK_PORT)).replace(/^http/, "ws"), token, proxy: run.model, log: (e, d) => options.log(e, { run: ref.id, ...d }) }) : undefined;
      const serve = { url: await previewUrl(box, BOX_SERVE_PORT), token: serveTokens.get(box) ?? "" };
      const previous = placed.get(ref.id);
      placed.set(ref.id, { driver, ...(dialer ? { dialer } : {}), serve, handle: result.handle, token: result.token.identifier, box, env: cls.env.id });
      if (previous) await this.retire(ref, previous, "now");
      return true;
    },

    /** Power off the sandbox that runs the run (SIGKILL of the whole box). */
    async kill(ref: RunRef): Promise<void> {
      const at = placed.get(ref.id);
      if (!at) return;
      // The box's event lines so far, for the evidence (a box without power keeps nothing).
      if (options.eventsLog) {
        const box = await client.get(at.box).catch(() => null);
        const r = box ? await client.exec(box, `cat ${BOX_EVENTS} 2>/dev/null; true`, 30).catch(() => null) : null;
        if (r?.result) writeFileSync(options.eventsLog, r.result.endsWith("\n") ? r.result : `${r.result}\n`, { flag: "a" });
      }
      await client.stop(at.box, true);
      options.log("cloud.killed", { run: ref.id, box: at.handle.name });
    },

    /**
     * Start a GPU sandbox for `ref` that runs the run through the pipe (or take the warm one): set it up, launch
     * remote-host.ts as the run user, dial it through a signed preview URL of its port with its bearer token, and send
     * it `invite`.
     */
    async startRemote(ref: RunRef, env: string, invite: Invite): Promise<{ socket: WebSocket; host: string }> {
      const cls = classOf(env);
      const t0 = Date.now();
      const warm = warmRemotes.get(ref.id);
      warmRemotes.delete(ref.id);
      const box = (warm && (await warm.catch(() => undefined))) || (await remoteBox(ref, cls));
      remotes.set(ref.id, box);
      const url = (await previewUrl(box.id, BOX_SERVE_PORT)).replace(/^http/, "ws");
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
      options.log("remote.dialed", { run: ref.id, box: box.name, warm: Boolean(warm), ms: Date.now() - t0 });
      return { socket, host: `${cls.env.label} sandbox (${target})` };
    },

    /** Delete the run's remote sandbox, keeping its host's log lines. */
    async stopRemote(ref: RunRef): Promise<void> {
      const box = remotes.get(ref.id);
      if (!box) return;
      remotes.delete(ref.id);
      if (options.eventsLog) {
        const r = await client.exec(box, `cat ${BOX_REMOTE_LOG} 2>/dev/null; true`, 30).catch(() => null);
        if (r?.result) writeFileSync(options.eventsLog, r.result.endsWith("\n") ? r.result : `${r.result}\n`, { flag: "a" });
      }
      await client.remove(box.id).catch((error) => options.log("daytona.delete-failed", { box: box.name, error: (error as Error).message }));
      serveTokens.delete(box.id);
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
      options.log("cloud.exited", { run: ref.id, how, status, ms: Date.now() - started, box: at.handle.name });
      if (options.eventsLog) {
        const box = await client.get(at.box).catch(() => null);
        if (box?.state === "started") {
          const r = await client.exec(box, `cat ${BOX_EVENTS} 2>/dev/null; true`, 30).catch(() => null);
          if (r?.result) writeFileSync(options.eventsLog, r.result.endsWith("\n") ? r.result : `${r.result}\n`, { flag: "a" });
        }
      }
      at.dialer?.close();
      serveTokens.delete(at.box);
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
