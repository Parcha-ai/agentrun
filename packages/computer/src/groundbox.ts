// The Groundbox host: sandboxes on Groundbox (https://groundbox.dev), each a Firecracker microVM, over its REST API
// (https://api.groundbox.dev/v1, a Bearer key) with fetch and Node's WebSocket (no SDK). The exec is a resumable
// command of Groundbox's command stream (GET /v1/sandboxes/{id}/exec/stream, a WebSocket of JSON messages), handed to
// framedExec: the command runs on in the sandbox when a connection ends, as every connection does within the hour, and
// a new socket reads on from the last output position, so no output is lost or read twice. Its stdin does not ride that
// socket, where input is delivered at most once and nothing says what arrived: the command reads a fifo, and each write
// is one answered call that writes the fifo (POST .../exec). A computer starts from our box image by default
// (prepareImage), where Groundbox runs a command as root; on Groundbox's own image or a template it runs as the image's
// user, runner, who has passwordless sudo, which the adapter's scripts use. A command's own kill is the user's who ran
// it, so kill is the shared pid kill as root. Labels are the sandbox's metadata, which the listing filters by. The
// lifetime is the janitor's, by the deadline label, and Groundbox's own timer (timeout_minutes) is set to the request's
// backstop. Kind desktop is the box image's Xvfb and xfwm4, started through the daemon as on E2B and boxd. The rest of
// the computer is the shared machine-host adapter's (./hosted/provider.ts). Every Groundbox fact used here is cited in
// the README's Groundbox section.
import { randomBytes } from "node:crypto";
import { boxImageRef } from "./box-image.js";
import { GROUNDBOX, GROUNDBOX_OWN_IMAGE } from "./descriptors/groundbox.js";
import { DEADLINE_LABEL, show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { type FramedEvent, framedExec } from "./hosted/framed-exec.js";
import { boundOf, orThrow, pause, seconds } from "./hosted/process.js";
import { HostedProvider, type HostedOptions } from "./hosted/provider.js";
import { allPages, jsonOf, type Rest, rest } from "./hosted/rest.js";
import { PID_KILL } from "./hosted/scripts.js";
import { dateOf, isWhole } from "./hosted/values.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, ok, type Result } from "./result.js";

/** The parts of a WebSocket the host uses: Node's global WebSocket, or a stand-in in tests. */
export interface GroundboxSocket {
	/** 0 connecting, 1 open, 2 closing, 3 closed. */
	readonly readyState: number;
	/** Bytes sent and not yet on the wire: a write waits while it is high. */
	readonly bufferedAmount: number;
	send(text: string): void;
	close(code?: number): void;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; message?: string }) => void): void;
}

export type GroundboxSocketFactory = (url: string, init: { headers: Record<string, string> }) => GroundboxSocket;

/** The Groundbox provider's options: the key and Groundbox's own settings, then the shared adapter's (HostedOptions). */
export interface GroundboxProviderOptions extends HostedOptions {
	/** The Groundbox API key (gbx_...). The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/** The REST API, ending in /v1; default https://api.groundbox.dev/v1. */
	apiUrl?: string;
	/** Every sandbox's disk, in whole GB, 1 to 100; default Groundbox's own (20). A spec names no disk. */
	diskGb?: number;
	/** The fetch every call goes through; default the global one. */
	fetch?: typeof fetch;
	/** For tests: every command stream opens through it. Default Node's global WebSocket. */
	webSocket?: GroundboxSocketFactory;
	/**
	 * For tests: the command stream's bounds (the silence after which a socket is taken as dead; the unread output that
	 * pauses reading, and the level it resumes at).
	 */
	streamBounds?: Partial<StreamBounds>;
}

export async function create(options: GroundboxProviderOptions): Promise<GroundboxProvider> {
	return new GroundboxProvider(options);
}

/** The conformance CLI's module for Groundbox: its live switch, the run's 30-minute cap and its image. */
export const conformance = () => import("./conformance/groundbox.js");

const DEFAULT_API_URL = "https://api.groundbox.dev/v1";
/** A loopback host as URL writes it (an IPv4 address in its four numbers, IPv6 in brackets): the one place http may go. */
const LOOPBACK = /^(127(\.\d{1,3}){3}|\[::1\]|localhost)$/;
/** The longest a resumable command may run, in seconds: 30 days (EXEC_STREAM_MAX_TIMEOUT_S in Groundbox's contracts). The sandbox's own timer ends it first. */
const EXEC_STREAM_MAX_S = 30 * 24 * 3_600;
/** The most timeout_minutes takes: 30 days (SANDBOX_MAX_TIMEOUT_MINUTES). */
const MAX_TIMEOUT_MINUTES = 30 * 24 * 60;
/**
 * The longest any plan keeps a computer: Groundbox's 30 days, less the adapter's backstop margin of 5 minutes and a
 * minute of rounding, so the backstop create asks Groundbox's timer for is one it takes.
 */
const MAX_LIFETIME_MS = (MAX_TIMEOUT_MINUTES - 6) * 60_000;
/** The cap a user gets unless the provider is given another: a day. */
const DEFAULT_LIFETIME_MS = 24 * 60 * 60_000;
/** A size's bounds (SandboxSpec): whole CPUs, and whole GB of memory up to 4 a CPU; with no CPUs named, Groundbox gives 2. */
const MAX_CPUS = 16;
const MAX_MEMORY_GB_PER_CPU = 4;
const DEFAULT_CPUS = 2;
const MAX_DISK_GB = 100;
/** A metadata name is 1 to 64 characters and its value at most 512 (Metadata). */
const LABEL_NAME_MAX = 64;
const LABEL_VALUE_MAX = 512;
/** A template's id, or its name, with a version or without (TemplateRef). */
const TEMPLATE = /^(tpl_[A-Za-z0-9]{8,40}|[a-z0-9][a-z0-9-]{0,62})(:[1-9]\d{0,5})?$/;
/**
 * Any other image is a public image reference that `docker pull` takes (ghcr.io/org/app:tag, name@sha256:...), sent as
 * `image`: one word of printable ASCII. A bare Docker Hub name such as "alpine" reads as a template; name it in full
 * (docker.io/library/alpine) or with a tag that is not a number (alpine:3.20).
 */
const IMAGE_REF = /^[\x21-\x7e]{1,512}$/;
/** What a spec's image is: Groundbox's own (no field sent), a template of the key's team, or a public image. */
const imageField = (image: string): { template?: string; image?: string } => (image === GROUNDBOX_OWN_IMAGE ? {} : TEMPLATE.test(image) ? { template: image } : { image });
/** The user of Groundbox's own image, which Groundbox runs a command as there (uid 1001, with passwordless sudo): init refuses to start beside its processes. */
const IMAGE_UID = 1001;
/** The listing's page, the most it takes, and the most pages read. */
const PAGE = 200;
const MAX_PAGES = 100;
/**
 * Groundbox's statuses (SANDBOX_STATUSES) as the adapter's. One shut down with its disk kept is there and not running.
 * stopped and failed are records Groundbox keeps of sandboxes that will not come back, so none; `live=true` lists
 * neither.
 */
const STATES: Readonly<Record<string, Machine["state"] | undefined>> = {
	...{ queued: "starting", starting: "starting", resuming: "starting", running: "running" },
	...{ pausing: "stopped", paused: "stopped", shutting_down: "stopped", shut_down: "stopped" },
	...{ stopping: "gone", stopped: undefined, failed: undefined },
};
/** Groundbox's error codes (ERROR_CODES) as the adapter's; one not here is read by its status (httpCode). */
const CODES: Readonly<Record<string, ComputerErrorCode>> = {
	...{ unauthorized: "denied", forbidden: "denied", key_pending_claim: "denied", missing_scope: "denied", team_held: "denied", team_suspended: "denied", paid_plan_required: "denied" },
	...{ insufficient_balance: "limit", spend_cap_reached: "limit", concurrency_limit: "limit", rate_limited: "limit" },
	...{ not_found: "not_found", timeout: "timeout", bad_request: "invalid", conflict: "refused", idempotency_key_reused: "refused" },
	...{ no_capacity: "vendor", not_available: "vendor", internal: "vendor" },
};
/**
 * Where each command's directory is made: in /tmp, under a name of the host's own that no one knows before the command
 * starts, so its writes and its kill find it. The directory is the command's user's alone (0700) and holds its stdin
 * fifo (`in`) and the record of its pid (`pid`): /tmp is anyone's, and once a command ended a fifo or a record left
 * there by name could be anyone's too, so a write (which may carry a disk's token) or a kill would go where they say.
 */
const DIR_PREFIX = "/tmp/.agentrun-exec-";
/**
 * The sh every command starts under ($1 its directory, then the argv). It makes the directory with mode 0700, as
 * mktemp -d does, and a path already there is never its own: the command does not start (exit 126). In it, the fifo
 * and the record of its own pid and start time (as PID_WRAPPER's line, for the kill; written whole and then renamed,
 * so the kill never reads half of it). It runs the argv with the fifo as its stdin, opened to read and write, so the
 * fifo never reads end of file between two writers; then it removes the directory and exits as the argv did.
 */
const START_SCRIPT = [
	"d=$1; shift",
	'mkdir -m 700 "$d" 2>/dev/null || { echo "agentrun: $d is already there, so it is not one this command made: the command did not start" >&2; exit 126; }',
	'mkfifo -m 600 "$d/in" || exit 126',
	'echo "$$ $(s=$(cat /proc/$$/stat 2>/dev/null) && set -- ${s##*") "} && echo "${20}")" >"$d/pid.new" && mv -f "$d/pid.new" "$d/pid"',
	'"$@" 0<>"$d/in"; c=$?',
	'rm -rf "$d"; exit $c',
].join("\n");
/**
 * The check a write and a kill make of a command's directory ($d) before they use what is in it, from inside it (cd,
 * so the path can't be swapped after the check): the directory itself and not a link to another, owned by this user
 * (the command's: Groundbox runs every command of a sandbox as one user) with mode 0700. Else exit 4, in words.
 */
const OWN_DIR = `cd -P "$d" 2>/dev/null && [ "$(pwd -P)" = "$(cd -P "\${d%/*}" && pwd -P)/\${d##*/}" ] && [ "$(stat -c %u:%a .)" = "$(id -u):700" ] || { echo "$d is not the command's own directory" >&2; exit 4; }`;
/** The check of one file in it ($1 its name): not a link, and this user's. */
const ownFile = (name: string) => `[ ! -L ${name} ] && [ "$(stat -c %u ${name})" = "$(id -u)" ] || { echo "$d/${name} is not the command's own" >&2; exit 4; }`;
/**
 * One write ($1 the command's directory): its stdin into the fifo there. A command Groundbox has just started may not
 * have made its fifo yet, so the write waits up to 5 s for it; with none by then the command has ended (its sh removed
 * it): exit 3. A fifo that went between the check and the write leaves a file of the write's own, removed: exit 3.
 */
const WRITE_SCRIPT = [
	'd=$1; i=0; until [ -p "$d/in" ]; do [ "$i" -lt 50 ] || exit 3; i=$((i + 1)); sleep 0.1; done',
	OWN_DIR,
	ownFile("in"),
	"cat >in",
	'[ -p in ] || { rm -f in; cd / && rmdir "$d" 2>/dev/null; exit 3; }',
].join("\n");
/**
 * The kill ($1 the command's directory, $2 PID_KILL): the shared pid kill of the recorded pid, as root, since a command
 * that became root through sudo is past its starter's signals, and Groundbox's own kill of a command is that user's. A
 * command Groundbox has just started may not have recorded its pid yet, so the kill waits up to 5 s for the record, as
 * a write waits for the fifo; with none by then the command has ended (its sh removed it). Then the directory is
 * removed, as the killed sh could not.
 */
const KILL_SCRIPT = [
	'd=$1; i=0; until [ -s "$d/pid" ]; do [ "$i" -lt 50 ] || exit 0; i=$((i + 1)); sleep 0.1; done',
	OWN_DIR,
	ownFile("pid"),
	"read -r pid start 2>/dev/null <pid || exit 0",
	'p=; [ "$(id -u)" = 0 ] || p="sudo -n"',
	'$p sh -c "$2" sh "$pid" "$start"',
	'cd / && rm -rf "$d"',
].join("\n");
/** One write's bytes: POST .../exec takes 512 KiB of stdin (EXEC_MAX_STDIN_BYTES). */
const WRITE_BYTES = 256 * 1024;
/** A write or a kill is one short command: its own bound in the sandbox, and the call's past it. */
const STEP_S = 60;
const STEP_MS = 75_000;
/** A resumable stream says `heartbeat` every 20 s (EXEC_STREAM_HEARTBEAT_S): one silent for this long is dead, and is opened again. */
const SILENCE_MS = 70_000;
/**
 * The pauses between tries to read on, doubling from the first to the last; and how long with no socket Groundbox
 * speaks on before the stream fails.
 */
const RESUME_MIN_MS = 500;
const RESUME_MAX_MS = 10_000;
const RESUME_GIVE_UP_MS = 5 * 60_000;
/** The longest one try to read on waits for Groundbox to speak on its socket: past one heartbeat. */
const ATTACH_MS = 30_000;
/** The close code of a socket this host drops to open another (not 1000, which ends the command). */
const DROP = 4000;
/** The close code that ends the command: a start that failed or timed out leaves nothing running unseen. */
const END = 1000;
/**
 * The output read and not yet taken by framedExec that pauses reading: the socket is let go of, and a new one attaches
 * from the position read to once the queue is down to QUEUE_LOW, so a reader that stops never makes the host hold more.
 * Groundbox keeps the command's output meanwhile; what it no longer keeps comes back as `skipped`, which fails the stream.
 */
const QUEUE_HIGH = 8 * 1024 * 1024;
const QUEUE_LOW = 2 * 1024 * 1024;

/** The command stream's bounds: SILENCE_MS, QUEUE_HIGH, QUEUE_LOW and RESUME_GIVE_UP_MS unless a test gives others. */
export interface StreamBounds {
	silenceMs: number;
	queueHighBytes: number;
	queueLowBytes: number;
	resumeGiveUpMs: number;
}

/** A sandbox as the API answers it (Sandbox in Groundbox's contracts), as far as this host reads it. */
interface Sandbox {
	id: string;
	status: string;
	metadata?: Record<string, string>;
	created_at?: string;
	stop_reason?: string | null;
}

/** One message of the command stream, as the server sends it (ExecStreamServerMessage). */
interface StreamMessage {
	type?: unknown;
	data?: unknown;
	seq?: unknown;
	exec_id?: unknown;
	exit_code?: unknown;
	message?: unknown;
	code?: unknown;
	bytes?: unknown;
}

/** One resumable command: its id, its directory, where its output has been read to, and what the stream has given. */
interface Command {
	sandbox: string;
	/** The directory of its stdin fifo and its pid record (DIR_PREFIX). */
	dir: string;
	/** The command's id once `started` came: what a new socket attaches to. */
	execId?: string;
	/** The position in the command's output just after the last chunk read. */
	seq: number;
	socket?: GroundboxSocket;
	/** The stream's events not read yet, and their output's bytes. */
	events: FramedEvent[];
	queued: number;
	/** No socket is open on purpose: the events not read yet passed QUEUE_HIGH, and reading on waits for QUEUE_LOW. */
	paused: boolean;
	/** A #resume is under way: no other starts. */
	resuming: boolean;
	/** The stream is over: the command exited, or it failed (failure). */
	ended: boolean;
	failure?: Error;
	/** Wakes the events waiting for more. */
	wake: () => void;
	/** Stops the current socket's silence watchdog. */
	quiet: () => void;
}

/** The bytes a chunk of base64 holds. */
const bytesOf = (base64: string): number => Math.floor((base64.length * 3) / 4);

/** A sandbox as the adapter reads a machine; none for a record Groundbox keeps of one that has ended. */
function machineOf(sandbox: Sandbox): Machine | undefined {
	const labels = { ...(sandbox.metadata ?? {}) };
	// A status this host does not know is a machine that is there and not running: the janitor still finds and ends it.
	if (!(sandbox.status in STATES)) return { id: sandbox.id, labels, state: "stopped", why: `Groundbox reads its status as ${sandbox.status}` };
	const state = STATES[sandbox.status];
	if (state === undefined) return undefined;
	const created = dateOf(sandbox.created_at);
	return { id: sandbox.id, labels, state, ...(created ? { createdAt: created } : {}) };
}

/** Why Groundbox's metadata can't hold these labels, in words; undefined when it can. */
function labelProblem(labels: Record<string, unknown>): string | undefined {
	const names = Object.keys(labels).filter((name) => name.length < 1 || name.length > LABEL_NAME_MAX);
	if (names.length > 0) return `Groundbox takes label names of 1 to ${LABEL_NAME_MAX} characters: ${names.map((name) => show(name)).join(", ")}`;
	const long = Object.entries(labels).filter(([, value]) => typeof value === "string" && value.length > LABEL_VALUE_MAX);
	if (long.length > 0) return `Groundbox takes label values of at most ${LABEL_VALUE_MAX} characters: ${long.map(([name, value]) => `${name} holds ${(value as string).length}`).join(", ")}`;
	return undefined;
}

/** Groundbox's sandboxes as a MachineHost (./host.ts). */
class GroundboxHost implements MachineHost {
	readonly descriptor = GROUNDBOX;
	readonly facts: HostFacts = {
		daemon: "child",
		isolation: "microvm",
		lifetime: "janitor",
		maxLifetimeMs: MAX_LIFETIME_MS,
		arch: "amd64",
		// Groundbox's agent in the guest listens on a unix socket that is root's, reached over vsock: nothing on TCP.
		vendorAgentPorts: [],
		// A desktop runs the box image's xfwm4 once its X server answers.
		windowManager: true,
	};
	readonly #apiKey: string;
	readonly #apiUrl: string;
	readonly #fetch: typeof fetch | undefined;
	readonly #webSocket: GroundboxSocketFactory;
	readonly #diskGb: number | undefined;
	readonly #kind: "desktop" | "linux";
	readonly #bounds: StreamBounds;
	readonly #api: Rest;

	constructor(options: { apiKey: string; apiUrl: string; fetch?: typeof fetch; webSocket: GroundboxSocketFactory; diskGb?: number; kind: "desktop" | "linux"; streamBounds?: Partial<StreamBounds> }) {
		this.#apiKey = options.apiKey;
		this.#apiUrl = options.apiUrl.replace(/\/+$/, "");
		this.#fetch = options.fetch;
		this.#webSocket = options.webSocket;
		this.#diskGb = options.diskGb;
		this.#kind = options.kind;
		this.#bounds = { silenceMs: SILENCE_MS, queueHighBytes: QUEUE_HIGH, queueLowBytes: QUEUE_LOW, resumeGiveUpMs: RESUME_GIVE_UP_MS, ...options.streamBounds };
		this.#api = this.#client();
	}

	/** The API's client, with headers of one call's own beside the key (a create's Idempotency-Key). */
	#client(headers: Record<string, string> = {}): Rest {
		return rest({
			base: this.#apiUrl,
			headers: () => ({ Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json", ...headers }),
			vendor: GROUNDBOX.id,
			...(this.#fetch ? { fetch: this.#fetch } : {}),
			timeoutMs: 30_000,
			retry: { attempts: 3, baseMs: 500 },
			// Every refusal's body is { error: { code, message } } (ErrorResponse): the code is read as the adapter's, the
			// message is the words.
			explain: ({ status, bytes, what }) => {
				const error = (jsonOf(bytes) as { error?: { code?: unknown; message?: unknown } } | null)?.error;
				const code = typeof error?.code === "string" ? CODES[error.code] : undefined;
				const words = typeof error?.message === "string" ? error.message : "";
				return { ...(code ? { code } : {}), message: `${what} answered ${status}${typeof error?.code === "string" ? ` ${error.code}` : ""}${words ? `: ${words}` : ""}` };
			},
		});
	}

	async #call<T>(method: string, path: string, json: unknown, ctx: HostCall, extra: { retry?: boolean; bytes?: Uint8Array<ArrayBuffer> } = {}, api: Rest = this.#api): Promise<T> {
		const answer = orThrow(await api.call(method, api.url(path), { ...(json === undefined ? {} : { json }), timeoutMs: ctx.timeoutMs, ...extra }, ctx.signal));
		return jsonOf(answer.bytes) as T;
	}

	/**
	 * A spec's image is "default" (Groundbox's own), a template of the key's team, or a public image; its size is whole CPUs and whole GiB of memory, as
	 * Groundbox takes them (a size outside its bounds is refused there, never rounded); a label is one its metadata holds.
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, cpus, memoryMb, labels } = spec;
		if (image !== undefined && !(typeof image === "string" && IMAGE_REF.test(image))) {
			refusals.push({ field: "image", message: `an image is "${GROUNDBOX_OWN_IMAGE}" (the team's default template, else Groundbox's own Ubuntu 24.04), a Groundbox template (its id tpl_..., its name, or name:version), or a public image reference such as ghcr.io/org/app:tag` });
		} else if (image === GROUNDBOX_OWN_IMAGE && this.#kind === "desktop") {
			// Groundbox's own image has Xvfb but not xfwm4, the window manager every desktop here runs.
			refusals.push({ field: "image", message: `a Groundbox desktop starts from an image with Xvfb and xfwm4, which Groundbox's own image lacks (xfwm4): name the box image, ${boxImageRef()}, which prepareImage() answers, or an image of your own that has both` });
		}
		if (cpus !== undefined && !(isWhole(cpus) && cpus >= 1 && cpus <= MAX_CPUS)) refusals.push({ field: "cpus", message: `a Groundbox computer has a whole number of CPUs, 1 to ${MAX_CPUS}` });
		if (memoryMb !== undefined) {
			const most = (isWhole(cpus) && cpus >= 1 && cpus <= MAX_CPUS ? cpus : DEFAULT_CPUS) * MAX_MEMORY_GB_PER_CPU;
			if (!(isWhole(memoryMb) && memoryMb >= 1024 && memoryMb % 1024 === 0)) refusals.push({ field: "memoryMb", message: "a Groundbox computer's memory is a whole number of GiB, such as 4096" });
			else if (memoryMb / 1024 > most) refusals.push({ field: "memoryMb", message: `a Groundbox computer has at most ${MAX_MEMORY_GB_PER_CPU} GiB of memory a CPU (${most * 1024} with ${most / MAX_MEMORY_GB_PER_CPU} CPUs): name more cpus, up to ${MAX_CPUS}` });
		}
		const problem = labels !== null && typeof labels === "object" && !Array.isArray(labels) ? labelProblem(labels) : undefined;
		if (problem) refusals.push({ field: "labels", message: problem });
		return refusals;
	}

	/**
	 * POST /v1/sandboxes from the spec's image (a template, a public image, or neither for Groundbox's own), with the labels
	 * as its metadata, the spec's size when it names one (else Groundbox's own, or the
	 * template's), and timeout_minutes to the request's backstop: Groundbox's timer is the only one it has, and it ends a
	 * sandbox whose server is gone. The call carries an Idempotency-Key of this one request, so sent again on no answer
	 * it never starts a second sandbox. Groundbox answers once the sandbox runs, or with it still starting, which the
	 * adapter then waits out; one it could not start is refused here in its words.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		// The adapter's own labels are held to Groundbox's bounds here: a network list or an image name may be long.
		const problem = labelProblem(req.labels);
		if (problem) throw new HostError("limit", `${problem}; give a shorter network list or labels`);
		const minutes = Math.ceil((Date.parse(req.backstopAt) - Date.now()) / 60_000);
		const body = {
			...imageField(req.image),
			...(req.cpus === undefined ? {} : { cpus: req.cpus }),
			...(req.memoryMb === undefined ? {} : { memory_gb: req.memoryMb / 1024 }),
			...(this.#diskGb === undefined ? {} : { disk_gb: this.#diskGb }),
			timeout_minutes: Math.min(MAX_TIMEOUT_MINUTES, Math.max(1, minutes)),
			metadata: req.labels,
		};
		const made = await this.#call<Sandbox>("POST", "/sandboxes", body, ctx, { retry: true }, this.#client({ "Idempotency-Key": `agentrun-${req.name}-${req.backstopAt}` }));
		if (typeof made?.id !== "string") throw new Error("POST /sandboxes: no sandbox id in the answer");
		if (made.status === "failed" || made.status === "stopped") {
			throw new HostError("vendor", `Groundbox did not start ${made.id}: its status is ${made.status}${made.stop_reason ? ` (${made.stop_reason})` : ""}`);
		}
		return { id: made.id };
	}

	/** GET /v1/sandboxes/{id}; a 404 is not_found, which the adapter reads as none, and an ended sandbox's record is none. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		return machineOf(await this.#call<Sandbox>("GET", `/sandboxes/${encodeURIComponent(id)}`, undefined, ctx, { retry: true }));
	}

	/**
	 * Every sandbox of the key's team that is there and carries these labels: one listing, `live=true` (every status but
	 * stopped and failed) with a `metadata[name]=value` for each label, every page, within ctx.timeoutMs in all.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const until = Date.now() + ctx.timeoutMs;
		const filter = Object.entries(labels).map(([name, value]) => `&${encodeURIComponent(`metadata[${name}]`)}=${encodeURIComponent(value)}`);
		const listed = orThrow(
			await allPages<Sandbox>(
				async (cursor) => {
					const query = `live=true&limit=${PAGE}${filter.join("")}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
					const page = await this.#api.json("GET", this.#api.url(`/sandboxes?${query}`), { retry: true, timeoutMs: Math.max(1, until - Date.now()) }, ctx.signal);
					if (!page.ok) return page;
					const { data, next_cursor: next } = (page.value ?? {}) as { data?: unknown; next_cursor?: unknown };
					if (!Array.isArray(data)) return { ok: false, error: { code: "vendor", vendor: GROUNDBOX.id, message: "GET /sandboxes: a page that is not a list of sandboxes" } };
					return { ok: true, value: { items: data as Sandbox[], ...(typeof next === "string" ? { next } : {}) } };
				},
				MAX_PAGES,
				{ vendor: GROUNDBOX.id, what: "the listing of live sandboxes" },
			),
		);
		return listed.map((sandbox) => (typeof sandbox?.id === "string" ? machineOf(sandbox) : undefined)).filter((machine): machine is Machine => machine !== undefined);
	}

	/** DELETE /v1/sandboxes/{id}, which answers the sandbox, ended or still stopping; one already ended is fine. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		await this.#call("DELETE", `/sandboxes/${encodeURIComponent(id)}`, undefined, ctx, { retry: true });
	}

	/**
	 * argv as one resumable command of the stream, through framedExec, under START_SCRIPT: as the sandbox's command user,
	 * in its own process group, with the longest timeout Groundbox takes (the sandbox's own timer ends it first), its
	 * output as base64, so every byte comes as it was and a position in it is exact. A write is one call per WRITE_BYTES
	 * that writes the command's fifo and answers once it has; there is no end of stdin (a fifo held open has none), which
	 * nothing the adapter runs waits for. kill is KILL_SCRIPT's. A write or a kill whose directory, fifo or pid record is
	 * not the command's own is refused.
	 */
	exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		return framedExec<Command>(
			{
				start: (argv, ctx) => this.#start(id, argv, ctx),
				events: (command) => this.#events(command),
				write: async (command, text) => {
					const bytes = Buffer.from(text, "utf8");
					for (let at = 0; at < bytes.length; at += WRITE_BYTES) {
						const code = await this.#step(command, [WRITE_SCRIPT, "sh", command.dir], bytes.subarray(at, at + WRITE_BYTES));
						if (code === 3) throw new Error("the process has ended");
						// Its words never hold what was written: it may be a disk's token.
						if (code === 4) throw new Error(`the command's stdin at ${command.dir} is not the command's own: the write was refused`);
						if (code !== 0) throw new Error(`writing to the command failed (exit ${code})`);
					}
				},
				kill: async (command) => {
					const code = await this.#step(command, [KILL_SCRIPT, "sh", command.dir, PID_KILL]);
					if (code === 4) throw new Error(`the command's pid record at ${command.dir} is not the command's own: the kill was refused`);
				},
			},
			argv,
			ctx,
		);
	}

	/** One short command beside a running one (POST .../exec), its stdin given whole: its exit code, -1 past its bound. Never sent twice. */
	async #step(command: Command, script: readonly string[], stdin?: Uint8Array): Promise<number> {
		const body = { args: ["sh", "-c", ...script], timeout_s: STEP_S, ...(stdin === undefined ? {} : { stdin_base64: Buffer.from(stdin).toString("base64") }) };
		const ran = await this.#call<{ exit_code?: unknown; timed_out?: unknown }>("POST", `/sandboxes/${encodeURIComponent(command.sandbox)}/exec`, body, { timeoutMs: STEP_MS });
		return typeof ran?.exit_code === "number" && ran.timed_out !== true ? ran.exit_code : -1;
	}

	/** Starts the command on a new socket and answers once Groundbox says it has started, within the call's bound. */
	async #start(id: string, argv: readonly string[], ctx: HostCall): Promise<Command> {
		const command: Command = { sandbox: id, dir: `${DIR_PREFIX}${randomBytes(8).toString("hex")}`, seq: 0, events: [], queued: 0, paused: false, resuming: false, ended: false, wake: () => {}, quiet: () => {} };
		const first = { type: "start", args: ["sh", "-c", START_SCRIPT, "sh", command.dir, ...argv], resumable: true, encoding: "base64", timeout_s: EXEC_STREAM_MAX_S };
		try {
			await this.#connect(command, first, ctx);
		} catch (error) {
			this.#end(command);
			throw error;
		}
		return command;
	}

	/**
	 * The stream is over: nothing more is read, its socket's watchdog stops, and the socket is closed (1000, which also
	 * ends a command still running).
	 */
	#end(command: Command, failure?: Error): void {
		if (!command.ended) command.failure ??= failure;
		command.ended = true;
		command.quiet();
		command.socket?.close(END);
		command.wake();
	}

	/**
	 * One socket of the command's stream: `first` is its start, or an attach from the position read to. It answers once
	 * the socket is the command's (a start: Groundbox said `started`; an attach: Groundbox said anything on it, so a peer
	 * that takes an attach and says nothing is no read-on), within the bound. From then its messages are the command's
	 * events, and a close that is no end of the command opens another (#resume). A start that failed or timed out closes
	 * with 1000, which ends the command should Groundbox have started it. A socket that does not open says what the
	 * sandbox reads as: a refused upgrade carries its status and body where a WebSocket client can't read them.
	 */
	async #connect(command: Command, first: { type: string }, ctx: HostCall): Promise<void> {
		const url = `${this.#apiUrl.replace(/^http/, "ws")}/sandboxes/${encodeURIComponent(command.sandbox)}/exec/stream`;
		let socket: GroundboxSocket;
		try {
			socket = this.#webSocket(url, { headers: { Authorization: `Bearer ${this.#apiKey}` } });
		} catch (error) {
			throw new Error(`opening the command stream: ${(error as Error).message}`);
		}
		command.socket = socket;
		let ready!: (failure?: Error) => void;
		const readied = new Promise<Error | undefined>((done) => (ready = done));
		let silence: ReturnType<typeof setTimeout> | undefined;
		command.quiet = () => clearTimeout(silence);
		/** This socket was given up on: nothing it says is read any more, and its close opens no other. */
		let abandoned = false;
		/**
		 * Lets this socket go while the command runs on: its later messages and its close are ignored, since a close may
		 * never come (WebSocket's close waits for a peer that may be gone). Silent: another socket attaches at once. Full:
		 * none until the reader has taken enough (#events).
		 */
		const letGo = (why: "silent" | "full") => {
			if (abandoned) return;
			abandoned = true;
			clearTimeout(silence);
			if (command.socket === socket) command.socket = undefined;
			try {
				socket.close(DROP);
			} catch {
				// Already closing: nothing more to do with it.
			}
			if (why === "full") command.paused = true;
			else {
				// An attach Groundbox never spoke on fails its try (#resume's); a socket already read on is past this.
				ready(new Error(`the command stream said nothing for ${seconds(this.#bounds.silenceMs)} after its ${first.type}`));
				void this.#resume(command);
			}
		};
		const heard = () => {
			clearTimeout(silence);
			// A resumable stream is never silent for long (its heartbeat): one that is has died, with or without a close.
			if (command.execId !== undefined && !command.ended) (silence = setTimeout(() => letGo("silent"), this.#bounds.silenceMs)).unref?.();
		};
		socket.addEventListener("open", () => {
			try {
				socket.send(JSON.stringify(first));
				heard();
			} catch (error) {
				ready(new Error(`the command stream took no ${first.type}: ${(error as Error).message}`));
			}
		});
		socket.addEventListener("message", ({ data }) => {
			if (abandoned || socket !== command.socket || command.ended || typeof data !== "string") return;
			let message: StreamMessage;
			try {
				message = JSON.parse(data) as StreamMessage;
			} catch {
				return;
			}
			heard();
			// Groundbox speaks on the attach (output, a heartbeat, the exit): the command is read on here.
			if (first.type === "attach") ready();
			if (message.type === "started" && typeof message.exec_id === "string") {
				command.execId = message.exec_id;
				// The watchdog arms only once there is a command to attach to: from here, a socket silent after `started` alone is let go too.
				heard();
				ready();
			} else if ((message.type === "stdout" || message.type === "stderr") && typeof message.data === "string") {
				command.events.push({ stream: message.type, base64: message.data });
				command.queued += bytesOf(message.data);
				if (typeof message.seq === "number") command.seq = message.seq;
				// Everything up to seq is queued: a socket opened later attaches from there, and nothing is lost or read twice.
				if (command.queued > this.#bounds.queueHighBytes) letGo("full");
			} else if (message.type === "skipped") {
				this.#end(command, new Error(`Groundbox no longer keeps ${String(message.bytes)} bytes of the command's output, lost while its stream was down`));
			} else if (message.type === "exit" && typeof message.exit_code === "number") {
				command.events.push({ exit: message.exit_code });
				this.#end(command);
			} else if (message.type === "error") {
				const failure = new HostError((typeof message.code === "string" ? CODES[message.code] : undefined) ?? "vendor", `Groundbox ended the command: ${typeof message.message === "string" ? message.message : "no reason given"}`);
				ready(failure);
				this.#end(command, failure);
			}
			command.wake();
		});
		socket.addEventListener("error", (event) => ready(new Error(`the command stream failed${event.message ? `: ${event.message}` : ""}`)));
		socket.addEventListener("close", ({ code }) => {
			clearTimeout(silence);
			ready(new Error(`the command stream closed before the command ${first.type === "attach" ? "was read on" : "started"} (code ${code ?? "none"})`));
			// The command runs on in the sandbox: another socket reads on from where this one got to.
			if (socket === command.socket && !abandoned && !command.ended && command.execId !== undefined) void this.#resume(command);
		});
		const bound = boundOf(ctx.timeoutMs, ctx.signal, first.type === "attach" ? "the command stream's attach" : "opening the command stream");
		try {
			const failed = await Promise.race([readied, bound.promise]);
			if (failed !== undefined) throw failed;
		} catch (error) {
			abandoned = true;
			clearTimeout(silence);
			// A start with no `started` in time may still start in the sandbox: only 1000 ends it there. An attach's command runs on.
			socket.close(first.type === "start" ? END : DROP);
			const name = (error as { name?: unknown }).name;
			if (error instanceof HostError || name === "AbortError" || name === "TimeoutError") throw error;
			const read = await this.#api.json("GET", this.#api.url(`/sandboxes/${encodeURIComponent(command.sandbox)}`), { timeoutMs: ctx.timeoutMs }, ctx.signal);
			if (!read.ok) throw new HostError(read.error.code, `${(error as Error).message}; ${read.error.message}`);
			const status = (read.value as Sandbox | null)?.status;
			const words = `${(error as Error).message}; Groundbox reads the sandbox as ${show(status)}`;
			throw typeof status === "string" && status in STATES && STATES[status] === undefined ? new HostError("gone", words) : new Error(words);
		} finally {
			bound.clear();
		}
	}

	/**
	 * Reads on after a socket closed with the command still running: a new socket attaches from the position read to,
	 * tried again with doubling pauses. A try succeeds once Groundbox speaks on its socket, so a peer that takes every
	 * attach and says nothing never starts the clock again. A sandbox that is gone, or no socket Groundbox speaks on
	 * within the give-up bound (RESUME_GIVE_UP_MS), fails the stream.
	 */
	async #resume(command: Command): Promise<void> {
		// One at a time, and none while reading is paused (#events starts it again).
		if (command.resuming || command.paused || command.ended) return;
		command.resuming = true;
		try {
			const since = Date.now();
			const giveUp = this.#bounds.resumeGiveUpMs;
			for (let wait = RESUME_MIN_MS; !command.ended; wait = Math.min(wait * 2, RESUME_MAX_MS)) {
				try {
					// Each try within what is left of the bound, and ATTACH_MS at most.
					const timeoutMs = Math.max(1, Math.min(ATTACH_MS, since + giveUp - Date.now()));
					await this.#connect(command, { type: "attach", exec_id: command.execId, seq: command.seq, encoding: "base64" } as { type: string }, { timeoutMs });
					return;
				} catch (error) {
					const code = error instanceof HostError ? error.code : undefined;
					if (code === "not_found" || code === "gone") return this.#end(command, error as Error);
					// No try that would start past the bound: the stream fails with the last try's words.
					if (Date.now() + wait - since >= giveUp) return this.#end(command, new Error(`the command's stream could not be read on again within ${seconds(giveUp)}: ${(error as Error).message}`));
				}
				await pause(wait);
			}
		} finally {
			command.resuming = false;
		}
	}

	/** The command's events as its sockets give them, to its exit or its failure; then the last socket is let go of. */
	async *#events(command: Command): AsyncGenerator<FramedEvent> {
		try {
			for (;;) {
				const next = command.events.shift();
				if (next !== undefined && "base64" in next) {
					command.queued -= bytesOf(next.base64);
					// Reading was paused with too much unread: read on from where it stopped once the reader has caught up.
					if (command.paused && command.queued <= this.#bounds.queueLowBytes) {
						command.paused = false;
						void this.#resume(command);
					}
				}
				if (next !== undefined) yield next;
				else if (command.ended) break;
				else await new Promise<void>((done) => (command.wake = done));
			}
			if (command.failure) throw command.failure;
		} finally {
			this.#end(command);
		}
	}

	/**
	 * The daemon's upload through the files API (PUT /v1/sandboxes/{id}/files?path=), the bytes as they are, written as
	 * the sandbox's command user (root on the box image, runner on Groundbox's own).
	 */
	async upload(id: string, path: string, bytes: Uint8Array, ctx: HostCall): Promise<void> {
		await this.#call("PUT", `/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`, undefined, ctx, { retry: true, bytes: new Uint8Array(bytes) });
	}

	/**
	 * The janitor's deadline label, moved. PATCH /v1/sandboxes/{id} replaces the whole metadata map, so the map is read
	 * and sent back with the one label changed; the adapter is its only writer. Groundbox's own timer stays at the
	 * backstop create gave it.
	 */
	async extend(id: string, endsAt: Date, ctx: HostCall): Promise<void> {
		const path = `/sandboxes/${encodeURIComponent(id)}`;
		const sandbox = await this.#call<Sandbox>("GET", path, undefined, ctx, { retry: true });
		await this.#call("PATCH", path, { metadata: { ...(sandbox?.metadata ?? {}), [DEADLINE_LABEL]: endsAt.toISOString() } }, ctx);
	}
}

/**
 * Computers that are Groundbox sandboxes, on the shared adapter. A spec's image is the box image by default
 * (prepareImage), "default" (the team's default template, else Groundbox's own image), a template of the key's team, or
 * a public image.
 */
export class GroundboxProvider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it): the box image the release publishes, by its
	 * public registry tag (box-image.ts). No call: Groundbox turns it into a disk at the first create from it, and keeps
	 * that disk for later ones.
	 */
	async prepareImage(): Promise<Result<string>> {
		return ok(boxImageRef());
	}

	constructor(options: GroundboxProviderOptions) {
		const { apiKey, apiUrl = DEFAULT_API_URL, diskGb, fetch, webSocket, streamBounds, maxLifetimeMs = DEFAULT_LIFETIME_MS, ...rest } = options ?? ({} as GroundboxProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the Groundbox API key, is required: the provider reads no environment, so the caller passes it");
		let url: URL | undefined;
		try {
			url = new URL(apiUrl);
		} catch {
			// Refused below, in words.
		}
		// The key rides every call and the stream's upgrade: never in cleartext past this machine.
		if (url === undefined || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.test(url.hostname)))) {
			throw new Error(`the Groundbox API URL must be https, or http to a loopback host (127.0.0.0/8, ::1 or localhost), such as ${DEFAULT_API_URL}, not ${JSON.stringify(apiUrl)}`);
		}
		if (diskGb !== undefined && !(isWhole(diskGb) && diskGb >= 1 && diskGb <= MAX_DISK_GB)) throw new Error(`diskGb is a whole number of GB, 1 to ${MAX_DISK_GB}, not ${String(diskGb)}`);
		if (Number(rest.daemonUser?.split(":")[0]) === IMAGE_UID) throw new Error(`the daemon user ${rest.daemonUser} is the uid of the sandbox's own user, whose processes init refuses to run beside; choose another, such as 2510:2510`);
		super(
			new GroundboxHost({
				apiKey,
				apiUrl,
				...(fetch ? { fetch } : {}),
				webSocket: webSocket ?? ((url, init) => new WebSocket(url, init as never) as unknown as GroundboxSocket),
				...(diskGb === undefined ? {} : { diskGb }),
				kind: rest.kind === "desktop" ? "desktop" : "linux",
				...(streamBounds === undefined ? {} : { streamBounds }),
			}),
			{ ...rest, maxLifetimeMs },
		);
	}
}
