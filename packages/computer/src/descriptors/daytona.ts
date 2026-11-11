// Daytona's descriptor: a sandbox on Daytona's cloud, the run's folder on an Archil disk, with GPUs when asked.
import { defineProvider } from "../descriptor.js";
import type { GpuCapability } from "../provider.js";
import { SANDBOX } from "./shared.js";

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
 * it takes no mount: daytona-gpu's user is daytona, not root, and it has no Archil client, so an Archil mount is refused
 * in words.
 */
export const DAYTONA_GPU: Readonly<GpuCapability> = Object.freeze({
	types: [DAYTONA_GPU_SNAPSHOT_GPU.type],
	max: DAYTONA_GPU_SNAPSHOT_GPU.count,
	preemptible: true,
	stopDeletes: true,
	region: DAYTONA_GPU_REGION,
	perGpu: { cpus: 16, memoryMb: 100 * 1024, diskMb: 400 * 1024 },
	mounts: [],
});

export const DAYTONA = defineProvider({
	id: "daytona",
	label: "Daytona",
	keys: [
		{ name: "DAYTONA_API_KEY", option: "apiKey", required: true },
		{ name: "DAYTONA_API_URL", option: "apiUrl", required: false },
		{ name: "DAYTONA_TARGET", option: "target", required: false },
	],
	metered: true,
	mounts: ["archil"],
	// None: its programs run in a network of their own (isolation.ts OWN_NETWORK_ONLY).
	network: ["none"],
	// A linux computer, with GPUs when asked.
	capabilities: [{ ...SANDBOX, gpu: DAYTONA_GPU }],
	defaultImage: { sandbox: DAYTONA_DEFAULT_SNAPSHOT },
	load: () => import("../daytona.js"),
});
