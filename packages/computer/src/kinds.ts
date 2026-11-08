// The kind registry: the computer an agent is given, its Setting. A kind is a set of capability groups of the computer
// protocol (the groups a provider's capabilities() declare and its computer's hello repeats), the tools a loop gets for
// it, and the provider ids that offer it. Whether a provider serves a kind is computed from its capabilities alone
// (serves, kindOf), never kept in a list beside them: a provider that drops a group stops serving the kind. The serve
// side reads this module to wire an agent's `computer: { kind, provider }` and to give its loop the kind's tools,
// nothing else.
import type { ComputerKind, Group } from "./protocol.js";
import type { ComputerCapabilities } from "./provider.js";
import type { ProviderId } from "./providers.js";

/**
 * What an agent's computer is. none: the run's folder only, no computer. sandbox: a Linux shell with files and
 * processes. desktop: a sandbox with a screen, a pointer and keys (Linux, Windows or macOS). phone: a screen, touch and
 * apps. browser: a computer class answering CDP.
 */
export type Kind = "none" | "sandbox" | "desktop" | "phone" | "browser";

/** Every kind, from the least to the most a loop is given, browser apart. */
export const KINDS: readonly Kind[] = ["none", "sandbox", "desktop", "phone", "browser"];

/**
 * How a loop reaches a kind's computer. computerd: the computer protocol's methods (a daemon, or a provider answering
 * them itself). cdp: the Chrome DevTools Protocol, a browser's target. none: no computer.
 */
export type KindPlane = "none" | "computerd" | "cdp";

/** One tool a loop gets for a kind, and the groups it needs: given only where every one of them is declared. */
export interface KindTool {
	/** Its name as the model sees it; the serve side defines its words and schema. */
	name: string;
	groups: readonly Group[];
}

export interface KindSpec {
	kind: Kind;
	plane: KindPlane;
	/** The groups a provider must declare to serve the kind, and whose conformance cases it must pass. */
	required: readonly Group[];
	/** Groups the kind takes when a provider declares them: they add tools, and are never needed. */
	optional: readonly Group[];
	/** The protocol kinds (capabilities().kind) a computer serving it may be. */
	computers: readonly ComputerKind[];
	/** The tools a loop gets for the kind, those of optional groups only where the provider declares them. */
	tools: readonly KindTool[];
}

const SANDBOX_GROUPS: readonly Group[] = ["exec", "files", "processes"];

/** The shell and file tools, as the kernel's tool registry names them: bash and the background tools on the computer. */
const SANDBOX_TOOLS: readonly KindTool[] = [
	{ name: "bash", groups: ["exec"] },
	{ name: "read", groups: ["files"] },
	{ name: "write", groups: ["files"] },
	{ name: "edit", groups: ["files"] },
	{ name: "bash_background", groups: ["processes"] },
	{ name: "bash_output", groups: ["processes"] },
	{ name: "bash_input", groups: ["processes"] },
	{ name: "bash_signal", groups: ["processes"] },
	{ name: "bash_list", groups: ["processes"] },
];

/** A screenshot of the computer's screen (screen.shot). */
const SCREEN_SHOT: KindTool = { name: "screen_shot", groups: ["screen"] };

/** pi-browser's tools, the ones serve registers for a run's browser today; the browser lane owns them. */
const BROWSER_TOOLS: readonly KindTool[] = ["snapshot", "run", "screenshot", "browser_read", "browser_release", "browser_relaunch", "browser_request_handoff", "browser_downloads", "browser_upload"].map(
	(name) => ({ name, groups: [] }),
);

export const KIND_SPECS: Readonly<Record<Kind, KindSpec>> = {
	none: { kind: "none", plane: "none", required: [], optional: [], computers: [], tools: [] },
	sandbox: { kind: "sandbox", plane: "computerd", required: SANDBOX_GROUPS, optional: [], computers: ["linux", "desktop"], tools: SANDBOX_TOOLS },
	desktop: {
		kind: "desktop",
		plane: "computerd",
		required: [...SANDBOX_GROUPS, "screen", "input.pointer", "input.keys"],
		optional: [],
		computers: ["desktop"],
		// desktop_input: input.actions with pointer and key actions.
		tools: [...SANDBOX_TOOLS, SCREEN_SHOT, { name: "desktop_input", groups: ["input.pointer", "input.keys"] }],
	},
	phone: {
		kind: "phone",
		plane: "computerd",
		required: ["screen", "input.touch", "apps"],
		optional: ["input.keys", "apps.ui_tree", "apps.install"],
		computers: ["android", "ios"],
		// touch: input.actions with touch actions; type: with key actions; apps: list, launch, terminate.
		tools: [
			SCREEN_SHOT,
			{ name: "touch", groups: ["input.touch"] },
			{ name: "type", groups: ["input.keys"] },
			{ name: "apps", groups: ["apps"] },
			{ name: "ui_tree", groups: ["apps.ui_tree"] },
			{ name: "app_install", groups: ["apps.install"] },
		],
	},
	// No provider declares a CDP plane yet: the browser lane adds it to the capabilities, and serves() reads it there.
	browser: { kind: "browser", plane: "cdp", required: [], optional: [], computers: [], tools: BROWSER_TOOLS },
};

/**
 * The provider ids that offer each kind, the menu an agent's setting picks from: each id is a line of the provider
 * registry (providers.ts), and offering is not serving. serves() decides for the provider built, from its capabilities;
 * a unit test builds each one listed here as it offers the kind and holds it to serves().
 */
export const KIND_PROVIDERS: Readonly<Record<Kind, readonly ProviderId[]>> = {
	none: [],
	sandbox: ["docker", "e2b", "daytona", "modal"],
	// Docker with its desktop option, E2B with kind desktop (its default), Orgo (desktops only).
	desktop: ["docker", "e2b", "orgo"],
	phone: [],
	browser: [],
};

/** The capabilities serves() and kindOf() read. */
export type KindCapabilities = Pick<ComputerCapabilities, "kind" | "groups">;

/** Why capabilities do not serve a kind, in words; none when they do. */
export function servingRefusals(capabilities: KindCapabilities, kind: Kind): string[] {
	const spec = KIND_SPECS[kind];
	if (spec === undefined) return [`${JSON.stringify(kind)} is not a kind: ${KINDS.join(", ")}`];
	if (spec.plane === "none") return ["kind none is no computer: no provider serves it"];
	if (spec.plane === "cdp") return ["kind browser answers CDP, and no provider declares a CDP plane yet"];
	const refusals: string[] = [];
	if (!spec.computers.includes(capabilities.kind)) refusals.push(`kind ${kind} is a ${spec.computers.join(" or ")} computer, not a ${capabilities.kind} one`);
	const groups = Array.isArray(capabilities.groups) ? capabilities.groups : [];
	const missing = spec.required.filter((group) => !groups.includes(group));
	if (missing.length > 0) refusals.push(`kind ${kind} needs groups ${missing.join(", ")}, which the provider does not declare`);
	return refusals;
}

/** Whether a provider with these capabilities serves the kind: its protocol kind is one the kind allows, and it declares every required group. */
export function serves(capabilities: KindCapabilities, kind: Kind): boolean {
	return servingRefusals(capabilities, kind).length === 0;
}

/** The order kindOf tries: the kind that gives a loop the most first. */
const RICHEST: readonly Kind[] = ["phone", "desktop", "sandbox"];

/** The richest kind these capabilities serve, or undefined when they serve none. */
export function kindOf(capabilities: KindCapabilities): Kind | undefined {
	return RICHEST.find((kind) => serves(capabilities, kind));
}

/** The kind's tools a loop gets from a provider with these capabilities: none when it does not serve the kind; else each tool whose groups it declares. */
export function toolsFor(kind: Kind, capabilities: KindCapabilities): KindTool[] {
	if (!serves(capabilities, kind)) return [];
	return KIND_SPECS[kind].tools.filter((tool) => tool.groups.every((group) => capabilities.groups.includes(group)));
}
