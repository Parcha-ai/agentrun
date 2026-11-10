// The Modal provisioner, VM runtime only: every call through the host's own Modal JS SDK client, of which this package
// names only the slice it uses (ModalSdk) and imports nothing. Every SDK fact below is cited in the README's Modal
// section, from modal-client@64880502 (js/src) and Modal's docs.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./client.js";
import {
	COMPUTER_LABEL,
	DAEMON_IN_COMPUTER,
	DEADLINE_LABEL,
	DEFAULT_CPUS,
	DEFAULT_MEMORY_MB,
	helloDrift,
	type ProbeReport,
	probeNetworkDrift,
	probeNotes,
	probeReportOf,
	WORK,
} from "./drift.js";
import { OWN_NETWORK_ONLY, probeOwnNetworkDrift, TOOL_USER } from "./isolation.js";
import { releaseOlder } from "./janitor.js";
import type { KindCapabilities } from "./kinds.js";
import { EPOCH_LABEL, epochOf, RUN_LABEL } from "./labels.js";
import { checkMount, type MountKind, type MountReadBack, readBackOf } from "./mount.js";
import {
	ARCHIL_HELPER,
	ARCHIL_MOUNT_LABEL,
	ARCHIL_TOOL_UID,
	type ArchilMount,
	type ArchilRoot,
	archilMount,
	archilRefusals,
	archilRelease,
	claimEpoch,
	mountDrift,
	type ProviderNote,
	type RecordedArchil,
	readArchilMount,
	recordedArchil as recordedArchilOf,
	syncingClient,
} from "./mount-archil.js";
import {
	type AttachedComputer,
	type CallContext,
	type ComputerCapabilities,
	type ComputerConnection,
	type ComputerInfo,
	type ComputerProvider,
	type ComputerRef,
	type ComputerSpec,
	type CreatedComputer,
	checkLifetime,
	type NetworkForm,
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
} from "./provider.js";
import { type ComputerErrorCode, fail, ok, type Result } from "./result.js";
import { daemonWatch, type ScreenWatch, type ScreenWatchHandlers, type WatchOptions } from "./screen-watch.js";
import { connectionError } from "./test-connection.js";
import { waitUntil } from "./wait.js";

/** The App sandboxes are made in (modal-client@64880502:js/src/app.ts:32-61). */
export interface ModalApp {
	readonly appId: string;
}

/** An Image, built on Modal's side when a sandbox is created from it (js/src/image.ts:311-401). */
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

/** One program started by exec in binary mode: the part of the SDK's ContainerProcess read here (sandbox.ts:2774-2914). */
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
	/** The sandbox's own command's output (the SDK's ModalReadStream): read only to say why a create's sandbox ended. */
	readonly stdout?: { readText(): Promise<string> };
	readonly stderr?: { readText(): Promise<string> };
}

/** The part of the SDK's ModalClient this provider calls. The host passes its own client. */
export interface ModalSdk {
	readonly apps: { fromName(name: string, params: { createIfMissing: boolean }): Promise<ModalApp> };
	/** fromId opens an image Modal already holds (im-..., as box/build-modal.py prints it); a spec naming one needs it. */
	readonly images: { fromRegistry(tag: string): ModalImage; fromId?(id: string): Promise<ModalImage> };
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
	/** A new connection, from the start of the bridge's exec (at most callMs of it) to the daemon's hello. */
	helloMs: number;
	/** The probe, run through the daemon. */
	probeMs: number;
	/** One whole list, every page and every sandbox's tags. */
	listMs: number;
	/** The daemon's upload, from the exec's start to its exit. The entrypoint waits this long and one call more. */
	uploadMs: number;
	/**
	 * How long release delete, and a create that refuses its sandbox (drift, an abort, a failed upload), wait after the
	 * terminate for poll to read the sandbox finished: Modal ends a sandbox asynchronously, and lists it until then. Each
	 * wait also ends on the caller's abort.
	 */
	releaseMs: number;
	/** The first pause between two of those polls; the pauses double up to 5 s. */
	releasePollMs: number;
	/** Each root step of an Archil mount through exec (the preflight, mount or revoke, serve), and its checkin at release. */
	mountMs: number;
}

export interface ModalProviderOptions {
	/** The host's Modal client, or anything with the same slice. */
	sdk: ModalSdk;
	/** Told what is no failure of the call it came from: a release that did not let an Archil folder go cleanly. */
	onNote?: ProviderNote;
	/** The Modal App the sandboxes live in; made when missing. */
	app: string;
	/**
	 * A registry image holding the daemon for linux/amd64 at /computerd, pinned by digest (name@sha256:<64 hex>), copied
	 * into each computer's image with COPY --from. Without it the daemon is uploaded (daemonPath).
	 */
	daemonImage?: string;
	/**
	 * The daemon binary for linux/amd64 on this machine, streamed into each computer right after create when no
	 * daemonImage is given. Default this package's dist/computerd-linux-amd64 (npm run build:daemon).
	 */
	daemonPath?: string;
	/** The longest lifetime check takes, in ms, declared as capabilities().maxLifetimeMs: at most 24 hours, Modal's longest timeout, which is the default. */
	maxLifetimeMs?: number;
	/**
	 * Who a computer runs as when its spec does not say: uid:gid in numbers, never root or root's group. Default 2510:2510
	 * (TOOL_USER). Init refuses to start while another process in the sandbox holds the uid.
	 */
	user?: string;
	timeouts?: Partial<ModalTimeouts>;
	/**
	 * The addresses the probe tries, to show none of them answers a computer with network none: host:port over TCP, or
	 * host:port/udp, a DNS query over UDP.
	 */
	probeTargets?: string[];
}

/** The mount kinds a Modal computer takes, as capabilities().mount declares them: the run's folder on an Archil disk. */
export const MOUNT: readonly MountKind[] = ["archil"];
/** The network a Modal computer's programs get: none, a network of their own (isolation.ts OWN_NETWORK_ONLY). */
export const NETWORK: readonly NetworkForm[] = ["none"];

/** The machine kind and groups of its one configuration: a linux computer. */
export const CAPABILITIES: readonly KindCapabilities[] = [{ kind: "linux", groups: ["exec", "files", "processes"] }];
/** A registry tag for linux/amd64 that Modal can pull: the default when a setting names no image. */
export const MODAL_DEFAULT_IMAGE = "debian:bookworm-slim";

/** The SDK's default server (modal-client@64880502:js/src/config.ts:143). */
export const MODAL_DEFAULT_SERVER_URL = "https://api.modal.com:443";

/** What modalClient gives the SDK's ModalClient: the token, explicitly, so the SDK fills none of it in. */
export interface ModalClientParams {
	tokenId: string;
	tokenSecret: string;
}

/** The SDK's ModalClient constructor, or a stand-in for one. */
export type ModalClientConstructor = new (params: ModalClientParams) => unknown;

/** What modalClient takes: the token, the server it goes to, and the SDK's client class. */
export interface ModalClientOptions {
	/** The Modal token's id and secret. Serve passes its MODAL_TOKEN_ID and MODAL_TOKEN_SECRET; the conformance module the token it reads. */
	tokenId: string;
	tokenSecret: string;
	/** The server the token goes to; default the SDK's, https://api.modal.com:443. */
	serverUrl?: string;
	/** The SDK's ModalClient; imported from the host's modal package by default. */
	ModalClient?: ModalClientConstructor;
}

/** What create() takes: the provider's options, the client's in place of the SDK. */
export interface ModalCreateOptions extends Omit<ModalProviderOptions, "sdk">, ModalClientOptions {}

/** Not a literal, so no type checker or bundler resolves the SDK from this package. */
const MODAL_PACKAGE: string = "modal";

/** The construction now running, or the last one: the next waits for it, so two never overlap. */
let constructing: Promise<unknown> = Promise.resolve();

/**
 * A Modal client given the token passed in, and nothing of the environment: a tokenId and tokenSecret passed to
 * ModalClient replace what the environment or the profile held, and clear any OAuth credentials (client.ts:124-148), so a
 * MODAL_TOKEN_ID or ~/.modal.toml on the host is never used. The key goes only to options.serverUrl, else the SDK's
 * default (config.ts:143). ModalClient cannot take a server explicitly: it declares `endpoint` (client.ts:51) and never
 * reads it, and the control-plane client is made from the profile's serverUrl (client.ts:131, 175, 281), which getProfile
 * takes from MODAL_SERVER_URL before any profile's server_url (config.ts:140-143), the profile being MODAL_PROFILE's or the
 * active one in MODAL_CONFIG_PATH or ~/.modal.toml (config.ts:76-82, 126-137).
 *
 * So this is the library's one touch of the environment, a guard and not a setting (README, Settings): an ambient
 * MODAL_SERVER_URL is refused, and MODAL_SERVER_URL is set to the chosen server only while the client is constructed,
 * and put back after, so no profile can redirect the key. process.env is the whole process's: constructions run one at a
 * time, each waiting for the last, so none sees another's server. The modal package is the host's: it is imported only
 * here.
 */
export async function modalClient({ tokenId, tokenSecret, serverUrl = MODAL_DEFAULT_SERVER_URL, ModalClient }: ModalClientOptions): Promise<ModalSdk> {
	if (typeof tokenId !== "string" || tokenId === "" || typeof tokenSecret !== "string" || tokenSecret === "") {
		throw new Error("the Modal provider needs options.tokenId and options.tokenSecret, a Modal token: it reads none from the environment, so the caller passes it");
	}
	if (typeof serverUrl !== "string" || !URL.canParse(serverUrl)) throw new Error("options.serverUrl is the Modal server's URL, such as https://api.modal.com:443");
	const ambient = `the Modal provider refuses to start while MODAL_SERVER_URL is set: the SDK would send the key there. Unset it, and pass the server as options.serverUrl if it is not ${MODAL_DEFAULT_SERVER_URL}`;
	if (process.env.MODAL_SERVER_URL) throw new Error(ambient);
	const Client = ModalClient ?? ((await import(MODAL_PACKAGE)) as { ModalClient: ModalClientConstructor }).ModalClient;
	// getProfile reads MODAL_SERVER_URL from process.env when the client is constructed (client.ts:123), and the
	// control-plane client is made then (client.ts:175); afterwards process.env is as it was. One construction at a time.
	const turn = constructing.then(() => {
		if (process.env.MODAL_SERVER_URL) throw new Error(ambient);
		const before = process.env.MODAL_SERVER_URL;
		process.env.MODAL_SERVER_URL = serverUrl;
		try {
			return new Client({ tokenId, tokenSecret }) as ModalSdk;
		} finally {
			if (before === undefined) delete process.env.MODAL_SERVER_URL;
			else process.env.MODAL_SERVER_URL = before;
		}
	});
	constructing = turn.catch(() => undefined);
	return turn;
}

/**
 * A ModalProvider from its options alone: the client as modalClient makes it from the token and server passed in, the
 * app (required), and the daemon copied from options.daemonImage when given, else uploaded (options.daemonPath, else this
 * package's build): given both, the image wins and no upload path is passed on, as the class takes one or the other. It
 * reads no environment but the guard modalClient keeps: serve passes its MODAL_TOKEN_ID, MODAL_TOKEN_SECRET and
 * AGENTRUN_BOX_APP, the conformance module the settings it reads. The app and the token are checked before any client
 * is made, and neither is ever echoed.
 */
export async function create(options: ModalCreateOptions): Promise<ModalProvider> {
	const { tokenId, tokenSecret, serverUrl, ModalClient, daemonImage, daemonPath, ...rest } = options ?? ({} as ModalCreateOptions);
	if (typeof rest.app !== "string" || rest.app.trim() === "") throw new Error("options.app, the Modal app its sandboxes live in, is required");
	const daemon = daemonImage !== undefined ? { daemonImage } : daemonPath !== undefined ? { daemonPath } : {};
	const sdk = await modalClient({ tokenId, tokenSecret, ...(serverUrl === undefined ? {} : { serverUrl }), ...(ModalClient ? { ModalClient } : {}) });
	return new ModalProvider({ ...rest, ...daemon, sdk });
}

/** The conformance CLI's module for Modal: its live switch, the run's 30-minute cap and the drifted twin. */
export const conformance = () => import("./conformance/modal.js");

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const NAME = /^computer-[0-9a-f]{12}$/;
/** A sandbox id as the SDK takes one; ownership is decided by its tags, never by its shape. */
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** An image Modal already holds, by its id, as box/build-modal.py prints it: opened with images.fromId, never pulled. */
const MODAL_IMAGE_ID = /^im-[A-Za-z0-9]+$/;
const NAME_TAG = `${COMPUTER_LABEL}.name`;
const SPEC_TAG = `${COMPUTER_LABEL}.spec`;
/** "A Sandbox can carry up to 10 tags" (guide/sandboxes#tagging); the provider uses four. */
const MAX_TAGS = 10;
const OWN_TAGS = 4;
/** "a timeout of up to 24 hours" (guide/sandboxes#timeouts). */
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** A registry reference pinned by digest. */
const PINNED = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
/** A workdir becomes a Dockerfile WORKDIR line, so it holds no space, quote or variable. */
const WORKDIR = /^\/[A-Za-z0-9._/-]*$/;
const USER = /^(\d+)(?::(\d+))?$/;
const MAX_ID = 4_294_967_294;
const USER_FORM = "a uid or uid:gid in numbers, such as 1000:1000; a name is refused, since the image may not have it";
/** A user that is root: uid 0, however written, or the name, with or without a group. */
const ROOT_USER = /^(?:0+|root)(?::|$)/;
const isRootUser = (value: unknown) => typeof value === "string" && ROOT_USER.test(value);
/**
 * Why a Modal computer never runs as root. Init leaves root no capability, yet uid 0 still owns /, /opt and
 * /opt/agentrun, so it can rename a program of its own over the daemon; no file mode stops the owner of every directory
 * above it. Every connection is Modal's exec of that path, outside the daemon, with Modal's own root capabilities.
 */
const ROOT =
	"a Modal computer does not run as root: each connection is Modal's exec of the daemon's stdio bridge, which runs /opt/agentrun/computerd outside the daemon with Modal's own root capabilities, and a root computer user, though init leaves it no capability, owns /, /opt and /opt/agentrun, so it could replace what that exec runs; ask for another uid, such as 1000:1000";
/** A probe target: host:port, over TCP, or host:port/udp, a DNS query over UDP. */
const TARGET = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}(?:\/udp)?$/;
/** Modal's own default request (guide/sandbox-resources, "Pay for what you use"): a spec's sizes are limits, as in Docker. */
const CPU_REQUEST = 0.125;
const MEMORY_REQUEST_MIB = 128;
/** "1 core = 2 vCPUs" (guide/sandbox-resources): a spec's cpus are CPUs, Modal's cpu is physical cores. */
const CPUS_PER_CORE = 2;
const DEFAULT_TIMEOUTS: ModalTimeouts = {
	createMs: 600_000,
	callMs: 60_000,
	helloMs: 30_000,
	probeMs: 30_000,
	listMs: 120_000,
	uploadMs: 300_000,
	releaseMs: 120_000,
	releasePollMs: 500,
	mountMs: 120_000,
};
/** The user an Archil computer's tools run as: the image's agentrun-tool, with no sudo and no capability. */
const ARCHIL_USER = `${ARCHIL_TOOL_UID}:${ARCHIL_TOOL_UID}`;
/**
 * What an Archil computer's entrypoint waits for, beside the daemon, before it becomes init: root makes it through exec
 * once the run's folder is mounted, so no tool program runs before that. The daemon's directory is root's alone.
 */
export const ARCHIL_GATE = "/opt/agentrun/archil-mounted";
/** The longest pause between two of release's polls. */
const RELEASE_POLL_MAX_MS = 5_000;
/** The daemon this package builds for Modal's architecture: images must be linux/amd64 (guide/existing-images). */
const DEFAULT_DAEMON_PATH = fileURLToPath(new URL("./computerd-linux-amd64", import.meta.url));
/** The SDK's own bytes per stdin message when it streams (task_command_router_client.ts:193): each writeBytes is one call. */
const UPLOAD_CHUNK = 256 * 1024;
/** The pause before the bridge is tried again while init is not yet listening. */
const LISTEN_RETRY_MS = 250;

/**
 * The sandbox's command when the daemon is uploaded: wait, bounded, for the daemon to be moved into place executable,
 * then become it with exec, so init is the sandbox's main process and the sandbox ends when init does. POSIX sh and
 * tools in BusyBox and coreutils alike; `date +%s` bounds the wait however long a sleep takes, and in whole seconds it
 * ends after more than w seconds and less than w + 3. An Archil computer's (`--gate <path>` before init's arguments)
 * also waits for the gate, which root makes once the run's folder is mounted; a gate there before it starts (an image
 * that holds one) is not this computer's, and goes first.
 */
const ENTRYPOINT_SCRIPT = [
	"# agentrun-computer: entrypoint",
	"d=$1; w=$2; h=$3; shift 3",
	'g=; if [ "${1-}" = --gate ]; then g=$2; shift 2; rm -f "$g"; fi',
	"end=$(( $(date +%s) + $w ))",
	'until [ -f "$d" ] && [ -x "$d" ] && { [ -z "$g" ] || [ -f "$g" ]; }; do',
	'\tif [ "$(date +%s)" -gt "$end" ]; then',
	'\t\tif [ -f "$d" ] && [ -x "$d" ]; then echo "agentrun-computer: the Archil mount was not made within $w s ($g is not there), so this computer ends" >&2',
	'\t\telse echo "agentrun-computer: the daemon did not arrive at $d within $w s, so this computer ends" >&2; fi',
	"\t\texit 3",
	"\tfi",
	"\tsleep 0.2 2>/dev/null || sleep 1",
	"done",
	'export HOME="$h"',
	'exec "$d" "$@"',
].join("\n");

/** held PATH: every component of PATH up to / is owned by uid 0 with no group or other write, and not a link; else it
 *  says which is not and returns 1. The same rule as the Daytona provider's install. */
const HELD = 'held() { x=$1; while :; do set -- $(ls -ldn "$x" 2>/dev/null); case "$1" in ?????[!w]??[!w]?|?????[!w]??[!w]?.) ;; *) false ;; esac && [ "$3" = 0 ] || { echo "the daemon at $d is not root\'s alone: $x is ${1:-missing}, owner ${3:-none}"; return 1; }; [ "$x" = / ] && return 0; x=${x%/*}; x=${x:-/}; done; }';

/**
 * The upload, run through exec as root (Modal containers always run as root): stdin to a part file beside the daemon's
 * path, its sha256 printed, and the part moved into place last, only when it is the one named. The rename is what the
 * entrypoint waits for, so it never starts a daemon half written or not the one uploaded.
 */
const UPLOAD_SCRIPT = [
	"# agentrun-computer: upload",
	'd=$1; s=$2; b=${d%/*}; p="$b/.computerd.part"',
	// The daemon's path must be root's alone, every directory up to /: each connection runs it as root through Modal's
	// exec, so a path a non-root computer user could change would let that user swap what root runs. A path another
	// user can change is refused with nothing installed; the daemon's own directory is made root's (0755) first.
	HELD,
	'[ -d "${b%/*}" ] || mkdir -p -m 0755 "${b%/*}" || { echo "making ${b%/*} failed"; exit 4; }',
	'held "${b%/*}" || exit 7',
	'[ -L "$b" ] && { echo "the daemon at $d is not root\'s alone: $b is a symbolic link"; exit 7; }',
	'mkdir -p "$b" && chown 0:0 "$b" && chmod 0755 "$b" || { echo "making $b root\'s failed"; exit 4; }',
	'cat > "$p" && chmod 0755 "$p" || { echo "writing the daemon to $p failed"; exit 4; }',
	'r=$(sha256sum "$p" | cut -c1-64)',
	'echo "sha256 $r"',
	'[ "$r" = "$s" ] || { echo "the daemon written to $p reads sha256 $r, not $s, so it is not moved into place"; exit 5; }',
	'mv -f "$p" "$d" || { echo "moving the daemon into $d failed"; exit 6; }',
	'held "$d" || exit 7',
].join("\n");

/**
 * The image route's hold step, run as root while the computer's image is built, right after the daemon is copied in:
 * the daemon's directory and binary are made root's (0755), a link is refused, and the whole path up to / is held to
 * the same rule as the upload's. A path another user can change fails the build, so no computer is made from it.
 */
const HOLD_SCRIPT = [
	"# agentrun-computer: hold",
	'd=$1; b=${d%/*}',
	HELD,
	'held "${b%/*}" || exit 7',
	'[ -L "$b" ] && { echo "the daemon at $d is not root\'s alone: $b is a symbolic link"; exit 7; }',
	'chown 0:0 "$b" "$d" && chmod 0755 "$b" "$d" || { echo "making $d root\'s failed"; exit 4; }',
	'held "$d" || exit 7',
].join("\n");

/**
 * Init's arguments, after the daemon's path: the one place they are built, for the image route's command and the
 * entrypoint alike. Init and every tool run in a network namespace of their own, loopback alone (--own-network), an
 * Archil computer's too: its archil client and serve run through exec as root, outside it.
 */
function initArgs({ deadline, user }: { deadline: string; user: string }): string[] {
	return ["init", "--deadline", deadline, "--user", user, "--own-network"];
}

/**
 * The commands the provider sends into a sandbox when it uploads the daemon, exactly: the sandbox's command
 * (entrypoint, which also waits for `gate` when given: an Archil computer's), the upload, and a connection's bridge
 * (stdio). Exported so a test can run them where Modal would.
 */
export function modalCommands({
	deadline = "",
	user = TOOL_USER,
	waitSeconds = 360,
	sha256 = "",
	daemon = DAEMON_IN_COMPUTER,
	home = WORK,
	gate,
}: { deadline?: string; user?: string; waitSeconds?: number; sha256?: string; daemon?: string; home?: string; gate?: string } = {}) {
	return {
		entrypoint: ["sh", "-c", ENTRYPOINT_SCRIPT, "sh", daemon, String(waitSeconds), home, ...(gate === undefined ? [] : ["--gate", gate]), ...initArgs({ deadline, user })],
		upload: ["sh", "-c", UPLOAD_SCRIPT, "sh", daemon, sha256],
		hold: ["sh", "-c", HOLD_SCRIPT, "sh", daemon],
		stdio: [daemon, "stdio"],
	};
}
/**
 * Public anycast resolvers, by address: with no network, not even DNS works (guide/sandbox-networking). TCP to 443, and
 * DNS over UDP to 53, the classic path out where TCP is dropped, over IPv4 and IPv6.
 */
const DEFAULT_PROBE_TARGETS = ["1.1.1.1:443", "8.8.8.8:443", "[2606:4700:4700::1111]:443", "1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp"];
/** How long close waits for the stdio bridge to exit once its stdin has ended. Modal has no kill for an exec. */
const CLOSE_WAIT_MS = 5_000;
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "cpus", "memoryMb", "pids", "labels", "workdir", "user", "mount"]);
const NUL = "a NUL byte cannot be passed to Modal";
const FIXED =
	"a Modal computer's network is fixed at create: Modal cannot update the policy of a sandbox made with blockNetwork, and updates only an allowlist set at create; create a new computer";
const STOP =
	"Modal has no stop that keeps a sandbox: terminate is a sandbox's only end, and a sandbox that has finished cannot run again; release it with delete";

/** What create records of a computer in its spec tag, and attach reads back. */
interface Recorded {
	image: string;
	user: string;
	network: "none" | "open";
	cpus: number;
	memoryMb: number;
	workdir: string;
	runtime: "vm";
	/** An Archil computer's mount as it reads back (readBackOf, under the claim's epoch): never the token. */
	mount?: MountReadBack;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const seconds = (ms: number) => `${ms / 1000} s`;
const pause = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
	});
/** Everything a stream gives, as text; what it gave before an error, if it errs. */
async function textOf(source: AsyncIterable<Uint8Array>): Promise<string> {
	let text = "";
	try {
		for await (const chunk of source) text = (text + Buffer.from(chunk).toString("utf8")).slice(-8192);
	} catch {
		// What was read is what there is.
	}
	return text;
}
const words = (error: unknown) => {
	const name = (error as { name?: unknown } | null)?.name;
	const message = error instanceof Error ? error.message : String(error);
	return `${typeof name === "string" && name !== "Error" ? `${name}: ` : ""}${message}`.replace(/\s+/g, " ").slice(0, 300);
};

/** The SDK names its errors (js/src/errors.ts); a call that failed on the wire carries a gRPC status code. */
function codeOf(error: unknown): ComputerErrorCode {
	const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
	if (name === "NotFoundError" || code === 5) return "not_found";
	if (name === "InvalidError" || code === 3) return "invalid";
	// gRPC's UNAUTHENTICATED and PERMISSION_DENIED: a token Modal refused.
	if (code === 16 || code === 7) return "denied";
	return "modal";
}

/** Settles with the promise's result, or a timeout or abort in words once ms pass or signal aborts. */
function race<T>(promise: Promise<T>, what: string, ms: number, signal?: AbortSignal): Promise<Result<T>> {
	if (signal?.aborted) {
		promise.catch(() => {});
		return Promise.resolve(fail("aborted", `${what} was aborted`));
	}
	return new Promise((settle) => {
		const timer = setTimeout(() => done(fail("timeout", `${what} did not answer within ${seconds(ms)}`)), ms);
		const onAbort = () => done(fail("aborted", `${what} was aborted`));
		signal?.addEventListener("abort", onAbort, { once: true });
		let settled = false;
		function done(result: Result<T>) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			settle(result);
		}
		promise.then(
			(value) => done(ok(value)),
			(error: unknown) => done(fail(codeOf(error), `${what} failed: ${words(error)}`)),
		);
	});
}

/** A signal that aborts after ms, or with signal. Its timer holds the event loop, as AbortSignal.timeout's does not. */
function within(ms: number, signal?: AbortSignal): { signal: AbortSignal; clear(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	const onAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		clear: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

/** Calls run and races it; a run that throws at once is an error like one that rejects. */
function call<T>(what: string, run: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<Result<T>> {
	if (signal?.aborted) return Promise.resolve(fail("aborted", `${what} was aborted before it was called`));
	let promise: Promise<T>;
	try {
		promise = Promise.resolve(run());
	} catch (error) {
		return Promise.resolve(fail(codeOf(error), `${what} failed: ${words(error)}`));
	}
	return race(promise, what, ms, signal);
}

export interface UntilFinishedOptions {
	/** The sandbox in words, for the errors, such as its name or id. */
	name: string;
	/** The longest the whole wait takes, in ms. */
	boundMs: number;
	/** The longest one poll may take, in ms. */
	callMs: number;
	/** The first pause between two polls, in ms; each pause doubles up to maxMs. */
	minMs: number;
	/** The longest pause between two polls, in ms. */
	maxMs: number;
	/** Ends the wait early, as aborted; a wait that must finish whatever its caller does is given none. */
	signal?: AbortSignal;
}

/**
 * The one wait after a terminate, which returns before Modal has ended the sandbox (sandbox.ts:1292-1296, 2238-2251):
 * polls through waitUntil until poll reads an exit code (null while it runs, sandbox.ts:2761-2771) or Modal no longer
 * knows the sandbox. Past boundMs it is a timeout, and on the signal's abort an abort, each saying what poll last read;
 * it never reports a sandbox finished that it did not read finished. release delete, a create that refuses its
 * sandbox, and modal-sweep --after all wait through it.
 */
export async function untilFinished(poll: () => Promise<number | null>, { name, boundMs, callMs, minMs, maxMs, signal }: UntilFinishedOptions): Promise<Result<void>> {
	const finished = await waitUntil(
		(readSignal) => call(`poll of ${name}`, poll, callMs, readSignal),
		(polled) => (polled.ok && polled.value !== null) || (!polled.ok && polled.error.code === "not_found"),
		{
			boundMs,
			signal,
			minMs,
			maxMs,
			what: `${name} to finish after its terminate`,
			describe: (polled) => (!polled.ok ? polled.error.message : polled.value === null ? "poll read null: it still runs" : `poll read exit code ${polled.value}`),
		},
	);
	return finished.ok ? ok(undefined) : finished;
}

/** Bytes as Buffers, which the daemon client reads lines from. */
async function* buffers(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
	for await (const chunk of source) yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function labelProblem(key: string, value: unknown): string | undefined {
	if (typeof value !== "string") return `the label ${key} must be a string`;
	if (key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)}: ${NUL}`;
	if (key === "") return "a label's name must be non-empty";
	if (key === COMPUTER_LABEL || key.startsWith(`${COMPUTER_LABEL}.`)) return `the label ${key} is in the provider's own namespace (${COMPUTER_LABEL})`;
	// Modal records the mount in its spec tag, so this label is read nowhere here; it is refused as Daytona and E2B
	// refuse it, so one spec meets the same rule on every provider with an Archil mount.
	if (key === ARCHIL_MOUNT_LABEL) return `the label ${key} is the provider's own: it records an Archil computer's mount`;
	return undefined;
}

/** Why labels cannot be a tag filter, or undefined when they can. */
function filterProblem(labels: unknown): string | undefined {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return "labels must map names to strings";
	for (const [key, value] of Object.entries(labels)) {
		if (typeof value !== "string") return `the label ${key} must be a string`;
		if (key === "" || key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)} must be a non-empty name with no NUL byte`;
	}
	return undefined;
}

/** "uid:gid" for a user in numbers (a uid alone is its own gid), or undefined when it is not one. */
function userOf(value: unknown): string | undefined {
	const match = typeof value === "string" ? USER.exec(value) : null;
	if (match === null) return undefined;
	const [uid, gid] = [Number(match[1]), Number(match[2] ?? match[1])];
	return uid <= MAX_ID && gid <= MAX_ID ? `${uid}:${gid}` : undefined;
}

/** Only a sandbox this provider made counts: its tag, a name of its making, and the name asked for when one is. */
const ours = (tags: Record<string, string>, name?: string) =>
	tags[COMPUTER_LABEL] === "1" && NAME.test(tags[NAME_TAG] ?? "") && (name === undefined || tags[NAME_TAG] === name);

/** The deadline tag as create writes it, an ISO time, or undefined. */
function deadlineOf(tags: Record<string, string>): Date | undefined {
	const written = tags[DEADLINE_LABEL];
	const at = written === undefined ? Number.NaN : Date.parse(written);
	return Number.isNaN(at) || new Date(at).toISOString() !== written ? undefined : new Date(at);
}

/** The spec tag, parsed, or a sentence saying why it is not the one create writes. */
function recordedOf(tags: Record<string, string>): Recorded | string {
	try {
		const value = JSON.parse(tags[SPEC_TAG] ?? "") as Partial<Recorded> | null;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Recorded;
	} catch {
		// Not JSON: said below.
	}
	return `spec: the tag ${SPEC_TAG} reads ${show(tags[SPEC_TAG])}, not the spec create writes`;
}

/** The network a computer was created with, as list reports it: a tag only the host's token writes. */
function recordedNetwork(tags: Record<string, string>): NetworkPolicy {
	const recorded = recordedOf(tags);
	if (typeof recorded !== "string" && (recorded.network === "none" || recorded.network === "open")) return recorded.network;
	return { other: `the tag ${SPEC_TAG} names no network this provider makes` };
}

/**
 * The Archil mount a computer's spec tag records (recordedArchilOf, shared), or undefined when it records none: the
 * tag's mount, under the epoch the tag recorded it at, which must be the label's.
 */
function recordedArchil(tags: Record<string, string>): RecordedArchil | undefined {
	const recorded = recordedOf(tags);
	if (typeof recorded === "string" || recorded.mount === undefined) return undefined;
	const read = epochOf(tags);
	const { kind, disk, region, folder, epoch: was } = (recorded.mount ?? {}) as Record<string, unknown>;
	if (kind !== "archil" || typeof disk !== "string" || typeof region !== "string" || typeof folder !== "string") {
		return recordedArchilOf(tags, { other: `the tag ${SPEC_TAG} records a mount this provider never makes` });
	}
	const mount = { kind, disk, region, folder } as const;
	if (read.ok && was !== read.value) {
		return recordedArchilOf(tags, { mount, other: `the tag ${SPEC_TAG} records the mount under epoch ${show(was)}, yet the label ${EPOCH_LABEL} reads ${read.value}` });
	}
	return recordedArchilOf(tags, { mount });
}

/** Every way the probe's report differs from what the computer should be. */
function probeDrift(probe: ProbeReport, expected: { user?: string; network?: NetworkSpec }): string[] {
	const found: string[] = [];
	const user = `${probe.uid}:${probe.gid}`;
	if (expected.user !== undefined && user !== expected.user) found.push(`user: declared ${expected.user}, read back ${user} (the uid:gid the daemon's programs run as)`);
	if (/gvisor/i.test(probe.kernel)) found.push(`runtime: declared vm, read back gVisor (the kernel reports ${JSON.stringify(probe.kernel)})`);
	if (expected.network === "none") found.push(...probeNetworkDrift(probe));
	// Its own network: the live interfaces lo alone (a kernel's quiet tunnels are none), and none it could bring up.
	found.push(...probeOwnNetworkDrift(probe));
	return found;
}

/** Every way the tags read back differ from those create gave. */
function tagDrift(given: Record<string, string>, read: Record<string, string>): string[] {
	const found: string[] = [];
	for (const [key, value] of Object.entries(given)) if (read[key] !== value) found.push(`tag ${key}: declared ${show(value)}, read back ${show(read[key])}`);
	for (const [key, value] of Object.entries(read)) if (!(key in given)) found.push(`tag ${key}: none declared, read back ${show(value)}`);
	return found;
}

/**
 * Computers that are Modal sandboxes on the VM runtime. The daemon is uploaded right after create, streamed through an
 * exec's stdin, while the sandbox's command, a small sh entrypoint, waits for it and then becomes `computerd init`; or,
 * with daemonImage, it comes in as a layer of the computer's image (COPY --from) and is the command itself. A
 * connection is `computerd stdio` through exec, so a computer with network none is still reached, and needs no network
 * to get its daemon either way. Modal ends each sandbox at its timeout, so the lifetime is the vendor's. Modal reads no
 * network policy back, so the daemon's probe stands for one: network none is honoured only when none of its addresses
 * answers (an address that accepts and sends nothing back is named in the read-back's notes), and an allowlist is
 * refused until the live bypass cases pass.
 */
export class ModalProvider implements ComputerProvider {
	readonly id = "modal";
	readonly version = VERSION;
	readonly #sdk: ModalSdk;
	readonly #appName: string;
	readonly #daemonImage: string | undefined;
	readonly #daemonPath: string;
	readonly #maxLifetimeMs: number;
	readonly #user: string;
	readonly #timeouts: ModalTimeouts;
	readonly #probeTargets: string[];
	readonly #onNote: ProviderNote | undefined;
	#app: ModalApp | undefined;

	constructor({ sdk, app, daemonImage, daemonPath, maxLifetimeMs = MAX_LIFETIME_MS, user, timeouts = {}, probeTargets = DEFAULT_PROBE_TARGETS, onNote }: ModalProviderOptions) {
		this.#onNote = onNote;
		const lacks = [
			["apps.fromName", sdk?.apps?.fromName],
			["images.fromRegistry", sdk?.images?.fromRegistry],
			["sandboxes.create", sdk?.sandboxes?.create],
			["sandboxes.fromId", sdk?.sandboxes?.fromId],
			["sandboxes.list", sdk?.sandboxes?.list],
		].filter(([, fn]) => typeof fn !== "function");
		if (lacks.length > 0) throw new Error(`options.sdk must be a Modal client; it lacks ${lacks.map(([name]) => name).join(", ")}`);
		if (typeof app !== "string" || app.trim() === "") throw new Error("options.app, the Modal app's name, is required");
		if (daemonImage !== undefined && daemonPath !== undefined) {
			throw new Error("give daemonImage or daemonPath, not both: the daemon is copied from an image or uploaded, one of them");
		}
		if (daemonImage !== undefined && (typeof daemonImage !== "string" || !PINNED.test(daemonImage))) {
			throw new Error(`the daemon image ${JSON.stringify(daemonImage)} must be pinned by digest, such as ghcr.io/<owner>/computerd@sha256:<64 hex digits>`);
		}
		if (daemonPath !== undefined && (typeof daemonPath !== "string" || daemonPath === "")) throw new Error("daemonPath must be the path of the daemon binary");
		if (!isWhole(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > MAX_LIFETIME_MS) {
			throw new Error(`maxLifetimeMs must be a whole number of ms above 0 and at most 24 hours (${MAX_LIFETIME_MS} ms), Modal's longest timeout`);
		}
		const given = user === undefined ? TOOL_USER : userOf(user);
		if (given === undefined) throw new Error(`the provider's user ${JSON.stringify(user)} must be ${USER_FORM}`);
		if (given.startsWith("0:")) throw new Error(`the provider's user ${user} is root; ${ROOT}`);
		if (given.endsWith(":0")) throw new Error(`the provider's user ${user} is in root's group (gid 0); a computer is in group 0 only when its spec asks`);
		const merged = { ...DEFAULT_TIMEOUTS, ...timeouts };
		for (const [key, value] of Object.entries(merged)) {
			if (!isNumber(value) || value <= 0) throw new Error(`timeouts.${key} must be a number of ms above 0`);
		}
		if (!Array.isArray(probeTargets) || probeTargets.length === 0) throw new Error("probeTargets must name at least one address for the probe");
		const bad = probeTargets.find((target) => typeof target !== "string" || !TARGET.test(target));
		if (bad !== undefined) throw new Error(`the probe target ${JSON.stringify(bad)} is not host:port or host:port/udp`);
		this.#sdk = sdk;
		this.#appName = app;
		this.#daemonImage = daemonImage;
		this.#daemonPath = daemonPath ?? DEFAULT_DAEMON_PATH;
		this.#maxLifetimeMs = maxLifetimeMs;
		this.#user = given;
		this.#timeouts = merged;
		this.#probeTargets = [...probeTargets];
	}

	/**
	 * daemon pid1: the sandbox's command is init itself (with daemonImage) or the entrypoint that execs into it, and Modal
	 * finishes the sandbox when that main process exits (sandbox.ts:384-388), so init's exit ends the computer. Whether
	 * Modal gives that process the number 1 is not documented; init reaps as a subreaper either way. maxLifetimeMs is this
	 * instance's cap: Modal's 24 hours unless the provider was made with less. Init starts with --own-network whatever
	 * Modal runs in the sandbox (no listener of its own there is documented, so no port is declared), and network none is
	 * all a computer takes until a proxy carries open out of the daemon's own network.
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: "linux",
			lifetime: "vendor",
			network: [...NETWORK],
			networkReadBack: false,
			isolation: "vm",
			os: "linux",
			daemon: "pid1",
			groups: ["exec", "files", "processes"],
			maxLifetimeMs: this.#maxLifetimeMs,
			// Never root: see ROOT.
			user: ["uid"],
			release: ["delete"],
			mount: [...MOUNT],
			vendorAgentPorts: [],
		};
	}

	/** What hello must report: this package's version, the kind and groups declared, and Modal's one architecture. */
	#expected() {
		const { kind, groups } = this.capabilities();
		return { version: VERSION, kind, groups, arch: "amd64" };
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
		const { image, lifetimeMs, network, cpus, memoryMb, pids, labels, workdir, user, mount } = given;
		if (typeof image !== "string" || image.trim() === "" || image.startsWith("-") || /\s/.test(image)) {
			refuse("image", `an image is required: a registry tag for linux/amd64 that Modal can pull, such as ${MODAL_DEFAULT_IMAGE}`);
		} else if (image.includes("\0")) refuse("image", NUL);
		refusals.push(...checkLifetime(lifetimeMs, this.capabilities()));
		if (network === "open" || (typeof network === "object" && network !== null && "allow" in network)) refuse("network", OWN_NETWORK_ONLY);
		else if (network !== "none") refuse("network", 'network is required: "none"');
		if (cpus !== undefined && !(isNumber(cpus) && cpus >= CPU_REQUEST * CPUS_PER_CORE)) {
			refuse("cpus", `cpus must be a number of CPUs of at least ${CPU_REQUEST * CPUS_PER_CORE}: Modal counts physical cores, 2 CPUs each, and requests ${CPU_REQUEST} of one by default`);
		}
		if (memoryMb !== undefined && !(isWhole(memoryMb) && memoryMb > 0)) refuse("memoryMb", "memoryMb must be a whole number of MiB above 0");
		if (pids !== undefined) refuse("pids", "a Modal computer has no pids limit to set, since Modal offers none; leave pids unset");
		if (labels !== undefined) {
			const entries = typeof labels === "object" && labels !== null && !Array.isArray(labels) ? Object.entries(labels) : undefined;
			const bad = entries === undefined ? "labels must map names to strings" : entries.map(([key, value]) => labelProblem(key, value)).find(Boolean);
			if (bad) refuse("labels", bad);
			else if ((entries?.length ?? 0) > MAX_TAGS - OWN_TAGS) {
				refuse("labels", `a Modal sandbox carries at most ${MAX_TAGS} tags and this provider uses ${OWN_TAGS}, so a computer takes at most ${MAX_TAGS - OWN_TAGS} labels`);
			}
		}
		if (workdir !== undefined && !(typeof workdir === "string" && WORKDIR.test(workdir))) {
			refuse("workdir", "workdir must be an absolute path of letters, digits and . _ - / only: it becomes the image's WORKDIR");
		}
		if (isRootUser(user)) refuse("user", ROOT);
		else if (user !== undefined && userOf(user) === undefined) refuse("user", `user must be ${USER_FORM}`);
		refusals.push(...checkMount(mount, MOUNT), ...archilRefusals(given as unknown as ComputerSpec));
		const archil = (mount as { kind?: unknown } | undefined)?.kind === "archil";
		if (archil && user !== undefined && !isRootUser(user) && userOf(user) !== ARCHIL_USER) {
			refuse("user", `a computer with an Archil mount runs its tools as agentrun-tool, ${ARCHIL_USER}, the user its image makes with no way to root; leave user unset or ask for ${ARCHIL_USER}`);
		}
		for (const [field, value] of Object.entries(given)) {
			if (SPEC_FIELDS.has(field) || value === undefined) continue;
			if (field === "gpu") refuse(field, "this provider makes VM computers, and Modal offers GPUs on the gVisor runtime only");
			else refuse(field, `a Modal computer does not support ${field}`);
		}
		return refusals;
	}

	async create(spec: ComputerSpec, { signal }: CallContext = {}): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		let daemon: { bytes: Buffer; sha256: string } | undefined;
		if (this.#daemonImage === undefined) {
			let bytes: Buffer;
			try {
				bytes = readFileSync(this.#daemonPath);
			} catch {
				return fail("not_found", `no daemon binary at ${this.#daemonPath}: run npm run build:daemon -w @parcha/agentrun-computer, or give daemonImage`);
			}
			daemon = { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
		}
		if (signal?.aborted) return fail("aborted", "create was aborted before Modal was called");
		const app = await this.#theApp(signal);
		if (!app.ok) return app;
		const name = `computer-${randomBytes(6).toString("hex")}`;
		const deadline = new Date(Date.now() + spec.lifetimeMs).toISOString();
		// An Archil mount is made under the run's claim (check() held the spec to both labels), for the tool user alone.
		const archil = spec.mount?.kind === "archil" ? { mount: spec.mount, run: spec.labels?.[RUN_LABEL] as string, epoch: claimEpoch(spec.labels) } : undefined;
		const user = archil === undefined ? (userOf(spec.user) ?? this.#user) : ARCHIL_USER;
		const workdir = spec.workdir ?? WORK;
		const cpus = spec.cpus ?? DEFAULT_CPUS;
		const memoryMb = spec.memoryMb ?? DEFAULT_MEMORY_MB;
		const recorded: Recorded = {
			image: spec.image,
			user,
			network: spec.network as "none" | "open",
			cpus,
			memoryMb,
			workdir,
			runtime: "vm",
			...(archil === undefined ? {} : { mount: readBackOf(archil.mount, archil.epoch) }),
		};
		const tags = { ...spec.labels, [COMPUTER_LABEL]: "1", [NAME_TAG]: name, [DEADLINE_LABEL]: deadline, [SPEC_TAG]: JSON.stringify(recorded) };
		// With daemonImage the daemon comes in as a layer of the computer's own image, there before the command starts.
		// Without, the command is the entrypoint, which waits for the upload below. Either way the computer needs no
		// network to get it. HOME is a directory init gives the computer's user.
		// The image route holds the daemon's path to root's alone in the image itself (exec form, no shell quoting): each
		// connection runs it as root through Modal's exec, so a path a non-root computer user could change fails the build.
		const copy =
			this.#daemonImage === undefined ? [] : [`COPY --from=${this.#daemonImage} /computerd ${DAEMON_IN_COMPUTER}`, `RUN ${JSON.stringify(modalCommands().hold)}`];
		// An im-... image is one Modal already holds (box/build-modal.py's Archil image): opened by its id. Anything else is a
		// registry tag.
		let base: ModalImage;
		if (MODAL_IMAGE_ID.test(spec.image)) {
			const fromId = this.#sdk.images.fromId;
			if (typeof fromId !== "function") return fail("invalid", `the image ${spec.image} is a Modal image id, and options.sdk has no images.fromId to open it: pass the SDK's own ModalClient`);
			const opened = await call(`images.fromId(${spec.image})`, () => fromId.call(this.#sdk.images, spec.image), this.#timeouts.callMs, signal);
			if (!opened.ok) return opened;
			base = opened.value;
		} else base = this.#sdk.images.fromRegistry(spec.image);
		const image = base.dockerfileCommands([...copy, `ENV HOME=${WORK}`, `WORKDIR ${workdir}`]);
		const { uploadMs, callMs } = this.#timeouts;
		// An Archil computer's command is always the entrypoint, which waits for the gate as well as the daemon: init, and
		// so every tool, starts only once the run's folder is mounted.
		const gate = archil === undefined ? undefined : ARCHIL_GATE;
		const waitMs = uploadMs + callMs + (gate === undefined ? 0 : this.#archilMs());
		const command =
			daemon === undefined && gate === undefined
				? [DAEMON_IN_COMPUTER, ...initArgs({ deadline, user })]
				: modalCommands({ deadline, user, waitSeconds: Math.ceil(waitMs / 1000), home: WORK, ...(gate === undefined ? {} : { gate }) }).entrypoint;
		const cpuLimit = cpus / CPUS_PER_CORE;
		const params: ModalCreateParams = {
			runtime: "vm",
			command,
			// Modal ends the sandbox at its timeout: the lifetime, in the whole seconds the SDK takes.
			timeoutMs: Math.ceil(spec.lifetimeMs / 1000) * 1000,
			workdir,
			cpu: Math.min(CPU_REQUEST, cpuLimit),
			cpuLimit,
			memoryMiB: Math.min(MEMORY_REQUEST_MIB, memoryMb),
			memoryLimitMiB: memoryMb,
			// An Archil computer's root reaches Archil, so Modal's network stays on: its tools' network none is init's own,
			// read back by the probe from inside, as the tool user, like every network none here.
			...(spec.network === "none" && archil === undefined ? { blockNetwork: true as const } : {}),
			tags,
		};
		let creating: Promise<ModalSandbox>;
		try {
			creating = Promise.resolve(this.#sdk.sandboxes.create(app.value, image, params));
		} catch (error) {
			return fail(codeOf(error), `sandboxes.create failed: ${words(error)}`);
		}
		const created = await race(creating, "sandboxes.create", this.#timeouts.createMs, signal);
		if (!created.ok) {
			if (created.error.code === "timeout" || created.error.code === "aborted") {
				// The SDK's create goes on without us: a sandbox it makes after this is terminated as it lands.
				creating.then((sandbox) => this.#terminate(sandbox, name)).catch(() => {});
				return fail(created.error.code, `${created.error.message}; a sandbox it makes after this is terminated`);
			}
			return created;
		}
		const sandbox = created.value;
		const ref = { id: sandbox.sandboxId, name };
		// From here the computer exists: every step takes the caller's signal, and an abort or a mismatch terminates it.
		const uploaded = daemon === undefined ? ok(undefined) : await this.#upload(sandbox, name, daemon, signal);
		// The run's folder, after the daemon is in place (serve runs it) and before init starts (the gate).
		const root = this.#root(sandbox, name);
		const mounted = uploaded.ok && archil !== undefined ? await this.#mountArchil(root, ref, archil, signal) : uploaded;
		const checked = mounted.ok ? await this.#checkCreated(sandbox, ref, tags, recorded, signal) : mounted;
		// A folder mounted for a computer create gives up on is let go before the terminate, never signalled.
		const letGo = async () => {
			if (archil !== undefined && mounted.ok) await archilRelease({ root, client: undefined, timeoutMs: this.#timeouts.mountMs });
		};
		if (signal?.aborted) {
			await letGo();
			const after = await this.#terminate(sandbox, name, signal);
			return fail("aborted", `create was aborted after Modal made the sandbox; the computer ${name} ${after}`);
		}
		if (checked.ok) return ok(checked.value.length > 0 ? { ...ref, notes: checked.value } : ref);
		// Read before the terminate, which would end it with its own code: whether the sandbox's command had already ended.
		const why = await this.#endedWords(sandbox, archil?.mount.token, signal);
		await letGo();
		const after = await this.#terminate(sandbox, name, signal);
		return fail(checked.error.code, `the computer ${name} ${after}: ${checked.error.message}${why}`);
	}

	/**
	 * When a create's sandbox has already finished, its command's exit code and the tail of its output (stdout, then
	 * stderr; the token, if any, cut), in words to append; nothing while it runs or when that cannot be read.
	 */
	async #endedWords(sandbox: ModalSandbox, token: string | undefined, signal?: AbortSignal): Promise<string> {
		const { callMs } = this.#timeouts;
		const polled = await call("poll of the sandbox", () => sandbox.poll(), callMs, signal);
		if (!polled.ok || polled.value === null) return "";
		const read = async (stream: ModalSandbox["stdout"]) => {
			if (typeof stream?.readText !== "function") return "";
			const text = await call("the sandbox's output", () => stream.readText(), callMs, signal);
			return text.ok ? text.value : "";
		};
		let output = `${await read(sandbox.stdout)} ${await read(sandbox.stderr)}`.replace(/\s+/g, " ").trim();
		if (token) output = output.replaceAll(token, "[token]");
		return `; its command exited ${polled.value}${output === "" ? ", with no output" : `: ${output.length > 500 ? `…${output.slice(-500)}` : output}`}`;
	}

	/**
	 * Streams the daemon into the sandbox through one exec's stdin, in binary mode, and checks the sha256 the upload
	 * prints against the one sent. Bounded by uploadMs as a whole: the exec's start, every write, and its exit.
	 */
	async #upload(sandbox: ModalSandbox, name: string, daemon: { bytes: Buffer; sha256: string }, signal?: AbortSignal): Promise<Result<void>> {
		const what = `the daemon's upload into ${name}`;
		const { upload } = modalCommands({ sha256: daemon.sha256 });
		const run = async () => {
			const program = await sandbox.exec(upload, { mode: "binary" });
			const stdout = textOf(program.stdout);
			const stderr = textOf(program.stderr);
			let streaming: unknown;
			try {
				for (let at = 0; at < daemon.bytes.length; at += UPLOAD_CHUNK) await program.stdin.writeBytes(new Uint8Array(daemon.bytes.subarray(at, at + UPLOAD_CHUNK)));
				await program.stdin.close();
			} catch (error) {
				// The script may have stopped reading (it says why); an end of input lets cat end, and the sha256 check fail.
				streaming = error;
				await program.stdin.close().catch(() => {});
			}
			const exitCode = await program.wait();
			return { exitCode, stdout: await stdout, stderr: await stderr, streaming };
		};
		const done = await call(what, run, this.#timeouts.uploadMs, signal);
		if (!done.ok) return done;
		const { exitCode, stdout, stderr, streaming } = done.value;
		if (exitCode !== 0) return fail("refused", `the daemon's upload exited with ${exitCode}: ${`${stdout} ${stderr}`.replace(/\s+/g, " ").trim().slice(0, 500)}`);
		if (streaming !== undefined) return fail(codeOf(streaming), `${what} failed while streaming: ${words(streaming)}`);
		const read = /^sha256 ([0-9a-f]{64})$/m.exec(stdout)?.[1];
		if (read !== daemon.sha256) {
			return fail("refused", `it did not match its spec: daemon: uploaded sha256 ${daemon.sha256}, the file in the computer reads back ${show(read)}`);
		}
		return ok(undefined);
	}

	/**
	 * The longest an Archil computer's entrypoint waits for the gate after the upload: each root step (the preflight,
	 * mount, a revoke, serve and the gate) within mountMs, and the takeover's listing and its releases.
	 */
	#archilMs(): number {
		const { mountMs, listMs, releaseMs } = this.#timeouts;
		return 6 * mountMs + listMs + 2 * releaseMs;
	}

	/**
	 * The root channel into a sandbox: Modal's exec, which runs as root (Modal containers always do), outside computerd.
	 * stdin, when given, is written as given and closed; otherwise stdin is closed at once. What the program printed is
	 * both streams, stdout first. An error is the SDK's, in words that never hold what stdin was given.
	 */
	#root(sandbox: ModalSandbox, name: string): ArchilRoot {
		return {
			run: (argv, { stdin, timeoutMs, signal }) =>
				call(
					`root's ${argv[0] === ARCHIL_HELPER ? `agentrun-archil ${argv[1]}` : argv[0]} in ${name}`,
					async () => {
						const program = await sandbox.exec([...argv], { mode: "binary" });
						const stdout = textOf(program.stdout);
						const stderr = textOf(program.stderr);
						try {
							if (stdin !== undefined) await program.stdin.writeBytes(new Uint8Array(Buffer.from(stdin, "utf8")));
						} finally {
							await program.stdin.close().catch(() => {});
						}
						const exitCode = await program.wait();
						return { exitCode, output: `${await stdout}${await stderr}` };
					},
					timeoutMs,
					signal,
				),
		};
	}

	/** The shared Archil steps (archilMount) through root, with the takeover of this provider's lower epochs; then the gate. */
	async #mountArchil(root: ArchilRoot, computer: ComputerRef, { mount, run, epoch }: { mount: ArchilMount; run: string; epoch: number }, signal?: AbortSignal): Promise<Result<void>> {
		const { mountMs, callMs } = this.#timeouts;
		const made = await archilMount({ root, mount, self: computer, releaseOlder: () => releaseOlder(this, run, epoch, signal ? { signal } : {}), timeoutMs: mountMs, ...(signal ? { signal } : {}) });
		if (!made.ok) return made;
		const gate = await root.run(["touch", ARCHIL_GATE], { timeoutMs: callMs, ...(signal ? { signal } : {}) });
		if (!gate.ok) return fail(gate.error.code, `the gate init waits for could not be made: ${gate.error.message}`);
		if (gate.value.exitCode !== 0) return fail("refused", `the gate init waits for could not be made (exit ${gate.value.exitCode}): ${gate.value.output.trim().slice(0, 300)}`);
		return ok(undefined);
	}

	/**
	 * What is mounted at /workspace, read from inside through computerd (its /proc/self/mounts), exclusive when the
	 * resident serve answers a sync; undefined when nothing is mounted there.
	 */
	#readMount(connection: ComputerConnection, name: string, archil: Pick<RecordedArchil, "mount" | "epoch">, signal?: AbortSignal): Promise<Result<MountReadBack | undefined>> {
		return readArchilMount(connection.client, archil, { name, timeoutMs: this.#timeouts.helloMs, ...(signal ? { signal } : {}) });
	}

	/**
	 * Terminates a sandbox create gives up on and waits, as release delete does, until poll reads it finished, so a
	 * refused create leaves nothing listed; and says how that went. The terminate does not take the caller's signal, so
	 * an aborted create still sends it, within callMs; the wait does, within releaseMs, so an abort ends it and the words
	 * say the sandbox may still be ending. A sandbox that lands after create gave up is given no signal.
	 */
	async #terminate(sandbox: ModalSandbox, name: string, signal?: AbortSignal): Promise<string> {
		const ended = await call(`terminate of ${name}`, () => sandbox.terminate(), this.#timeouts.callMs);
		if (!ended.ok && ended.error.code !== "not_found") return `could not be terminated (${ended.error.message})`;
		const finished = await this.#untilFinished(sandbox, name, signal);
		return finished.ok ? "was terminated" : `was terminated, and may still be ending (${finished.error.message})`;
	}

	/** untilFinished on sandbox, bounded by releaseMs, its pauses from releasePollMs. */
	#untilFinished(sandbox: ModalSandbox, name: string, signal?: AbortSignal): Promise<Result<void>> {
		const { releaseMs, releasePollMs, callMs } = this.#timeouts;
		return untilFinished(() => sandbox.poll(), { name, boundMs: releaseMs, callMs, minMs: Math.min(releasePollMs, RELEASE_POLL_MAX_MS), maxMs: RELEASE_POLL_MAX_MS, signal });
	}

	/**
	 * The drift check after create: the sandbox runs, its tags read back as given, and the daemon and probe match. Its
	 * value is the probe's notes, what it recorded that does not refuse the computer.
	 */
	async #checkCreated(sandbox: ModalSandbox, ref: ComputerRef, tags: Record<string, string>, recorded: Recorded, signal?: AbortSignal): Promise<Result<string[]>> {
		const polled = await call(`poll of ${ref.name}`, () => sandbox.poll(), this.#timeouts.callMs, signal);
		if (!polled.ok) return polled;
		if (polled.value !== null) return fail("refused", `it had finished, with exit code ${polled.value}, before its drift check`);
		const read = await call(`getTags of ${ref.id}`, () => sandbox.getTags(), this.#timeouts.callMs, signal);
		if (!read.ok) return read;
		// Init may not be listening yet when create's answer, or the upload, comes back: the bridge is tried until hello.
		const archil = recordedArchil(tags);
		const inside = await this.#inside(sandbox, ref.name, signal, true, archil);
		if (!inside.ok) return inside;
		const found = [
			...tagDrift(tags, read.value),
			...helloDrift(inside.value.hello, this.#expected()),
			...probeDrift(inside.value.probe, { user: recorded.user, network: recorded.network }),
			...(archil === undefined ? [] : mountDrift(archil.expected, inside.value.mount)),
		];
		return found.length === 0 ? ok(probeNotes(inside.value.probe, recorded.network)) : fail("refused", `it did not match its spec: ${found.join("; ")}`);
	}

	/** One connection's hello and the probe through it, and an Archil computer's mount read back, the connection closed after. */
	async #inside(
		sandbox: ModalSandbox,
		name: string,
		signal?: AbortSignal,
		patient = false,
		archil?: RecordedArchil,
	): Promise<Result<{ hello: ComputerConnection["hello"]; probe: ProbeReport; mount?: MountReadBack }>> {
		const opened = patient ? await this.#openWhenListening(sandbox, name, signal) : await this.#open(sandbox, name, signal);
		if (!opened.ok) return opened;
		try {
			const probe = await this.#probe(opened.value, name, signal);
			if (!probe.ok) return probe;
			if (archil === undefined) return ok({ hello: opened.value.hello, probe: probe.value });
			const mount = await this.#readMount(opened.value, name, archil, signal);
			if (!mount.ok) return mount;
			return ok({ hello: opened.value.hello, probe: probe.value, ...(mount.value === undefined ? {} : { mount: mount.value }) });
		} finally {
			await opened.value.close();
		}
	}

	/** `computerd probe` through the daemon, so it runs as the computer's own user. */
	async #probe(connection: ComputerConnection, name: string, signal?: AbortSignal): Promise<Result<ProbeReport>> {
		const { probeMs } = this.#timeouts;
		const bound = within(probeMs, signal);
		const argv = [DAEMON_IN_COMPUTER, "probe", ...this.#probeTargets.flatMap((target) => ["--connect", target])];
		const ran = await connection.client.call("exec.run", { argv, timeoutMs: probeMs }, { signal: bound.signal });
		bound.clear();
		if (!ran.ok) {
			if (signal?.aborted) return fail("aborted", `the probe in ${name} was aborted`);
			if (ran.error.code === "aborted") return fail("timeout", `the probe in ${name} did not answer within ${seconds(probeMs)}`);
			return fail(ran.error.code, `the probe in ${name} failed: ${ran.error.message}`);
		}
		const { exitCode, stdout, stderr, timedOut } = ran.value;
		if (timedOut) return fail("timeout", `the probe in ${name} did not end within ${seconds(probeMs)}`);
		if (exitCode !== 0) {
			return fail("refused", `the probe in ${name} exited with ${exitCode}: ${Buffer.from(stderr, "base64").toString("utf8").trim().slice(0, 300)}`);
		}
		const report = probeReportOf(stdout);
		if ("not" in report) return fail("refused", `the probe in ${name} ${report.not}`);
		return ok(report);
	}

	/** The app, looked up (and made when missing) once per provider; a failed lookup is tried again next time. */
	async #theApp(signal?: AbortSignal): Promise<Result<ModalApp>> {
		if (this.#app) return ok(this.#app);
		const found = await call(`apps.fromName ${this.#appName}`, () => this.#sdk.apps.fromName(this.#appName, { createIfMissing: true }), this.#timeouts.callMs, signal);
		if (found.ok) this.#app = found.value;
		return found;
	}

	/**
	 * Settings' test: the provider's app read without making it (createIfMissing false), which makes nothing. An app not
	 * made yet is a connection all the same: the token was taken, and the first computer makes the app.
	 */
	async testConnection({ signal }: CallContext = {}): Promise<Result<{ detail: string }>> {
		const found = await call(`apps.fromName ${this.#appName}`, () => this.#sdk.apps.fromName(this.#appName, { createIfMissing: false }), this.#timeouts.callMs, signal);
		if (found.ok) return ok({ detail: `Modal answered: the app ${this.#appName} is there` });
		if (found.error.code === "not_found") return ok({ detail: `Modal answered: no app ${this.#appName} yet; the first computer makes it` });
		const error = connectionError(found.error);
		return fail(error.code, error.message);
	}

	/** The sandbox with an id and the tags it carries; one Modal does not know is not_found. */
	async #find(id: string, signal?: AbortSignal): Promise<Result<{ sandbox: ModalSandbox; tags: Record<string, string> }>> {
		const sandbox = await call("sandboxes.fromId", () => this.#sdk.sandboxes.fromId(id), this.#timeouts.callMs, signal);
		if (!sandbox.ok) return sandbox;
		const tags = await call(`getTags of ${id}`, () => sandbox.value.getTags(), this.#timeouts.callMs, signal);
		if (!tags.ok) return tags.error.code === "not_found" ? fail("not_found", `no Modal computer has the id ${id}`) : tags;
		return ok({ sandbox: sandbox.value, tags: tags.value });
	}

	/** This provider's sandbox for ref, or why not. */
	async #own(ref: ComputerRef, signal?: AbortSignal): Promise<Result<{ sandbox: ModalSandbox; tags: Record<string, string> }>> {
		const found = await this.#find(ref.id, signal);
		if (!found.ok) return found;
		if (!ours(found.value.tags, ref.name)) return fail("not_found", `no Modal computer named ${ref.name} has the id ${ref.id}`);
		return found;
	}

	/** The live view: screen.watch on a connection of the watch's own (daemonWatch); a sandbox has no screen. */
	watch(ref: ComputerRef, handlers: ScreenWatchHandlers, options?: WatchOptions): Promise<Result<ScreenWatch>> {
		return daemonWatch(this, ref, handlers, options);
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		const found = await this.#own(ref);
		if (!found.ok) return found;
		const root = rootRecorded(found.value.tags, ref.name);
		if (root) return root;
		const opened = await this.#open(found.value.sandbox, ref.name);
		if (!opened.ok) return opened;
		const drift = helloDrift(opened.value.hello, this.#expected());
		// An Archil computer's client syncs the run's folder after every call that may change it, before it answers.
		if (drift.length === 0) return recordedArchil(found.value.tags) === undefined ? opened : ok({ ...opened.value, client: syncingClient(opened.value.client) });
		await opened.value.close();
		return fail("refused", `the daemon in ${ref.name} does not match this provider: ${drift.join("; ")}`);
	}

	/**
	 * #open, tried again while the bridge finds no daemon listening, until hello or helloMs in all. For a computer just
	 * made, whose init may not have made its socket yet.
	 */
	async #openWhenListening(sandbox: ModalSandbox, name: string, signal?: AbortSignal): Promise<Result<ComputerConnection>> {
		const until = Date.now() + this.#timeouts.helloMs;
		for (;;) {
			const opened = await this.#open(sandbox, name, signal, until);
			if (opened.ok || !opened.notListening || signal?.aborted || Date.now() + LISTEN_RETRY_MS >= until) return opened;
			await pause(LISTEN_RETRY_MS, signal);
		}
	}

	/**
	 * One connection to the computer's daemon over `computerd stdio` through exec, after hello, unchecked. One deadline,
	 * until (helloMs from now by default), bounds the exec's start and hello together: the start takes at most callMs of
	 * it and hello what is left. Modal's exec goes on when the start is given up on (a timeout or the caller's abort), so
	 * a bridge that lands after that has its stdin closed as it lands, and ends, as a late sandbox create is terminated.
	 */
	async #open(sandbox: ModalSandbox, name: string, signal?: AbortSignal, until = Date.now() + this.#timeouts.helloMs): Promise<Result<ComputerConnection> & { notListening?: true }> {
		const what = `exec of the daemon's stdio bridge in ${name}`;
		const { helloMs: totalMs, callMs } = this.#timeouts;
		if (signal?.aborted) return fail("aborted", `${what} was aborted before it was called`);
		let starting: Promise<ModalProcess>;
		try {
			starting = Promise.resolve(sandbox.exec([DAEMON_IN_COMPUTER, "stdio"], { mode: "binary" }));
		} catch (error) {
			return fail(codeOf(error), `${what} failed: ${words(error)}`);
		}
		const startMs = Math.max(1, Math.min(callMs, until - Date.now()));
		const started = await race(starting, what, startMs, signal);
		if (!started.ok) {
			if (started.error.code === "timeout" || started.error.code === "aborted") {
				starting.then((late) => late.stdin.close()).catch(() => {});
				if (started.error.code === "timeout" && startMs < callMs) {
					return fail("timeout", `the daemon in ${name} did not answer hello within ${seconds(totalMs)}: the exec of its stdio bridge had not started; a bridge that starts after this is closed`);
				}
				return fail(started.error.code, `${started.error.message}; a bridge that starts after this is closed`);
			}
			return started;
		}
		const program = started.value;
		let stderr = "";
		const stderrRead = (async () => {
			for await (const chunk of program.stderr) stderr = (stderr + Buffer.from(chunk).toString("utf8")).slice(-4096);
		})().catch(() => {});
		const readable = Readable.from(buffers(program.stdout), { objectMode: false });
		const writable = new Writable({
			write(chunk: Buffer, _encoding, done) {
				program.stdin.writeBytes(new Uint8Array(chunk)).then(() => done(), done);
			},
			final(done) {
				program.stdin.close().then(() => done(), done);
			},
		});
		const client = new DaemonClient({ readable, writable });
		let closing: Promise<void> | undefined;
		// Modal has no kill for an exec: the bridge ends when its stdin does, which close gives it.
		const close = () =>
			(closing ??= (async () => {
				client.close();
				await race(program.wait(), "the stdio bridge's exit", CLOSE_WAIT_MS);
			})());
		const bound = within(Math.max(1, until - Date.now()), signal);
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: bound.signal });
		bound.clear();
		if (!hello.ok) {
			if (hello.error.code === "gone") await race(stderrRead, "the stdio bridge's stderr", 1000);
			await close();
			if (signal?.aborted) return fail("aborted", `hello to the daemon in ${name} was aborted`);
			if (hello.error.code === "aborted") return fail("timeout", `the daemon in ${name} did not answer hello within ${seconds(totalMs)}`);
			if (hello.error.code !== "gone") return hello;
			return { ...fail("modal", `cannot reach the daemon in ${name}: ${stderr.trim() || hello.error.message}`), notListening: true };
		}
		return ok({ client, hello: hello.value, close });
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			const id = given.id;
			if (typeof id !== "string" || !SANDBOX_ID.test(id)) return fail("invalid", `${String(id)} is not a Modal sandbox id`);
			const found = await this.#find(id, signal);
			if (!found.ok) return found;
			if (!ours(found.value.tags)) return fail("not_found", `no Modal computer has the id ${id}`);
			return this.#attached(found.value.sandbox, found.value.tags, signal);
		}
		const problem = filterProblem(given.labels);
		if (problem) return fail("invalid", problem);
		const labels = given.labels as Record<string, string>;
		if (Object.keys(labels).length === 0) return fail("invalid", "attach by labels needs at least one label");
		const listed = await this.list(labels, { signal });
		if (!listed.ok) return listed;
		const words = JSON.stringify(labels);
		if (listed.value.length === 0) return fail("not_found", `no Modal computer has the labels ${words}`);
		if (listed.value.length > 1) return fail("invalid", `${listed.value.length} computers match the labels ${words}: ${listed.value.map((info) => info.ref.name).join(", ")}`);
		const match = (listed.value[0] as ComputerInfo).ref;
		const found = await this.#own(match, signal);
		if (!found.ok) return found;
		return this.#attached(found.value.sandbox, found.value.tags, signal);
	}

	/**
	 * The drift check of a computer attach did not make: the spec create recorded in its tags, held to what check()
	 * allows, then hello and the probe, as at create. Modal reads back none of the spec, so the user, runtime and network
	 * none are what the probe reports from inside; image and sizes are as recorded. A drifted computer is left running.
	 */
	async #attached(sandbox: ModalSandbox, tags: Record<string, string>, signal?: AbortSignal): Promise<Result<AttachedComputer>> {
		const name = tags[NAME_TAG] as string;
		const ref = { id: sandbox.sandboxId, name };
		const polled = await call(`poll of ${name}`, () => sandbox.poll(), this.#timeouts.callMs, signal);
		if (!polled.ok) return polled;
		if (polled.value !== null) return fail("not_found", `the Modal computer ${name} has finished, with exit code ${polled.value}`);
		const found: string[] = [];
		const deadline = deadlineOf(tags);
		if (deadline === undefined) found.push(`deadline: the tag ${DEADLINE_LABEL} reads ${show(tags[DEADLINE_LABEL])}, not the ISO time create writes`);
		else if (deadline.getTime() > Date.now() + MAX_LIFETIME_MS + 60_000) found.push(`deadline: ${deadline.toISOString()} is past the 24 hours Modal allows`);
		const recorded = recordedOf(tags);
		if (typeof recorded === "string") found.push(recorded);
		else {
			if (recorded.runtime !== "vm") found.push(`runtime: the tag ${SPEC_TAG} says ${show(recorded.runtime)}; this provider makes vm computers`);
			const { image, network, cpus, memoryMb, workdir, user } = recorded;
			const refusals = this.check({ image, lifetimeMs: 1, network, cpus, memoryMb, workdir, user } as ComputerSpec);
			found.push(...refusals.map(({ field, message }) => `${field}: ${message}, as recorded at create`));
			// No exec in a computer whose user is root: the bridge would run what that user could have replaced.
			if (isRootUser(user)) return fail("refused", `the computer ${name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		}
		const archil = recordedArchil(tags);
		const inside = await this.#inside(sandbox, name, signal, false, archil);
		if (!inside.ok) return inside;
		const { hello, probe, mount } = inside.value;
		found.push(...helloDrift(hello, this.#expected()));
		if (typeof recorded !== "string") found.push(...probeDrift(probe, { user: recorded.user, network: recorded.network }));
		// The mount read back from inside is the one the spec tag records, under the computer's epoch label.
		if (archil !== undefined) found.push(...mountDrift(archil.expected, mount));
		if (found.length > 0 || typeof recorded === "string" || deadline === undefined) {
			return fail("refused", `the computer ${name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		}
		const { image, network, cpus, memoryMb, workdir } = recorded;
		const notes = probeNotes(probe, network);
		return ok({
			...ref,
			spec: { image, user: `${probe.uid}:${probe.gid}`, network, cpus, memoryMb, workdir, deadline, kind: hello.kind, ...(archil === undefined || mount === undefined ? {} : { mount }) },
			...(notes.length > 0 ? { notes } : {}),
		});
	}

	/**
	 * Every running computer this provider made that carries all of these labels. Modal's list asks for running sandboxes
	 * only (includeFinished: false, sandbox.ts:1135-1140), yet a sandbox terminated a moment ago is still listed: each one
	 * listed is polled, and one that poll reads finished (an exit code, not null, sandbox.ts:2761-2771) or no longer
	 * finds is left out.
	 */
	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const problem = filterProblem(labels);
		if (problem) return fail("invalid", problem);
		const until = Date.now() + this.#timeouts.listMs;
		const left = () => Math.max(1, until - Date.now());
		const app = await this.#theApp(signal);
		if (!app.ok) return app;
		let iterator: AsyncIterator<ModalSandbox>;
		try {
			iterator = this.#sdk.sandboxes.list({ appId: app.value.appId, tags: { ...labels, [COMPUTER_LABEL]: "1" } })[Symbol.asyncIterator]();
		} catch (error) {
			return fail(codeOf(error), `sandboxes.list failed: ${words(error)}`);
		}
		const infos: ComputerInfo[] = [];
		const stop = <T>(result: Result<T>) => {
			Promise.resolve(iterator.return?.()).catch(() => {});
			return result;
		};
		for (;;) {
			const next = await race(iterator.next(), "sandboxes.list", left(), signal);
			if (!next.ok) return stop(next);
			if (next.value.done) break;
			const sandbox = next.value.value;
			const tags = await call(`getTags of ${sandbox.sandboxId}`, () => sandbox.getTags(), Math.min(this.#timeouts.callMs, left()), signal);
			if (!tags.ok) {
				// A sandbox that finished between the list and its tags is left out.
				if (tags.error.code === "not_found") continue;
				return stop(tags);
			}
			if (!ours(tags.value) || !Object.entries(labels).every(([key, value]) => tags.value[key] === value)) continue;
			const polled = await call(`poll of ${sandbox.sandboxId}`, () => sandbox.poll(), Math.min(this.#timeouts.callMs, left()), signal);
			if (!polled.ok) {
				if (polled.error.code === "not_found") continue;
				return stop(polled);
			}
			if (polled.value !== null) continue;
			// list execs into no computer: an Archil computer's mount is the one its spec tag records, under its epoch label.
			const archil = recordedArchil(tags.value);
			infos.push({
				ref: { id: sandbox.sandboxId, name: tags.value[NAME_TAG] as string },
				labels: { ...tags.value },
				deadline: deadlineOf(tags.value),
				state: "running",
				network: recordedNetwork(tags.value),
				...(archil === undefined ? {} : { mount: archil.expected }),
			});
		}
		return ok(infos);
	}

	/**
	 * Modal reads no policy back. Open is open, nothing being wider; none is read back by the probe from inside, and is
	 * another network in words when any of its addresses answered (an address that only accepted, and sent nothing back,
	 * leaves it none). A change is refused: it is fixed at create.
	 */
	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (policy !== undefined && policy !== "none") {
			const wider = policy === "open" || (typeof policy === "object" && policy !== null && "allow" in policy);
			return fail("refused", wider ? `${OWN_NETWORK_ONLY}; ${FIXED}` : `${FIXED}; a network is "none"`);
		}
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		const recorded = recordedNetwork(found.value.tags);
		if (typeof recorded !== "string") return fail("refused", `the computer ${ref.name}: ${"other" in recorded ? recorded.other : JSON.stringify(recorded)}`);
		if (policy !== undefined && policy !== recorded) return fail("refused", `${FIXED}: ${ref.name} was created with network ${recorded}, not ${policy}`);
		let read: NetworkPolicy = recorded;
		if (recorded === "none") {
			const root = rootRecorded(found.value.tags, ref.name);
			if (root) return root;
			const inside = await this.#inside(found.value.sandbox, ref.name, signal);
			if (!inside.ok) return inside;
			const { reached } = inside.value.probe;
			if (reached.length > 0) read = { other: `created with network none, yet from inside an answer came back from ${reached.join(", ")}` };
		}
		if (policy === undefined || policy === read) return ok(read);
		return fail("refused", `${ref.name} was asked to keep network ${policy}, and reads back: ${typeof read === "string" ? read : JSON.stringify(read)}`);
	}

	/**
	 * delete terminates, and is idempotent: a sandbox already finished, or one Modal no longer knows, is ok. Modal ends a
	 * sandbox asynchronously (terminate returns before it has finished unless asked to wait, sandbox.ts:1292-1296 and
	 * 2238-2251), so delete then polls through untilFinished, as a refusing create does, with pauses that double from
	 * releasePollMs to 5 s, until poll reads an exit code (null while it runs, sandbox.ts:2761-2771) or Modal no longer
	 * knows it, within releaseMs and the caller's signal. Past releaseMs it is a timeout that says what poll last read,
	 * never done. An Archil computer that still runs lets go of the run's folder first (archilRelease: the final sync
	 * through computerd, then checkin as root); the terminate runs whatever that answers. A folder not let go cleanly
	 * loses nothing (every call that changed it synced, and the next claim revokes the hold), so it is said through
	 * onNote, and the release succeeds once the sandbox is gone.
	 */
	async release(ref: ComputerRef, how: "stop" | "delete", { signal }: CallContext = {}): Promise<Result<void>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (how !== "stop" && how !== "delete") return fail("invalid", `release is "stop" or "delete", not ${String(how)}`);
		if (how === "stop") return fail("unsupported", STOP);
		const found = await this.#find(ref.id, signal);
		if (!found.ok) return found.error.code === "not_found" ? ok(undefined) : found;
		if (!ours(found.value.tags, ref.name)) return fail("not_found", `no Modal computer named ${ref.name} has the id ${ref.id}`);
		const { sandbox, tags } = found.value;
		const letGo = recordedArchil(tags) === undefined ? ok(undefined) : await this.#letGo(sandbox, ref.name, signal);
		const deleted = await this.#delete(sandbox, ref, signal);
		if (letGo.ok) return deleted;
		if (!deleted.ok) return fail(deleted.error.code, `${deleted.error.message}; and ${letGo.error.message}`);
		this.#onNote?.({ computer: ref.name, note: `${ref.name} was terminated, and ${letGo.error.message}` });
		return deleted;
	}

	/** An Archil computer's folder let go, when the sandbox still runs: there is nothing to let go in one that finished. */
	async #letGo(sandbox: ModalSandbox, name: string, signal?: AbortSignal): Promise<Result<void>> {
		const polled = await call(`poll of ${name}`, () => sandbox.poll(), this.#timeouts.callMs, signal);
		if ((polled.ok && polled.value !== null) || (!polled.ok && polled.error.code === "not_found")) return ok(undefined);
		const opened = await this.#open(sandbox, name, signal);
		try {
			return await archilRelease({ root: this.#root(sandbox, name), client: opened.ok ? opened.value.client : undefined, timeoutMs: this.#timeouts.mountMs, ...(signal ? { signal } : {}) });
		} finally {
			if (opened.ok) await opened.value.close();
		}
	}

	/** release delete's terminate and its wait for the end: see release. */
	async #delete(sandbox: ModalSandbox, ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const ended = await call(`terminate of ${ref.name}`, () => sandbox.terminate(), this.#timeouts.callMs, signal);
		if (!ended.ok && ended.error.code === "not_found") return ok(undefined);
		if (!ended.ok && (ended.error.code === "timeout" || ended.error.code === "aborted")) return ended;
		if (!ended.ok) {
			const polled = await call(`poll of ${ref.name}`, () => sandbox.poll(), this.#timeouts.callMs, signal);
			return polled.ok && polled.value !== null ? ok(undefined) : ended;
		}
		const finished = await this.#untilFinished(sandbox, ref.name, signal);
		if (finished.ok) return ok(undefined);
		return fail(finished.error.code, `release delete of ${ref.name} is not done: ${finished.error.message}`);
	}
}

/** A refusal for a computer whose spec tag records a root user, before any exec in it (see ROOT); else undefined. */
function rootRecorded(tags: Record<string, string>, name: string): Result<never> | undefined {
	const recorded = recordedOf(tags);
	if (typeof recorded === "string" || !isRootUser(recorded.user)) return undefined;
	return fail("refused", `the computer ${name} was made with user ${recorded.user}, so this provider runs nothing in it: ${ROOT}`);
}

/** Why ref is not a Modal computer's ref, or undefined. */
function refProblem(ref: ComputerRef): string | undefined {
	if (typeof ref?.name !== "string" || !NAME.test(ref.name)) return `${String(ref?.name)} is not the name of a Modal computer (computer-<12 hex digits>)`;
	if (typeof ref.id !== "string" || !SANDBOX_ID.test(ref.id)) return `${String(ref.id)} is not a Modal sandbox id`;
	return undefined;
}
