// Universes on Modal: the fleet's client is the package's `modalSandboxes` (modalHost's DaytonaClient over the Modal SDK),
// so daytona-fleet.ts drives Modal sandboxes unchanged. GPU sandboxes run on gVisor, whose fsync is acknowledged without
// the disk, so they take the pipe transport; a `vm` runtime mounts the disk durably and can be direct. The runner's port
// is reached through the sandbox's encrypted tunnel.
//
// A GPU class may not place for minutes. A create is given `placeMs` per class, in the order given, and the first class
// that places makes the machine; the machine's label and rate are its class's. A create that gave up can still place
// later, before Modal tags it: `sweepApp` terminates every running sandbox of the app, which belongs to this driver
// alone, so nothing outlives a run of the multiverse.
//
// `modalSandboxes` comes from modalHost, which is not on every build of the package yet: it is looked up at run time, and
// a build without it says so instead of failing to compile.
import type { CreateSandboxBody, DaytonaClient, SandboxInfo } from "@parcha/pi-durable-disk";
import type { HostKind } from "./show/types.ts";

/** Modal's on-demand list prices, USD per hour (per GPU; per CPU core; per GiB of memory). Estimates for the cost meter. */
const GPU_PER_HOUR: Record<string, number> = { T4: 0.59, L4: 0.8, A10: 1.1, A10G: 1.1, L40S: 1.95, "A100-80GB": 2.5, H100: 3.95, H200: 4.54, B200: 6.25 };
const CPU_CORE_PER_HOUR = 0.0473;
const GIB_PER_HOUR = 0.008;

export interface ModalUniversesOptions {
  /** The Modal app the sandboxes live in; it must hold this driver's sandboxes only (`sweepApp` terminates them all). */
  readonly appName: string;
  /** A Modal image id (`im-...`) with Node at /opt/node24, the run user and sudo (D4's layer; D2's GPU image on top). */
  readonly image: string;
  readonly runtime: "vm" | "gvisor";
  /** GPU classes to try, in order ("L4", "A10", "L40S", "H100"); none for a CPU sandbox. */
  readonly gpus?: readonly string[];
  /** How long a create may wait for one class to place before the next is tried. Default 90 s. */
  readonly placeMs?: number;
  readonly cpu?: number;
  readonly memoryMiB?: number;
  /** Where Modal may place the sandboxes; near the disk ("us-east") a pipe commit is about 23 ms instead of about 103. */
  readonly regions?: readonly string[];
  /** Ports the runner listens on, exposed through encrypted tunnels. */
  readonly ports: readonly number[];
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

type Tunnels = Record<number, { url: string }>;
type SdkSandbox = { sandboxId: string; poll(): Promise<number | null>; terminate(): Promise<void>; tunnels(timeoutMs?: number): Promise<Tunnels> };
type ModalSdk = {
  apps: { fromName(name: string, params: { createIfMissing: boolean }): Promise<{ appId: string }> };
  sandboxes: { fromId(id: string): Promise<SdkSandbox>; list(params: { appId: string }): AsyncIterable<SdkSandbox> };
};

export type ModalUniverses = {
  client: DaytonaClient;
  previewUrl(boxId: string, port: number): Promise<string>;
  kind: HostKind;
  ratePerHour(box: SandboxInfo): number;
  label(box: SandboxInfo, short: string): string;
  /** Terminate every running sandbox of the app (the end of a run, or after a crash); returns their ids. */
  sweepApp(): Promise<string[]>;
};

export async function modalUniverses(o: ModalUniversesOptions): Promise<ModalUniverses> {
  const pdd = (await import("@parcha/pi-durable-disk")) as unknown as { modalSandboxes?: (sdk: unknown, options: Record<string, unknown>) => DaytonaClient };
  if (!pdd.modalSandboxes) throw new Error("this build of @parcha/pi-durable-disk has no modalSandboxes (modalHost); build the package with it");
  const { ModalClient } = (await import("modal")) as unknown as { ModalClient: new () => ModalSdk };
  const sdk = new ModalClient();
  const log = o.log ?? (() => {});
  const classes = o.gpus && o.gpus.length > 0 ? [...o.gpus] : [undefined];
  const cpu = o.cpu ?? 2;
  const memoryMiB = o.memoryMiB ?? 8192;
  const clients = new Map(
    classes.map((gpu) => [
      gpu,
      pdd.modalSandboxes!(sdk, {
        appName: o.appName,
        image: o.image,
        runtime: o.runtime,
        ...(gpu ? { gpu } : {}),
        cpu,
        memoryMiB,
        ...(o.regions ? { regions: [...o.regions] } : {}),
        encryptedPorts: [...o.ports],
      }),
    ]),
  );
  const first = clients.get(classes[0])!;
  /** The class each sandbox placed as. */
  const classOf = new Map<string, string | undefined>();
  const rateOf = (gpu: string | undefined) => (gpu ? (GPU_PER_HOUR[gpu] ?? GPU_PER_HOUR.H100!) : 0) + cpu * CPU_CORE_PER_HOUR + (memoryMiB / 1024) * GIB_PER_HOUR;

  /** The class client that made each box: it alone knows the box's tags, so every call on the box goes to it. */
  const owner = new Map<string, DaytonaClient>();
  const via = (id: string) => owner.get(id) ?? first;
  const client: DaytonaClient = {
    get: (idOrName) => via(idOrName).get(idOrName),
    async list(labels) {
      const seen = new Map<string, SandboxInfo>();
      for (const c of new Set(clients.values())) for (const b of await c.list(labels)) seen.set(b.id, b);
      return [...seen.values()];
    },
    stop: (id, force) => via(id).stop(id, force),
    remove: (id) => via(id).remove(id),
    exec: (box, command, timeoutSec) => via(box.id).exec(box, command, timeoutSec),
    upload: (box, path, content) => via(box.id).upload(box, path, content),
    async create(body: CreateSandboxBody): Promise<SandboxInfo> {
      let last: unknown;
      for (const [i, gpu] of classes.entries()) {
        // Each attempt has its own name: a create that gave up may still place, under its own name.
        const name = i === 0 ? body.name : `${body.name.slice(0, 59)}-g${i}`;
        const t0 = Date.now();
        const attempt = clients.get(gpu)!.create({ ...body, name });
        attempt.catch(() => {});
        const placed = await Promise.race([attempt, new Promise<null>((r) => setTimeout(() => r(null), o.placeMs ?? 90_000).unref())]).catch((error: unknown) => {
          last = error;
          return null;
        });
        if (placed) {
          classOf.set(placed.id, gpu);
          owner.set(placed.id, clients.get(gpu)!);
          log("modal.placed", { name, gpu: gpu ?? null, ms: Date.now() - t0 });
          return placed;
        }
        log("modal.not-placed", { name, gpu: gpu ?? null, ms: Date.now() - t0, error: last ? (last as Error).message : "timed out" });
        // Given up on, it may still place: then it is terminated at once rather than idle until the run's sweep.
        void attempt.then(
          (late) => clients.get(gpu)!.remove(late.id).then(() => log("modal.late-terminated", { name, id: late.id })),
          () => undefined,
        );
      }
      throw new Error(`no class of ${classes.join(", ")} placed: ${last ? (last as Error).message : "timed out"}`);
    },
  };

  return {
    client,
    async previewUrl(boxId, port) {
      const tunnels = await (await sdk.sandboxes.fromId(boxId)).tunnels(30_000);
      const t = tunnels[port];
      if (!t) throw new Error(`sandbox ${boxId} has no tunnel for port ${port}`);
      return t.url;
    },
    kind: o.gpus && o.gpus.length > 0 ? "gpu" : o.runtime === "vm" ? "vm" : "sandbox",
    ratePerHour: (box) => rateOf(classOf.get(box.id) ?? classes[0]),
    label: (box, short) => {
      const gpu = classOf.get(box.id) ?? classes[0];
      return `Modal ${gpu ?? (o.runtime === "vm" ? "VM" : "sandbox")} ${short}`;
    },
    async sweepApp() {
      const app = await sdk.apps.fromName(o.appName, { createIfMissing: false });
      const done: string[] = [];
      for await (const sb of sdk.sandboxes.list({ appId: app.appId })) {
        if ((await sb.poll().catch(() => 0)) !== null) continue;
        await sb.terminate().then(
          () => done.push(sb.sandboxId),
          (error: Error) => log("modal.sweep-failed", { id: sb.sandboxId, error: error.message }),
        );
      }
      return done;
    },
  };
}
