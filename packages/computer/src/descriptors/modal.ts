// Modal's descriptor: a sandbox in a Modal app, the run's folder on an Archil disk, with GPUs when asked. It starts from
// our box image, the public registry tag its prepareImage() answers (box-image.ts), which Modal pulls at the first create.
import { defineProvider } from "../descriptor.js";
import type { GpuCapability } from "../provider.js";
import { SANDBOX } from "./shared.js";

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
 * preemptible, as Modal may end a GPU container to free capacity; a synced folder alone, the Archil client's FUSE mount
 * not being proven on gVisor; and the loopback fence made inside a user namespace, as gVisor's root may not make a network
 * namespace itself (a live probe, 11-11: unshare -n refused, unshare -Urn allowed).
 */
export const MODAL_GPU: Readonly<GpuCapability> = Object.freeze({
	types: [...MODAL_GPU_TYPES],
	max: MODAL_GPU_MAX,
	isolation: "gvisor",
	preemptible: true,
	mounts: ["sync" as const],
	// Its gVisor runtime gives /dev/fuse (modal-6, 11-11: a character device 10:229 that opens), but Archil's FUSE mount
	// under gVisor is not proven safe for the Archil client.
	unmounted: Object.freeze({ why: "Archil's FUSE mount isn't proven on Modal's gVisor runtime (#2279)", yet: true }),
	fence: "userns-netns",
});

export const MODAL = defineProvider({
	id: "modal",
	label: "Modal",
	keys: [
		{ name: "MODAL_TOKEN_ID", option: "tokenId", required: true },
		{ name: "MODAL_TOKEN_SECRET", option: "tokenSecret", required: true },
	],
	// The Modal app its computers live in: the server's own when its settings name none. How the server reaches its
	// machines: exec (the provider's default, when the settings name none), a bridge through Modal's exec per
	// connection, or dial, the machine dials the server.
	settings: [
		{ name: "modalApp", option: "app", default: "agentrun" },
		{ name: "modalConnect", option: "connect" },
	],
	metered: true,
	mounts: ["archil"],
	// None: its programs run in a network of their own, their loopback alone (isolation.ts), and the sandbox is made with
	// its network blocked. Open and a list: the sandbox's network is not blocked, and its programs' one way out is init's
	// egress proxy, which reaches the public internet alone, and with a list its hosts alone (hosted/network.ts).
	network: ["none", "open", "allow"],
	// A linux computer, with GPUs when asked.
	capabilities: [{ ...SANDBOX, gpu: MODAL_GPU }],
	// No default image: every computer starts from the box image its prepareImage() answers.
	prepareImage: true,
	load: () => import("../modal.js"),
});
