// modalHost: one Modal sandbox per instance. It is `daytonaHost` over a Modal-backed client: the in-box launcher
// (`daytona-launch.ts`), the staged mount token, the restart rules, the fleet and run labels (Modal sandbox tags) and the
// start/status/stop contract are all that driver's, because a Modal sandbox is the same shape of host (an image with
// Node, the archil client, this package and the run user; commands run in it as root through an exec API; no systemd).
//
// What differs, and is handled here:
//   Runtime. `vm` is a VM with its own kernel: `/dev/fuse` exists and `archil mount` works, so a VM host mounts the
//     disk like any other FUSE client. `gvisor` (the only runtime Modal offers GPUs on) may not mount FUSE; for such a
//     host pass `command` to run the agent some other way (through a pipe) and the launcher still keeps it alive.
//   Lifetime. A sandbox is destroyed by Modal at its timeout (at most 24 h) whatever its state, which bounds a leak from a
//     driver that died; `stop` terminates it, which removes its mounts and every process in it.
//   Names are unique per app among live sandboxes (a duplicate is the 409 the driver already adopts), and a terminated
//     sandbox is looked up by id as exited and by name as absent.
//   Tags are set right after create. A crash between the two leaves an untagged box that no handle names; the timeout is
//     its bound and the name prefix lets a janitor find it.
// The Modal SDK is a structural dependency (`ModalSdk`): the package never imports it, the caller passes its `ModalClient`
// (Node 22 or later). The mount token never leaves the staged-file path of `daytonaHost`; the Modal API key stays with the
// caller's client.
import { DaytonaApiError, daytonaHost, type CreateSandboxBody, type DaytonaClient, type DaytonaHostOptions, type ExecResult, type SandboxInfo } from "./daytona.ts";
import type { HostDriver } from "../supervise.ts";

export const MODAL_MAX_TIMEOUT_MS = 24 * 3_600_000;

// ---- the part of the Modal SDK the driver uses ----------------------------------------------------------------------------

export interface ModalProcess {
  stdin: { writeBytes(bytes: Uint8Array): Promise<void>; close(): Promise<void> };
  stdout: { readBytes(): Promise<Uint8Array> };
  stderr: { readBytes(): Promise<Uint8Array> };
  wait(): Promise<number>;
}

export interface ModalSandbox {
  readonly sandboxId: string;
  exec(command: string[], params: { mode: "binary"; timeoutMs?: number }): Promise<ModalProcess>;
  /** null while it runs, its exit code once it has ended. */
  poll(): Promise<number | null>;
  terminate(): Promise<void>;
  setTags(tags: Record<string, string>): Promise<void>;
  getTags(): Promise<Record<string, string>>;
}

export interface ModalCreateParams {
  name: string;
  runtime?: "vm" | "gvisor";
  gpu?: string;
  cpu?: number;
  memoryMiB?: number;
  regions?: string[];
  timeoutMs: number;
  blockNetwork?: boolean;
  outboundCidrAllowlist?: string[];
  encryptedPorts?: number[];
  unencryptedPorts?: number[];
  /** Mount path -> a Modal Volume object (resolved by name from `ModalSandboxesOptions.volumes`). */
  volumes?: Record<string, unknown>;
  [more: string]: unknown;
}

export interface ModalSdk {
  apps: { fromName(name: string, params: { createIfMissing: boolean }): Promise<{ appId: string }> };
  images: { fromRegistry(tag: string): unknown; fromId(id: string): Promise<unknown> };
  /** Only needed with `volumes` (a named Modal Volume mounted into each sandbox). */
  volumes?: { fromName(name: string, params?: { createIfMissing?: boolean }): Promise<unknown> };
  sandboxes: {
    create(app: { appId: string }, image: unknown, params: ModalCreateParams): Promise<ModalSandbox>;
    fromId(id: string): Promise<ModalSandbox>;
    fromName(appName: string, name: string): Promise<ModalSandbox>;
    list(params: { appId: string; tags: Record<string, string> }): AsyncIterable<ModalSandbox>;
  };
}

export interface ModalSandboxesOptions {
  /** The Modal app the driver's sandboxes live in (created if missing). */
  appName: string;
  /** A registry tag (`ubuntu:24.04`), a Modal image id (`im-...`), or a function returning an SDK Image. Resolved once. */
  image: string | (() => unknown | Promise<unknown>);
  runtime?: "vm" | "gvisor";
  gpu?: string;
  cpu?: number;
  memoryMiB?: number;
  /** Where Modal may place the sandbox (`["us-east"]`): near the disk, a mount's round trip is a few ms instead of tens. */
  regions?: string[];
  /** Ports the sandbox exposes (an SDK create parameter): for a desktop or an event stream. */
  encryptedPorts?: number[];
  unencryptedPorts?: number[];
  /** Modal Volumes to mount, by mount path (`{ "/vol": "pda-weights" }`): the volume is looked up by name once and must already exist. */
  volumes?: Record<string, string>;
  /** Anything else `sandboxes.create` accepts, passed through unchanged. */
  create?: Record<string, unknown>;
}

const errorName = (err: unknown) => (err as { constructor?: { name?: string } })?.constructor?.name ?? "";
const isNotFound = (err: unknown) => errorName(err) === "NotFoundError" || (err as { code?: unknown })?.code === "NOT_FOUND";

function apiError(what: string, err: unknown): DaytonaApiError {
  const name = errorName(err);
  const text = `${what}: ${name ? `${name}: ` : ""}${(err as Error)?.message ?? String(err)}`.replace(/\s+/g, " ").slice(0, 300);
  if (name === "AlreadyExistsError") return new DaytonaApiError(409, text, { cause: err });
  if (name === "ResourceExhaustedError") return new DaytonaApiError(429, text, { cause: err });
  if (name === "InvalidError" || name === "NotFoundError") return new DaytonaApiError(400, text, { cause: err });
  // Everything else (a dropped connection, an internal failure, a timeout) is worth one more attempt.
  return new DaytonaApiError(null, text, { cause: err });
}

/** The Modal SDK as the client `daytonaHost` drives. A sandbox is `started` from the moment `create` returns. */
export function modalSandboxes(sdk: ModalSdk, options: ModalSandboxesOptions): DaytonaClient {
  const names = new Map<string, string>();
  const handles = new Map<string, ModalSandbox>();
  // The tags this client means to put on a name it is creating. A create whose answer was lost can leave a sandbox that is
  // not tagged yet; the retry's lookup of that name finishes the tagging, so the driver adopts it instead of failing on a 409.
  const intended = new Map<string, Record<string, string>>();
  const tagged = new Map<string, Record<string, string>>();
  let app: Promise<{ appId: string }> | undefined;
  let image: Promise<unknown> | undefined;
  const theApp = () => (app ??= sdk.apps.fromName(options.appName, { createIfMissing: true }));
  let mounts: Promise<Record<string, unknown>> | undefined;
  const theVolumes = () =>
    (mounts ??= (async () => {
      if (!sdk.volumes) throw new Error("this Modal SDK has no volumes API");
      const out: Record<string, unknown> = {};
      for (const [path, name] of Object.entries(options.volumes ?? {})) out[path] = await sdk.volumes!.fromName(name, { createIfMissing: false });
      return out;
    })());
  const theImage = () =>
    (image ??= Promise.resolve(
      typeof options.image === "function" ? options.image() : options.image.startsWith("im-") ? sdk.images.fromId(options.image) : sdk.images.fromRegistry(options.image),
    ));

  const info = (box: ModalSandbox, labels: Record<string, string>, state: string, name?: string): SandboxInfo => ({
    id: box.sandboxId,
    name: name ?? names.get(box.sandboxId) ?? box.sandboxId,
    state,
    snapshot: typeof options.image === "string" ? options.image : "image",
    labels,
  });

  async function handle(id: string): Promise<ModalSandbox> {
    const known = handles.get(id);
    if (known) return known;
    const box = await sdk.sandboxes.fromId(id).catch((err: unknown) => {
      throw apiError(`sandbox ${id}`, err);
    });
    handles.set(id, box);
    return box;
  }

  async function lookup(idOrName: string): Promise<ModalSandbox | null> {
    try {
      const box = idOrName.startsWith("sb-") ? await sdk.sandboxes.fromId(idOrName) : await sdk.sandboxes.fromName(options.appName, idOrName);
      handles.set(box.sandboxId, box);
      return box;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw apiError(`looking up sandbox ${idOrName}`, err);
    }
  }

  async function terminate(id: string): Promise<void> {
    let box: ModalSandbox;
    try {
      box = await handle(id);
    } catch (err) {
      if (err instanceof DaytonaApiError && err.status === 400) return;
      throw err;
    }
    try {
      await box.terminate();
    } catch (err) {
      if (isNotFound(err)) return;
      throw apiError(`terminating sandbox ${id}`, err);
    }
    handles.delete(id);
  }

  return {
    async create(body: CreateSandboxBody) {
      const params: ModalCreateParams = {
        ...options.create,
        name: body.name,
        ...(options.runtime ? { runtime: options.runtime } : {}),
        ...(options.gpu ? { gpu: options.gpu } : {}),
        ...(options.cpu ? { cpu: options.cpu } : {}),
        ...(options.memoryMiB ? { memoryMiB: options.memoryMiB } : {}),
        ...(options.regions ? { regions: options.regions } : {}),
        ...(options.encryptedPorts ? { encryptedPorts: options.encryptedPorts } : {}),
        ...(options.unencryptedPorts ? { unencryptedPorts: options.unencryptedPorts } : {}),
        ...(options.volumes && Object.keys(options.volumes).length > 0 ? { volumes: await theVolumes() } : {}),
        timeoutMs: Math.min(Math.max(1, body.ttlMinutes ?? 60) * 60_000, MODAL_MAX_TIMEOUT_MS),
        ...(body.networkBlockAll ? { blockNetwork: true } : {}),
        ...(body.networkAllowList ? { outboundCidrAllowlist: body.networkAllowList.split(",").map((c) => c.trim()).filter(Boolean) } : {}),
      };
      let box: ModalSandbox;
      intended.set(body.name, body.labels);
      try {
        box = await sdk.sandboxes.create(await theApp(), await theImage(), params);
      } catch (err) {
        // Kept: the sandbox may exist (AlreadyExists after a lost answer) and `get` tags it for the retry.
        throw apiError(`creating sandbox ${body.name}`, err);
      }
      names.set(box.sandboxId, body.name);
      handles.set(box.sandboxId, box);
      try {
        await box.setTags(body.labels);
      } catch (err) {
        // A box without its tags is nobody's: the driver could never tell whose it is.
        intended.delete(body.name);
        await box.terminate().catch(() => {});
        throw apiError(`tagging sandbox ${body.name}`, err);
      }
      intended.delete(body.name);
      tagged.set(box.sandboxId, body.labels);
      return info(box, body.labels, "started", body.name);
    },

    async get(idOrName) {
      const box = await lookup(idOrName);
      if (!box) return null;
      let exit: number | null;
      let labels: Record<string, string>;
      try {
        exit = await box.poll();
        // An ended sandbox keeps its tags if Modal still answers for it; otherwise this client's own record of them stands, so
        // the driver sees a sandbox of its fleet that is gone rather than one it cannot place.
        labels = await box.getTags().catch((err: unknown) => {
          if (exit === null) throw err;
          return {};
        });
        if (Object.keys(labels).length === 0 && exit !== null) labels = tagged.get(box.sandboxId) ?? {};
        const meant = intended.get(idOrName);
        if (exit === null && meant && Object.keys(labels).length === 0) {
          await box.setTags(meant);
          labels = meant;
          tagged.set(box.sandboxId, meant);
          names.set(box.sandboxId, idOrName);
          intended.delete(idOrName);
        }
      } catch (err) {
        throw apiError(`reading sandbox ${idOrName}`, err);
      }
      return info(box, labels, exit === null ? "started" : "destroyed");
    },

    async list(labels) {
      const out: SandboxInfo[] = [];
      try {
        const app = await theApp();
        for await (const box of sdk.sandboxes.list({ appId: app.appId, tags: labels })) {
          handles.set(box.sandboxId, box);
          out.push(info(box, { ...labels, ...(await box.getTags()) }, "started"));
        }
      } catch (err) {
        throw apiError("listing sandboxes", err);
      }
      return out;
    },

    // Terminating is the one way a sandbox stops, and it ends the processes in it whatever the signal: `force` changes nothing.
    stop: (id) => terminate(id),
    remove: (id) => terminate(id),

    async exec(box, command, timeoutSec): Promise<ExecResult> {
      const sb = await handle(box.id);
      try {
        // The command is a script for a shell, with stderr in stdout as the toolbox answers.
        const p = await sb.exec(["bash", "-c", `exec 2>&1\n${command}`], { mode: "binary", timeoutMs: Math.max(1, timeoutSec) * 1000 });
        await p.stdin.close().catch(() => {});
        const [out, , code] = await Promise.all([p.stdout.readBytes(), p.stderr.readBytes(), p.wait()]);
        return { exitCode: code, result: new TextDecoder().decode(out) };
      } catch (err) {
        throw apiError(`exec in sandbox ${box.name}`, err);
      }
    },

    async upload(box, path, content) {
      const sb = await handle(box.id);
      try {
        // Owner-only, parents made: what an upload to a toolbox does for a root user with a 077 umask.
        const p = await sb.exec(["bash", "-c", 'umask 077; mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "upload", path], { mode: "binary", timeoutMs: 60_000 });
        await p.stdin.writeBytes(content);
        await p.stdin.close();
        const [, err, code] = await Promise.all([p.stdout.readBytes(), p.stderr.readBytes(), p.wait()]);
        if (code !== 0) throw new Error(`exited ${code}: ${new TextDecoder().decode(err).trim().slice(-200)}`);
      } catch (err) {
        throw apiError(`upload to sandbox ${box.name}`, err);
      }
    },
  };
}

// ---- the driver ---------------------------------------------------------------------------------------------------------------

export interface ModalHostOptions
  extends Omit<DaytonaHostOptions, "client" | "snapshot" | "target" | "sudo" | "network" | "labels" | "ttlMinutes">,
    ModalSandboxesOptions {
  sdk: ModalSdk;
  /** Extra tags on every sandbox. */
  labels?: Record<string, string>;
  /** Modal destroys every sandbox this long after creation, whatever its state (at most 24 h). Default 24 h. */
  ttlMinutes?: number;
  /** Egress: Modal's blocking and CIDR allow list. Default: open (`archil mount` needs the network). */
  network?: { blockAll?: boolean; allowList?: string };
}

/**
 * Start the run's instance in a Modal sandbox, as `daytonaHost` does in a Daytona one. The handle's `driver` is "modal"
 * and its `sandboxId` a Modal sandbox id. `prepare` receives the client (exec, upload) to install what the image lacks.
 */
export function modalHost(opts: ModalHostOptions): HostDriver & { readonly fleet: string; readonly mountRoot: string } {
  const { sdk, appName, image, runtime, gpu, cpu, memoryMiB, regions, encryptedPorts, unencryptedPorts, volumes, create, ttlMinutes, ...rest } = opts;
  const client = modalSandboxes(sdk, { appName, image, runtime: runtime ?? "vm", gpu, cpu, memoryMiB, regions, encryptedPorts, unencryptedPorts, volumes, create });
  return daytonaHost({
    ...rest,
    client,
    driver: "modal",
    snapshot: typeof image === "string" ? image : "image",
    // The exec API runs commands as root, which is what `sudo -n` is for elsewhere.
    sudo: false,
    // A planned stop leaves nothing held: what the agent detached from the instance would keep the mount busy.
    reapOnStop: rest.reapOnStop ?? true,
    ttlMinutes: Math.min(ttlMinutes ?? 24 * 60, 24 * 60),
  });
}
