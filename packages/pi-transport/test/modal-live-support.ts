import type { BoxSpec } from "../src/box/box.ts";
import type { ModalSdk } from "../src/box/modal.ts";

// Names every Modal app and label the live suites make. A host that shares an account sets its own prefix and labels:
// PI_TRANSPORT_LIVE_PREFIX, and PI_TRANSPORT_LIVE_LABELS as `key=value,key=value`.
const PREFIX = process.env.PI_TRANSPORT_LIVE_PREFIX ?? "pi-transport-live-";
export const LABELS: Record<string, string> = {
	"pi-transport": "1",
	...Object.fromEntries(
		(process.env.PI_TRANSPORT_LIVE_LABELS ?? "")
			.split(",")
			.filter((pair) => pair.includes("="))
			.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
	),
};
export const APP_NAME = `${PREFIX}conformance`;
const MODAL_VERSION = "0.11.0";

/** A kind of Modal box the live suites run on. */
export type Kind = { readonly name: string; readonly isolation?: BoxSpec["isolation"]; readonly gpu?: string };
export const KINDS: readonly Kind[] = [
	{ name: "sandbox" },
	{ name: "vm", isolation: "vm" },
	{ name: "gpu", gpu: "T4" },
];

/** The kinds `PI_TRANSPORT_LIVE_MODAL_KINDS` names; the GPU kind is never a default. */
export function wantedKinds(): readonly Kind[] {
	const wanted = (process.env.PI_TRANSPORT_LIVE_MODAL_KINDS ?? "sandbox,vm").split(",");
	return KINDS.filter((kind) => wanted.includes(kind.name));
}

/** The spec every box of a kind starts from, without its lifetime. */
export function kindSpec(kind: Kind): Omit<BoxSpec, "maxLifetimeMs"> {
	return {
		cpus: 2,
		labels: LABELS,
		...(kind.isolation === undefined ? {} : { isolation: kind.isolation }),
		...(kind.gpu === undefined ? {} : { gpu: kind.gpu }),
	};
}

// The Modal SDK is not a dependency of this package: the suites load it only when asked to run.
export async function loadClient(): Promise<ModalSdk> {
	const specifier = "modal";
	try {
		const sdk = (await import(specifier)) as { ModalClient: new () => ModalSdk };
		return new sdk.ModalClient();
	} catch (cause) {
		throw new Error(
			`the live Modal suite needs the Modal SDK: run \`npm install --no-save modal@${MODAL_VERSION}\` (${String(cause)})`,
		);
	}
}

/**
 * Whether Modal reports the sandbox as ended, asked of the SDK by id and not through the provider. A sandbox Modal no
 * longer knows counts as ended. The lifetime conformance case takes this as its out-of-band probe.
 */
export async function sandboxEnded(sdk: ModalSdk, id: string): Promise<boolean> {
	try {
		return (await (await sdk.sandboxes.fromId(id)).poll()) !== null;
	} catch (cause) {
		const code = (cause as { code?: unknown } | null)?.code;
		if ((cause as { constructor?: { name?: string } } | null)?.constructor?.name === "NotFoundError" || code === 5) {
			return true;
		}
		throw cause;
	}
}
