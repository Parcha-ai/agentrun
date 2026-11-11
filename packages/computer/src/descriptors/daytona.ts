// Daytona's descriptor: a sandbox on Daytona's cloud, the run's folder on an Archil disk, with GPUs when asked.
import { defineProvider } from "../descriptor.js";
import type { GpuCapability } from "../provider.js";
import { SANDBOX } from "./shared.js";

/** The image a Daytona computer starts from when its spec names "default": Daytona's own default snapshot. */
export const DAYTONA_DEFAULT_SNAPSHOT = "default";

/**
 * The GPU types Daytona takes, by its own names: the GpuType enum of its API (daytona_api_client 0.214.0
 * models/gpu_type.py; dotfiles/gpu-sandboxes, 11-10). A sandbox asks for them as gpu (how many) and gpuType (a
 * preference list, here the one type asked), and reads them back as gpu and gpuType.
 */
export const DAYTONA_GPU_TYPES = ["H100", "H200", "RTX-PRO-6000", "RTX-4090", "RTX-5090", "MI355X"] as const;
/** The most GPUs Daytona gives one sandbox: 8, dedicated through VFIO (dotfiles/gpu-sandboxes). */
export const DAYTONA_GPU_MAX = 8;
/** The one region Daytona runs a GPU sandbox in, whatever the provider's target. */
export const DAYTONA_GPU_REGION = "earth";
/**
 * The GPUs Daytona offers, as capabilities().gpu and its configuration declare them, with its limits on a GPU sandbox:
 * its stop deletes it (no pause, no snapshot: nothing is kept), it runs in region earth, each GPU comes with 16 vCPUs,
 * 192 GiB of memory and 512 GiB of disk (Daytona's defaults), and it may be preempted (daytona.io/pricing lists its
 * GPUs as "Preemptible GPU prices", 11-10).
 */
export const DAYTONA_GPU: Readonly<GpuCapability> = Object.freeze({
	types: [...DAYTONA_GPU_TYPES],
	max: DAYTONA_GPU_MAX,
	preemptible: true,
	stopDeletes: true,
	region: DAYTONA_GPU_REGION,
	perGpu: { cpus: 16, memoryMb: 192 * 1024, diskMb: 512 * 1024 },
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
