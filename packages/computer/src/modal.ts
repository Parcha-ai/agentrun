// The Modal provisioner, VM runtime only: every call through the host's own Modal JS SDK client, of which this package
// names only the slice it uses (ModalSdk) and imports nothing. Not built yet.
import type {
	AttachedComputer,
	CallContext,
	ComputerCapabilities,
	ComputerConnection,
	ComputerInfo,
	ComputerProvider,
	ComputerRef,
	ComputerSpec,
	NetworkPolicy,
	NetworkSpec,
	Refusal,
} from "./provider.js";
import { fail, type Result } from "./result.js";

/** The App sandboxes are made in (modal-client@64880502:js/src/app.ts:32-61). */
export interface ModalApp {
	readonly appId: string;
}

/** An Image, built on Modal's side when a sandbox is created from it (js/src/image.ts:311-420). */
export interface ModalImage {
	dockerfileCommands(commands: string[]): ModalImage;
}

/** What sandboxes.create is given: every field is one of the SDK's SandboxCreateParams (js/src/sandbox.ts:356-474). */
export interface ModalCreateParams {
	runtime: "vm";
	command: string[];
	timeoutMs: number;
	workdir: string;
	cpu: number;
	cpuLimit: number;
	memoryMiB: number;
	memoryLimitMiB: number;
	blockNetwork?: true;
	tags: Record<string, string>;
}

/** A program's stdin in binary mode: the SDK's ModalWriteStream (js/src/streams.ts:33-39) and WritableStream's close. */
export interface ModalByteSink {
	writeBytes(bytes: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

/** One program started by exec in binary mode: the part of the SDK's ContainerProcess read here (sandbox.ts:2774-2910). */
export interface ModalProcess {
	readonly stdin: ModalByteSink;
	readonly stdout: AsyncIterable<Uint8Array>;
	readonly stderr: AsyncIterable<Uint8Array>;
	wait(): Promise<number>;
}

/** The part of the SDK's Sandbox called here (sandbox.ts:1624-2772). */
export interface ModalSandbox {
	readonly sandboxId: string;
	exec(command: string[], params: { mode: "binary" }): Promise<ModalProcess>;
	/** null while the sandbox runs, its exit code once it has finished. */
	poll(): Promise<number | null>;
	getTags(): Promise<Record<string, string>>;
	terminate(): Promise<void>;
}

/** The part of the SDK's ModalClient this provider calls. The host passes its own client. */
export interface ModalSdk {
	readonly apps: { fromName(name: string, params: { createIfMissing: true }): Promise<ModalApp> };
	readonly images: { fromRegistry(tag: string): ModalImage };
	readonly sandboxes: {
		create(app: ModalApp, image: ModalImage, params: ModalCreateParams): Promise<ModalSandbox>;
		fromId(id: string): Promise<ModalSandbox>;
		list(params: { appId: string; tags: Record<string, string> }): AsyncIterable<ModalSandbox>;
	};
}

/** The longest each kind of call may take, in ms. */
export interface ModalTimeouts {
	/** sandboxes.create, which builds the image layer and waits for the sandbox to be scheduled. */
	createMs: number;
	/** Every other SDK call: apps.fromName, fromId, getTags, poll, terminate, exec's start. */
	callMs: number;
	/** The daemon's hello over a new connection. */
	helloMs: number;
	/** The probe, run through the daemon. */
	probeMs: number;
	/** One whole list, every page and every sandbox's tags. */
	listMs: number;
}

export interface ModalProviderOptions {
	/** The host's Modal client, or anything with the same slice. */
	sdk: ModalSdk;
	/** The Modal App the sandboxes live in; made when missing. */
	app: string;
	/** A registry image holding the daemon for linux/amd64 at /computerd, pinned by digest (name@sha256:<64 hex>). */
	daemonImage: string;
	/** Who a computer runs as when its spec does not say: uid:gid in numbers, never root or root's group. Default 1000:1000. */
	user?: string;
	timeouts?: Partial<ModalTimeouts>;
	/** host:port addresses the probe tries to connect to, to show a computer with network none reaches nothing. */
	probeTargets?: string[];
}

const NOT_BUILT = "the Modal provider is not built yet";

export class ModalProvider implements ComputerProvider {
	readonly id = "modal";
	readonly version = "0.0.0";

	constructor(_options: ModalProviderOptions) {}

	capabilities(): ComputerCapabilities {
		throw new Error(NOT_BUILT);
	}

	check(_spec: ComputerSpec): Refusal[] {
		throw new Error(NOT_BUILT);
	}

	async create(_spec: ComputerSpec, _context: CallContext = {}): Promise<Result<ComputerRef>> {
		return fail("unsupported", NOT_BUILT);
	}

	async attach(_ref: { id: string } | { labels: Record<string, string> }, _context: CallContext = {}): Promise<Result<AttachedComputer>> {
		return fail("unsupported", NOT_BUILT);
	}

	async list(_labels: Record<string, string>, _context: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		return fail("unsupported", NOT_BUILT);
	}

	async network(_ref: ComputerRef, _policy?: NetworkSpec, _context: CallContext = {}): Promise<Result<NetworkPolicy>> {
		return fail("unsupported", NOT_BUILT);
	}

	async connect(_ref: ComputerRef): Promise<Result<ComputerConnection>> {
		return fail("unsupported", NOT_BUILT);
	}

	async release(_ref: ComputerRef, _how: "stop" | "delete", _context: CallContext = {}): Promise<Result<void>> {
		return fail("unsupported", NOT_BUILT);
	}
}
