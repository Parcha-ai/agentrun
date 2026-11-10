// Modal's descriptor: a sandbox in a Modal app, the run's folder on an Archil disk.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** The image a Modal computer starts from when its setting names none. */
export const MODAL_DEFAULT_IMAGE = "debian:bookworm-slim";

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
	capabilities: [SANDBOX],
	defaultImage: { sandbox: MODAL_DEFAULT_IMAGE },
	load: () => import("../modal.js"),
});
