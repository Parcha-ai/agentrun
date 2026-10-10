// daytonaHost: one Daytona sandbox per instance, created from a snapshot that holds Node, the archil client
// (libfuse2), this package, the run user and the sudoers drop-in for `archil-scoped` and `fusermount -u` (or from a
// default image the caller's `prepare` installs them into). The toolbox's user is root or has passwordless sudo (a
// default Daytona image's `daytona` user). The box runs `daytona-launch.ts`, which keeps the instance alive as the run
// user (the in-box stand-in for systemd: restart in place after a non-terminal exit, never after 0, 65, 70, 75 or 76).
//
// The mount token never travels in argv, an environment variable, a toolbox command string or the sandbox's env (which
// Daytona stores and returns on every read): the driver creates a 0700 staging directory of the toolbox's user, uploads
// the token into it, and the launcher (root) moves it into its root-only directory, reads it, unlinks it and hands it to
// the first incarnation on a pipe to its stdin.
//
// Every sandbox is labeled with its fleet and run, deletes itself when it stops (`autoDeleteInterval: 0`) and is destroyed
// by Daytona after `ttlMinutes` whatever its state, so a start that fails half way, or a driver that dies, leaks nothing
// past that bound. `stop` drains the instance (bounded) and deletes the box, which removes its mounts and every process
// in it, the commands a crashed incarnation detached included. The supervisor holds the API key; boxes never do.
import { DEFAULT_MOUNT_ROOT, runPath, type RunRef } from "../claim.ts";
import { PdaError } from "../errors.ts";
import type { HostDriver, HostHandle, HostStatus } from "../supervise.ts";
import { LAUNCH_DIR, type LaunchSpec, type LaunchState, type LaunchStatus } from "./daytona-launch.ts";
import { TERMINAL_EXITS } from "./local-host.ts";

export const DAYTONA_API_URL = "https://app.daytona.io/api";
export const LABEL_FLEET = "pda-fleet";
export const LABEL_RUN = "pda-run";

// ---- the Daytona API, as much of it as the driver uses ------------------------------------------------------------------

export type SandboxInfo = {
  id: string;
  name: string;
  state?: string;
  snapshot?: string;
  labels?: Record<string, string>;
  target?: string;
  toolboxProxyUrl?: string;
  errorReason?: string;
};

export type CreateSandboxBody = {
  name: string;
  snapshot: string;
  target?: string;
  labels: Record<string, string>;
  autoStopInterval: number;
  autoDeleteInterval: number;
  ttlMinutes?: number;
  networkBlockAll?: boolean;
  networkAllowList?: string;
};

export type ExecResult = { exitCode: number; result: string };

export interface DaytonaClient {
  create(body: CreateSandboxBody): Promise<SandboxInfo>;
  /** By id or name; null when it does not exist. */
  get(idOrName: string): Promise<SandboxInfo | null>;
  list(labels: Record<string, string>): Promise<SandboxInfo[]>;
  /** `force`: SIGKILL instead of SIGTERM. A sandbox that does not exist is not an error. */
  stop(id: string, force: boolean): Promise<void>;
  /** A sandbox that does not exist is not an error. */
  remove(id: string): Promise<void>;
  /** A shell script run by the toolbox's user; stdout and stderr combined. */
  exec(box: SandboxInfo, command: string, timeoutSec: number): Promise<ExecResult>;
  upload(box: SandboxInfo, path: string, content: Uint8Array): Promise<void>;
}

export class DaytonaApiError extends PdaError {
  /** The HTTP status, null when no response arrived (network failure or timeout). */
  readonly status: number | null;
  /** Worth one more attempt: no response, 429 or a 5xx. */
  readonly retryable: boolean;
  constructor(status: number | null, message: string, options: { cause?: unknown } = {}) {
    super("DAYTONA_API_FAILED", message, options);
    this.status = status;
    this.retryable = status === null || status === 429 || status >= 500;
  }
}

export interface DaytonaRestOptions {
  apiKey: string;
  /** Default https://app.daytona.io/api. */
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Per request, for calls that take no explicit timeout. Default 30 s. */
  timeoutMs?: number;
}

/** The REST API with an API key (Bearer). Error messages carry the method, path and status, never a header or a body sent. */
export function daytonaRest(options: DaytonaRestOptions): DaytonaClient {
  if (!options.apiKey) throw new DaytonaHostError("INVALID_ARGUMENT", "a Daytona API key is required");
  const base = (options.apiUrl ?? DAYTONA_API_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const auth = { Authorization: `Bearer ${options.apiKey}`, "X-Daytona-Source": "pi-durable-disk" };
  const proxies = new Map<string, string>();

  async function call(method: string, url: string, init: { json?: unknown; form?: FormData; missingOk?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
    const what = `${method} ${new URL(url).pathname}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: init.json === undefined ? auth : { ...auth, "Content-Type": "application/json" },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
        signal: AbortSignal.timeout(init.timeoutMs ?? options.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new DaytonaApiError(null, `${what}: ${(err as Error).message}`, { cause: err });
    }
    const text = await res.text().catch(() => "");
    if (res.status === 404 && init.missingOk) return null;
    if (!res.ok) throw new DaytonaApiError(res.status, `${what}: ${res.status} ${text.replace(/\s+/g, " ").slice(0, 300)}`);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new DaytonaApiError(res.status, `${what}: the answer is not JSON`, { cause: err });
    }
  }

  const sandboxUrl = (idOrName: string, rest = "") => `${base}/sandbox/${encodeURIComponent(idOrName)}${rest}`;

  async function toolbox(box: SandboxInfo): Promise<string> {
    let proxy = box.toolboxProxyUrl ?? proxies.get(box.id);
    if (!proxy) {
      const r = (await call("GET", sandboxUrl(box.id, "/toolbox-proxy-url"))) as { url?: string } | null;
      if (!r?.url) throw new DaytonaApiError(200, `GET toolbox-proxy-url for ${box.id}: no url in the answer`);
      proxy = r.url;
      proxies.set(box.id, proxy);
    }
    return `${proxy.replace(/\/+$/, "")}/${encodeURIComponent(box.id)}`;
  }

  return {
    async create(body) {
      return (await call("POST", `${base}/sandbox`, { json: body, timeoutMs: 120_000 })) as SandboxInfo;
    },
    async get(idOrName) {
      return (await call("GET", sandboxUrl(idOrName), { missingOk: true })) as SandboxInfo | null;
    },
    async list(labels) {
      const out: SandboxInfo[] = [];
      let cursor: string | null = null;
      do {
        const q = new URLSearchParams({ labels: JSON.stringify(labels), limit: "100", ...(cursor ? { cursor } : {}) });
        const page = (await call("GET", `${base}/sandbox?${q}`)) as { items?: SandboxInfo[]; nextCursor?: string | null } | SandboxInfo[] | null;
        if (Array.isArray(page)) return [...out, ...page];
        out.push(...(page?.items ?? []));
        cursor = page?.nextCursor ?? null;
      } while (cursor);
      return out;
    },
    async stop(id, force) {
      await call("POST", sandboxUrl(id, `/stop${force ? "?force=true" : ""}`), { missingOk: true, timeoutMs: 120_000 });
    },
    async remove(id) {
      await call("DELETE", sandboxUrl(id), { missingOk: true, timeoutMs: 120_000 });
    },
    async exec(box, command, timeoutSec) {
      const r = (await call("POST", `${await toolbox(box)}/process/execute`, { json: { command, timeout: timeoutSec }, timeoutMs: (timeoutSec + 15) * 1000 })) as Partial<ExecResult> | null;
      return { exitCode: typeof r?.exitCode === "number" ? r.exitCode : -1, result: typeof r?.result === "string" ? r.result : "" };
    },
    async upload(box, path, content) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(content)]), "file");
      await call("POST", `${await toolbox(box)}/files/upload-v2?${new URLSearchParams({ path })}`, { form });
    },
  };
}

// ---- the driver ------------------------------------------------------------------------------------------------------

export type DaytonaHostErrorCode = "INVALID_ARGUMENT" | "START_FAILED" | "STOP_FAILED" | "DAYTONA_API_FAILED";

export class DaytonaHostError extends PdaError {
  constructor(code: DaytonaHostErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

export interface DaytonaHostOptions {
  /** The API client; the supervisor builds it with its own key (`daytonaRest`). */
  client: DaytonaClient;
  /** The snapshot every box starts from (its resources come with it). */
  snapshot: string;
  /** The region (`us`, `eu`, a custom region); default the organization's. */
  target?: string;
  /** Names the boxes this driver owns, in their label and in every handle; a handle of another fleet is not its own. */
  fleet?: string;
  /** Box names are `<namePrefix><run id>-<stamp>`. Default "pda-". */
  namePrefix?: string;
  /** Extra labels on every box. */
  labels?: Record<string, string>;
  /** In the box; the same on every host of a deployment. Default /mnt/archil. */
  mountRoot?: string;
  /** Node in the box. Default /usr/local/bin/node. */
  node?: string;
  /** This package, installed (built), in the box. Default /usr/local/lib/pi-durable-disk. */
  packageDir?: string;
  /** The in-box launcher. Default `<packageDir>/dist/hosts/daytona-launch.js`. */
  launcher?: string;
  /** The archil wrapper in the box, root-owned. Default /usr/local/sbin/archil-scoped. */
  archil?: string;
  /** The unprivileged user and group the instance and its tools run as in the box. Default "pda". */
  user?: string;
  group?: string;
  /** The instance program in the box; `run` and its flags are appended. Default: `node` and `<packageDir>/dist/cli.js`. */
  command?: string[];
  /** Extra flags for `run` (an app module, lease periods). */
  runArgs?: string[];
  /** Extra environment for the instance. The driver never copies its own environment (which holds the API keys). */
  env?: Record<string, string>;
  /** Restart in place after a non-terminal exit (default true). */
  restart?: boolean;
  /** Daytona destroys every box this long after creation, whatever its state. Default 25 h (a mount token lives 24 h). */
  ttlMinutes?: number;
  /** Sandbox egress. Default: the organization's (full egress on Tier 3 and 4, which `archil mount` needs). */
  network?: { blockAll?: boolean; allowList?: string };
  /** The launcher's root-only directory in the box. Default /run/pda. */
  boxDir?: string;
  /** Where the toolbox's user uploads (its own, 0700) before the launcher moves the files into `boxDir`. Default /tmp/pda-stage. */
  stageDir?: string;
  /** Run the launcher through `sudo -n` (default true: a default Daytona image's toolbox user is `daytona`, with sudo). */
  sudo?: boolean;
  /** From the create call to the instance spawned. Default 180 s. */
  startTimeoutMs?: number;
  /** How long `stop` lets the instance drain before it deletes the box. Default 30 s. */
  stopTimeoutMs?: number;
  /** Runs once the box is started and before the launcher: installs what the snapshot lacks (a default image). */
  prepare?: (box: SandboxInfo, client: DaytonaClient) => Promise<void>;
  /** Poll period while waiting on a box. Default 1 s. */
  pollMs?: number;
  /** Create attempts on a retryable failure (each first looks the name up, in case the last one landed). Default 3. */
  createAttempts?: number;
  now?: () => number;
}

// Shell-inert characters only: the paths go into launcher command lines. `@` admits npm's scoped package directories.
const BOX_PATH = /^\/[A-Za-z0-9._@/-]+$/;
const ACCOUNT = /^(?:[a-z_][a-z0-9_-]{0,31}|\d{1,10})$/;
const FLEET = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UP = new Set(["creating", "pulling_snapshot", "pending_build", "building_snapshot", "starting", "restoring", "resuming", "resizing", "snapshotting", "forking", "stopping", "pausing", "paused"]);
const DOWN = new Set(["stopped", "archived", "archiving", "destroying"]);
const BROKEN = new Set(["error", "build_failed"]);

/**
 * A sandbox state as a host status; `started` needs the box's own word (`check`). Transitions either way and `paused` (a
 * frozen VM still holding its claim) are running, so the lease decides and STONITH stops them; deletion under way is
 * stopped, deleted is gone.
 */
export function sandboxStatus(state: string | undefined): HostStatus | "check" {
  if (state === "started") return "check";
  if (state === "destroyed") return "gone";
  if (state !== undefined && UP.has(state)) return "running";
  if (state !== undefined && DOWN.has(state)) return "stopped";
  if (state !== undefined && BROKEN.has(state)) return "failed";
  return "unknown";
}

/** A Daytona-safe box name for a run: lowercase, at most 63 characters, unique per call. */
export function sandboxName(prefix: string, runId: string, now: number): string {
  const slug = runId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  const stamp = `${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
  return `${prefix}${slug}-${stamp}`.slice(0, 63);
}

/** The last line of a command's output that parses as JSON, or null. */
function lastJson<T>(text: string): T | null {
  for (const line of text.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line) as T;
    } catch {
      // not this line
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function daytonaHost(opts: DaytonaHostOptions): HostDriver & { readonly fleet: string; readonly mountRoot: string } {
  const client = opts.client;
  const fleet = opts.fleet ?? "pda";
  const prefix = opts.namePrefix ?? "pda-";
  const mountRoot = opts.mountRoot ?? DEFAULT_MOUNT_ROOT;
  const node = opts.node ?? "/usr/local/bin/node";
  const packageDir = opts.packageDir ?? "/usr/local/lib/pi-durable-disk";
  const archil = opts.archil ?? "/usr/local/sbin/archil-scoped";
  const user = opts.user ?? "pda";
  const group = opts.group ?? user;
  const dir = opts.boxDir ?? LAUNCH_DIR;
  const stage = opts.stageDir ?? "/tmp/pda-stage";
  const S = opts.sudo === false ? "" : "sudo -n ";
  const ttlMinutes = opts.ttlMinutes ?? 25 * 60;
  const startTimeoutMs = opts.startTimeoutMs ?? 180_000;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 1_000;
  const createAttempts = opts.createAttempts ?? 3;
  const now = opts.now ?? Date.now;
  const launch = opts.launcher ?? `${packageDir}/dist/hosts/daytona-launch.js`;
  for (const [what, value] of Object.entries({ mountRoot, node, packageDir, archil, boxDir: dir, stageDir: stage, launcher: launch })) {
    if (!BOX_PATH.test(value)) throw new DaytonaHostError("INVALID_ARGUMENT", `${what} ${JSON.stringify(value)} is not a plain absolute path`);
  }
  if (!ACCOUNT.test(user) || !ACCOUNT.test(group)) throw new DaytonaHostError("INVALID_ARGUMENT", "user and group are account names or numeric ids");
  if (user === "root" || user === "0") throw new DaytonaHostError("INVALID_ARGUMENT", "the instance and the agent's tools never run as root");
  if (!FLEET.test(fleet)) throw new DaytonaHostError("INVALID_ARGUMENT", `fleet ${JSON.stringify(fleet)} is not a lowercase label value`);
  if (!opts.snapshot) throw new DaytonaHostError("INVALID_ARGUMENT", "a snapshot is required");
  const command = opts.command ?? [node, `${packageDir}/dist/cli.js`];

  const mine = (h: HostHandle) => h.driver === "daytona" && h.fleet === fleet && typeof h.sandboxId === "string" && typeof h.name === "string";
  const ours = (box: SandboxInfo, runId: string) => box.labels?.[LABEL_FLEET] === fleet && box.labels?.[LABEL_RUN] === runId;
  const launcher = (verb: "start" | "status" | "stop", name: string, timeoutMs?: number) =>
    `${S}${node} ${launch} ${verb} ${name} --dir ${dir}${verb === "start" ? ` --stage ${stage}` : ""}${timeoutMs === undefined ? "" : ` --timeout-ms ${timeoutMs}`}`;

  async function createOrAdopt(body: CreateSandboxBody, runId: string): Promise<SandboxInfo> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.create(body);
      } catch (err) {
        if (err instanceof DaytonaApiError && err.status === 409) {
          // The name is unique per organization and this one is fresh, so a holder is this start's own earlier attempt.
          const box = await client.get(body.name);
          if (box && ours(box, runId)) return box;
          throw new DaytonaHostError("START_FAILED", `a sandbox named ${body.name} exists and is not this start's`, { cause: err });
        }
        if (!(err instanceof DaytonaApiError && err.retryable) || attempt >= createAttempts) {
          throw new DaytonaHostError("START_FAILED", `creating sandbox ${body.name} failed: ${(err as Error).message}`, { cause: err });
        }
        const landed = await client.get(body.name).catch(() => null);
        if (landed && ours(landed, runId)) return landed;
        await sleep(Math.min(pollMs * 2 ** attempt, 10_000));
      }
    }
  }

  async function waitStarted(box: SandboxInfo, deadline: number): Promise<SandboxInfo> {
    for (let current: SandboxInfo | null = box; ; ) {
      if (current?.state === "started") return current;
      const s = current ? sandboxStatus(current.state) : "gone";
      if (s === "gone" || s === "failed" || current?.state === "destroying") {
        throw new DaytonaHostError("START_FAILED", `sandbox ${box.name} went to ${current?.state ?? "deleted"} while starting${current?.errorReason ? `: ${current.errorReason}` : ""}`);
      }
      if (now() >= deadline) throw new DaytonaHostError("START_FAILED", `sandbox ${box.name} did not start in ${startTimeoutMs} ms (last state ${current?.state})`);
      await sleep(pollMs);
      current = await client.get(box.id);
    }
  }

  async function run(box: SandboxInfo, command: string, timeoutSec: number, what: string): Promise<ExecResult> {
    const r = await client.exec(box, command, timeoutSec);
    if (r.exitCode !== 0) throw new DaytonaHostError("START_FAILED", `${what} in ${box.name} exited ${r.exitCode}: ${r.result.trim().split("\n").at(-1)?.slice(0, 300) ?? ""}`);
    return r;
  }

  return {
    fleet,
    mountRoot,

    async start(ref: RunRef, mountToken: string): Promise<HostHandle> {
      runPath(ref.id);
      if (!mountToken) throw new DaytonaHostError("INVALID_ARGUMENT", "no mount token");
      const t0 = now();
      const name = sandboxName(prefix, ref.id, t0);
      const body: CreateSandboxBody = {
        name,
        snapshot: opts.snapshot,
        ...(opts.target ? { target: opts.target } : {}),
        labels: { ...opts.labels, [LABEL_FLEET]: fleet, [LABEL_RUN]: ref.id },
        autoStopInterval: 0,
        autoDeleteInterval: 0,
        ttlMinutes,
        ...(opts.network?.blockAll ? { networkBlockAll: true } : {}),
        ...(opts.network?.allowList ? { networkAllowList: opts.network.allowList } : {}),
      };
      let box = await createOrAdopt(body, ref.id);
      try {
        box = await waitStarted(box, t0 + startTimeoutMs);
        const prepared = now();
        if (opts.prepare) await opts.prepare(box, client);
        const prepareMs = now() - prepared;
        const handle: HostHandle = { driver: "daytona", fleet, target: box.target ?? opts.target ?? null, sandboxId: box.id, name, mountpoint: `${mountRoot}/${runPath(ref.id)}` };
        const spec: LaunchSpec = {
          argv: [...command, "run", "--disk", ref.disk, "--region", ref.region, "--id", ref.id, "--mount-root", mountRoot, "--archil", archil, ...(opts.runArgs ?? []), "--token-stdin"],
          env: { ...opts.env, PDA_HOLDER: JSON.stringify(handle) },
          user,
          group,
          restart: opts.restart !== false,
          terminalExits: [...TERMINAL_EXITS],
        };
        // Both directories first (an upload creates missing parents with the toolbox's default mode): the staging one the
        // toolbox's user's own and 0700, so no other user (the run user above all) can have made it or read from it.
        await run(box, `umask 077 && mkdir -p ${stage} && chmod 700 ${stage} && [ "$(stat -c %u ${stage})" = "$(id -u)" ] && ${S}mkdir -p ${dir} && ${S}chmod 700 ${dir}`, 30, "preparing the launch directories");
        await client.upload(box, `${stage}/${name}.json`, new TextEncoder().encode(JSON.stringify(spec)));
        await client.upload(box, `${stage}/${name}.token`, new TextEncoder().encode(`${mountToken}\n`));
        const left = Math.max(5_000, t0 + prepareMs + startTimeoutMs - now());
        const r = await run(box, launcher("start", name, left), Math.ceil(left / 1000) + 10, "starting the instance");
        const state = lastJson<LaunchState>(r.result);
        if (!state || !(state.spawned > 0)) {
          throw new DaytonaHostError("START_FAILED", `the instance in ${name} did not start: ${state?.reason ?? r.result.trim().slice(0, 300)}`);
        }
        return handle;
      } catch (err) {
        await client.remove(box.id).catch(() => {});
        if (err instanceof DaytonaHostError) throw err;
        throw new DaytonaHostError("START_FAILED", `starting an instance in ${name} failed: ${(err as Error).message}`, { cause: err });
      }
    },

    async status(h: HostHandle): Promise<HostStatus> {
      if (!mine(h)) return "unknown";
      let box: SandboxInfo | null;
      try {
        box = await client.get(h.sandboxId as string);
      } catch (err) {
        throw new DaytonaHostError("DAYTONA_API_FAILED", `reading sandbox ${h.name}: ${(err as Error).message}`, { cause: err });
      }
      if (!box) return "gone";
      // The label, not the id in a handle, decides whose box this is: a handle can never reach another fleet's box.
      if (box.labels?.[LABEL_FLEET] !== fleet) return "unknown";
      const s = sandboxStatus(box.state);
      if (s !== "check") return s;
      // A box we cannot ask is still a live box holding whatever it held: running, so STONITH stops it.
      const r = await client.exec(box, launcher("status", h.name as string), 20).catch(() => null);
      const word = r && r.exitCode === 0 ? lastJson<LaunchStatus>(r.result)?.status : undefined;
      return word === "stopped" || word === "failed" ? word : "running";
    },

    async stop(h: HostHandle): Promise<void> {
      if (!mine(h)) return;
      const id = h.sandboxId as string;
      let box: SandboxInfo | null;
      try {
        box = await client.get(id);
      } catch (err) {
        throw new DaytonaHostError("STOP_FAILED", `reading sandbox ${h.name} to confirm it is this fleet's: ${(err as Error).message}`, { cause: err });
      }
      if (box === null || box.labels?.[LABEL_FLEET] !== fleet) return;
      if (box.state === "started") {
        await client.exec(box, launcher("stop", h.name as string, stopTimeoutMs), Math.ceil(stopTimeoutMs / 1000) + 10).catch(() => null);
      }
      try {
        await client.remove(id);
      } catch (first) {
        // A delete refused mid-transition: power the box off (SIGKILL), then delete again.
        await client.stop(id, true).catch(() => {});
        try {
          await client.remove(id);
        } catch (err) {
          throw new DaytonaHostError("STOP_FAILED", `deleting sandbox ${h.name} failed: ${(err as Error).message}`, { cause: first });
        }
      }
    },
  };
}

/** Delete every box of a fleet (the janitor after a crash of whoever started them); returns what it asked to delete. */
export async function sweepSandboxes(client: DaytonaClient, labels: Record<string, string>): Promise<{ deleted: string[]; failed: { id: string; error: string }[] }> {
  if (!labels[LABEL_FLEET]) throw new DaytonaHostError("INVALID_ARGUMENT", `a sweep needs the ${LABEL_FLEET} label`);
  const out = { deleted: [] as string[], failed: [] as { id: string; error: string }[] };
  for (const box of await client.list(labels)) {
    if (box.labels?.[LABEL_FLEET] !== labels[LABEL_FLEET]) continue;
    await client.remove(box.id).then(
      () => out.deleted.push(box.id),
      (e: unknown) => out.failed.push({ id: box.id, error: (e as Error).message }),
    );
  }
  return out;
}
