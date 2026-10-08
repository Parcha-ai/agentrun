// The Daytona live helpers. The ledger (P9-STATE.json in $PDA_STATE_DIR) gets every sandbox before its create call returns, every
// token user and run directory the moment they exist, and stamps each when it is gone. The guarded Daytona client only
// lists by this lane's label and only runs commands in, uploads to, stops or deletes a box that is both in the ledger and
// labeled `pda-fleet=p9`: the organization may run other sandboxes, which the suite never touches. Identifiers only;
// never a key or a token.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./_paths.ts";
import { daytonaRest, LABEL_FLEET, type DaytonaClient, type SandboxInfo } from "../../src/hosts/daytona.ts";

export const LEDGER = statePath("PDA_P9_STATE", "P9-STATE.json");
export const RESULTS = statePath("PDA_P9_RESULTS", "P9-PROBE.json");
export const FLEET = "p9";
export const NAME_PREFIX = "pda-p9-";
export const LIVE_DAYTONA = process.env.PDA_LIVE === "1" && Boolean(process.env.DAYTONA_API_KEY);
/** Daytona's public pricing (2026-10-07): vCPU $0.0504/h, memory $0.0162/GiB-h, disk $0.000108/GiB-h past 5 GiB. */
export const RATE_PER_HOUR: Record<string, number> = {
  "daytona-small": 0.0504 + 0.0162,
  "daytona-medium": 2 * 0.0504 + 4 * 0.0162 + 3 * 0.000108,
};

type Entry = Record<string, unknown>;
type Ledger = {
  lane: "P9";
  phase: number;
  updated: string;
  note: string;
  daytona: { sandboxes: Entry[] };
  archil: { tokens: Entry[]; subdirs: Entry[] };
  events: Entry[];
  spendUsd: { daytona: number; archil: number };
  closed: boolean;
};

const now = () => new Date().toISOString();

function load(): Ledger {
  const fresh: Ledger = { lane: "P9", phase: 1, updated: now(), note: "", daytona: { sandboxes: [] }, archil: { tokens: [], subdirs: [] }, events: [], spendUsd: { daytona: 0, archil: 0 }, closed: true };
  if (!existsSync(LEDGER)) return fresh;
  const l = JSON.parse(readFileSync(LEDGER, "utf8")) as Partial<Ledger> & { phase?: number };
  if (l.phase === 0) return { ...fresh, note: "Phase 0 was desk only; phase 1 starts here." };
  return { ...fresh, ...l } as Ledger;
}

function update(fn: (l: Ledger) => void): void {
  const l = load();
  fn(l);
  l.updated = now();
  l.spendUsd.daytona = Math.round(spendOf(l) * 10000) / 10000;
  l.closed = l.daytona.sandboxes.every((s) => s.deletedAt || s.createFailedAt) && l.archil.tokens.every((t) => t.removedAt) && l.archil.subdirs.every((d) => d.deletedAt);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, `${JSON.stringify(l, null, 2)}\n`);
}

function spendOf(l: Ledger): number {
  let usd = 0;
  for (const s of l.daytona.sandboxes) {
    if (s.createFailedAt && !s.id) continue;
    const from = Date.parse(String(s.createdAt));
    const to = s.goneAt ? Date.parse(String(s.goneAt)) : s.deletedAt ? Date.parse(String(s.deletedAt)) : Date.now();
    usd += ((to - from) / 3_600_000) * (RATE_PER_HOUR[String(s.snapshot)] ?? RATE_PER_HOUR["daytona-medium"]);
  }
  return usd;
}

const stamp = (list: Entry[], key: string, value: unknown, fields: Entry) => list.filter((e) => e[key] === value).forEach((e) => Object.assign(e, fields));

export const ledger = {
  creating(name: string, labels: Record<string, string>, snapshot: string | undefined, purpose: string) {
    update((l) => void l.daytona.sandboxes.push({ name, labels, snapshot: snapshot ?? "default", purpose, createdAt: now() }));
  },
  created(name: string, id: string) {
    update((l) => stamp(l.daytona.sandboxes, "name", name, { id }));
  },
  createFailed(name: string, error: string) {
    update((l) => stamp(l.daytona.sandboxes, "name", name, { createFailedAt: now(), error }));
  },
  deleted(id: string, how: string) {
    update((l) => l.daytona.sandboxes.filter((e) => e.id === id && !e.deletedAt).forEach((e) => Object.assign(e, { deletedAt: now(), how })));
  },
  gone(id: string, state: string) {
    update((l) => l.daytona.sandboxes.filter((e) => e.id === id && !e.goneAt).forEach((e) => Object.assign(e, { goneAt: now(), finalState: state, deletedAt: e.deletedAt ?? now(), how: e.how ?? "deleted by Daytona (force stop with autoDeleteInterval 0, or TTL)" })));
  },
  token(identifier: string, nickname: string, purpose: string) {
    update((l) => void l.archil.tokens.push({ identifier, nickname, purpose, createdAt: now() }));
  },
  tokenRemoved(identifier: string) {
    update((l) => stamp(l.archil.tokens, "identifier", identifier, { removedAt: now() }));
  },
  subdir(key: string, purpose: string) {
    update((l) => void l.archil.subdirs.push({ key, purpose, createdAt: now() }));
  },
  subdirDeleted(key: string, result: string) {
    update((l) => stamp(l.archil.subdirs, "key", key, { deletedAt: now(), result }));
  },
  event(kind: string, detail: Entry = {}) {
    update((l) => void l.events.push({ at: now(), kind, ...detail }));
  },
  read(): Ledger {
    return load();
  },
  spend(): number {
    return spendOf(load());
  },
  ids(): Set<string> {
    return new Set(load().daytona.sandboxes.map((s) => s.id).filter((x): x is string => typeof x === "string"));
  },
};

/** Merge one phase's results into P9-PROBE.json. */
export function record(phase: string, data: Entry): void {
  const all = existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, "utf8")) as Entry) : {};
  all[phase] = { at: now(), ...data };
  writeFileSync(RESULTS, `${JSON.stringify(all, null, 2)}\n`);
}

export class NotOursError extends Error {}

/** The REST client from the with-daytona environment, wrapped so it can only touch this lane's boxes. */
export function guardedClient(inner: DaytonaClient = daytonaRest({ apiKey: process.env.DAYTONA_API_KEY!, apiUrl: process.env.DAYTONA_API_URL || undefined })): DaytonaClient {
  const ours = (box: SandboxInfo) => box.labels?.[LABEL_FLEET] === FLEET && box.name.startsWith(NAME_PREFIX) && ledger.ids().has(box.id);
  const require = (box: SandboxInfo) => {
    if (!ours(box)) throw new NotOursError(`refusing to touch sandbox ${box.id}: not created by lane P9`);
  };
  /** A box being deleted carries a soft-delete name, so it no longer matches; it needs nothing more from this lane. */
  const requireId = async (id: string): Promise<SandboxInfo | null> => {
    const box = await inner.get(id);
    if (!box || box.state === "destroying" || box.state === "destroyed") return null;
    require(box);
    return box;
  };
  return {
    async create(body) {
      if (body.labels[LABEL_FLEET] !== FLEET || !body.name.startsWith(NAME_PREFIX)) throw new NotOursError("a P9 box carries the p9 fleet label and name prefix");
      ledger.creating(body.name, body.labels, body.snapshot, body.labels["pda-p9"] ?? "?");
      try {
        const box = await inner.create(body);
        ledger.created(body.name, box.id);
        return box;
      } catch (err) {
        ledger.createFailed(body.name, (err as Error).message);
        throw err;
      }
    },
    get: (idOrName) => inner.get(idOrName),
    async list(labels) {
      if (labels[LABEL_FLEET] !== FLEET) throw new NotOursError("this lane lists only by its own fleet label");
      return inner.list(labels);
    },
    async stop(id, force) {
      if (!(await requireId(id))) return;
      await inner.stop(id, force);
    },
    async remove(id) {
      if (!(await requireId(id))) return;
      await inner.remove(id);
      ledger.deleted(id, "remove");
    },
    async exec(box, command, timeoutSec) {
      require(box);
      return inner.exec(box, command, timeoutSec);
    },
    async upload(box, path, content) {
      require(box);
      return inner.upload(box, path, content);
    },
  };
}

/** Wait until every ledger box is deleted or destroyed (read by id), stamping each; returns the ones still alive. */
export async function confirmGone(client: DaytonaClient, timeoutMs = 120_000): Promise<string[]> {
  const pending = () => ledger.read().daytona.sandboxes.filter((s) => s.id && !s.goneAt).map((s) => String(s.id));
  for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 2_000))) {
    for (const id of pending()) {
      const box = await client.get(id);
      if (!box || box.state === "destroyed") ledger.gone(id, box?.state ?? "404");
    }
    if (!pending().length || Date.now() - t0 > timeoutMs) return pending();
  }
}

// ---- the box's runtime (a default Daytona image gets it at boot; no snapshot is built) ----------------------------------

export const NODE = "/opt/node24/bin/node";
export const PACKAGE_DIR = "/usr/local/lib/pi-durable-archil";
export const ARCHIL_WRAPPER = "/usr/local/sbin/archil-scoped";
export const MOUNT_ROOT = "/mnt/pda/p9";
/** The run user's uid and gid in every box (fixed, so the supervisor can create run directories before a box exists). */
export const PDA_ID = 1500;
/** Where the e2e app writes what it sees, outside the mount, writable by the run user. */
export const APP_OUT = "/var/tmp/pda-out";
const NODE_URL = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz";
const NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
const ARCHIL_URL = "https://s3.amazonaws.com/archil-client/pkg/archil_0.8.42-1790378297_amd64.deb";
const ARCHIL_SHA256 = "ee593dde01f1c2cbd4ff9cba7852aa87b45f58b97dc328e66e03ced98d9c60d3";
const REPO = new URL("../../", import.meta.url).pathname;

/** This checkout's working tree (no node_modules, .git or .tmp) as a gzipped tar. */
export function packageTarball(): Uint8Array {
  const r = spawnSync("tar", ["-czf", "-", "--exclude=./node_modules", "--exclude=./.git", "--exclude=./.tmp", "-C", REPO, "."], { maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return new Uint8Array(r.stdout);
}

const PREPARE = String.raw`
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
id pda >/dev/null 2>&1 || { sudo -n groupadd --gid ${PDA_ID} pda && sudo -n useradd --uid ${PDA_ID} --gid ${PDA_ID} --create-home --shell /bin/bash pda; }
[ "$(id -u pda):$(id -g pda)" = "${PDA_ID}:${PDA_ID}" ]
sudo -n install -d -m 0755 ${PACKAGE_DIR}
sudo -n tar -xzf /tmp/pda-pkg.tar.gz -C ${PACKAGE_DIR} --no-same-owner
rm -f /tmp/pda-pkg.tar.gz
sudo -n env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root npm ci --prefix ${PACKAGE_DIR} --no-audit --no-fund --loglevel=error >/dev/null
sudo -n chown -R root:root ${PACKAGE_DIR}
sudo -n chmod -R a+rX,go-w ${PACKAGE_DIR}
step package
sudo -n install -o root -g root -m 0755 ${PACKAGE_DIR}/bin/archil-scoped ${ARCHIL_WRAPPER}
printf '%s\n' 'pda ALL=(root) NOPASSWD: ${ARCHIL_WRAPPER}, /usr/bin/fusermount -u ${MOUNT_ROOT}/runs/*' | sudo -n tee /etc/sudoers.d/pi-durable-archil >/dev/null
sudo -n chmod 0440 /etc/sudoers.d/pi-durable-archil
sudo -n visudo -cf /etc/sudoers.d/pi-durable-archil >/dev/null
sudo -n install -d -m 0755 /mnt/pda ${MOUNT_ROOT}
sudo -n install -d -o pda -g pda -m 0755 ${MOUNT_ROOT}/runs ${APP_OUT}
step setup
printf 'archil\t%s\n' "$(archil --version 2>&1 | head -1)"
printf 'node\t%s\n' "$(${NODE} --version)"
printf 'pda\t%s\n' "$(id pda)"
`;

/** Run a script in one of this lane's boxes; a non-zero exit throws with the output's tail. */
export async function sh(client: DaytonaClient, box: SandboxInfo, script: string, timeoutSec = 120): Promise<string> {
  const r = await client.exec(box, script, timeoutSec);
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode} in ${box.name}: ${r.result.trim().split("\n").slice(-5).join(" | ").slice(0, 600)}`);
  return r.result;
}

/** Install the pinned runtime (Node 24.21.0, archil 0.8.42, both sha256-checked), the package, the run user and sudoers. */
export async function prepareBox(client: DaytonaClient, box: SandboxInfo): Promise<{ ms: number; steps: Record<string, number>; versions: Record<string, string> }> {
  const t0 = performance.now();
  await client.upload(box, "/tmp/pda-pkg.tar.gz", packageTarball());
  const out = await sh(client, box, PREPARE, 900);
  const steps: Record<string, number> = {};
  const versions: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [k, a, b] = line.split("\t");
    if (k === "step") steps[a] = Number(b);
    else if (a !== undefined && ["archil", "node", "pda"].includes(k)) versions[k] = a;
  }
  return { ms: Math.round(performance.now() - t0), steps, versions };
}

/** Put a mount token into the box's root-only /run/pda/<name>.token through the toolbox user's 0700 staging directory. */
export async function stageToken(client: DaytonaClient, box: SandboxInfo, name: string, token: string): Promise<string> {
  await sh(client, box, `umask 077 && mkdir -p /tmp/pda-stage && chmod 700 /tmp/pda-stage && [ "$(stat -c %u /tmp/pda-stage)" = "$(id -u)" ] && sudo -n mkdir -p /run/pda && sudo -n chmod 700 /run/pda`);
  await client.upload(box, `/tmp/pda-stage/${name}.token`, new TextEncoder().encode(`${token}\n`));
  await sh(client, box, `sudo -n sh -c 'umask 077 && cat /tmp/pda-stage/${name}.token > /run/pda/${name}.token' && rm -f /tmp/pda-stage/${name}.token`);
  return `/run/pda/${name}.token`;
}

/** Everything under `prefix` on the scratch disk: files, then directory markers deepest first; then prove it empty. */
export async function deletePrefix(disk: { listObjects: (p: string, o?: { recursive?: boolean }) => Promise<{ objects: { key: string }[] }>; deleteObjects: (k: string[], o?: { quiet?: boolean }) => Promise<{ errors: unknown[] }> }, prefix: string): Promise<{ objects: number; errors: number; left: number }> {
  const keys = (await disk.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
  const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])];
  const depth = (k: string) => k.split("/").length;
  let errors = keys.some((k) => !k.endsWith("/")) ? (await disk.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true })).errors.length : 0;
  for (const d of [...new Set(dirs.map(depth))].sort((x, y) => y - x)) {
    errors += (await disk.deleteObjects(dirs.filter((k) => depth(k) === d), { quiet: true })).errors.length;
  }
  const left = (await disk.listObjects(prefix, { recursive: true })).objects.length;
  return { objects: keys.length, errors, left };
}

/** Block all egress of one of this lane's running boxes (Tier 3 and 4 only): a network partition. */
export async function blockEgress(client: DaytonaClient, id: string): Promise<{ status: number; body: string }> {
  const box = await client.get(id);
  if (!box || box.labels?.[LABEL_FLEET] !== FLEET || !box.name.startsWith(NAME_PREFIX) || !ledger.ids().has(box.id)) throw new NotOursError(`refusing to touch sandbox ${id}`);
  const base = (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, "");
  const res = await fetch(`${base}/sandbox/${encodeURIComponent(id)}/network-settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DAYTONA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ networkBlockAll: true }),
    signal: AbortSignal.timeout(30_000),
  });
  // The answer echoes the box (and the organization's id): only the status is kept.
  await res.text().catch(() => "");
  return { status: res.status, body: "" };
}

/**
 * The journal lines since `since` (UTC, "YYYY-MM-DD HH:MM:SS") that carry a mount token's variable name, and as a positive
 * control those carrying an `archil-scoped mount` command line. Counts only; the pattern reaches grep on stdin, through
 * a temporary file (never argv), and no line is printed.
 */
export function journalTokenLines(since: string): { tokenLines: number; mountLines: number } {
  const count = (pattern: string) => {
    const r = spawnSync("bash", ["-c", 'p=$(mktemp); cat > "$p"; sudo -n journalctl --utc --since "$1" --no-pager -o cat </dev/null | /usr/bin/grep -c -F -f "$p"; rm -f "$p"; true', "bash", since], { input: `${pattern}\n`, encoding: "utf8" });
    return Number(r.stdout.trim().split("\n").at(-1) || "0");
  };
  return { tokenLines: count("ARCHIL_MOUNT_TOKEN="), mountLines: count("archil-scoped mount") };
}
