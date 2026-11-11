// Modal's descriptor: a sandbox in a Modal app, the run's folder on an Archil disk, with GPUs when asked.
import { defineProvider } from "../descriptor.js";
import type { GpuCapability } from "../provider.js";
import { SANDBOX } from "./shared.js";

/** The image a Modal computer starts from when its setting names none. */
export const MODAL_DEFAULT_IMAGE = "debian:bookworm-slim";

/**
 * The GPU types Modal takes, by its own names (guide/gpu, 11-10): "A100" is the 40 GB one, "A100-40GB" its explicit
 * name. Its "H100!" and "B200+" variants (no upgrade to an H200; a B200 or B300) are not offered: what a computer gets
 * should be what it asked for.
 */
export const MODAL_GPU_TYPES = ["T4", "L4", "A10", "L40S", "A100", "A100-40GB", "A100-80GB", "RTX-PRO-6000", "H100", "H200", "B200", "B300"] as const;
/** The most GPUs Modal gives one container: 8 (guide/gpu; an A10 container takes at most 4, which Modal refuses in words past). */
export const MODAL_GPU_MAX = 8;
/**
 * The GPUs Modal offers, as capabilities().gpu and its configuration declare them: on gVisor, Modal's one GPU runtime;
 * preemptible, as Modal may end a GPU container to free capacity; no mount yet, the Archil client's FUSE mount not
 * being proven on gVisor; and the loopback fence made inside a user namespace, as gVisor's root may not make a network
 * namespace itself (a live probe, 11-11: unshare -n refused, unshare -Urn allowed).
 */
export const MODAL_GPU: Readonly<GpuCapability> = Object.freeze({ types: [...MODAL_GPU_TYPES], max: MODAL_GPU_MAX, isolation: "gvisor", preemptible: true, mounts: [], fence: "userns-netns" });

export const MODAL = defineProvider({
	id: "modal",
	label: "Modal",
	keys: [
		{ name: "MODAL_TOKEN_ID", option: "tokenId", required: true },
		{ name: "MODAL_TOKEN_SECRET", option: "tokenSecret", required: true },
	],
	// The Modal app its computers live in: the server's own when its settings name none.
	settings: [{ name: "modalApp", option: "app", default: "agentrun" }],
	metered: true,
	mounts: ["archil"],
	// None: its programs run in a network of their own (isolation.ts OWN_NETWORK_ONLY).
	network: ["none"],
	// A linux computer, with GPUs when asked.
	capabilities: [{ ...SANDBOX, gpu: MODAL_GPU }],
	defaultImage: { sandbox: MODAL_DEFAULT_IMAGE },
	load: () => import("../modal.js"),
});
