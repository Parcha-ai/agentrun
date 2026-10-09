// The docker live suite's helpers. The ledger ($PDA_DOCKER_STATE, else docker-STATE.json in the live state directory)
// gets every container before it is created, every token user and run directory the moment they exist, and stamps each
// when it is gone. Docker calls that remove or stop anything select by the suite's name prefix and label
// (`pda.fleet=$PDA_DOCKER_FLEET`, default `live`; containers are named `pda-<fleet>-...` and run directories
// `runs/<fleet>-...`): the same Docker daemon may run other containers, which the suite never touches. Identifiers only;
// never a key or a token.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRunDir } from "../../src/claim.ts";
import { scratchDisk } from "./_archil.ts";
import { statePath } from "./_paths.ts";

export const LEDGER = statePath("PDA_DOCKER_STATE", "docker-STATE.json");
export const RESULTS = process.env.PDA_DOCKER_RESULTS ?? join(dirname(LEDGER), "docker-PROBE.json");
export const FLEET = process.env.PDA_DOCKER_FLEET ?? "live";
export const LABEL = `pda.fleet=${FLEET}`;
export const NAME_PREFIX = `pda-${FLEET}`;
/** The image the suite runs (docker/Dockerfile, built from this checkout). */
export const IMAGE = process.env.PDA_DOCKER_IMAGE ?? "pi-durable-disk:local";
/** The run user's uid and gid in the image (docker/Dockerfile); the supervisor creates run directories owned by it. */
export const RUN_UID = 1500;

type Entry = Record<string, unknown>;
type Ledger = {
  suite: string;
  updated: string;
  disk: string;
  images: Entry[];
  containers: Entry[];
  archil: { tokens: Entry[]; subdirs: Entry[] };
  events: Entry[];
  closed: boolean;
};

const now = () => new Date().toISOString();

function load(): Ledger {
  const fresh: Ledger = { suite: FLEET, updated: now(), disk: process.env.PDA_LIVE_DISK ?? "", images: [], containers: [], archil: { tokens: [], subdirs: [] }, events: [], closed: true };
  if (!existsSync(LEDGER)) return fresh;
  const l = JSON.parse(readFileSync(LEDGER, "utf8")) as Partial<Ledger>;
  return { ...fresh, ...l, archil: { ...fresh.archil, ...l.archil } } as Ledger;
}

function update(fn: (l: Ledger) => void): void {
  const l = load();
  fn(l);
  l.updated = now();
  l.closed =
    l.containers.every((c) => c.removedAt) && l.images.every((i) => i.removedAt || i.keep) && l.archil.tokens.every((t) => t.removedAt) && l.archil.subdirs.every((d) => d.deletedAt);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, `${JSON.stringify(l, null, 2)}\n`);
}

const stamp = (list: Entry[], key: string, value: unknown, fields: Entry) => list.filter((e) => e[key] === value).forEach((e) => Object.assign(e, fields));

export const ledger = {
  container(name: string, purpose: string) {
    update((l) => void l.containers.push({ name, purpose, createdAt: now() }));
  },
  containerRemoved(name: string) {
    update((l) => l.containers.filter((c) => c.name === name && !c.removedAt).forEach((c) => Object.assign(c, { removedAt: now() })));
  },
  image(ref: string, purpose: string, extra: Entry = {}) {
    update((l) => void l.images.push({ ref, purpose, createdAt: now(), ...extra }));
  },
  imageRemoved(ref: string) {
    update((l) => l.images.filter((i) => i.ref === ref && !i.removedAt).forEach((i) => Object.assign(i, { removedAt: now() })));
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
};

/** Merge one phase's results into the results file. */
export function record(phase: string, data: Entry): void {
  const all = existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, "utf8")) as Entry) : {};
  all[phase] = { at: now(), ...data };
  writeFileSync(RESULTS, `${JSON.stringify(all, null, 2)}\n`);
}

// ---- docker ----------------------------------------------------------------------------------------------------------

export type Ran = { status: number | null; stdout: string; stderr: string; ms: number };

const ENV = () => ({
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: process.env.HOME ?? "/",
  LANG: "C.UTF-8",
  ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
});

/** One docker CLI call, input on stdin, the secret scrubbed from what comes back. */
export function docker(args: string[], opts: { input?: string; timeoutMs?: number; secret?: string } = {}): Ran {
  const t0 = performance.now();
  const r = spawnSync("docker", args, { env: ENV(), input: opts.input ?? "", encoding: "utf8", timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 << 20 });
  const scrub = (s: string | null) => (opts.secret ? (s ?? "").split(opts.secret).join("<token>") : (s ?? ""));
  return { status: r.status, stdout: scrub(r.stdout), stderr: scrub(r.stderr), ms: performance.now() - t0 };
}

export class NotOursError extends Error {}

const ours = (name: string) => name.startsWith(NAME_PREFIX);

/** `docker run -d` of a container named with the suite's prefix and labeled with its fleet; recorded before it starts. */
export function runContainer(name: string, purpose: string, flags: string[], image: string, cmd: string[] = []): Ran {
  if (!ours(name)) throw new NotOursError(`container ${name} lacks the ${NAME_PREFIX} prefix`);
  ledger.container(name, purpose);
  return docker(["run", "-d", "--name", name, "--label", LABEL, ...flags, image, ...cmd]);
}

/** `docker exec` in one of this suite's containers. */
export function exec(name: string, argv: string[], opts: { input?: string; timeoutMs?: number; secret?: string; user?: string } = {}): Ran {
  if (!ours(name)) throw new NotOursError(`refusing to exec in ${name}`);
  return docker(["exec", ...(opts.input !== undefined ? ["-i"] : []), ...(opts.user ? ["--user", opts.user] : []), name, ...argv], opts);
}

/** Labels of a container, or null when it does not exist. */
function labelsOf(name: string): Record<string, string> | null {
  const r = docker(["inspect", "--type", "container", "--format", "{{json .Config.Labels}}", name]);
  if (r.status !== 0) return null;
  return JSON.parse(r.stdout.trim() || "{}") as Record<string, string>;
}

/** Remove one of this suite's containers (name prefix and label both checked); a missing one counts as removed. */
export function removeContainer(name: string): void {
  if (!ours(name)) throw new NotOursError(`refusing to remove ${name}`);
  const labels = labelsOf(name);
  if (labels && labels["pda.fleet"] !== FLEET) throw new NotOursError(`refusing to remove ${name}: label pda.fleet is ${labels["pda.fleet"]}`);
  if (labels) docker(["rm", "-f", name]);
  if (!labelsOf(name)) ledger.containerRemoved(name);
}

/** Every container carrying this suite's label, any state. */
export function fleetContainers(): string[] {
  const r = docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.Names}}"]);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// ---- archil ----------------------------------------------------------------------------------------------------------

/** A token user for one probe or test step; recorded the moment it exists. */
export async function mint(purpose: string, ttl = "2h"): Promise<{ token: string; identifier: string; nickname: string }> {
  const disk = await scratchDisk();
  const nickname = `${NAME_PREFIX}-${purpose}-${Date.now().toString(36)}`.slice(0, 60);
  const user = await disk.addUser({ type: "token", nickname, ttl });
  if (!user.identifier || !user.token) throw new Error("addUser returned no identifier or token");
  ledger.token(user.identifier, nickname, purpose);
  return { token: user.token, identifier: user.identifier, nickname };
}

export async function unmint(identifier: string): Promise<void> {
  const disk = await scratchDisk();
  await disk.removeUser("token", identifier).catch((err: unknown) => {
    if ((err as { status?: number }).status !== 404) throw err;
  });
  ledger.tokenRemoved(identifier);
}

/** `runs/<id>/` owned by the image's run user, recorded. */
export async function makeRunDir(id: string, purpose: string, uid = RUN_UID): Promise<void> {
  const disk = await scratchDisk();
  await createRunDir(disk, id, { uid, gid: uid });
  ledger.subdir(`runs/${id}/`, purpose);
}

/** Everything under `prefix`: files, then directory markers deepest first; then prove it empty. */
export async function deletePrefix(prefix: string): Promise<{ objects: number; errors: number; left: number }> {
  const disk = await scratchDisk();
  const keys = (await disk.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
  const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])];
  const depth = (k: string) => k.split("/").length;
  let errors = keys.some((k) => !k.endsWith("/")) ? (await disk.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true })).errors.length : 0;
  for (const d of [...new Set(dirs.map(depth))].sort((x, y) => y - x)) {
    errors += (await disk.deleteObjects(dirs.filter((k) => depth(k) === d), { quiet: true })).errors.length;
  }
  const left = (await disk.listObjects(prefix, { recursive: true })).objects.length;
  const result = { objects: keys.length, errors, left };
  if (left === 0 && errors === 0) ledger.subdirDeleted(prefix, JSON.stringify(result));
  return result;
}

/** Delegations on `runs/<id>` and below, as the control API lists them. */
export async function delegationsOn(id: string) {
  const disk = await scratchDisk();
  const path = `runs/${id}`;
  return (await disk.listDelegations()).filter((d) => {
    const p = d.path?.replace(/^\/+/, "");
    return p === path || p?.startsWith(`${path}/`) === true;
  });
}

export async function revokeAll(id: string): Promise<number> {
  const disk = await scratchDisk();
  const held = await delegationsOn(id);
  for (const d of held) await disk.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId });
  return held.length;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
