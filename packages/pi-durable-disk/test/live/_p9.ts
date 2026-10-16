// The Daytona live helpers. The ledger (P9-STATE.json in $PDA_STATE_DIR) gets every sandbox and snapshot before its create call
// returns, every token user and run directory the moment they exist, and stamps each when it is gone. The guarded Daytona client only
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
  daytona: { sandboxes: Entry[]; snapshots: Entry[] };
  archil: { tokens: Entry[]; subdirs: Entry[] };
  events: Entry[];
  spendUsd: { daytona: number; archil: number };
  closed: boolean;
};

const now = () => new Date().toISOString();

function load(): Ledger {
  const fresh: Ledger = { lane: "P9", phase: 1, updated: now(), note: "", daytona: { sandboxes: [], snapshots: [] }, archil: { tokens: [], subdirs: [] }, events: [], spendUsd: { daytona: 0, archil: 0 }, closed: true };
  if (!existsSync(LEDGER)) return fresh;
  const l = JSON.parse(readFileSync(LEDGER, "utf8")) as Partial<Ledger> & { phase?: number };
  if (l.phase === 0) return { ...fresh, note: "Phase 0 was desk only; phase 1 starts here." };
  return { ...fresh, ...l, daytona: { snapshots: [], ...l.daytona } } as Ledger;
}

function update(fn: (l: Ledger) => void): void {
  const l = load();
  fn(l);
  l.updated = now();
  l.spendUsd.daytona = Math.round(spendOf(l) * 10000) / 10000;
  // A snapshot kept on purpose (for the next take) is open but named: `kept` says who uses it.
  l.closed =
    l.daytona.sandboxes.every((s) => s.deletedAt || s.createFailedAt) &&
    l.daytona.snapshots.every((s) => s.deletedAt || s.failedAt || s.kept) &&
    l.archil.tokens.every((t) => t.removedAt) &&
    l.archil.subdirs.every((d) => d.deletedAt);
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
  snapshotCreating(name: string, commit: string, purpose: string) {
    update((l) => void l.daytona.snapshots.push({ name, commit, purpose, createdAt: now() }));
  },
  snapshotSettled(name: string, fields: Entry) {
    update((l) => stamp(l.daytona.snapshots, "name", name, fields));
  },
  snapshotDeleted(name: string) {
    update((l) => stamp(l.daytona.snapshots, "name", name, { deletedAt: now() }));
  },
  snapshotNames(): Set<string> {
    return new Set(load().daytona.snapshots.filter((s) => !s.deletedAt).map((s) => String(s.name)));
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

// ---- the box's runtime (a default Daytona image gets it at boot, or a snapshot built from it already holds it) ------------

export const NODE = "/opt/node24/bin/node";
export const PACKAGE_DIR = "/usr/local/lib/pi-durable-disk";
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

/**
 * How the box installs the package's dependencies in PACKAGE_DIR (with `--prefix`). `npm install`, not `npm ci`: the
 * directory is this package's working tree (`packageTarball`), whose lockfile is the workspace's, at the repository root,
 * so it has none, and `npm ci` refuses a directory without one.
 */
export const PACKAGE_INSTALL = ["npm", "install", "--no-audit", "--no-fund", "--loglevel=error"] as const;

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
sudo -n env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root ${PACKAGE_INSTALL.join(" ")} --prefix ${PACKAGE_DIR} >/dev/null
sudo -n chown -R root:root ${PACKAGE_DIR}
sudo -n chmod -R a+rX,go-w ${PACKAGE_DIR}
step package
sudo -n install -o root -g root -m 0755 ${PACKAGE_DIR}/bin/archil-scoped ${ARCHIL_WRAPPER}
printf '%s\n' 'pda ALL=(root) NOPASSWD: ${ARCHIL_WRAPPER}, /usr/bin/fusermount -u ${MOUNT_ROOT}/runs/*' | sudo -n tee /etc/sudoers.d/pi-durable-disk >/dev/null
sudo -n chmod 0440 /etc/sudoers.d/pi-durable-disk
sudo -n visudo -cf /etc/sudoers.d/pi-durable-disk >/dev/null
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

// ---- a snapshot with the runtime built in, so a takeover box starts in seconds -------------------------------------------

/**
 * The image `daytona-medium` runs. A snapshot built on it shares its layers (which Daytona's runners already hold, so a
 * box pulls only the runtime on top) and its toolbox user `daytona`, with sudo, so every daytonaHost option stays as is.
 */
export const SNAPSHOT_BASE = "daytonaio/sandbox:0.9.0";
/** `daytona-medium`'s resources: a box from the snapshot is priced as one from it. */
export const SNAPSHOT_RESOURCES = { cpu: 2, memory: 4, disk: 8 } as const;
/** In the snapshot: the hash of the dependency fields its node_modules were installed for. */
const DEPS_STAMP = `${PACKAGE_DIR}/node_modules/.pda-deps.sha256`;
/** Prints the hash of a package.json's dependency fields (sorted), with the box's node; the file is the argument. */
const DEPS_HASH = `${NODE} -e 'const p=require(process.argv[1]);const f=["dependencies","devDependencies","peerDependencies","optionalDependencies"];process.stdout.write(require("node:crypto").createHash("sha256").update(JSON.stringify(f.map((k)=>Object.entries(p[k]||{}).sort()))).digest("hex"))'`;

/**
 * The snapshot's Dockerfile: on SNAPSHOT_BASE, the same runtime PREPARE installs at boot (Node and archil sha256-checked,
 * the run user, the wrapper, the sudoers drop-in, the mount root), and the package's dependencies, installed from its
 * package.json at `commit` of the public repository. It needs no build context. The package itself (its source and
 * dist) still comes from the checkout at boot (`prepareOnSnapshot`), over the snapshot's node_modules.
 */
export function snapshotDockerfile(commit: string, options: { readonly demo?: boolean } = {}): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`the snapshot pins a full commit sha, not ${JSON.stringify(commit)}`);
  // The demo variant keeps npm's cache: a box's offline install still resolves its explicit specs (DEMO_EXTRA) there.
  const dropCache = options.demo ? "" : "rm -rf /root/.npm; ";
  return [
    `FROM ${SNAPSHOT_BASE}`,
    "USER root",
    `RUN set -eu; cd /tmp; curl -fsSLo node.tar.xz ${NODE_URL}; echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c -; install -d -m 0755 /opt/node24; tar -xJf node.tar.xz -C /opt/node24 --strip-components=1; chmod -R a+rX /opt/node24; rm -f node.tar.xz`,
    `RUN set -eu; cd /tmp; curl -fsSLo archil.deb ${ARCHIL_URL}; echo "${ARCHIL_SHA256}  archil.deb" | sha256sum -c -; apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libfuse2t64 fuse3 /tmp/archil.deb; rm -rf /var/lib/apt/lists/* /tmp/archil.deb`,
    `RUN groupadd --gid ${PDA_ID} pda && useradd --uid ${PDA_ID} --gid ${PDA_ID} --create-home --shell /bin/bash pda`,
    `RUN set -eu; install -d -m 0755 ${PACKAGE_DIR}; curl -fsSLo ${PACKAGE_DIR}/package.json https://raw.githubusercontent.com/Parcha-ai/agentrun/${commit}/packages/pi-durable-disk/package.json; curl -fsSLo ${ARCHIL_WRAPPER} https://raw.githubusercontent.com/Parcha-ai/agentrun/${commit}/packages/pi-durable-disk/bin/archil-scoped; env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root ${PACKAGE_INSTALL.join(" ")} --prefix ${PACKAGE_DIR}; ${DEPS_HASH} ${PACKAGE_DIR}/package.json > ${DEPS_STAMP}; ${dropCache}chown -R root:root ${PACKAGE_DIR}; chmod -R a+rX,go-w ${PACKAGE_DIR}`,
    ...(options.demo ? [demoClosureRun(commit)] : []),
    `RUN set -eu; chown root:root ${ARCHIL_WRAPPER}; chmod 0755 ${ARCHIL_WRAPPER}; printf '%s\\n' 'pda ALL=(root) NOPASSWD: ${ARCHIL_WRAPPER}, /usr/bin/fusermount -u ${MOUNT_ROOT}/runs/*' > /etc/sudoers.d/pi-durable-disk; chmod 0440 /etc/sudoers.d/pi-durable-disk; visudo -cf /etc/sudoers.d/pi-durable-disk; install -d -m 0755 /mnt/pda ${MOUNT_ROOT}; install -d -o pda -g pda -m 0755 ${MOUNT_ROOT}/runs ${APP_OUT}`,
    "USER daytona",
    "",
  ].join("\n");
}

// ---- the demo variant: what the disk demo's box installs besides this package, baked in ---------------------------------

/** The workspace packages the disk demo's box installs from this checkout's tarballs, by directory under packages/. */
export const DEMO_PACKS = ["dsl", "pi", "pi-browser", "pi-vision", "pi-transport"] as const;
/** What the demo's box installs from npm with them. */
export const DEMO_EXTRA = ["@earendil-works/pi-codemode@1.1.0"] as const;
const DEMO_STUBS = "/opt/pda-demo/stubs";

type LockEntry = { version?: string; link?: boolean; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };

const gitShow = (commit: string, path: string): string => {
  const r = spawnSync("git", ["show", `${commit}:${path}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git show ${commit}:${path}: ${r.stderr.trim()}`);
  return r.stdout;
};

/**
 * The demo packs' third-party dependency closure at `commit`, from their package.json files and the workspace lockfile:
 * `stubs`, each pack's package.json cut to its name, version and dependency fields (installed in the snapshot as stand-ins
 * the box's own tarballs replace), and `pins`, every package of the closure the lockfile resolves to one version, at that
 * version (npm overrides), so the snapshot holds the lockfile's versions. A name the lockfile has at several versions
 * (typebox, pinned exactly by each pack) is left to npm, which nests it as the lockfile does. A workspace package that is
 * not a pack (`@parcha/agentrun-jev`) comes from npm at its version, as it does in the box.
 */
export function demoClosure(commit: string): { stubs: Record<string, Record<string, unknown>>; pins: Record<string, string> } {
  const lock = (JSON.parse(gitShow(commit, "package-lock.json")) as { packages: Record<string, LockEntry> }).packages;
  const stubs: Record<string, Record<string, unknown>> = {};
  const packNames = new Set<string>();
  for (const dir of DEMO_PACKS) {
    const pkg = JSON.parse(gitShow(commit, `packages/${dir}/package.json`)) as Record<string, unknown>;
    packNames.add(String(pkg.name));
    stubs[dir] = Object.fromEntries(["name", "version", "dependencies", "peerDependencies", "peerDependenciesMeta", "optionalDependencies"].filter((k) => pkg[k] !== undefined).map((k) => [k, pkg[k]]));
  }
  // Node's lookup over the lockfile's paths: <from>/node_modules/<name>, then each parent's, then the root's.
  const find = (from: string, name: string): string | undefined => {
    for (let dir = from; ; ) {
      const key = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
      if (lock[key]) return key;
      if (!dir) return undefined;
      const i = dir.lastIndexOf("/node_modules/");
      dir = i >= 0 ? dir.slice(0, i) : "";
    }
  };
  const versions = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const walk = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const entry = lock[key]!;
    const optionalPeer = (name: string) => entry.peerDependenciesMeta?.[name]?.optional === true;
    const names = [...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...Object.keys(entry.peerDependencies ?? {}).filter((n) => !optionalPeer(n))];
    for (const name of names) {
      if (packNames.has(name)) continue;
      const at = find(key, name);
      if (!at) continue; // an optional dependency the lockfile did not install (another platform's)
      const dep = lock[at]!;
      if (dep.link) {
        // Another workspace package: the box gets it from npm, at the version the workspace has.
        const target = lock[String((dep as { resolved?: string }).resolved ?? "")];
        if (target?.version) (versions.get(name) ?? versions.set(name, new Set()).get(name)!).add(target.version);
        continue;
      }
      if (dep.version) (versions.get(name) ?? versions.set(name, new Set()).get(name)!).add(dep.version);
      walk(at);
    }
  };
  for (const dir of DEMO_PACKS) walk(`packages/${dir}`);
  const pins = Object.fromEntries([...versions].filter(([, v]) => v.size === 1).map(([name, v]) => [name, [...v][0]!]).sort(([a], [b]) => a.localeCompare(b)));
  return { stubs, pins };
}

/** The demo variant's one extra layer: the stubs and DEMO_EXTRA installed over the package's own dependencies, pinned by `demoClosure`. */
function demoClosureRun(commit: string): string {
  const { stubs, pins } = demoClosure(commit);
  const disk = JSON.parse(gitShow(commit, "packages/pi-durable-disk/package.json")) as Record<string, Record<string, string>>;
  const direct: Record<string, string> = { ...disk.dependencies, ...disk.devDependencies };
  for (const dir of DEMO_PACKS) direct[String(stubs[dir]!.name)] = `file:${DEMO_STUBS}/${dir}`;
  for (const spec of DEMO_EXTRA) {
    const at = spec.lastIndexOf("@");
    direct[spec.slice(0, at)] = spec.slice(at + 1);
  }
  // npm refuses an override of a direct dependency that differs from it; the direct ones stay as declared.
  const overrides = Object.fromEntries(Object.entries(pins).filter(([name]) => !(name in direct)));
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  const writeStubs = DEMO_PACKS.map((dir) => `mkdir -p ${DEMO_STUBS}/${dir}; echo ${b64(stubs[dir])} | base64 -d > ${DEMO_STUBS}/${dir}/package.json`).join("; ");
  const root = { name: "pda-demo-closure", private: true, dependencies: direct, overrides };
  // The package's own package.json goes back after, so its dependency stamp (and prepareOnSnapshot's check) is unchanged.
  return `RUN set -eu; ${writeStubs}; cp ${PACKAGE_DIR}/package.json /tmp/disk-package.json; echo ${b64(root)} | base64 -d > ${PACKAGE_DIR}/package.json; env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root ${PACKAGE_INSTALL.join(" ")} --install-links --prefix ${PACKAGE_DIR}; mv /tmp/disk-package.json ${PACKAGE_DIR}/package.json; rm -f ${PACKAGE_DIR}/package-lock.json; chown -R root:root ${PACKAGE_DIR}; chmod -R a+rX,go-w ${PACKAGE_DIR}`;
}

/**
 * The demo's install on a box from the demo variant: this checkout's packs (DEMO_PACKS, packed by the caller) and
 * DEMO_EXTRA, offline, over the closure the snapshot holds; then only what it installed is made root-owned and
 * world-readable (the snapshot's node_modules already is). `offline: false` is the same install with the network, for a
 * box from the plain snapshot.
 */
export async function installDemoPacks(client: DaytonaClient, box: SandboxInfo, tarballs: readonly string[], options: { readonly offline?: boolean } = {}): Promise<{ ms: number; steps: Record<string, number> }> {
  const t0 = performance.now();
  const steps: Record<string, number> = {};
  const lap = (name: string) => (steps[name] = Math.round(performance.now() - t0));
  await sh(client, box, "rm -rf /tmp/packs && mkdir -p /tmp/packs");
  for (const file of tarballs) await client.upload(box, `/tmp/packs/${file.split("/").at(-1)}`, new Uint8Array(readFileSync(file)));
  lap("upload");
  const names = DEMO_PACKS.map((dir) => String(JSON.parse(readFileSync(new URL(`../../../${dir}/package.json`, import.meta.url), "utf8")).name)).concat(DEMO_EXTRA.map((s) => s.slice(0, s.lastIndexOf("@"))));
  await sh(client, box, `set -euo pipefail
sudo -n env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root ${PACKAGE_INSTALL.join(" ")} --prefix ${PACKAGE_DIR} --no-save ${options.offline === false ? "" : "--offline"} /tmp/packs/*.tgz ${DEMO_EXTRA.join(" ")} >/dev/null`, 900);
  lap("npm");
  await sh(client, box, `set -euo pipefail
cd ${PACKAGE_DIR}/node_modules && sudo -n chown -R root:root ${names.join(" ")} && sudo -n chmod -R a+rX,go-w ${names.join(" ")}
rm -rf /tmp/packs`);
  lap("chown");
  return { ms: Math.round(performance.now() - t0), steps };
}

/**
 * What a box from the snapshot does at boot: the checkout's package source replaces the snapshot's (its node_modules
 * stay), `npm install` runs only when the dependency fields differ from the ones the snapshot installed, and the wrapper
 * is installed again from the checkout. A box without the snapshot's runtime fails here, never half prepared.
 */
const PREPARE_ON_SNAPSHOT = String.raw`
set -euo pipefail
t0=$(date +%s%N)
step() { printf 'step\t%s\t%s\n' "$1" $(( ($(date +%s%N) - t0) / 1000000 )); }
[ -x ${NODE} ] && command -v archil >/dev/null && [ -f ${DEPS_STAMP} ] && id pda >/dev/null 2>&1 || { echo "this box is not from the runtime snapshot (no node, archil, deps stamp or pda)" >&2; exit 3; }
sudo -n find ${PACKAGE_DIR} -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
sudo -n tar -xzf /tmp/pda-pkg.tar.gz -C ${PACKAGE_DIR} --no-same-owner
rm -f /tmp/pda-pkg.tar.gz
sudo -n find ${PACKAGE_DIR} -path ${PACKAGE_DIR}/node_modules -prune -o -exec chmod a+rX,go-w {} +
step package
want=$(${DEPS_HASH} ${PACKAGE_DIR}/package.json)
if [ "$want" != "$(cat ${DEPS_STAMP})" ]; then
  sudo -n env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root ${PACKAGE_INSTALL.join(" ")} --prefix ${PACKAGE_DIR} >/dev/null
  printf '%s' "$want" | sudo -n tee ${DEPS_STAMP} >/dev/null
  sudo -n chown -R root:root ${PACKAGE_DIR}/node_modules
  printf 'deps\tinstalled\n'
else
  printf 'deps\tfrom the snapshot\n'
fi
step deps
sudo -n install -o root -g root -m 0755 ${PACKAGE_DIR}/bin/archil-scoped ${ARCHIL_WRAPPER}
step setup
printf 'archil\t%s\n' "$(archil --version 2>&1 | head -1)"
printf 'node\t%s\n' "$(${NODE} --version)"
printf 'pda\t%s\n' "$(id pda)"
printf 'user\t%s\n' "$(id -un)"
`;

/** prepareBox for a box from the runtime snapshot: the same result, in seconds (see PREPARE_ON_SNAPSHOT). */
export async function prepareOnSnapshot(client: DaytonaClient, box: SandboxInfo): Promise<{ ms: number; steps: Record<string, number>; versions: Record<string, string> }> {
  const t0 = performance.now();
  await client.upload(box, "/tmp/pda-pkg.tar.gz", packageTarball());
  const out = await sh(client, box, PREPARE_ON_SNAPSHOT, 900);
  const steps: Record<string, number> = {};
  const versions: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [k, a, b] = line.split("\t");
    if (k === "step") steps[a] = Number(b);
    else if (a !== undefined && ["archil", "node", "pda", "deps", "user"].includes(k)) versions[k] = a;
  }
  return { ms: Math.round(performance.now() - t0), steps, versions };
}

/** The organization's snapshot API (the guarded box client has none): this lane only creates, reads and deletes its own. */
async function snapshotApi(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; json: Entry }> {
  const base = (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, "");
  const res = await fetch(`${base}/snapshots${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.DAYTONA_API_KEY}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text().catch(() => "");
  let json: Entry = {};
  try {
    json = text ? (JSON.parse(text) as Entry) : {};
  } catch {
    json = { message: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

/** What a snapshot's record says that is not the organization's: name, state, size (GiB), resources, error. */
const snapshotFacts = (s: Entry) => ({ name: s.name, state: s.state, size: s.size, cpu: s.cpu, mem: s.mem, disk: s.disk, errorReason: s.errorReason ?? null });

/** One of this lane's snapshots, or null when it does not exist. */
export async function getSnapshot(name: string): Promise<ReturnType<typeof snapshotFacts> | null> {
  const r = await snapshotApi("GET", `/${encodeURIComponent(name)}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`GET snapshot ${name}: ${r.status} ${String(r.json.message ?? "").slice(0, 200)}`);
  return snapshotFacts(r.json);
}

/**
 * Build the runtime snapshot from `snapshotDockerfile(commit)` under a new name of this lane's (NAME_PREFIX), never one
 * that exists (a default or another lane's is never overwritten), and wait until it is active or failed.
 */
export async function buildSnapshot(name: string, commit: string, options: { readonly demo?: boolean; readonly timeoutMs?: number } = {}): Promise<{ facts: ReturnType<typeof snapshotFacts>; ms: number }> {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  if (!name.startsWith(NAME_PREFIX) || !/^[a-z0-9-]+$/.test(name)) throw new NotOursError(`a lane snapshot is named ${NAME_PREFIX}<lowercase, digits, dashes>, not ${name}`);
  if (await getSnapshot(name)) throw new NotOursError(`snapshot ${name} exists: a snapshot is built once under a new name, never over one`);
  const t0 = performance.now();
  const dockerfileContent = snapshotDockerfile(commit, { demo: options.demo === true });
  ledger.snapshotCreating(name, commit, options.demo ? "runtime snapshot, demo variant" : "runtime snapshot");
  const created = await snapshotApi("POST", "", { name, buildInfo: { dockerfileContent, contextHashes: [] }, ...SNAPSHOT_RESOURCES });
  if (created.status >= 300) {
    ledger.snapshotSettled(name, { failedAt: now(), error: `${created.status} ${String(created.json.message ?? "").slice(0, 200)}` });
    throw new Error(`POST snapshot ${name}: ${created.status} ${String(created.json.message ?? "").slice(0, 300)}`);
  }
  for (;;) {
    const facts = await getSnapshot(name);
    const state = String(facts?.state ?? "missing");
    const settled = state === "active" || state === "error" || state === "build_failed";
    if (settled || performance.now() - t0 > timeoutMs) {
      const ms = Math.round(performance.now() - t0);
      // A build still running when the wait ends stays open (it may yet become active, and is billed): only a failed
      // build is closed. Delete it, or mark it kept, by hand.
      const outcome = state === "active" ? {} : settled ? { failedAt: now(), error: facts?.errorReason ?? state } : { timedOutAt: now() };
      ledger.snapshotSettled(name, { state, size: facts?.size ?? null, buildMs: ms, ...outcome });
      return { facts: facts ?? snapshotFacts({ name, state }), ms };
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/** Delete one of this lane's snapshots, by the name its ledger recorded. */
export async function deleteSnapshot(name: string): Promise<number> {
  if (!name.startsWith(NAME_PREFIX) || !ledger.snapshotNames().has(name)) throw new NotOursError(`refusing to delete snapshot ${name}: not one this lane built`);
  const r = await snapshotApi("DELETE", `/${encodeURIComponent(name)}`);
  if (r.status < 300 || r.status === 404) ledger.snapshotDeleted(name);
  return r.status;
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
