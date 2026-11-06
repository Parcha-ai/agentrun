// The Daytona provisioner, over Daytona's v0 REST API with fetch (no SDK), as pi-transport's Daytona box does. The daemon
// goes in through the toolbox's file upload and starts as a session command, dropped to a user with no capabilities;
// connect() carries stdio over a session command's input calls and its log stream. Every Daytona fact used here is cited
// in the README's Daytona section.
import { readFileSync } from "node:fs";
import type {
	AttachedComputer,
	ComputerCapabilities,
	ComputerConnection,
	ComputerInfo,
	ComputerProvider,
	ComputerRef,
	ComputerSpec,
	NetworkPolicy,
	Refusal,
} from "./provider.js";
import { fail, type Result } from "./result.js";

/** The longest each kind of call may take, and the pauses between polls and retries. */
export interface DaytonaTimeouts {
	/** One control-plane or toolbox call. */
	requestMs: number;
	/** POST /sandbox. */
	createMs: number;
	/** From the create's answer to a started sandbox. */
	startMs: number;
	/** One DELETE. */
	deleteMs: number;
	/** From the stop's answer to a stopped sandbox. */
	stopMs: number;
	/** The daemon's upload. */
	uploadMs: number;
	/** The install script. */
	execMs: number;
	/** From a connect's start to the daemon's hello, and each read-back call after it. */
	helloMs: number;
	pollMs: number;
	/** The first pause before a retry; each next one doubles. */
	retryMs: number;
	/** How long create waits for the listing to show the new computer steadily, and for how long it must. */
	listedMs: number;
	listedStableMs: number;
}

/** The parts of a WebSocket the provider uses: Node's global WebSocket, or a fake in tests. */
export interface WebSocketLike {
	binaryType: string;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; message?: string }) => void): void;
	close(code?: number): void;
}

export type WebSocketFactory = (url: string, init: { headers: Record<string, string>; protocols: string[] }) => WebSocketLike;

export interface DaytonaProviderOptions {
	/** The Daytona API key. The caller passes it; this provider never reads the environment and never puts it in a computer. */
	apiKey: string;
	/** Default https://app.daytona.io/api. */
	apiUrl?: string;
	/** The daemon binary on this machine, for the sandboxes' architecture (dist/computerd-linux-<arch>). */
	daemonPath: string;
	/** Go's name for the sandboxes' architecture, which hello must report. Default amd64. */
	arch?: string;
	/** The class the snapshots this provider is given make: container (default) or linux-vm. */
	sandboxClass?: "container" | "linux-vm";
	/** The Daytona target (region); default the organization's. */
	target?: string;
	/** Who the daemon runs as, uid:gid in numbers, never root. Default 1000:1000. */
	daemonUser?: string;
	/** For tests: every request goes through it. Default the global fetch. */
	fetch?: typeof fetch;
	/** For tests: every log stream opens through it. Default Node's global WebSocket. */
	webSocket?: WebSocketFactory;
	timeouts?: Partial<DaytonaTimeouts>;
}

/** A stub until the provider is built. */
export function daytonaCommands(_options: { staging?: string; deadline?: string; user?: string } = {}): { install: string; init: string; stdio: string } {
	throw new Error("the Daytona provider is not built yet");
}

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const NOT_YET = "the Daytona provider is not built yet";

/** A stub: every method refuses until the provider is built. */
export class DaytonaProvider implements ComputerProvider {
	readonly id = "daytona";
	readonly version = VERSION;

	constructor(_options: DaytonaProviderOptions) {}

	capabilities(): ComputerCapabilities {
		return { lifetime: "janitor", network: [], isolation: "container", os: "linux", daemon: [] };
	}

	check(_spec: ComputerSpec): Refusal[] {
		return [{ field: "provider", message: NOT_YET }];
	}

	async create(): Promise<Result<ComputerRef>> {
		return fail("unsupported", NOT_YET);
	}

	async attach(): Promise<Result<AttachedComputer>> {
		return fail("unsupported", NOT_YET);
	}

	async list(): Promise<Result<ComputerInfo[]>> {
		return fail("unsupported", NOT_YET);
	}

	async network(): Promise<Result<NetworkPolicy>> {
		return fail("unsupported", NOT_YET);
	}

	async connect(): Promise<Result<ComputerConnection>> {
		return fail("unsupported", NOT_YET);
	}

	async release(): Promise<Result<void>> {
		return fail("unsupported", NOT_YET);
	}
}
