// The Orgo provisioner: desktops on Orgo (orgo.ai), a Linux VM with a screen, for the desktop kind. computerd runs in the
// VM as everywhere (design: "computerd in every computer"), so a desktop is the same wire as every computer: it is
// uploaded, installed and started as a child of Orgo's own agent, on Orgo's own X display (:99), with its tools as
// 2510:2510 in init's own network namespace. Orgo's screenshot and input API is not used. Everything inside a computer
// goes through an OrgoChannel (orgo-channel.ts): Orgo's bash and upload calls and its root terminal, by default.
//
// Orgo has no labels and no list of computers but a workspace's: the computers of a deployment live in one workspace
// (the workspaceId option), and a computer's name carries what list needs with nothing run inside it: computer-<12 hex>,
// then -r<the run label's hash> and -e<the epoch label>. Every label, the deadline and its most are in a root-owned file
// in the computer, /opt/agentrun/labels.json, the truth attach reads. Every Orgo fact is cited in orgo-channel.ts and
// the plan: POST /computers takes workspace_id, name (≤ 80), os, ram, cpu, template_ref and ends_in_hours (1 to 720,
// after which Orgo deletes the computer); DELETE /computers/{id} answers 404 computer_not_found once it is gone and 409
// computer_waking while it wakes; POST /computers/{id}/extend { hours } with an Idempotency-Key lengthens Orgo's end.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { childCommands, type DaemonExpected, daemonDrift } from "./child.js";
import { DaemonClient } from "./client.js";
import { DESKTOP_GROUPS } from "./desktop.js";
import { COMPUTER_LABEL, DAEMON_IN_COMPUTER, helloDrift, type ProbeReport, probeNetworkDrift, probeNotes, probeReportOf, SOCKET_DIR, WORK } from "./drift.js";
import { EPOCH_LABEL, RUN_LABEL } from "./labels.js";
import type { KindCapabilities } from "./kinds.js";
import { checkMount, type MountKind } from "./mount.js";
import { type OrgoChannel, type OrgoRest, type OrgoStart, type OrgoWebSocketFactory, ORGO_API_URL, orgoRest, orgoTerminalChannel, START_LOG } from "./orgo-channel.js";
import type { Group } from "./protocol.js";
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
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
} from "./provider.js";
import { type ComputerError, fail, ok, type Result } from "./result.js";
import { daemonWatch, type ScreenWatch, type ScreenWatchHandlers, type WatchOptions } from "./screen-watch.js";
import { listTested } from "./test-connection.js";

/** The mount kinds an Orgo computer takes: none yet (an Archil mount needs an Orgo template that bakes the helper). */
export const MOUNT: readonly MountKind[] = [];

/** The groups every Orgo computer offers: a Linux shell, files and processes, and the desktop's screen and input. */
const GROUPS: Group[] = ["exec", "files", "processes", ...DESKTOP_GROUPS];

/** What a built provider declares, known without building one: one configuration, a Linux desktop (the registry's entry). */
export const CAPABILITIES: readonly KindCapabilities[] = [{ kind: "desktop", groups: [...GROUPS] }];

/** The conformance CLI's module for Orgo: its live switch, the run's 1 h cap and the drifted twin. */
export const conformance = () => import("./conformance/orgo.js");

/** The longest each kind of call may take, and the pause between two polls. */
export interface OrgoTimeouts {
	/** One REST call: get, delete, extend, a workspace's computers. */
	requestMs: number;
	/** The create call, and the wait until Orgo reads the computer running. */
	createMs: number;
	/** The daemon's upload. */
	uploadMs: number;
	/** One command through the channel: install, the X check, the labels file, the start. */
	execMs: number;
	/** From a bridge's start to the daemon's hello, and each read-back call after it. */
	helloMs: number;
	/** The probe, through the daemon. */
	probeMs: number;
	/** One whole list. */
	listMs: number;
	/** From a delete to a computer Orgo no longer has. */
	goneMs: number;
	/** The pause between two reads while create or release waits. */
	pollMs: number;
}

export interface OrgoProviderOptions {
	/** The Orgo API key. Serve passes ORGO_API_KEY's value; the provider never reads the environment or logs it. */
	apiKey: string;
	/** The workspace this deployment's computers live in; the provider lists, attaches and releases only there. */
	workspaceId: string;
	/** Orgo's API, https; default https://www.orgo.ai/api. */
	apiUrl?: string;
	/** For tests: every REST call goes through it. Default the global fetch. */
	fetch?: typeof fetch;
	/** For tests: the terminal socket. Default Node's global WebSocket. */
	webSocket?: OrgoWebSocketFactory;
	/** The way into a computer; default Orgo's bash, upload and root terminal (orgoTerminalChannel). */
	channel?: OrgoChannel;
	/** The daemon binary for linux/amd64. Default this package's dist/computerd-linux-amd64. */
	daemonPath?: string;
	/** The longest lifetime check takes: at most Orgo's 720 h, the default. */
	maxLifetimeMs?: number;
	/** Who the tools run as, uid:gid in numbers, never root: default 2510:2510, the remote tool user. */
	user?: string;
	/** How init is started: from bash, detached (default), or in a named terminal session. */
	start?: OrgoStart;
	/** Orgo's X display, where the daemon's screen and input go. Default :99. */
	display?: string;
	timeouts?: Partial<OrgoTimeouts>;
	/** The addresses the probe tries, host:port over TCP or host:port/udp, to show none of them answers. */
	probeTargets?: string[];
}

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const HOUR = 3_600_000;
/** Orgo's longest end: ends_in_hours is at most 720. */
const MAX_LIFETIME_MS = 720 * HOUR;
/** Orgo's RAM sizes, in GB, and the vCPUs each takes by default. */
const RAM_GB = [4, 8, 16, 32] as const;
const CPU_FOR_RAM: Record<number, number> = { 4: 1, 8: 2, 16: 4, 32: 6 };
/** The vCPUs a computer may ask for on its own (8 needs Orgo to set the account up). */
const CPUS = [0.5, 1, 2, 4, 6];
const NAME_MAX = 80;
/** A name of this provider's making: computer-<12 hex>, the run label's hash, the epoch label, the deadline (base 36 s). */
const NAME = /^computer-([0-9a-f]{12})(?:-r([a-z2-7]{16}))?(?:-e(0|[1-9][0-9]{0,15}))?(?:-d([0-9a-z]{1,11}))?$/;
/** An Orgo template: namespace/name@version. */
const TEMPLATE = /^[a-z0-9][a-z0-9_.-]{0,63}\/[a-z0-9][a-z0-9_.-]{0,63}@[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** Orgo's base desktop, no template: the image a spec names for a plain Linux desktop, and the default for kind desktop. */
export const ORGO_BASE_IMAGE = "linux";
const BASE = ORGO_BASE_IMAGE;
const COMPUTER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const USER = /^(\d+):(\d+)$/;
const DISPLAY = /^:(\d{1,5})(?:\.\d{1,5})?$/;
const TARGET = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}(?:\/udp)?$/;
const DEFAULT_PROBE_TARGETS = ["1.1.1.1:443", "8.8.8.8:443", "[2606:4700:4700::1111]:443", "1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp"];
const DEFAULTS: OrgoTimeouts = { requestMs: 30_000, createMs: 300_000, uploadMs: 120_000, execMs: 60_000, helloMs: 30_000, probeMs: 30_000, listMs: 60_000, goneMs: 120_000, pollMs: 1_000 };
const DEFAULT_DAEMON_PATH = fileURLToPath(new URL("./computerd-linux-amd64", import.meta.url));
/** The labels file: every label, the deadline and its most, the image and sizes, root's, readable by all. */
export const LABELS_FILE = "/opt/agentrun/labels.json";
const STAGING = "/tmp/agentrun-computerd-";
const LISTEN_RETRY_MS = 250;
/** How often a delete that answers 409 (the computer waking) is tried again. */
const DELETE_TRIES = 5;
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "cpus", "memoryMb", "labels"]);
/** The states in which a computer runs, or is on its way to. */
const RUNNING = new Set(["running", "creating", "restarting", "updating", "resuming"]);
const NETWORK =
	'an Orgo computer takes network "none" only: Orgo has no egress control, so its tools have no network of their own (init\'s namespace holds them to loopback), and open or an allowlist waits for the proxy-backed feature';

/** The scripts the provider runs as root, each marked on its first line, its arguments after it. */
const X11_SCRIPT = ["# agentrun-computer: orgo-x11", "s=$1", '[ -S "$s" ] || { echo "no X socket at $s"; exit 1; }'].join("\n");
const LABELS_SCRIPT = ["# agentrun-computer: orgo-labels", 'p=$1; t=$2; d=${p%/*}', 'mkdir -p "$d" && printf \'%s\' "$t" > "$p.part" && chmod 0644 "$p.part" && mv -f "$p.part" "$p"'].join("\n");
const LABELS_READ_SCRIPT = ["# agentrun-computer: orgo-labels-read", 'cat "$1"'].join("\n");
/** What the computer holds when its daemon does not answer: init running (anchored, so this script never matches itself), its socket, its log's tail. */
const STATUS_SCRIPT = [
	"# agentrun-computer: orgo-status",
	"d=$1; s=$2; l=$3",
	'if pgrep -f "^$d init" >/dev/null 2>&1; then echo "init running"; else echo "init not running"; fi',
	'if [ -S "$s" ]; then echo "socket present"; else echo "socket absent"; fi',
	"echo \"log $(tail -c 300 \"$l\" 2>/dev/null | tr '\\n' ' ')\"",
].join("\n");
/**
 * The TCP ports root listens on in Orgo's own network (its agent, its VNC, anything else of the image's), one decimal
 * port a line, from /proc/net/tcp and tcp6 (state 0A, LISTEN): no tool of the image's is relied on but awk.
 */
const PORTS_SCRIPT = [
	"# agentrun-computer: orgo-ports",
	"for f in /proc/net/tcp /proc/net/tcp6; do [ -r \"$f\" ] && awk 'NR > 1 && $4 == \"0A\" { n = split($2, a, \":\"); print a[n] }' \"$f\"; done | sort -u | while read -r h; do printf '%d\\n' \"0x$h\"; done",
].join("\n");
/**
 * The ports Orgo's own agent listens on in a computer, which its tools must never reach: its VNC (5999), websockify
 * (6080) and desktop API (8080), as live run 4's notes read them (Orgo documents only the host's side). create reads
 * every port root listens on beside these and holds the tools to none of them either.
 */
const ORGO_AGENT_PORTS = [5999, 6080, 8080];
/**
 * Every path unix socket of Orgo's desktop made root's alone (owner root, mode 0600), but the display's own ($1) and
 * computerd's, before any tool runs: the tools reach the X server through that one and nothing else (live run 4 found
 * root's D-Bus buses connectable by the tool user). Prints `locked <path>` for each, and `failed <path>` for one it
 * could not lock. Any failure fails the script: the scan, the sort, or one socket's chown or chmod (a later socket that
 * locks hides none), and create then refuses the computer. Plain sh (no pipefail): the scan and the sort are each
 * checked, and the loop reads a here-document, so its failed flag is the script's own. Orgo's desktop runs as root, so
 * nothing of its own loses a socket.
 */
export const LOCKDOWN_SCRIPT = [
	"# agentrun-computer: orgo-lockdown",
	"x=$1",
	"set --",
	'for d in /tmp /run /var/run /dev/shm; do [ -d "$d" ] && set -- "$@" "$d"; done',
	"[ $# -gt 0 ] || exit 0",
	// GNU find's -ignore_readdir_race: a socket gone between listing and reading is no failure. Used only where find has it.
	"r=",
	"find / -maxdepth 0 -ignore_readdir_race >/dev/null 2>&1 && r=-ignore_readdir_race",
	'found=$(find "$@" $r -type s) || { echo "scanning for sockets failed"; exit 1; }',
	"sorted=$(printf '%s\\n' \"$found\" | sort -u) || { echo \"sorting the sockets failed\"; exit 1; }",
	"failed=0",
	"while IFS= read -r s; do",
	'\t[ -n "$s" ] || continue',
	'\tcase "$s" in "$x" | /run/agentrun/* | /run/agentrun-archil/*) continue ;; esac',
	'\tif chown 0:0 "$s" && chmod 0600 "$s"; then echo "locked $s"; else echo "failed $s"; failed=1; fi',
	"done <<EOF",
	"$sorted",
	"EOF",
	"exit $failed",
].join("\n");

/** What the labels file holds. */
interface LabelsFile {
	name: string;
	labels: Record<string, string>;
	deadline: string;
	maxDeadline: string;
	image: string;
	cpus?: number;
	memoryMb?: number;
}

/** What Orgo reports of a computer, as far as the provider reads it. */
interface OrgoComputer {
	id: string;
	name: string;
	status: string;
	workspace_id?: string;
	project_id?: string;
	ends_at?: string | null;
	created_at?: string;
}

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const seconds = (ms: number) => `${ms / 1000} s`;
const pause = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((done) => {
		const timer = setTimeout(finish, ms);
		function finish() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			done();
		}
		if (signal?.aborted) finish();
		else signal?.addEventListener("abort", finish, { once: true });
	});

/** The run label's hash, as a name carries it: base32 of its sha256, lower case, 16 letters. */
function runHash(run: string): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	const bytes = createHash("sha256").update(run, "utf8").digest();
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5 && out.length < 16) {
			out += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		if (out.length >= 16) break;
	}
	return out;
}

/**
 * The name of a computer with these labels: computer-<hex>, then -r<the run label's hash> and -e<the epoch label> when
 * the labels carry a run and an epoch that is one, then -d<the deadline> when given: whole seconds since the epoch,
 * rounded up (never before init's own), in base 36, the janitor's deadline. Only those: a name is no place for a label's
 * value. Everything but the deadline is the name's stable part, which a rename on extend keeps.
 */
export function orgoName(labels: Record<string, string>, hex: string, deadline?: Date): string {
	const run = labels[RUN_LABEL];
	const epoch = labels[EPOCH_LABEL];
	const stable = `computer-${hex}${typeof run === "string" && run !== "" ? `-r${runHash(run)}` : ""}${typeof epoch === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(epoch) ? `-e${epoch}` : ""}`;
	return deadline === undefined ? stable : withDeadline(stable, deadline);
}

/** A name's stable part with this deadline. */
function withDeadline(stable: string, deadline: Date): string {
	return `${stable}-d${Math.ceil(deadline.getTime() / 1000).toString(36)}`;
}

/** What a name of this provider's making says, or undefined for any other name: its stable part, and its deadline. */
function nameParts(name: unknown): { hex: string; run?: string; epoch?: string; stable: string; deadline?: Date } | undefined {
	const match = typeof name === "string" ? NAME.exec(name) : null;
	if (match === null) return undefined;
	const seconds = match[4] === undefined ? Number.NaN : Number.parseInt(match[4], 36);
	return {
		hex: match[1] as string,
		...(match[2] ? { run: match[2] } : {}),
		...(match[3] !== undefined ? { epoch: match[3] } : {}),
		stable: (name as string).replace(/-d[0-9a-z]+$/, ""),
		...(Number.isSafeInteger(seconds) ? { deadline: new Date(seconds * 1000) } : {}),
	};
}

/** Whether two names are one computer's: their stable parts are the same (the deadline moves with extend). */
const sameComputer = (a: string, b: string) => nameParts(a)?.stable !== undefined && nameParts(a)?.stable === nameParts(b)?.stable;

function labelProblem(key: string, value: unknown): string | undefined {
	if (typeof value !== "string") return `the label ${key} must be a string`;
	if (key === "" || key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)} must be a non-empty name, and neither holds a NUL byte`;
	if (key === COMPUTER_LABEL || key.startsWith(`${COMPUTER_LABEL}.`)) return `the label ${key} is in the provider's own namespace (${COMPUTER_LABEL})`;
	return undefined;
}

function filterProblem(labels: unknown): string | undefined {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return "labels must map names to strings";
	for (const [key, value] of Object.entries(labels)) {
		if (typeof value !== "string" || key === "" || key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)} must be a non-empty name and a string, with no NUL byte`;
	}
	return undefined;
}

/** Why ref is not an Orgo computer's ref, or undefined. */
function refProblem(ref: ComputerRef): string | undefined {
	if (typeof ref?.name !== "string" || nameParts(ref.name) === undefined) return `${String(ref?.name)} is not the name of an Orgo computer of this provider (computer-<12 hex digits>...)`;
	if (typeof ref.id !== "string" || !COMPUTER_ID.test(ref.id)) return `${String(ref.id)} is not an Orgo computer id`;
	return undefined;
}

/** The labels file as written, or why it is not. */
function labelsOf(text: string): LabelsFile | string {
	try {
		const value = JSON.parse(text) as Partial<LabelsFile> | null;
		if (typeof value?.name === "string" && typeof value.labels === "object" && value.labels !== null && typeof value.deadline === "string" && typeof value.maxDeadline === "string" && typeof value.image === "string") {
			return value as LabelsFile;
		}
	} catch {
		// Said below.
	}
	return `the labels file ${LABELS_FILE} is not the one create writes`;
}

/**
 * Orgo desktops: see the module's header. A spec's image is "linux" (Orgo's base desktop) or an Orgo template
 * (namespace/name@version); cpus and memoryMb are Orgo's sizes; the network is none.
 */
export class OrgoProvider implements ComputerProvider {
	readonly id = "orgo";
	readonly version = VERSION;
	readonly #rest: OrgoRest;
	readonly #channel: OrgoChannel;
	readonly #workspaceId: string;
	readonly #daemonPath: string;
	readonly #maxLifetimeMs: number;
	readonly #uid: string;
	readonly #gid: string;
	readonly #start: OrgoStart;
	readonly #display: string;
	readonly #timeouts: OrgoTimeouts;
	readonly #probeTargets: string[];
	/** Each computer's extend in flight, by id: the next waits for it, so two never read the same old deadline. */
	readonly #extending = new Map<string, Promise<unknown>>();

	constructor({ apiKey, workspaceId, apiUrl = ORGO_API_URL, fetch, webSocket, channel, daemonPath = DEFAULT_DAEMON_PATH, maxLifetimeMs = MAX_LIFETIME_MS, user = "2510:2510", start = "bash", display = ":99", timeouts = {}, probeTargets = DEFAULT_PROBE_TARGETS }: OrgoProviderOptions) {
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, an Orgo API key, is required");
		if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) throw new Error("options.workspaceId, the Orgo workspace this deployment's computers live in, is required");
		let url: URL;
		try {
			url = new URL(apiUrl);
		} catch {
			throw new Error("options.apiUrl is not a URL");
		}
		if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("options.apiUrl must be https, with no credentials in it: the key goes to it");
		if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > MAX_LIFETIME_MS) throw new Error(`maxLifetimeMs must be a whole number of ms above 0 and at most Orgo's 720 h (${MAX_LIFETIME_MS} ms)`);
		const ids = USER.exec(user);
		if (ids === null) throw new Error(`the user ${JSON.stringify(user)} must be uid:gid in numbers, such as 2510:2510`);
		if (Number(ids[1]) === 0 || Number(ids[2]) === 0) throw new Error(`the user ${user} is root or in root's group: an Orgo computer's tools run as neither`);
		if (start !== "bash" && start !== "session") throw new Error(`start is "bash" or "session", not ${JSON.stringify(start)}`);
		if (!DISPLAY.test(display)) throw new Error(`display ${JSON.stringify(display)} must be a local X display, such as :99`);
		const merged = { ...DEFAULTS, ...timeouts };
		for (const [key, value] of Object.entries(merged)) {
			if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1) throw new Error(`timeouts.${key} must be a whole number of ms above 0`);
		}
		if (!Array.isArray(probeTargets) || probeTargets.length === 0 || probeTargets.some((target) => typeof target !== "string" || !TARGET.test(target))) {
			throw new Error("probeTargets must name at least one address for the probe, each host:port or host:port/udp");
		}
		this.#rest = orgoRest({ apiKey, apiUrl: url.href, ...(fetch ? { fetch } : {}) });
		this.#channel = channel ?? orgoTerminalChannel({ rest: this.#rest, workspaceId, ...(webSocket ? { webSocket } : {}) });
		this.#workspaceId = workspaceId;
		this.#daemonPath = daemonPath;
		this.#maxLifetimeMs = maxLifetimeMs;
		[this.#uid, this.#gid] = [String(Number(ids[1])), String(Number(ids[2]))];
		this.#start = start;
		this.#display = display;
		this.#timeouts = merged;
		this.#probeTargets = [...probeTargets];
	}

	/**
	 * daemon child: Orgo's own agent is the VM's first process, and init is a command it ran. lifetime janitor: Orgo ends
	 * a computer only in whole hours (ends_in_hours, the backstop), so the janitor deletes it at its exact deadline, which
	 * its name carries (list() reads it with nothing run inside); init ends its programs at that deadline inside. network
	 * none alone, read back by the probe from inside (Orgo reads no policy back). release delete alone: Orgo's stop
	 * freezes a computer, which nothing here needs.
	 */
	capabilities(): ComputerCapabilities {
		return {
			kind: "desktop",
			lifetime: "janitor",
			network: ["none"],
			networkReadBack: false,
			isolation: "vm",
			os: "linux",
			daemon: "child",
			groups: [...GROUPS],
			maxLifetimeMs: this.#maxLifetimeMs,
			release: ["delete"],
			mount: [...MOUNT],
			// Init starts with --own-network (childCommands): no tool reaches these, nor any port root listens on.
			vendorAgentPorts: [...ORGO_AGENT_PORTS],
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
		const { image, lifetimeMs, network, cpus, memoryMb, labels, mount } = given;
		if (image !== BASE && !(typeof image === "string" && TEMPLATE.test(image))) refuse("image", `an image is "${BASE}" (Orgo's base desktop) or an Orgo template, namespace/name@version`);
		refusals.push(...checkLifetime(lifetimeMs, this.capabilities()));
		if (network !== "none") refuse("network", NETWORK);
		if (memoryMb !== undefined && !RAM_GB.some((gb) => gb * 1024 === memoryMb)) refuse("memoryMb", "memoryMb is one of Orgo's sizes: 4096, 8192, 16384 or 32768");
		if (cpus !== undefined && !CPUS.includes(cpus as number)) refuse("cpus", "cpus is one of Orgo's sizes: 0.5, 1, 2, 4 or 6");
		if (labels !== undefined) {
			const entries = typeof labels === "object" && labels !== null && !Array.isArray(labels) ? Object.entries(labels) : undefined;
			const bad = entries === undefined ? "labels must map names to strings" : entries.map(([key, value]) => labelProblem(key, value)).find(Boolean);
			if (bad) refuse("labels", bad);
		}
		refusals.push(...checkMount(mount, MOUNT));
		for (const [field, value] of Object.entries(given)) {
			if (SPEC_FIELDS.has(field) || field === "mount" || value === undefined) continue;
			if (field === "user") refuse(field, `an Orgo computer's tools run as the provider's user (${this.#uid}:${this.#gid}, the remote tool user), never as one a spec names`);
			else if (field === "workdir") refuse(field, `an Orgo computer works in ${WORK}, its home; a spec cannot name another`);
			else if (field === "pids") refuse(field, "Orgo offers no pids limit to set; leave pids unset");
			else refuse(field, `an Orgo computer does not support ${field}`);
		}
		return refusals;
	}

	async create(spec: ComputerSpec, { signal }: CallContext = {}): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		if (refusals.length > 0) return fail("refused", refusals.map(({ field, message }) => `${field}: ${message}`).join("; "));
		let daemon: Buffer;
		try {
			daemon = readFileSync(this.#daemonPath);
		} catch {
			return fail("not_found", `no daemon binary at ${this.#daemonPath}: run npm run build:daemon -w @parcha/agentrun-computer`);
		}
		if (signal?.aborted) return fail("aborted", "create was aborted before Orgo was called");
		const labels = { ...spec.labels };
		const now = Date.now();
		const deadline = new Date(now + spec.lifetimeMs).toISOString();
		const maxDeadline = new Date(now + this.#maxLifetimeMs).toISOString();
		// The janitor's deadline is in the name, so list() and the sweep read it with nothing run inside.
		const name = orgoName(labels, randomBytes(6).toString("hex"), new Date(deadline));
		if (name.length > NAME_MAX || nameParts(name) === undefined) return fail("invalid", `the name ${name} is not one Orgo holds: at most ${NAME_MAX} of letters, digits and dashes`);
		const ram = spec.memoryMb === undefined ? 4 : spec.memoryMb / 1024;
		const cpu = spec.cpus ?? (CPU_FOR_RAM[ram] as number);
		const body = {
			workspace_id: this.#workspaceId,
			name,
			os: "linux",
			ram,
			cpu,
			// Orgo's end, the vendor's backstop: whole hours, deleting the computer and its disk. init ends it on time.
			ends_in_hours: Math.max(1, Math.ceil(spec.lifetimeMs / HOUR)),
			...(spec.image === BASE ? {} : { template_ref: spec.image }),
		};
		const made = await this.#rest.request<OrgoComputer>("POST", "/computers", { body, timeoutMs: this.#timeouts.createMs, ...(signal ? { signal } : {}) });
		if (!made.ok) {
			// A create Orgo refused (a 4xx) made nothing. One whose answer never came may have: it goes by its name.
			if (["invalid", "denied", "limit", "not_found", "refused"].includes(made.error.code)) return made;
			return fail(made.error.code, `${made.error.message}${await this.#deleteNamed(name)}`);
		}
		const id = made.value?.id;
		if (typeof id !== "string" || !COMPUTER_ID.test(id)) return fail("orgo", `Orgo's create answered no computer id${await this.#deleteNamed(name)}`);
		const ref = { id, name };
		const file: LabelsFile = { name, labels, deadline, maxDeadline, image: spec.image, cpus: cpu, memoryMb: ram * 1024 };
		const prepared = await this.#prepare(ref, made.value.status, file, daemon, signal);
		if (signal?.aborted) return this.#abandon(ref, { code: "aborted", message: "create was aborted" });
		if (prepared.ok) return ok(prepared.value.length > 0 ? { ...ref, notes: prepared.value } : ref);
		return this.#abandon(ref, prepared.error);
	}

	/**
	 * Everything between Orgo's answer and a computer that passed the drift check: running, computerd uploaded and
	 * installed (its sha256 read back), Orgo's X server's path socket there, the labels file, init started, its first
	 * connection, then the daemon's report and the probe. Its value is the probe's notes.
	 */
	async #prepare(ref: ComputerRef, status: string, file: LabelsFile, daemon: Buffer, signal?: AbortSignal): Promise<Result<string[]>> {
		const { uploadMs, execMs } = this.#timeouts;
		const running = status === "running" ? ok(undefined) : await this.#untilRunning(ref, signal);
		if (!running.ok) return running;
		const staging = `${STAGING}${randomBytes(8).toString("hex")}`;
		const uploaded = await this.#channel.upload(ref.id, staging, daemon, { timeoutMs: uploadMs, ...(signal ? { signal } : {}) });
		if (!uploaded.ok) return fail(uploaded.error.code, `the daemon's upload into ${ref.name} failed: ${uploaded.error.message}`);
		const commands = childCommands({ staging, deadline: file.deadline, user: `${this.#uid}:${this.#gid}`, display: this.#display, maxDeadline: file.maxDeadline });
		const install = await this.#channel.run(ref.id, ["sh", "-c", commands.install], { timeoutMs: execMs, ...(signal ? { signal } : {}) });
		if (!install.ok) return install;
		if (install.value.exitCode !== 0) return fail("refused", `installing the daemon failed (exit ${install.value.exitCode}): ${install.value.output.trim().slice(0, 500)}`);
		const sha256 = createHash("sha256").update(daemon).digest("hex");
		const read = /^sha256 ([0-9a-f]{64})$/m.exec(install.value.output)?.[1];
		if (read !== sha256) return fail("refused", `it did not match its spec: daemon: uploaded sha256 ${sha256}, the installed binary reads back ${show(read)}`);
		// The tools live in init's own network namespace, which cuts the X server's abstract socket: they reach it through
		// its path socket alone, so a display with none is no desktop here.
		const socket = `/tmp/.X11-unix/X${(DISPLAY.exec(this.#display) as RegExpExecArray)[1]}`;
		const x11 = await this.#channel.run(ref.id, ["sh", "-c", X11_SCRIPT, "sh", socket], { timeoutMs: execMs, ...(signal ? { signal } : {}) });
		if (!x11.ok) return x11;
		if (x11.value.exitCode !== 0) {
			return fail("refused", `Orgo's X server for ${this.#display} has no socket at ${socket}: the tools reach it only through that path, since init's own network namespace cuts the abstract one (${x11.value.output.trim().slice(0, 200)})`);
		}
		const written = await this.#writeLabels(ref, file, signal);
		if (!written.ok) return written;
		// Every port root listens on in Orgo's own network, read before init starts in a network of its own.
		const ports = await this.#rootPorts(ref, signal);
		if (!ports.ok) return ports;
		// Every path socket of Orgo's desktop root's alone but the display's own, before any tool runs.
		const locked = await this.#lockDown(ref, socket, signal);
		if (!locked.ok) return locked;
		const started = await this.#channel.start(ref.id, ["sh", "-c", commands.init], { how: this.#start, timeoutMs: execMs, ...(signal ? { signal } : {}) });
		if (!started.ok) return fail(started.error.code, `starting the daemon in ${ref.name} failed: ${started.error.message}`);
		const opened = await this.#openWhenListening(ref, signal);
		if (!opened.ok) {
			if (opened.error.code === "aborted") return opened;
			return fail(opened.error.code, `the daemon did not answer: ${opened.error.message}; in the computer: ${await this.#status(ref, signal)}`);
		}
		try {
			const inside = await this.#checkInside(opened.value, ref.name, ports.value, signal);
			if (!inside.ok) return inside;
			return ok([
				...inside.value,
				`Orgo's own network listens on ${ports.value.join(", ") || "no TCP port"} (TCP, as root reads it); the tools' probe was refused at each and at ${ORGO_AGENT_PORTS.join(", ")}, on both loopbacks`,
				`Orgo's desktop sockets made root's alone: ${locked.value.join(", ") || "none"} (the display's own, ${socket}, left to the tools)`,
			]);
		} finally {
			await opened.value.close();
		}
	}

	/** Every path socket of Orgo's desktop made root's alone but the display's own (LOCKDOWN_SCRIPT): the paths it locked. */
	async #lockDown(ref: ComputerRef, display: string, signal?: AbortSignal): Promise<Result<string[]>> {
		const ran = await this.#channel.run(ref.id, ["sh", "-c", LOCKDOWN_SCRIPT, "sh", display], { timeoutMs: this.#timeouts.execMs, ...(signal ? { signal } : {}) });
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) return fail("refused", `making Orgo's desktop sockets root's alone in ${ref.name} failed (exit ${ran.value.exitCode}): ${ran.value.output.trim().slice(0, 200)}`);
		return ok(ran.value.output.split("\n").flatMap((line) => (line.startsWith("locked ") ? [line.slice("locked ".length).trim()] : [])));
	}

	/** The TCP ports root listens on in Orgo's own network, sorted, read through the channel. */
	async #rootPorts(ref: ComputerRef, signal?: AbortSignal): Promise<Result<number[]>> {
		const read = await this.#channel.run(ref.id, ["sh", "-c", PORTS_SCRIPT], { timeoutMs: this.#timeouts.execMs, ...(signal ? { signal } : {}) });
		if (!read.ok) return read;
		if (read.value.exitCode !== 0) return fail("refused", `reading the ports root listens on in ${ref.name} failed (exit ${read.value.exitCode}): ${read.value.output.trim().slice(0, 200)}`);
		const ports = read.value.output
			.split("\n")
			.map((line) => Number(line.trim()))
			.filter((port) => Number.isSafeInteger(port) && port > 0 && port < 65536);
		return ok([...new Set(ports)].sort((a, b) => a - b));
	}

	/** The probe's targets on the computer's own loopbacks: every port given and every declared agent port, on 127.0.0.1 and ::1. */
	#agentTargets(ports: readonly number[]): string[] {
		return [...new Set([...ports, ...ORGO_AGENT_PORTS])].sort((a, b) => a - b).flatMap((port) => [`127.0.0.1:${port}`, `[::1]:${port}`]); // key-gate: loopback-rule the computer's own loopbacks, where Orgo's agent listens and its tools must be refused
	}

	/** What the computer holds, in words, for a daemon that does not answer: init running or not, its socket, its log's tail. */
	async #status(ref: ComputerRef, signal?: AbortSignal): Promise<string> {
		const read = await this.#channel.run(ref.id, ["sh", "-c", STATUS_SCRIPT, "sh", DAEMON_IN_COMPUTER, `${SOCKET_DIR}/computerd.sock`, START_LOG], { timeoutMs: this.#timeouts.execMs, ...(signal ? { signal } : {}) });
		if (!read.ok) return `its status could not be read (${read.error.message})`;
		return read.value.output.trim().split("\n").map((line) => line.trim()).join("; ").slice(0, 600);
	}

	/** Polls Orgo until it reads the computer running, within createMs. */
	async #untilRunning(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const until = Date.now() + this.#timeouts.createMs;
		let last = "unread";
		for (;;) {
			const read = await this.#get(ref.id, signal);
			if (!read.ok) return read;
			last = read.value.status;
			if (last === "running") return ok(undefined);
			if (!RUNNING.has(last)) return fail("orgo", `Orgo read ${ref.name} ${last}, not running`);
			if (Date.now() >= until) return fail("timeout", `Orgo did not read ${ref.name} running within ${seconds(this.#timeouts.createMs)}; it last read ${last}`);
			await pause(this.#timeouts.pollMs, signal);
			if (signal?.aborted) return fail("aborted", "create was aborted while Orgo made the computer");
		}
	}

	/** The labels file written as root, readable by all, writable by root alone. */
	async #writeLabels(ref: ComputerRef, file: LabelsFile, signal?: AbortSignal): Promise<Result<void>> {
		const written = await this.#channel.run(ref.id, ["sh", "-c", LABELS_SCRIPT, "sh", LABELS_FILE, JSON.stringify(file)], { timeoutMs: this.#timeouts.execMs, ...(signal ? { signal } : {}) });
		if (!written.ok) return written;
		return written.value.exitCode === 0 ? ok(undefined) : fail("refused", `writing ${LABELS_FILE} in ${ref.name} failed (exit ${written.value.exitCode}): ${written.value.output.trim().slice(0, 300)}`);
	}

	/** The labels file, read through the channel. */
	async #readLabels(ref: ComputerRef, signal?: AbortSignal): Promise<Result<LabelsFile>> {
		const read = await this.#channel.run(ref.id, ["sh", "-c", LABELS_READ_SCRIPT, "sh", LABELS_FILE], { timeoutMs: this.#timeouts.execMs, ...(signal ? { signal } : {}) });
		if (!read.ok) return read;
		if (read.value.exitCode !== 0) return fail("refused", `${ref.name} has no labels file ${LABELS_FILE} to read (exit ${read.value.exitCode})`);
		const file = labelsOf(read.value.output);
		return typeof file === "string" ? fail("refused", `${ref.name}: ${file}`) : ok(file);
	}

	/**
	 * The daemon's report (hello with the desktop groups, its credentials, home and binary) and the probe, which refuses
	 * on an answer from any target and records a silent accept in the notes it returns.
	 */
	async #checkInside(connection: ComputerConnection, name: string, ports: readonly number[], signal?: AbortSignal): Promise<Result<string[]>> {
		const found = await daemonDrift(connection, this.#daemonExpected(), this.#timeouts.helloMs, signal);
		if (!found.ok) return found;
		const probe = await this.#probe(connection, name, ports, signal);
		if (!probe.ok) return probe;
		const drift = [...found.value, ...probeNetworkDrift(probe.value)];
		return drift.length === 0 ? ok(probeNotes(probe.value, "none")) : fail("refused", `it did not match its spec: ${drift.join("; ")}`);
	}

	#daemonExpected(): DaemonExpected {
		const { kind, groups } = this.capabilities();
		return { version: VERSION, uid: this.#uid, gid: this.#gid, arch: "amd64", kind, groups };
	}

	#bounded(ms: number, signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
	}

	/** `computerd probe` through the daemon, as the tool user: the outside targets, and Orgo's agent's ports (ports and the declared ones) on both loopbacks. */
	async #probe(connection: ComputerConnection, name: string, ports: readonly number[], signal?: AbortSignal): Promise<Result<ProbeReport>> {
		const { probeMs } = this.#timeouts;
		const argv = [DAEMON_IN_COMPUTER, "probe", ...[...this.#probeTargets, ...this.#agentTargets(ports)].flatMap((target) => ["--connect", target])];
		const ran = await connection.client.call("exec.run", { argv, timeoutMs: probeMs }, { signal: this.#bounded(probeMs + 5_000, signal) });
		if (!ran.ok) {
			if (signal?.aborted) return fail("aborted", `the probe in ${name} was aborted`);
			return fail(ran.error.code === "aborted" ? "timeout" : ran.error.code, `the probe in ${name} failed: ${ran.error.message}`);
		}
		const { exitCode, stdout, stderr, timedOut } = ran.value;
		if (timedOut) return fail("timeout", `the probe in ${name} did not end within ${seconds(probeMs)}`);
		if (exitCode !== 0) return fail("refused", `the probe in ${name} exited with ${exitCode}: ${Buffer.from(stderr, "base64").toString("utf8").trim().slice(0, 300)}`);
		const report = probeReportOf(stdout);
		return "not" in report ? fail("refused", `the probe in ${name} ${report.not}`) : ok(report);
	}

	/** One connection to the daemon through the channel's stdio bridge, after hello, unchecked. */
	async #open(ref: ComputerRef, signal?: AbortSignal, helloMs = this.#timeouts.helloMs): Promise<Result<ComputerConnection> & { notListening?: true }> {
		const bridge = await this.#channel.stdio(ref.id, ["sh", "-c", childCommands().stdio], { timeoutMs: helloMs, ...(signal ? { signal } : {}) });
		if (!bridge.ok) return bridge;
		const stream = bridge.value;
		const client = new DaemonClient({ readable: stream.readable, writable: stream.writable });
		let closed: Promise<void> | undefined;
		const close = () =>
			(closed ??= (async () => {
				client.close();
				await stream.close();
			})());
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: this.#bounded(helloMs, signal) });
		if (!hello.ok) {
			await close();
			if (signal?.aborted) return fail("aborted", `hello to the daemon in ${ref.name} was aborted`);
			if (hello.error.code === "aborted") return fail("timeout", `the daemon in ${ref.name} did not answer hello within ${seconds(helloMs)}`);
			if (hello.error.code !== "gone") return hello;
			return { ...fail("orgo", `cannot reach the daemon in ${ref.name}: ${stream.said() || hello.error.message}`), notListening: true };
		}
		return ok({ client, hello: hello.value, close });
	}

	/** #open, tried again while the bridge finds no daemon listening, until hello or helloMs in all. */
	async #openWhenListening(ref: ComputerRef, signal?: AbortSignal): Promise<Result<ComputerConnection>> {
		const until = Date.now() + this.#timeouts.helloMs;
		for (;;) {
			const opened = await this.#open(ref, signal, Math.max(1, until - Date.now()));
			if (opened.ok || !opened.notListening || signal?.aborted || Date.now() + LISTEN_RETRY_MS >= until) return opened;
			await pause(LISTEN_RETRY_MS, signal);
		}
	}

	/** Orgo's record of a computer; not_found once Orgo no longer has it. */
	async #get(id: string, signal?: AbortSignal): Promise<Result<OrgoComputer>> {
		const read = await this.#rest.request<OrgoComputer>("GET", `/computers/${encodeURIComponent(id)}`, { timeoutMs: this.#timeouts.requestMs, ...(signal ? { signal } : {}) });
		if (!read.ok) return read;
		if (typeof read.value?.name !== "string" || typeof read.value.status !== "string") return fail("orgo", `Orgo's record of ${id} has no name or status`);
		return ok(read.value);
	}

	/** Whether Orgo's record is a computer of this provider: its name's shape, in this workspace. */
	#ours(record: OrgoComputer, name?: string): boolean {
		// A ref's name matches by its stable part: extend renames the computer with its new deadline.
		return nameParts(record.name) !== undefined && (record.workspace_id ?? record.project_id) === this.#workspaceId && (name === undefined || sameComputer(record.name, name)) && record.status !== "deleted";
	}

	/** This provider's computer for ref, as Orgo reads it, or why not. */
	async #own(ref: ComputerRef, signal?: AbortSignal): Promise<Result<OrgoComputer>> {
		const read = await this.#get(ref.id, signal);
		if (!read.ok) return read.error.code === "not_found" ? fail("not_found", `no Orgo computer is ${ref.name} (${ref.id})`) : read;
		if (!this.#ours(read.value, ref.name)) return fail("not_found", `no Orgo computer of this provider named ${ref.name} has the id ${ref.id}`);
		return read;
	}

	/** Deletes a computer create gives up on, and waits until Orgo no longer has it. Never signalled: it outlives an abort. */
	async #abandon(ref: ComputerRef, error: ComputerError): Promise<Result<never>> {
		const deleted = await this.#delete(ref);
		return fail(error.code, `the computer ${ref.name} ${deleted.ok ? "was deleted" : `could not be deleted (${deleted.error.message}); Orgo ends it at its end`}: ${error.message}`);
	}

	/** Every computer of this workspace with the name create gave: for a create whose answer never came. Best effort, in words. */
	async #deleteNamed(name: string): Promise<string> {
		const listed = await this.#desktops();
		if (!listed.ok) return `; a computer named ${name} may be left (${listed.error.message}), which Orgo ends at its end`;
		const found = listed.value.filter((one) => one.name === name);
		if (found.length === 0) return `; no computer named ${name} is in the workspace`;
		const said = [];
		for (const one of found) {
			const deleted = await this.#delete({ id: one.id, name });
			said.push(deleted.ok ? `${one.id} was deleted` : `${one.id} may be left (${deleted.error.message})`);
		}
		return `; the computer named ${name}: ${said.join("; ")}`;
	}

	/** DELETE, tried again while Orgo answers 409 (waking), then the wait until Orgo no longer has the computer. */
	async #delete(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const { requestMs, pollMs, goneMs } = this.#timeouts;
		for (let tries = 1; ; tries++) {
			const deleted = await this.#rest.request("DELETE", `/computers/${encodeURIComponent(ref.id)}`, { timeoutMs: requestMs });
			if (deleted.ok || deleted.error.code === "not_found") break;
			const status = (deleted as { status?: number }).status;
			if (status !== 409 || tries >= DELETE_TRIES) return deleted;
			await pause(pollMs);
		}
		const until = Date.now() + goneMs;
		let last = "unread";
		for (;;) {
			const read = await this.#get(ref.id, signal);
			if (!read.ok && read.error.code === "not_found") return ok(undefined);
			if (read.ok && read.value.status === "deleted") return ok(undefined);
			if (!read.ok && read.error.code !== "timeout") return fail(read.error.code, `release of ${ref.name}: reading it back failed (${read.error.message})`);
			last = read.ok ? read.value.status : read.error.message;
			if (Date.now() >= until) return fail("timeout", `${ref.name} was still there ${seconds(goneMs)} after its delete; Orgo last read ${last}`);
			await pause(pollMs, signal);
			if (signal?.aborted) return fail("aborted", `the wait for ${ref.name} to go was aborted; Orgo last read ${last}`);
		}
	}

	/** The workspace's computers, as Orgo lists them. */
	async #desktops(signal?: AbortSignal): Promise<Result<OrgoComputer[]>> {
		const read = await this.#rest.request<{ desktops?: unknown }>("GET", `/workspaces/${encodeURIComponent(this.#workspaceId)}`, { timeoutMs: this.#timeouts.listMs, ...(signal ? { signal } : {}) });
		if (!read.ok) return read;
		const desktops = read.value?.desktops;
		if (!Array.isArray(desktops)) return fail("orgo", `Orgo's workspace ${this.#workspaceId} lists no computers array`);
		return ok(desktops.filter((one): one is OrgoComputer => typeof one?.id === "string" && typeof one.name === "string").map((one) => ({ ...one, workspace_id: this.#workspaceId })));
	}

	/** The live view: screen.watch on a connection of the watch's own (daemonWatch), never Orgo's VNC (proxy only). */
	watch(ref: ComputerRef, handlers: ScreenWatchHandlers, options?: WatchOptions): Promise<Result<ScreenWatch>> {
		return daemonWatch(this, ref, handlers, options);
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		const found = await this.#own(ref);
		if (!found.ok) return found;
		if (found.value.status !== "running") return fail("refused", `${ref.name} is ${found.value.status}, not running: its daemon does not run`);
		const opened = await this.#open(ref);
		if (!opened.ok) return opened;
		const { kind, groups } = this.capabilities();
		const drift = helloDrift(opened.value.hello, { version: VERSION, kind, groups, arch: "amd64" });
		if (drift.length === 0) return opened;
		await opened.value.close();
		return fail("refused", `the daemon in ${ref.name} does not match this provider: ${drift.join("; ")}`);
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: CallContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			if (typeof given.id !== "string" || !COMPUTER_ID.test(given.id)) return fail("invalid", `${String(given.id)} is not an Orgo computer id`);
			const read = await this.#get(given.id, signal);
			if (!read.ok) return read.error.code === "not_found" ? fail("not_found", `no Orgo computer has the id ${given.id}`) : read;
			if (!this.#ours(read.value)) return fail("not_found", `no Orgo computer of this provider has the id ${given.id}`);
			return this.#attached(read.value, signal);
		}
		const problem = filterProblem(given.labels);
		if (problem) return fail("invalid", problem);
		const labels = given.labels as Record<string, string>;
		if (Object.keys(labels).length === 0) return fail("invalid", "attach by labels needs at least one label");
		const listed = await this.list(labels, { signal });
		if (!listed.ok) return listed;
		const words = JSON.stringify(labels);
		if (listed.value.length === 0) return fail("not_found", `no Orgo computer has the labels ${words}`);
		if (listed.value.length > 1) return fail("invalid", `${listed.value.length} computers match the labels ${words}: ${listed.value.map((info) => info.ref.name).join(", ")}`);
		const found = await this.#own((listed.value[0] as ComputerInfo).ref, signal);
		if (!found.ok) return found;
		return this.#attached(found.value, signal);
	}

	/**
	 * The drift check of a computer attach did not make: its labels file, the truth, held to its name, then its daemon
	 * and the probe, as at create. One that drifts is refused and left as it is. A computer that does not run is
	 * refused: reading it from inside would wake it.
	 */
	async #attached(record: OrgoComputer, signal?: AbortSignal): Promise<Result<AttachedComputer>> {
		const ref = { id: record.id, name: record.name };
		if (record.status !== "running") return fail("refused", `${ref.name} is ${record.status}: its labels file and daemon are read from inside, and a read would wake it`);
		const file = await this.#readLabels(ref, signal);
		if (!file.ok) return file;
		const found: string[] = [];
		const parts = nameParts(record.name) as { run?: string; epoch?: string };
		const { labels } = file.value;
		if (typeof file.value.name !== "string" || !sameComputer(file.value.name, record.name)) found.push(`name: Orgo's is ${record.name}, the labels file's ${show(file.value.name)}`);
		const run = labels[RUN_LABEL];
		if ((parts.run ?? "") !== (typeof run === "string" && run !== "" ? runHash(run) : "")) found.push(`run: the name's run hash ${show(parts.run)} is not the labels file's run ${show(run)}`);
		if ((parts.epoch ?? "") !== (labels[EPOCH_LABEL] ?? "")) found.push(`epoch: the name says ${show(parts.epoch)}, the labels file ${show(labels[EPOCH_LABEL])}`);
		const deadline = new Date(file.value.deadline);
		if (Number.isNaN(deadline.getTime())) found.push(`deadline: the labels file reads ${show(file.value.deadline)}, not a time`);
		let notes: string[] = [];
		let kind: AttachedComputer["spec"]["kind"];
		if (found.length === 0) {
			const ports = await this.#rootPorts(ref, signal);
			if (!ports.ok) return ports;
			const opened = await this.#open(ref, signal);
			if (!opened.ok) return opened;
			try {
				const inside = await this.#checkInside(opened.value, ref.name, ports.value, signal);
				if (!inside.ok && inside.error.code !== "refused") return inside;
				if (!inside.ok) found.push(inside.error.message.replace(/^it did not match its spec: /, ""));
				else notes = inside.value;
			} finally {
				await opened.value.close();
			}
			kind = opened.value.hello.kind;
		}
		if (found.length > 0) return fail("refused", `the computer ${ref.name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		return ok({
			...ref,
			spec: {
				image: file.value.image,
				user: `${this.#uid}:${this.#gid}`,
				network: "none",
				...(file.value.cpus === undefined ? {} : { cpus: file.value.cpus }),
				...(file.value.memoryMb === undefined ? {} : { memoryMb: file.value.memoryMb }),
				workdir: WORK,
				deadline,
				...(kind === undefined ? {} : { kind }),
			},
			...(notes.length > 0 ? { notes } : {}),
		});
	}

	/**
	 * Every computer of this provider in the workspace that carries all of these labels. The run and the epoch are read
	 * from the name, with nothing run in a computer, so a stopped one is listed too; any other label is read from the
	 * labels file of a running computer (a stopped one is not woken, so it proves no such label and is left out).
	 */
	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const problem = filterProblem(labels);
		if (problem) return fail("invalid", problem);
		const listed = await this.#desktops(signal);
		if (!listed.ok) return listed;
		const others = Object.keys(labels).filter((key) => key !== RUN_LABEL && key !== EPOCH_LABEL);
		const infos: ComputerInfo[] = [];
		for (const record of listed.value) {
			const parts = nameParts(record.name);
			if (parts === undefined || record.status === "deleted") continue;
			if (labels[RUN_LABEL] !== undefined && parts.run !== runHash(labels[RUN_LABEL])) continue;
			if (labels[EPOCH_LABEL] !== undefined && parts.epoch !== labels[EPOCH_LABEL]) continue;
			const ref = { id: record.id, name: record.name };
			const running = RUNNING.has(record.status);
			let read: Record<string, string> = {
				...(labels[RUN_LABEL] !== undefined ? { [RUN_LABEL]: labels[RUN_LABEL] } : {}),
				...(parts.epoch !== undefined ? { [EPOCH_LABEL]: parts.epoch } : {}),
			};
			// The janitor's deadline is the name's; a name of an older make has none, and Orgo's end stands for it.
			let deadline: Date | undefined = parts.deadline ?? (typeof record.ends_at === "string" ? new Date(record.ends_at) : undefined);
			if (others.length > 0) {
				if (record.status !== "running") continue;
				const file = await this.#readLabels(ref, signal);
				if (!file.ok) continue;
				if (!others.every((key) => file.value.labels[key] === labels[key])) continue;
				read = { ...file.value.labels };
				deadline = parts.deadline ?? new Date(file.value.deadline);
			}
			infos.push({ ref, labels: read, deadline, state: running ? "running" : "stopped", network: "none" });
		}
		return ok(infos);
	}

	/** none, read back by the probe from inside, as the tool user; a change is refused: none is the one network here. */
	/** Settings' test: one read of the workspace's computers (list with no label to read from inside), which makes nothing. */
	async testConnection(context: CallContext = {}): Promise<Result<{ detail: string }>> {
		return listTested("Orgo", await this.list({}, context));
	}

	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (policy !== undefined && policy !== "none") return fail("refused", NETWORK);
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		if (found.value.status !== "running") return fail("refused", `${ref.name} is ${found.value.status}: its network is read from inside, and a read would wake it`);
		const ports = await this.#rootPorts(ref, signal);
		if (!ports.ok) return ports;
		const opened = await this.#open(ref, signal);
		if (!opened.ok) return opened;
		try {
			const probe = await this.#probe(opened.value, ref.name, ports.value, signal);
			if (!probe.ok) return probe;
			if (probe.value.reached.length > 0) return ok({ other: `created with network none, yet from inside an answer came back from ${probe.value.reached.join(", ")}` });
			return ok("none");
		} finally {
			await opened.value.close();
		}
	}

	/** delete: idempotent, a computer Orgo no longer has is done; it waits until Orgo no longer has it. No stop. */
	async release(ref: ComputerRef, how: "stop" | "delete", { signal }: CallContext = {}): Promise<Result<void>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (how !== "stop" && how !== "delete") return fail("invalid", `release is "stop" or "delete", not ${String(how)}`);
		if (how === "stop") return fail("unsupported", "an Orgo computer has no stop that this provider declares: release it with delete");
		const read = await this.#get(ref.id);
		if (!read.ok) return read.error.code === "not_found" ? ok(undefined) : read;
		if (read.value.status === "deleted") return ok(undefined);
		if (!this.#ours(read.value, ref.name)) return fail("not_found", `no Orgo computer of this provider is ${ref.name} (${ref.id}), so it is left as it is`);
		return this.#delete(ref, signal);
	}

	/**
	 * Moves the deadline to now + ttlMs, never earlier and never past the most the labels file holds (create's time plus
	 * the cap): Orgo's end first, in whole hours with an Idempotency-Key, so it never ends the computer before init does;
	 * then init's deadline; then the name's, from the time init took; then the labels file. The result is the deadline
	 * init took. A computer's extends are taken in turn: each reads the deadline the one before it left, so a shorter one
	 * is refused as earlier, never renaming the computer back to an earlier deadline the janitor would trust.
	 */
	extend(ref: ComputerRef, ttlMs: number, context: CallContext = {}): Promise<Result<{ deadline: Date }>> {
		const key = typeof ref?.id === "string" ? ref.id : "";
		const before = this.#extending.get(key) ?? Promise.resolve();
		const turn = before.then(() => this.#extend(ref, ttlMs, context));
		const settled = turn.then(
			() => undefined,
			() => undefined,
		);
		this.#extending.set(key, settled);
		void settled.then(() => {
			if (this.#extending.get(key) === settled) this.#extending.delete(key);
		});
		return turn;
	}

	async #extend(ref: ComputerRef, ttlMs: number, { signal }: CallContext = {}): Promise<Result<{ deadline: Date }>> {
		const problem = refProblem(ref);
		if (problem) return fail("invalid", problem);
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return fail("invalid", "extend takes ttlMs, a whole number of milliseconds above 0");
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		if (found.value.status !== "running") return fail("refused", `${ref.name} is ${found.value.status}, not running`);
		const file = await this.#readLabels(ref, signal);
		if (!file.ok) return file;
		const most = Date.parse(file.value.maxDeadline);
		const current = Date.parse(file.value.deadline);
		const target = Date.now() + ttlMs;
		if (Number.isNaN(most) || target > most) return fail("limit", `${new Date(target).toISOString()} is past ${file.value.maxDeadline}, the most this computer may live`);
		// An extend never shortens a computer's life: one that would is refused in words, and nothing moves.
		if (target < current) return fail("refused", `${new Date(target).toISOString()} is earlier than ${ref.name}'s deadline ${file.value.deadline}: an extend never moves it earlier; nothing moved`);
		if (target === current) return ok({ deadline: new Date(current) });
		const end = typeof found.value.ends_at === "string" ? Date.parse(found.value.ends_at) : Number.NaN;
		if (!Number.isNaN(end) && end < target) {
			const hours = Math.ceil((target - end) / HOUR);
			const moved = await this.#rest.request("POST", `/computers/${encodeURIComponent(ref.id)}/extend`, { body: { hours }, headers: { "idempotency-key": randomUUID() }, timeoutMs: this.#timeouts.requestMs, ...(signal ? { signal } : {}) });
			if (!moved.ok) return fail(moved.error.code, `Orgo's end did not move, so nothing did: ${moved.error.message}`);
		}
		// Init's deadline next, then the janitor's, in the name (a rename, its stable part kept), from the time init took:
		// the name, init and the labels file then agree. A step that fails leaves the janitor ending the computer no later
		// than init, never after it.
		const opened = await this.#open(ref, signal);
		if (!opened.ok) return fail(opened.error.code, `Orgo's end moved, and init's deadline did not: ${opened.error.message}`);
		let took: Date;
		try {
			const at = new Date(target).toISOString();
			const extended = await opened.value.client.call("deadline.extend", { at }, { signal: this.#bounded(this.#timeouts.helloMs, signal) });
			if (!extended.ok) return fail(extended.error.code, `Orgo's end moved, and init's deadline did not: ${extended.error.message}`);
			const answered = Date.parse(extended.value.at);
			took = new Date(Number.isNaN(answered) ? at : answered);
		} finally {
			await opened.value.close();
		}
		// The name's deadline never moves back: a name that already holds this deadline or a later one is kept.
		const parts = nameParts(found.value.name) as { stable: string; deadline?: Date };
		const name = parts.deadline !== undefined && parts.deadline.getTime() >= Math.ceil(took.getTime() / 1000) * 1000 ? found.value.name : withDeadline(parts.stable, took);
		if (name !== found.value.name) {
			const renamed = await this.#rest.request("PATCH", `/computers/${encodeURIComponent(ref.id)}`, { body: { name }, timeoutMs: this.#timeouts.requestMs, ...(signal ? { signal } : {}) });
			if (!renamed.ok) return fail(renamed.error.code, `init's deadline moved to ${took.toISOString()}, and the deadline in ${found.value.name} did not: ${renamed.error.message}`);
		}
		const written = await this.#writeLabels(ref, { ...file.value, name, deadline: took.toISOString() }, signal);
		if (!written.ok) return fail(written.error.code, `init's deadline moved to ${took.toISOString()}, and the labels file did not: ${written.error.message}`);
		return ok({ deadline: took });
	}
}

/**
 * An OrgoProvider from its options alone, its key included: it reads no environment. Serve passes apiKey from its
 * ORGO_API_KEY setting and its workspace; the conformance module reads COMPUTER_ORGO_* (settingsFromEnv).
 */
export function create(options: OrgoProviderOptions): OrgoProvider {
	return new OrgoProvider(options);
}

export type { OrgoChannel, OrgoStart, OrgoStream, OrgoWebSocketFactory } from "./orgo-channel.js";
