// Daytona's descriptor: a sandbox on Daytona's cloud, with GPUs when asked; the run's folder on an Archil disk only where
// the operator gives an Archil egress relay (a self-hosted Daytona target), never on Daytona's hosted cloud.
import { defineProvider } from "../descriptor.js";
import type { GpuCapability } from "../provider.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

/**
 * Why a Daytona desktop is made on connect dial alone: its X server and window manager come from a snapshot of
 * box/Dockerfile, whose sandbox boots agentrun-dial and dials the server, the path a live run proves; no desktop has run
 * on exec, where init is a command started through the toolbox's session. The provider's constructor refuses kind
 * desktop on exec in these words, after kindRefusal's.
 */
export const DAYTONA_DIAL_DESKTOP = "a desktop's sandbox boots from a snapshot of box/Dockerfile and dials this server, and none has run through the toolbox's session commands, so connect \"exec\" makes kind linux";

/** The key that turns on a Daytona computer's Archil mount: the operator's Archil egress relay (archilEgress). */
export const DAYTONA_ARCHIL_EGRESS = "DAYTONA_ARCHIL_EGRESS";

/** Why a Daytona computer made with no Archil egress takes no Archil mount: check() refuses one in these words. */
export const DAYTONA_NO_ARCHIL = `Archil mounts don't work on Daytona's hosted cloud, where Archil's client hangs on its sandboxes; a self-hosted Daytona target takes one once its operator sets ${DAYTONA_ARCHIL_EGRESS}`;

/** The image a Daytona computer starts from when its spec names "default": Daytona's own default snapshot. */
export const DAYTONA_DEFAULT_SNAPSHOT = "default";

/** The one region Daytona runs a GPU sandbox in, whatever the provider's target. */
export const DAYTONA_GPU_REGION = "earth";
/**
 * The snapshot every GPU sandbox is made from: Daytona's general GPU snapshot, its default sandbox image (user daytona,
 * passwordless sudo) with the CUDA toolkit, as Daytona's dashboard makes one (GET /snapshots/daytona-gpu, 11-11). A GPU
 * spec names it, or "default"; no other snapshot is proven to give a GPU computer, so check() refuses one.
 */
export const DAYTONA_GPU_SNAPSHOT = "daytona-gpu";
/**
 * The GPU a snapshot gives every sandbox made from it. A Daytona snapshot carries its own resources, GPUs among them: a
 * create that names a snapshot sends none (Daytona answers 400 "Cannot specify Sandbox resources when using a
 * snapshot", live 11-11), so a GPU computer's type and count are its snapshot's, and the read-back is held to them.
 */
export interface DaytonaSnapshotGpu {
	type: string;
	count: number;
}
/** daytona-gpu's GPU, as GET /snapshots/daytona-gpu declares it (gpu 1, gpuType H100; 11-11). */
export const DAYTONA_GPU_SNAPSHOT_GPU: Readonly<DaytonaSnapshotGpu> = Object.freeze({ type: "H100", count: 1 });
/**
 * The GPUs Daytona offers, as capabilities().gpu and its configuration declare them: the GPU of its GPU snapshot,
 * daytona-gpu, alone (another type needs a snapshot of its own), with its limits on a GPU sandbox: its stop deletes it
 * (no pause, no snapshot: nothing is kept), it runs in region earth, it has the snapshot's 16 vCPUs, 100 GiB of memory
 * and 400 GiB of disk, it may be preempted (daytona.io/pricing lists its GPUs as "Preemptible GPU prices", 11-10), and
 * it takes a synced folder alone: Daytona's GPU host gives no /dev/fuse, even to root (live 11-11), and the archil client
 * mounts through FUSE, so an Archil mount is refused in words.
 */
export const DAYTONA_GPU: Readonly<GpuCapability> = Object.freeze({
	types: [DAYTONA_GPU_SNAPSHOT_GPU.type],
	max: DAYTONA_GPU_SNAPSHOT_GPU.count,
	preemptible: true,
	stopDeletes: true,
	region: DAYTONA_GPU_REGION,
	perGpu: { cpus: 16, memoryMb: 100 * 1024, diskMb: 400 * 1024 },
	mounts: ["sync" as const],
	unmounted: Object.freeze({ why: "Daytona's GPU runtime gives it no /dev/fuse", yet: false }),
});

/**
 * Our GPU snapshots: box/Dockerfile built with a GPU (box/build-daytona.py --gpu <type>), named
 * agentrun-archil-gpu-<type>-<the recipe's hash>. Their user is root and they carry the Archil client and our helper,
 * but their GPU computers take no mount either: Daytona's GPU host gives no /dev/fuse. The name says the GPU: one of
 * the type it names (the build's resources).
 */
const ARCHIL_GPU_SNAPSHOT = /^agentrun-archil-gpu-(h100)-[0-9a-f]{12}$/;
const ARCHIL_GPU_TYPES: Readonly<Record<string, string>> = { h100: "H100" };

/** The snapshot a provider makes its GPU computers from, and its GPU. */
export interface DaytonaGpuSnapshot extends DaytonaSnapshotGpu {
	snapshot: string;
}

/**
 * The GPU snapshot a provider with the gpuSnapshot option (or none) makes its GPU computers from: daytona-gpu when none
 * is given; else ours, with the GPU its name says. Throws in words for a name that is not one of ours
 * (box/build-daytona.py --gpu prints it).
 */
export function daytonaGpuSnapshot(gpuSnapshot?: string): DaytonaGpuSnapshot {
	if (gpuSnapshot === undefined) return { snapshot: DAYTONA_GPU_SNAPSHOT, ...DAYTONA_GPU_SNAPSHOT_GPU };
	const named = ARCHIL_GPU_SNAPSHOT.exec(gpuSnapshot);
	const type = named === null ? undefined : ARCHIL_GPU_TYPES[named[1] as string];
	if (type === undefined) throw new Error(`gpuSnapshot ${JSON.stringify(gpuSnapshot)} is not a GPU snapshot of box/Dockerfile: box/build-daytona.py --gpu H100 prints its name, agentrun-archil-gpu-h100-<12 hex digits>`);
	return { snapshot: gpuSnapshot, type, count: 1 };
}

/** The GPUs a provider declares for its GPU snapshot (DAYTONA_GPU's limits and synced folder, the snapshot's GPU): a copy. */
export function daytonaGpu(gpuSnapshot?: string): GpuCapability {
	const { type, count } = daytonaGpuSnapshot(gpuSnapshot);
	return { ...DAYTONA_GPU, types: [type], max: count, perGpu: { ...(DAYTONA_GPU.perGpu as NonNullable<GpuCapability["perGpu"]>) }, mounts: ["sync"] };
}

export const DAYTONA = defineProvider({
	id: "daytona",
	label: "Daytona",
	keys: [
		{ name: "DAYTONA_API_KEY", option: "apiKey", required: true },
		{ name: "DAYTONA_API_URL", option: "apiUrl", required: false },
		{ name: "DAYTONA_TARGET", option: "target", required: false },
		{ name: DAYTONA_ARCHIL_EGRESS, option: "archilEgress", required: false },
	],
	// How the server reaches its machines: exec (the provider's default, when the server's settings name none), a session
	// command through the toolbox per connection, or dial, the machine dials the server (a snapshot of box/Dockerfile).
	settings: [{ name: "daytonaConnect", option: "connect" }],
	connect: "either",
	metered: true,
	// No mount by default: on Daytona's hosted cloud, Archil's client (0.10.1) mounts on its container sandboxes, but
	// nothing reads its /dev/fuse after, so the first statx of the folder hangs, on every kernel and mount shape tried
	// (live, 11-14). An Archil mount is refused in these words, before any request. A self-hosted Daytona target whose
	// sandboxes reach Archil through the operator's egress relay mounts it (live, 11-14): the operator sets
	// DAYTONA_ARCHIL_EGRESS, and a provider made with it takes an Archil mount (mountsOf).
	mounts: [],
	unmounted: { archil: DAYTONA_NO_ARCHIL },
	mountsWith: { archil: DAYTONA_ARCHIL_EGRESS },
	// None: its programs run in a network of their own, their loopback alone (isolation.ts), and the sandbox is made with
	// networkBlockAll. Open and a list: the sandbox is not blocked (the account's tier may still limit where it goes), and
	// its programs' one way out is init's egress proxy, which reaches the public internet alone, and with a list its hosts
	// alone (hosted/network.ts).
	network: ["none", "open", "allow"],
	// A linux computer, with GPUs when asked; or, on connect dial alone, a desktop with none: a snapshot of box/Dockerfile's
	// X server, started through computerd over the socket the sandbox dialed, and xfwm4, which computerd starts itself
	// (init --window-manager), at the snapshot's 2 CPUs and 4 GiB (box/build-daytona.py). The desktop's configuration
	// selects dial itself, whatever daytonaConnect says: a provider on connect exec refuses kind desktop when it is made
	// (DAYTONA_DIAL_DESKTOP).
	capabilities: [{ ...SANDBOX, gpu: DAYTONA_GPU }, { ...LINUX_DESKTOP, options: { kind: "desktop", connect: "dial" } }],
	defaultImage: { sandbox: DAYTONA_DEFAULT_SNAPSHOT },
	// The operator's own snapshot for every Daytona computer, named here; the default snapshot stands while unset. A
	// computer with an Archil mount needs a snapshot of box/Dockerfile (box/build-daytona.py prints its name).
	imageEnv: "AGENTRUN_DAYTONA_SNAPSHOT",
	load: () => import("../daytona.js"),
});
