// Universes on Modal: the fleet's client is the package's `modalSandboxes` (modalHost's DaytonaClient over the Modal SDK),
// so daytona-fleet.ts drives Modal sandboxes unchanged. GPU sandboxes run on gVisor, whose fsync is acknowledged without
// the disk, so they take the pipe transport; a `vm` runtime mounts the disk durably and can be direct. The runner's port
// is reached through the sandbox's encrypted tunnel.
//
// `modalSandboxes` comes from modalHost, which is not on every build of the package yet: it is looked up at run time, and
// a build without it says so instead of failing to compile.
import type { DaytonaClient, SandboxInfo } from "@parcha/pi-durable-disk";
import type { HostKind } from "./show/types.ts";

/** Modal's on-demand list prices, USD per hour (per GPU; per CPU core; per GiB of memory). Estimates for the cost meter. */
const GPU_PER_HOUR: Record<string, number> = { T4: 0.59, L4: 0.8, A10: 1.1, A10G: 1.1, L40S: 1.95, "A100-80GB": 2.5, H100: 3.95, H200: 4.54, B200: 6.25 };
const CPU_CORE_PER_HOUR = 0.0473;
const GIB_PER_HOUR = 0.008;

export interface ModalUniversesOptions {
  /** The Modal app the sandboxes live in. */
  readonly appName: string;
  /** A Modal image id (`im-...`) with Node at /opt/node24, the run user and sudo (D4's layer; D2's GPU image on top). */
  readonly image: string;
  readonly runtime: "vm" | "gvisor";
  /** A GPU type ("L4", "L40S", "H100"); none for a CPU sandbox. */
  readonly gpu?: string;
  readonly cpu?: number;
  readonly memoryMiB?: number;
  /** Where Modal may place the sandboxes; near the disk ("us-east") a pipe commit is about 23 ms instead of about 103. */
  readonly regions?: readonly string[];
  /** Ports the runner listens on, exposed through encrypted tunnels. */
  readonly ports: readonly number[];
}

type Tunnels = Record<number, { url: string }>;
type ModalSdk = { sandboxes: { fromId(id: string): Promise<{ tunnels(timeoutMs?: number): Promise<Tunnels> }> } };

export async function modalUniverses(o: ModalUniversesOptions): Promise<{
  client: DaytonaClient;
  previewUrl(boxId: string, port: number): Promise<string>;
  kind: HostKind;
  ratePerHour(box: SandboxInfo): number;
  label(box: SandboxInfo, short: string): string;
}> {
  const pdd = (await import("@parcha/pi-durable-disk")) as unknown as { modalSandboxes?: (sdk: unknown, options: Record<string, unknown>) => DaytonaClient };
  if (!pdd.modalSandboxes) throw new Error("this build of @parcha/pi-durable-disk has no modalSandboxes (modalHost); build the package with it");
  const { ModalClient } = (await import("modal")) as unknown as { ModalClient: new () => ModalSdk };
  const sdk = new ModalClient();
  const client = pdd.modalSandboxes(sdk, {
    appName: o.appName,
    image: o.image,
    runtime: o.runtime,
    ...(o.gpu ? { gpu: o.gpu } : {}),
    cpu: o.cpu ?? 2,
    memoryMiB: o.memoryMiB ?? 8192,
    ...(o.regions ? { regions: [...o.regions] } : {}),
    encryptedPorts: [...o.ports],
  });
  const rate = (o.gpu ? (GPU_PER_HOUR[o.gpu] ?? GPU_PER_HOUR.H100!) : 0) + (o.cpu ?? 2) * CPU_CORE_PER_HOUR + ((o.memoryMiB ?? 8192) / 1024) * GIB_PER_HOUR;
  return {
    client,
    async previewUrl(boxId, port) {
      const tunnels = await (await sdk.sandboxes.fromId(boxId)).tunnels(30_000);
      const t = tunnels[port];
      if (!t) throw new Error(`sandbox ${boxId} has no tunnel for port ${port}`);
      return t.url;
    },
    kind: o.gpu ? "gpu" : o.runtime === "vm" ? "vm" : "sandbox",
    ratePerHour: () => rate,
    label: (_box, short) => `Modal ${o.gpu ?? (o.runtime === "vm" ? "VM" : "sandbox")} ${short}`,
  };
}
