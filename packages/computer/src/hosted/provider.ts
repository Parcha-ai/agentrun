// The shared machine-host adapter: hostedProvider(host, options) is a whole ComputerProvider over a vendor's
// MachineHost (../host.ts). The vendor answers create, get, list, delete and exec about its own machines; everything a
// computer is beyond that is here, once, for every vendor: the spec's check, the computer's name from its create's
// request id (one create per request: a retry finds the first), the daemon's upload, install and sha256 read-back,
// the Archil mount, init's start (detached, or the machine's main process on a pid1 host), the stdio bridge, the
// read-back inside the computer (the daemon's credentials and network, the display, the network-none probe), the wait
// for the listing, list and attach, the network (fixed at create), the deadline and extend, delete-then-wait-gone, the
// sweep of a create whose answer never came, and the words of every refusal.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { CreateRequests, endedWords, otherSpecWords } from "../create-requests.js";
import { DESKTOP_GROUPS, type DesktopOptions, desktopOf, startDisplay } from "../desktop.js";
import { COMPUTER_LABEL, DAEMON_IN_COMPUTER, DEADLINE_LABEL, helloDrift, type ProbeReport, probeNetworkDrift, probeNotes, probeReportOf, WORK } from "../drift.js";
import type { HostCall, Machine, MachineHost, MachineRequest } from "../host.js";
import { OWN_NETWORK_ONLY, readOwnNetwork, TOOL_USER } from "../isolation.js";
import { releaseOlder } from "../janitor.js";
import { RUN_LABEL } from "../labels.js";
import { checkMount, type MountReadBack, readBackOf } from "../mount.js";
import {
	ARCHIL_MOUNT_LABEL,
	ARCHIL_TOOL_UID,
	type ArchilMount,
	type ArchilRoot,
	archilLabels,
	archilMount,
	archilRefusals,
	archilRelease,
	claimEpoch,
	mountDrift,
	type ProviderNote,
	type RecordedArchil,
	readArchilMount,
	recordedArchil as recordedArchilOf,
	recordedMount,
	syncingClient,
} from "../mount-archil.js";
import {
	type AttachedComputer,
	type AttachContext,
	type CallContext,
	type ComputerCapabilities,
	type ComputerConnection,
	type ComputerInfo,
	type ComputerProvider,
	type ComputerRef,
	type ComputerSpec,
	type CreateContext,
	type CreatedComputer,
	checkGpu,
	checkTenure,
	type NetworkPolicy,
	type NetworkSpec,
	type Refusal,
	type ReleaseContext,
	type ReleaseHow,
	runLifetimeMs,
} from "../provider.js";
import { type ComputerError, ok, type Result } from "../result.js";
import { daemonWatch, type ScreenWatch, type ScreenWatchHandlers, type WatchOptions } from "../screen-watch.js";
import { countTested } from "../test-connection.js";
import { waitUntil } from "../wait.js";
import { bounded, CALL_SLACK_MS, failOf, hostCall, type Opened, openBridge, pause, race, rootOf, runToExit, seconds, uploadThroughExec, words } from "./process.js";
import { ARCHIL_GATE, type DaemonExpected, daemonDrift, type HostedCommands, hostedCommands, installerOf } from "./scripts.js";

/** The longest each kind of call may take, and the pauses between polls. */
export interface HostedTimeouts {
	/** One control-plane call: get, delete, a timer, a bridge's start. */
	requestMs: number;
	/** The vendor's create, and the wait until the machine runs. */
	createMs: number;
	/** The daemon's upload. */
	uploadMs: number;
	/** The install command, and init's start. */
	execMs: number;
	/** From a connect's start to the daemon's hello, and each read-back call after it. */
	helloMs: number;
	/** The probe, run through the daemon: it takes at most 20 s (10 s to connect, 10 s to answer, every target at once). */
	probeMs: number;
	/** One whole list, every page and every machine's read-back. */
	listMs: number;
	/** From a delete to a machine the vendor no longer has and no longer lists. */
	goneMs: number;
	/** The first pause between two reads while release waits; the pauses double up to 5 s. */
	pollMs: number;
	/** How long create waits for the listing to show the new computer. */
	listedMs: number;
	/**
	 * The listing's stability window: create's wait ends once the listing has shown the new computer on two consecutive
	 * polls, the first of them at least this long before the last, and on every poll between.
	 */
	listedStableMs: number;
	/** Each root step of an Archil mount (the preflight, mount or revoke, serve), and its checkin at release. */
	mountMs: number;
}

export interface HostedOptions {
	/** The vendor's name in words ("E2B"), for refusals and Settings' test. */
	label: string;
	/** desktop: an X server started through the daemon; linux (default): no screen. */
	kind?: "desktop" | "linux";
	/** The display and its X server, for kind desktop. Default Xvfb on :0, 1280x800. */
	desktop?: DesktopOptions;
	/** The longest lifetime check takes; at most facts.maxLifetimeMs, which is its default. */
	maxLifetimeMs?: number;
	/** The daemon binary for the host's arch on this machine. Default this package's dist/computerd-linux-<arch>. */
	daemonPath?: string;
	/**
	 * Who the daemon runs as, uid:gid in numbers, never root. Default 2510:2510 (TOOL_USER), a uid no vendor process
	 * holds: init refuses to start while another process does.
	 */
	daemonUser?: string;
	timeouts?: Partial<HostedTimeouts>;
	/**
	 * The addresses the probe tries, to show none of them answers a computer with network none: host:port over TCP, or
	 * host:port/udp, a DNS query over UDP.
	 */
	probeTargets?: string[];
	/** Told what is no failure of the call it came from: a release that did not let an Archil folder go cleanly. */
	onNote?: ProviderNote;
}

const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const NAME_LABEL = `${COMPUTER_LABEL}.name`;
/** The image create was asked for: a vendor may report another name for it (a template's id). */
export const IMAGE_LABEL = `${COMPUTER_LABEL}.image`;
/** The most extend may move the deadline to: create's time plus the cap, by this machine's clock, as init was given. */
export const MAX_LABEL = `${COMPUTER_LABEL}.max-deadline`;
const NAME = /^computer-[0-9a-f]{12}$/;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const USER = /^(\d+):(\d+)$/;
/** A spec's user, where the host takes one: a uid, or uid:gid, in numbers (a uid alone is its own gid). */
const SPEC_USER = /^(\d+)(?::(\d+))?$/;
const MAX_ID = 4_294_967_294;
const DEFAULTS: HostedTimeouts = {
	requestMs: 30_000,
	createMs: 120_000,
	uploadMs: 120_000,
	execMs: 60_000,
	helloMs: 30_000,
	probeMs: 30_000,
	listMs: 60_000,
	goneMs: 120_000,
	pollMs: 1_000,
	listedMs: 15_000,
	listedStableMs: 1_000,
	mountMs: 120_000,
};
/** The user an Archil computer's tools run as: the image's agentrun-tool, with no sudo and no capability. */
const ARCHIL_USER = `${ARCHIL_TOOL_UID}:${ARCHIL_TOOL_UID}`;
const RELEASE_POLL_MAX_MS = 5_000;
const LISTED_POLL_MS = 150;
const LISTED_ROUNDS = 2;
const LISTED_POLL_MAX_MS = 1_000;
const LISTEN_RETRY_MS = 250;
const START_POLL_MS = 500;
/** The longest a Node timer or AbortSignal.timeout holds. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The longest timeout the adapter takes: the race of a call bounded by it must still fit a Node timer. */
const MAX_TIMEOUT_MS = MAX_TIMER_MS - CALL_SLACK_MS;
const STAGING = "/tmp/agentrun-computerd-";
/**
 * Public anycast resolvers, by address: TCP to 443, and DNS over UDP to 53, the classic path out where TCP is dropped,
 * over IPv4 and IPv6.
 */
const DEFAULT_PROBE_TARGETS = ["1.1.1.1:443", "8.8.8.8:443", "[2606:4700:4700::1111]:443", "1.1.1.1:53/udp", "[2606:4700:4700::1111]:53/udp"];
/** A probe target: host:port, over TCP, or host:port/udp, a DNS query over UDP. */
const TARGET = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}(?:\/udp)?$/;
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "labels", "mount", "gpu", "owner"]);

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));
const policyWords = (policy: NetworkPolicy) => (typeof policy === "string" ? policy : "other" in policy ? policy.other : JSON.stringify(policy));
const alive = (state: Machine["state"]) => state === "running" || state === "stopped" || state === "starting";

/** An ISO time a label holds, or undefined when it is missing or not the ISO time create writes. */
function isoOf(written: string | undefined): Date | undefined {
	const at = written === undefined ? Number.NaN : Date.parse(written);
	return Number.isNaN(at) || new Date(at).toISOString() !== written ? undefined : new Date(at);
}

/**
 * When a machine ends: the deadline create wrote; or, once an extend moved the vendor's own timer past where create set
 * it (the vendor keeps no label change), that end, up to the most the computer may live, which is what init was given.
 */
export function deadlineOf(machine: Pick<Machine, "labels" | "endsAt" | "timerMoved">): Date | undefined {
	const written = isoOf(machine.labels[DEADLINE_LABEL]);
	if (written === undefined) return undefined;
	const end = machine.endsAt instanceof Date ? machine.endsAt.getTime() : Number.NaN;
	if (machine.timerMoved !== true || Number.isNaN(end)) return written;
	const most = isoOf(machine.labels[MAX_LABEL]);
	return new Date(most === undefined ? end : Math.min(end, most.getTime()));
}

/** Only a machine this adapter made counts: its label, a name of its making, and the name asked for when one is. */
export const ours = (labels: Record<string, string> | undefined, name?: string) =>
	labels?.[COMPUTER_LABEL] === "1" && NAME.test(labels[NAME_LABEL] ?? "") && (name === undefined || labels[NAME_LABEL] === name);

/** The Archil mount a computer's agentrun.mount label records, or undefined when it has none. */
function recordedArchil(labels: Record<string, string> | undefined): RecordedArchil | undefined {
	if (labels?.[ARCHIL_MOUNT_LABEL] === undefined) return undefined;
	const mount = recordedMount(labels);
	return recordedArchilOf(labels, mount === undefined ? { other: `the label ${ARCHIL_MOUNT_LABEL} records a mount this provider never makes` } : { mount });
}

function filterProblem(labels: unknown): string | undefined {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return "labels must map names to strings";
	for (const [key, value] of Object.entries(labels)) {
		if (typeof value !== "string") return `the label ${key} must be a string`;
		if (key === "" || key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)} must be a non-empty name with no NUL byte`;
	}
	return undefined;
}

/** A spec's user as uid:gid in numbers, or undefined when it is not one. */
function specUserOf(value: unknown): string | undefined {
	const found = typeof value === "string" ? SPEC_USER.exec(value) : null;
	if (found === null) return undefined;
	const [uid, gid] = [Number(found[1]), Number(found[2] ?? found[1])];
	return uid <= MAX_ID && gid <= MAX_ID ? `${uid}:${gid}` : undefined;
}

/** The caller's labels of a machine: every one but the adapter's own namespace and the Archil mount's. */
const callerLabels = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).filter(([key]) => key !== COMPUTER_LABEL && !key.startsWith(`${COMPUTER_LABEL}.`) && key !== ARCHIL_MOUNT_LABEL));

/** What create made before the machine: its deadlines, its labels, the daemon with its sha256, and its scripts. */
interface Made {
	deadline: string;
	maxDeadline: string;
	labels: Record<string, string>;
	daemon: Buffer;
	sha256: string;
	commands: HostedCommands;
	/** Who the daemon runs as, uid:gid: the provider's daemon user, or the spec's where the host takes one. */
	user: string;
	/** The runtime the host says this request runs (facts.runtime), which the probe's kernel is held to. */
	runtime?: "vm" | "gvisor";
}

type Extend = (ref: ComputerRef, ttlMs: number, context?: CallContext) => Promise<Result<{ deadline: Date }>>;

/** hostedProvider's provider: a ComputerProvider whose vendor is host. */
export class HostedProvider implements ComputerProvider {
	readonly id: string;
	readonly version = VERSION;
	/** The vendor's machines, for the live sweep (conformance/sweep.ts); nothing else reaches past the provider to them. */
	readonly host: MachineHost;
	readonly extend?: Extend;
	readonly #label: string;
	readonly #fail: ReturnType<typeof failOf>;
	readonly #daemonPath: string;
	readonly #kind: "desktop" | "linux";
	readonly #desktop: Required<DesktopOptions> | undefined;
	readonly #maxLifetimeMs: number;
	readonly #uid: string;
	readonly #gid: string;
	readonly #timeouts: HostedTimeouts;
	readonly #probeTargets: string[];
	readonly #onNote: ProviderNote | undefined;
	/** Each create in flight, and the names of the computers this provider ended (create-requests.ts). In memory alone:
	 *  past it, and past this process, the vendor's listing is what holds. */
	readonly #requests = new CreateRequests();
	/** Each computer's last extend, by machine id, while one runs: the next waits for it. */
	readonly #extending = new Map<string, Promise<void>>();

	constructor(host: MachineHost, options: HostedOptions) {
		const {
			label,
			kind = "linux",
			desktop = {},
			maxLifetimeMs = host.facts.maxLifetimeMs,
			daemonPath = fileURLToPath(new URL(`../computerd-linux-${host.facts.arch}`, import.meta.url)),
			daemonUser = TOOL_USER,
			timeouts = {},
			probeTargets = DEFAULT_PROBE_TARGETS,
			onNote,
		} = options;
		this.id = host.id;
		this.host = host;
		this.#label = label;
		this.#fail = failOf(host);
		this.#onNote = onNote;
		if (kind !== "desktop" && kind !== "linux") throw new Error(`kind is desktop or linux, not ${String(kind)}`);
		if (!isWhole(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > host.facts.maxLifetimeMs) {
			throw new Error(`maxLifetimeMs must be a whole number of ms above 0 and at most ${host.facts.maxLifetimeMs} ms, the longest ${label} keeps a computer`);
		}
		const user = USER.exec(daemonUser);
		if (user === null || Number(user[1]) > MAX_ID || Number(user[2]) > MAX_ID) throw new Error(`the daemon user ${daemonUser} must be uid:gid in numbers, such as 1000:1000`);
		// The numbers, not the text: "00" is root as much as "0" is.
		if (Number(user[1]) === 0 || Number(user[2]) === 0) throw new Error(`the daemon user ${daemonUser} is root or in root's group; ${a(label)} computer's daemon runs as neither`);
		const merged = { ...DEFAULTS, ...timeouts };
		// AbortSignal.timeout and Node's timers take whole ms up to 2^31 - 1 (a fraction throws, a longer one fires at
		// once), and a call's race adds CALL_SLACK_MS to its bound: refused here, before any machine exists. The listing's
		// stability window alone may be 0: two consecutive polls, with no time between them asked for.
		for (const [key, value] of Object.entries(merged)) {
			const zero = key === "listedStableMs";
			if (!isWhole(value) || value < (zero ? 0 : 1) || value > MAX_TIMEOUT_MS) throw new Error(`timeouts.${key} must be a whole number of ms ${zero ? "0 or more" : "above 0"} and at most ${MAX_TIMEOUT_MS}, not ${value}`);
		}
		if (!Array.isArray(probeTargets) || probeTargets.length === 0 || probeTargets.some((target) => typeof target !== "string" || !TARGET.test(target))) {
			throw new Error("probeTargets must name at least one address for the probe, each host:port or host:port/udp");
		}
		this.#daemonPath = resolve(daemonPath);
		this.#kind = kind;
		this.#desktop = kind === "desktop" ? desktopOf(desktop) : undefined;
		this.#maxLifetimeMs = maxLifetimeMs;
		[this.#uid, this.#gid] = [String(Number(user[1])), String(Number(user[2]))];
		this.#timeouts = merged;
		this.#probeTargets = [...probeTargets];
		// Extend only where the deadline can follow it: the vendor's timer moved, or the janitor's label.
		const { lifetime } = host.facts;
		if ((lifetime === "vendor" && host.setTimer) || (lifetime === "janitor" && host.setLabels)) this.extend = (ref, ttlMs, context) => this.#extendSerial(ref, ttlMs, context?.signal);
	}

	/** The computer's facts, from the host's and the adapter's options alone. */
	capabilities(): ComputerCapabilities {
		const { facts } = this.host;
		return {
			kind: this.#kind,
			lifetime: facts.lifetime,
			network: [...facts.network],
			networkReadBack: facts.networkReadBack,
			isolation: facts.isolation,
			os: "linux",
			daemon: facts.daemon,
			groups: ["exec", "files", "processes", ...(this.#desktop ? DESKTOP_GROUPS : [])],
			maxLifetimeMs: this.#maxLifetimeMs,
			release: [...facts.release],
			...(facts.stopDeletes === undefined ? {} : { stopDeletes: facts.stopDeletes }),
			...(facts.mounts === undefined ? {} : { mount: [...facts.mounts] }),
			vendorAgentPorts: [...facts.vendorAgentPorts],
			...(facts.gpu === undefined ? {} : { gpu: structuredClone(facts.gpu) }),
			...(facts.user === undefined ? {} : { user: [...facts.user] }),
		};
	}

	check(spec: ComputerSpec): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const given = (typeof spec === "object" && spec !== null ? spec : {}) as unknown as Record<string, unknown>;
		const { image, network, labels, mount } = given;
		const capabilities = this.capabilities();
		const label = this.#label;
		refusals.push(...checkMount(mount, capabilities.mount ?? []), ...archilRefusals(given as unknown as ComputerSpec));
		const daemonUser = `${this.#uid}:${this.#gid}`;
		const archil = (mount as { kind?: unknown } | undefined)?.kind === "archil";
		const asked = this.#takesUser() ? given.user : undefined;
		if (asked !== undefined) {
			const user = specUserOf(asked);
			if (user === undefined) refuse("user", "user must be a uid or uid:gid in numbers, such as 1000:1000; a name is refused, since the image may not have it");
			else if (user.startsWith("0:") && !(this.host.facts.user ?? []).includes("root")) {
				refuse(
					"user",
					`${a(label)} computer does not run as root: each connection is the vendor's exec of the daemon's stdio bridge, as the vendor's root, outside the daemon, and a root computer user, though init leaves it no capability, owns the directories above the daemon, so it could replace what that exec runs; ask for another uid, such as 1000:1000`,
				);
			} else if (archil && user !== ARCHIL_USER) {
				refuse("user", `a computer with an Archil mount runs its tools as agentrun-tool, ${ARCHIL_USER}, the user its image makes with no way to root; leave user unset or ask for ${ARCHIL_USER}`);
			}
		} else if (archil && daemonUser !== ARCHIL_USER) {
			refuse(
				"mount",
				`a computer with an Archil mount runs its tools as agentrun-tool, ${ARCHIL_USER}, the user its image makes with no way to root; this provider's daemon user is ${daemonUser}: make it with daemonUser ${ARCHIL_USER}`,
			);
		}
		if (typeof image !== "string" || image === "" || image.includes("\0")) refuse("image", `an image is required: the name of ${a(label)} image`);
		refusals.push(...checkTenure(given, capabilities, label));
		if (network === "open" || (typeof network === "object" && network !== null && "allow" in network)) refuse("network", OWN_NETWORK_ONLY);
		else if (network !== "none") refuse("network", 'network is required: "none"');
		if (labels !== undefined) {
			const entries = typeof labels === "object" && labels !== null && !Array.isArray(labels) ? Object.entries(labels) : undefined;
			const bad = entries === undefined ? "labels must map names to strings" : (entries.map(([key, value]) => labelProblem(key, value, this.host.facts.labelRules?.key)).find(Boolean) ?? this.#labelCount(entries.length, mount));
			if (bad) refuse("labels", bad);
		}
		refusals.push(...checkGpu(given.gpu, capabilities, mount));
		const taken = new Set<string>(this.host.facts.specFields ?? []);
		for (const [field, value] of Object.entries(given)) {
			if (SPEC_FIELDS.has(field) || taken.has(field) || value === undefined) continue;
			if (field === "cpus" || field === "memoryMb" || field === "pids") refuse(field, `${a(label)} computer has the size of its image: name an image of the size you need, not ${field}`);
			else if (field === "user") refuse(field, `${a(label)} computer's daemon runs as the provider's daemon user (${daemonUser}), never as one a spec names`);
			else if (field === "workdir") refuse(field, `${a(label)} computer works in ${WORK}, its home; a spec cannot name another`);
			else refuse(field, `${a(label)} computer does not support ${field}`);
		}
		if (this.host.check) refusals.push(...this.host.check(spec));
		return refusals;
	}

	/** Whether the host takes a spec's user (facts.specFields): then a computer's daemon runs as the one a spec names. */
	#takesUser(): boolean {
		return (this.host.facts.specFields ?? []).includes("user");
	}

	/** Who one create's daemon runs as, uid:gid: the spec's user where the host takes one, else the provider's daemon user. */
	#userOf(spec: ComputerSpec): string {
		return (this.#takesUser() ? specUserOf(spec.user) : undefined) ?? `${this.#uid}:${this.#gid}`;
	}

	/** Why a spec's labels, with the adapter's own, are more than the vendor takes; undefined when they fit. */
	#labelCount(count: number, mount: unknown): string | undefined {
		const max = this.host.facts.labelRules?.max;
		if (max === undefined) return undefined;
		const own = 5 + ((mount as { kind?: unknown } | undefined)?.kind === "archil" ? Object.keys(archilLabels({ kind: "archil", disk: "d", region: "r", folder: "f", token: "t" } as ArchilMount)).length : 0);
		return count + own > max ? `${a(this.#label)} computer takes ${max} labels, ${own} of them the provider's own: ${count} is ${count + own - max} too many` : undefined;
	}

	/** A host call bounded by ms, the caller's signal when given. */
	#call<T>(what: string, run: (ctx: HostCall) => Promise<Result<T>>, ms: number, signal?: AbortSignal): Promise<Result<T>> {
		return hostCall(this.host, what, run, ms, signal);
	}

	/**
	 * Makes a computer, once per request: context.requestId names it (computerNameFor), and a create of a request already made
	 * finds that computer instead of making another. One still starting is waited for (within createMs); one up is
	 * returned once its labels and daemon read back as attach reads them, else refused as exists; one that ended (or
	 * that this provider gave up on) is refused as exists, in words. A second create of a request still in flight waits
	 * for the first and answers what it does.
	 */
	async create(spec: ComputerSpec, context: CreateContext): Promise<Result<CreatedComputer>> {
		const refusals = this.check(spec);
		return this.#requests.create(spec, context, {
			refuse: (code, message) => this.#fail(code, message),
			...(refusals.length > 0 ? { refused: refusals.map(({ field, message }) => `${field}: ${message}`).join("; ") } : {}),
			// The checks #again makes of a computer listed already, made here of the spec in flight: what it gives is shared
			// only with a create that asks the same.
			differ: (asked, inFlight, name) => this.#inFlightDiffer(asked, inFlight, name),
			make: (name) => this.#createOnce(spec, name, context.signal),
		});
	}

	/** A request's computer given up on or deleted: its request is refused from now on. */
	#end(name: string): void {
		this.#requests.end(name);
	}

	/** How spec's labels differ from labels, a computer's of this request (seen: "read back", or "in flight"), in words. */
	#labelDiffer(spec: ComputerSpec, name: string, labels: Record<string, string>, seen: string): string[] {
		const asked = this.#labelsOf(spec, name, labels[DEADLINE_LABEL] ?? "", labels[MAX_LABEL] ?? "");
		const differ = Object.entries(asked)
			.filter(([key, value]) => key !== DEADLINE_LABEL && key !== MAX_LABEL && labels[key] !== value)
			.map(([key, value]) => `label ${key}: asked ${show(value)}, ${seen} ${show(labels[key])}`);
		const extra = Object.keys(callerLabels(labels)).filter((key) => !Object.hasOwn(asked, key));
		if (extra.length > 0) differ.push(`labels ${extra.join(", ")}: ${seen}, never asked for`);
		return differ;
	}

	/**
	 * How spec differs from pending, the spec of a create of the same request still in flight: the labels and the user,
	 * as #again holds a listed computer to them, and every other field the host is given (facts.specFields, gpu), which
	 * the spec in flight holds exactly.
	 */
	#inFlightDiffer(spec: ComputerSpec, pending: ComputerSpec, name: string): string[] {
		const differ = this.#labelDiffer(spec, name, this.#labelsOf(pending, name, "", ""), "in flight");
		const [asked, flying] = [this.#userOf(spec), this.#userOf(pending)];
		if (asked !== flying) differ.push(`user: asked ${asked}, in flight ${flying}`);
		const taken = new Set<string>(this.host.facts.specFields ?? []);
		for (const field of ["cpus", "memoryMb", "workdir", "gpu"] as const) {
			if ((field === "gpu" || taken.has(field)) && !isDeepStrictEqual(spec[field], pending[field])) differ.push(`${field}: asked ${show(spec[field])}, in flight ${show(pending[field])}`);
		}
		return differ;
	}

	async #createOnce(spec: ComputerSpec, name: string, signal?: AbortSignal): Promise<Result<CreatedComputer>> {
		const { listMs } = this.#timeouts;
		const listed = await this.#call("the listing by the request's name", (ctx) => this.host.list({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: name }, ctx), listMs, signal);
		if (!listed.ok) return listed;
		const found = listed.value.filter((machine) => ours(machine.labels, name));
		if (found.length > 1) return this.#fail("exists", `${found.length} machines carry the name ${name} (${found.map((m) => m.id).join(", ")}): create with a new request id`);
		if (found.length === 1) return this.#again(spec, name, found[0] as Machine, signal);
		const launched = await this.#launch(spec, name, signal);
		if (!launched.ok) return launched;
		const { ref, made } = launched.value;
		// From here the machine exists: every step takes the caller's signal, and a failure or an abort deletes it.
		// Another provider instance's create of this request may have made one too (#converge): the oldest is kept.
		const first = await this.#converge(name, ref.id, signal);
		if (first.ok && first.value !== undefined && first.value.id !== ref.id) return this.#again(spec, name, first.value, signal);
		const prepared = await this.#prepare(spec, ref, made, signal);
		if (signal?.aborted) return this.#abandon(ref, { code: "aborted", message: "create was aborted" }, signal);
		if (!prepared.ok) {
			// A create of this request on another instance, whose machine is older, deletes this one under it: answer that one.
			const kept = await this.#converge(name, ref.id, signal);
			if (kept.ok && kept.value !== undefined && kept.value.id !== ref.id) {
				await this.#kill(ref.id);
				return this.#again(spec, name, kept.value, signal);
			}
			return this.#abandon(ref, prepared.error, signal);
		}
		// The last read of the name, once this machine is listed: one made by another instance and listed only now is
		// settled here, the oldest kept and every other deleted.
		const last = await this.#converge(name, ref.id, signal);
		if (!last.ok) return this.#abandon(ref, last.error, signal, true);
		if (last.value !== undefined && last.value.id !== ref.id) return this.#again(spec, name, last.value, signal);
		return ok(prepared.value.length > 0 ? { ...ref, notes: prepared.value } : ref);
	}

	/**
	 * The one machine a request keeps. Two creates of one request on two provider instances can both find no machine by
	 * the name and both make one: #requests holds within one instance alone, and a vendor's name or label need not be
	 * unique. So after the vendor's answer the name's listing is read, with mine (read by get when not yet listed): where
	 * more than one machine holds the name, the oldest (createdAt, or the lowest id where any has none) is kept, and every
	 * other is deleted and read back gone, its Archil folder let go first. Every instance picks the same one from the
	 * same listing. Its value is the machine kept, or undefined when mine holds the name alone (or nothing is listed yet).
	 */
	async #converge(name: string, mine: string, signal?: AbortSignal): Promise<Result<Machine | undefined>> {
		const listed = await this.#call("the listing by the request's name", (ctx) => this.host.list({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: name }, ctx), this.#timeouts.listMs, signal);
		if (!listed.ok) return listed;
		const holders = listed.value.filter((machine) => ours(machine.labels, name) && alive(machine.state));
		if (!holders.some((machine) => machine.id !== mine)) return ok(undefined);
		if (!holders.some((machine) => machine.id === mine)) {
			const read = await this.#get(mine, signal);
			if (read.ok && read.value !== undefined && alive(read.value.state)) holders.push(read.value);
		}
		const [kept, ...others] = holders.sort(oldestFirst(holders));
		for (const other of others) {
			const gone = await this.#discard(other, signal);
			if (!gone.ok) return this.#fail(gone.error.code, `${holders.length} machines carry the name ${name}: ${kept?.id}, the oldest, is kept, and ${other.id} could not be deleted (${gone.error.message})`);
		}
		return ok(kept);
	}

	/** A machine create does not keep, deleted and read back gone; a running Archil computer lets go of its folder first. */
	async #discard(machine: Machine, signal?: AbortSignal): Promise<Result<void>> {
		const ref = { id: machine.id, name: machine.labels[NAME_LABEL] as string };
		if (recordedArchil(machine.labels) !== undefined && machine.state === "running") {
			const letGo = await this.#letGo(ref, signal);
			if (!letGo.ok) this.#onNote?.({ computer: ref.name, note: `${machine.id}, a second machine of one request, was deleted, and ${letGo.error.message}` });
		}
		const killed = await this.#kill(machine.id);
		return killed.ok ? this.#settle(ref, signal) : killed;
	}

	/** A create of a request whose computer is listed already: the same create, the computer as it is; see create. */
	async #again(spec: ComputerSpec, name: string, first: Machine, signal?: AbortSignal): Promise<Result<CreatedComputer>> {
		const until = Date.now() + this.#timeouts.createMs;
		let machine: Machine | undefined = first;
		let last: { code: ComputerError["code"]; message: string } | undefined;
		for (;;) {
			if (machine === undefined || !alive(machine.state) || machine.state === "stopped") return this.#fail("exists", endedWords(name));
			const deadline = deadlineOf(machine);
			if (deadline !== undefined && deadline.getTime() <= Date.now()) return this.#fail("exists", endedWords(name));
			if (machine.state === "running") {
				const differ = this.#labelDiffer(spec, name, machine.labels, "read back");
				if (differ.length > 0) return this.#fail("exists", otherSpecWords(name, "was made", differ));
				const attached = await this.#attached(machine, signal);
				if (attached.ok && attached.value.spec.user !== this.#userOf(spec)) {
					return this.#fail("exists", otherSpecWords(name, "was made", [`user: asked ${this.#userOf(spec)}, read back ${attached.value.spec.user}`]));
				}
				if (attached.ok) return ok({ id: attached.value.id, name: attached.value.name, ...(attached.value.notes ? { notes: attached.value.notes } : {}) });
				if (attached.error.code === "aborted") return attached;
				// Its daemon is not up yet, or not yet as declared (a desktop whose display the first create is still
				// starting): the first create is still making it. A refusal that holds past createMs is exists.
				last = attached.error;
			}
			if (Date.now() + this.#startPollMs() >= until) {
				const within = seconds(this.#timeouts.createMs);
				if (last?.code === "refused") return this.#fail("exists", `${name} was made for this request, and after ${within} still ${last.message}`);
				return this.#fail("timeout", `${name}, made for this request, was not up within ${within}${last ? `: ${last.message}` : ""}`);
			}
			await pause(this.#startPollMs(), signal);
			if (signal?.aborted) return this.#fail("aborted", `create was aborted while ${name}, made for this request, came up`);
			const read = await this.#get(first.id, signal);
			if (!read.ok) return read;
			machine = read.value;
		}
	}

	/** The labels create gives a computer: the caller's, the adapter's own, and an Archil mount's (never its token). */
	#labelsOf(spec: ComputerSpec, name: string, deadline: string, maxDeadline: string): Record<string, string> {
		return {
			...spec.labels,
			[COMPUTER_LABEL]: "1",
			[NAME_LABEL]: name,
			[DEADLINE_LABEL]: deadline,
			[IMAGE_LABEL]: spec.image,
			[MAX_LABEL]: maxDeadline,
			...(spec.mount?.kind === "archil" ? archilLabels(spec.mount) : {}),
		};
	}

	/** Everything create does up to the vendor's answer: the daemon read, the machine made, by its request. */
	async #launch(spec: ComputerSpec, name: string, signal?: AbortSignal): Promise<Result<{ ref: ComputerRef; made: Made }>> {
		let daemon: Buffer;
		try {
			daemon = readFileSync(this.#daemonPath);
		} catch {
			return this.#fail("not_found", `no daemon binary at ${this.#daemonPath}: run npm run build:daemon -w @parcha/agentrun-computer`);
		}
		const sha256 = createHash("sha256").update(daemon).digest("hex");
		if (signal?.aborted) return this.#fail("aborted", `create was aborted before ${this.#label} was called`);
		const now = Date.now();
		const lifetimeMs = runLifetimeMs(spec);
		const deadline = new Date(now + lifetimeMs).toISOString();
		const maxDeadline = new Date(now + this.#maxLifetimeMs).toISOString();
		const labels = this.#labelsOf(spec, name, deadline, maxDeadline);
		const archil = spec.mount?.kind === "archil";
		const user = this.#userOf(spec);
		const commands = hostedCommands({
			staging: `${STAGING}${randomBytes(8).toString("hex")}`,
			deadline,
			user,
			display: this.#desktop?.display ?? "",
			maxDeadline,
			atomic: this.host.facts.daemon === "pid1",
			sha256,
			// This create's own: the entrypoint starts the daemon whose marker holds it, never one the image had.
			nonce: randomBytes(16).toString("hex"),
			waitS: Math.ceil((this.#timeouts.createMs + this.#timeouts.uploadMs + this.#timeouts.execMs + (archil ? this.#timeouts.mountMs * 3 : 0)) / 1000),
			...(archil && this.host.facts.daemon === "pid1" ? { gate: ARCHIL_GATE } : {}),
		});
		const taken = new Set(this.host.facts.specFields ?? []);
		const request: MachineRequest = {
			name,
			image: spec.image,
			labels,
			...(this.host.facts.lifetime === "vendor" ? { lifetimeMs } : {}),
			// An Archil computer's root reaches Archil, so its vendor network is open: its tools' none is init's own, read
			// back by the probe from inside, as the tool user, like every network none here.
			network: archil ? "open" : "none",
			...(this.host.facts.daemon === "pid1" ? { command: commands.entrypoint } : {}),
			...(spec.gpu === undefined ? {} : { gpu: spec.gpu }),
			...(taken.has("cpus") && spec.cpus !== undefined ? { cpus: spec.cpus } : {}),
			...(taken.has("memoryMb") && spec.memoryMb !== undefined ? { memoryMb: spec.memoryMb } : {}),
			...(taken.has("workdir") && spec.workdir !== undefined ? { workdir: spec.workdir } : {}),
			...(taken.has("user") && spec.user !== undefined ? { user } : {}),
		};
		const runtime = this.host.facts.runtime?.(request);
		const { createMs } = this.#timeouts;
		// Never cancelled, only raced: an aborted call could leave a machine made whose id never came back.
		let creating: Promise<Result<{ id: string }>>;
		try {
			creating = Promise.resolve(this.host.create(request, { timeoutMs: createMs }));
		} catch (error) {
			return this.#fail(this.host.errorCode(error), `${this.#label}'s create failed: ${words(error)}`);
		}
		const raced = await race(this.host, creating, `${this.#label}'s create`, createMs + CALL_SLACK_MS, signal);
		const created: Result<{ id: string }> = raced.ok ? raced.value : raced;
		if (!created.ok) {
			const { code, message } = created.error;
			if (code === "aborted" || code === "timeout") {
				// One that lands is deleted by its id; one whose answer never comes, by its name.
				this.#end(name);
				creating.then(
					async (made) => void (made.ok ? await this.#kill(made.value.id) : await this.#deleteNamed(name)),
					async () => void (await this.#deleteNamed(name)),
				);
				return this.#fail(code, `${message}; a machine it makes after this is deleted as it lands, and ${this.#label} ends it by ${deadline} either way`);
			}
			// A create the vendor refused made nothing. One that failed otherwise may have: it goes by its name.
			if (["invalid", "denied", "limit", "not_found", "refused", "unauthorized", "exists"].includes(code)) return created;
			this.#end(name);
			const swept = await this.#deleteNamed(name);
			return this.#fail(code, `${this.#label} did not create the machine: ${message}${swept}`);
		}
		this.#requests.made(name);
		return ok({ ref: { id: created.value.id, name }, made: { deadline, maxDeadline, labels, daemon, sha256, commands, user, ...(runtime === undefined ? {} : { runtime }) } });
	}

	/** Deletes a machine create gives up on, then waits, under the caller's signal, until the vendor reads it gone. */
	async #abandon(ref: ComputerRef, error: { code: ComputerError["code"]; message: string; vendor?: string }, signal?: AbortSignal, mounted = false): Promise<Result<never>> {
		this.#end(ref.name);
		// A computer create made whole (its Archil folder mounted) lets go of the folder first, as release does.
		if (mounted) {
			const read = await this.#get(ref.id);
			if (read.ok && read.value !== undefined && recordedArchil(read.value.labels) !== undefined && read.value.state === "running") await this.#letGo(ref, signal);
		}
		const killed = await this.#kill(ref.id);
		const gone = killed.ok ? await this.#settle(ref, signal) : killed;
		const after = gone.ok
			? "was deleted"
			: killed.ok && gone.error.code === "aborted"
				? `was deleted, and the wait for it to go was aborted; ${this.#label} ends it at its deadline if the delete did not take`
				: `could not be deleted (${gone.error.message}); it ends at its deadline`;
		return this.#fail(error.code, `the computer ${ref.name} ${after}: ${error.message}`);
	}

	/**
	 * Every machine carrying a name create gave, deleted and read back gone: for a create whose answer never came. The
	 * listing shows a new machine a moment after the vendor makes it, so it is read for the name until one shows or
	 * listedMs passes. Best effort, in words.
	 */
	async #deleteNamed(name: string): Promise<string> {
		const { listedMs, pollMs, listMs } = this.#timeouts;
		const until = Date.now() + listedMs;
		let found: Machine[];
		for (;;) {
			const listed = await this.#call("the listing by name", (ctx) => this.host.list({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: name }, ctx), listMs);
			if (!listed.ok) return `; a machine named ${name} may be left (${listed.error.message}), which ends at its deadline`;
			found = listed.value.filter((machine) => ours(machine.labels, name));
			if (found.length > 0 || Date.now() >= until) break;
			await pause(Math.min(LISTED_POLL_MS, pollMs));
		}
		if (found.length === 0) return `; no machine named ${name} was listed within ${seconds(listedMs)}, and any it made ends at its deadline`;
		const said: string[] = [];
		for (const machine of found) {
			const killed = await this.#kill(machine.id);
			const gone = killed.ok ? await this.#settle({ id: machine.id, name }) : killed;
			said.push(gone.ok ? `${machine.id} was deleted and read back gone` : `${machine.id} may be left (${gone.error.message}), which ends at its deadline`);
		}
		return `; the machine named ${name} it made: ${said.join("; ")}`;
	}

	/** The host's delete, never signalled: a delete that cleans up after an abort must outlive it. Not found is done. */
	async #kill(id: string): Promise<Result<void>> {
		const killed = await this.#call(`the delete of ${id}`, (ctx) => this.host.delete(id, ctx), this.#timeouts.requestMs);
		return killed.ok || killed.error.code === "not_found" ? ok(undefined) : killed;
	}

	/** The pause between two reads of a machine that is starting: the next read comes after it, within createMs. */
	#startPollMs(): number {
		return Math.min(START_POLL_MS, this.#timeouts.pollMs * 10);
	}

	/** The host's get, bounded by requestMs. */
	#get(id: string, signal?: AbortSignal): Promise<Result<Machine | undefined>> {
		return this.#call(`the read of ${id}`, (ctx) => this.host.get(id, ctx), this.#timeouts.requestMs, signal);
	}

	/** The machine running, read while it starts (within createMs); gone or failed is refused in words. */
	async #running(ref: ComputerRef, signal?: AbortSignal): Promise<Result<Machine>> {
		const until = Date.now() + this.#timeouts.createMs;
		for (;;) {
			const read = await this.#get(ref.id, signal);
			if (!read.ok) return read;
			const machine = read.value;
			if (machine === undefined) return this.#fail("gone", `${ref.name} was gone before it ran`);
			if (machine.state === "failed") return this.#fail("vendor", `${this.#label} could not start ${ref.name}${machine.why ? `: ${machine.why}` : ""}`);
			if (machine.state !== "starting") return ok(machine);
			if (Date.now() + this.#startPollMs() >= until) return this.#fail("timeout", `${ref.name} did not start within ${seconds(this.#timeouts.createMs)}`);
			await pause(this.#startPollMs(), signal);
			if (signal?.aborted) return this.#fail("aborted", "create was aborted while the machine started");
		}
	}

	/** Every way a machine, as the vendor reads it back, differs from what create asked for. Pure: no call. */
	#machineDrift(spec: ComputerSpec, machine: Machine, labels: Record<string, string>): string[] {
		const found = [...(machine.drift ?? [])];
		for (const [key, value] of Object.entries(labels)) if (machine.labels[key] !== value) found.push(`label ${key}: declared ${show(value)}, read back ${show(machine.labels[key])}`);
		if (this.host.facts.networkReadBack) {
			// An Archil computer's vendor network is open, for root to reach Archil; its tools' none is read from inside.
			const archil = spec.mount?.kind === "archil";
			const vendor: NetworkPolicy = archil ? "open" : spec.network;
			const network = machine.network ?? { other: `${this.#label} read no network back` };
			if (network !== vendor) found.push(`network: declared ${policyWords(vendor)}${archil ? ` (${this.#label}'s, for root to reach Archil)` : ""}, read back ${policyWords(network)}`);
		}
		if (machine.state !== "running") found.push(`state: declared "running", read back ${show(machine.state)}`);
		// No extend has run on a machine create just made: a timer that reads moved ends it later than its spec.
		if (machine.timerMoved === true) found.push(`timer: declared the spec's lifetime, read back an end of ${machine.endsAt instanceof Date ? machine.endsAt.toISOString() : "nothing"}, later than create set it`);
		return found;
	}

	/**
	 * Everything between the vendor's answer and a computer that passed the read-back, whose value is what the read-back
	 * recorded that does not refuse it (notes).
	 */
	async #prepare(spec: ComputerSpec, ref: ComputerRef, { labels, daemon, sha256, commands, user, runtime }: Made, signal?: AbortSignal): Promise<Result<string[]>> {
		const { uploadMs, execMs, requestMs } = this.#timeouts;
		const running = await this.#running(ref, signal);
		if (!running.ok) return running;
		if (this.host.prepare) {
			const prepare = this.host.prepare.bind(this.host);
			const prepared = await this.#call(`${this.#label}'s settings of ${ref.name}`, (ctx) => prepare(ref.id, ctx), requestMs, signal);
			if (!prepared.ok) return prepared;
		}
		const drift = this.#machineDrift(spec, running.value, labels);
		if (drift.length > 0) return this.#fail("refused", `it did not match its spec: ${drift.join("; ")}`);
		const staging = commands.install[4] as string;
		const bytes = new Uint8Array(daemon.buffer, daemon.byteOffset, daemon.byteLength);
		const upload = this.host.upload?.bind(this.host);
		const uploaded = upload
			? await this.#call(`the daemon's upload into ${ref.name}`, (ctx) => upload(ref.id, staging, bytes, ctx), uploadMs, signal)
			: await uploadThroughExec(this.host, ref.id, staging, bytes, uploadMs, signal);
		if (!uploaded.ok) return this.#fail(uploaded.error.code, `the daemon's upload was refused: ${uploaded.error.message}`);
		const install = await runToExit(this.host, ref.id, commands.install, { ms: execMs, ...(signal ? { signal } : {}), what: `the daemon's install in ${ref.name}` });
		if (!install.ok) return install;
		const printed = `${install.value.stdout} ${install.value.stderr}`.trim();
		if (install.value.exitCode !== 0) return this.#fail("refused", `installing the daemon failed (exit ${install.value.exitCode}): ${printed.slice(0, 500)}`);
		const read = /^sha256 ([0-9a-f]{64})$/m.exec(install.value.stdout)?.[1];
		if (read !== sha256) return this.#fail("refused", `it did not match its spec: daemon: uploaded sha256 ${sha256}, the installed binary reads back ${show(read)}`);
		// Who installed it, for the create's notes: root, or the image's user through passwordless sudo.
		const installer = installerOf(install.value.stdout);
		// The run's folder, after the daemon is in place (serve runs it) and before init starts: no tool program runs before
		// it is mounted. A folder mounted for a computer create then gives up on is let go before the delete, never signalled.
		const started = async () => {
			const done = await this.#start(spec, ref, commands, { user, ...(runtime === undefined ? {} : { runtime }) }, signal);
			return done.ok && installer !== undefined ? ok([installer, ...done.value]) : done;
		};
		if (spec.mount?.kind !== "archil") return started();
		const root = rootOf(this.host, ref.id, ref.name);
		const mounted = await this.#mountArchil(root, ref, { mount: spec.mount, run: spec.labels?.[RUN_LABEL] as string, epoch: claimEpoch(spec.labels) }, signal);
		if (!mounted.ok) return mounted;
		if (this.host.facts.daemon === "pid1") {
			// The entrypoint waits for this gate as well as the daemon: init starts once the folder is there.
			const gated = await root.run(["sh", "-c", 'touch "$1"', "sh", ARCHIL_GATE], { timeoutMs: execMs, ...(signal ? { signal } : {}) });
			if (!gated.ok || gated.value.exitCode !== 0) {
				await archilRelease({ root, client: undefined, timeoutMs: this.#timeouts.mountMs });
				return gated.ok ? this.#fail("refused", `the Archil gate was not made (exit ${gated.value.exitCode}): ${gated.value.output.trim().slice(0, 300)}`) : gated;
			}
		}
		const done = await started();
		if (!done.ok || signal?.aborted) await archilRelease({ root, client: undefined, timeoutMs: this.#timeouts.mountMs });
		return done;
	}

	/** The rest of #prepare from the daemon's install on: init started, its first connection checked, the listing waited for. */
	async #start(spec: ComputerSpec, ref: ComputerRef, commands: HostedCommands, want: Expected, signal?: AbortSignal): Promise<Result<string[]>> {
		if (this.host.facts.daemon === "child") {
			const init = await runToExit(this.host, ref.id, commands.start, { ms: this.#timeouts.execMs, ...(signal ? { signal } : {}), what: `starting the daemon in ${ref.name}` });
			if (!init.ok) return init;
			if (init.value.exitCode !== 0) return this.#fail("refused", `starting the daemon failed (exit ${init.value.exitCode}): ${`${init.value.stdout} ${init.value.stderr}`.trim().slice(0, 500)}`);
		}
		const opened = await this.#openWhenListening(ref, signal);
		if (!opened.ok) {
			if (opened.error.code === "aborted") return opened;
			const why = await this.#initWords(ref);
			return this.#fail(opened.error.code, `the daemon did not answer: ${opened.error.message}${why ? `; init wrote: ${why}` : ""}`);
		}
		let notes: string[];
		try {
			const archil = spec.mount?.kind === "archil" ? { mount: { kind: "archil" as const, disk: spec.mount.disk, region: spec.mount.region, folder: spec.mount.folder }, epoch: claimEpoch(spec.labels) } : undefined;
			const expected = archil === undefined ? undefined : { ...archil, expected: readBackOf({ ...archil.mount, token: "" }, archil.epoch) };
			const inside = await this.#checkInside(opened.value, ref.name, spec.network as "none", true, want, signal, expected);
			if (!inside.ok) return inside;
			notes = inside.value;
		} finally {
			await opened.value.close();
		}
		const listed = await this.#waitListed(ref, signal);
		return listed.ok ? ok(notes) : listed;
	}

	/** What init wrote to its log (child) or the vendor's words of the machine (pid1): the end of it, or nothing. */
	async #initWords(ref: ComputerRef): Promise<string> {
		const { requestMs } = this.#timeouts;
		// A pid1 machine's init is its main process, with no log of start's: the vendor's words of the machine stand for it.
		if (this.host.facts.daemon === "child") {
			const log = await runToExit(this.host, ref.id, hostedCommands().log, { ms: requestMs, what: `reading init's log in ${ref.name}` });
			if (log.ok) return log.value.stdout.trim().slice(-500);
		}
		const read = await this.#get(ref.id);
		return read.ok && read.value?.why ? read.value.why.slice(-500) : "";
	}

	/**
	 * Inside the computer: for a desktop just made, the X server started through the daemon and hello declaring the
	 * display; then the daemon's own report (hello, credentials, home, binary) and, for network none, the probe, which
	 * refuses on an answer and records a silent accept in the notes it returns; and, for an Archil computer, the mount
	 * read back from inside, held to the one expected. want.user is the uid:gid the daemon runs as (undefined: read back,
	 * never root), want.runtime the kernel the probe must report. Its value says what was read back of the mount (mount)
	 * and, through the probe, the user the computer's programs run as (user).
	 */
	async #checkInside(
		connection: ComputerConnection,
		name: string,
		network: NetworkPolicy,
		starting: boolean,
		want: Expected,
		signal?: AbortSignal,
		archil?: RecordedArchil,
	): Promise<Result<string[]> & { mount?: MountReadBack; user?: string }> {
		let current = connection;
		if (starting && this.#desktop) {
			const shown = await startDisplay(connection.client, this.#desktop, { version: VERSION, vendor: this.id, signal });
			if (!shown.ok) return shown;
			const hello = await connection.client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: bounded(this.#timeouts.helloMs, signal) });
			if (!hello.ok) return hello.error.code === "aborted" && !signal?.aborted ? this.#fail("timeout", `the daemon in ${name} did not answer hello within ${seconds(this.#timeouts.helloMs)}`) : hello;
			current = { ...connection, hello: hello.value };
		}
		const found = await daemonDrift(current, this.#daemonExpected(want.user), this.#timeouts.helloMs, signal);
		if (!found.ok) return found;
		const drift = [...found.value];
		const notes: string[] = [];
		let user: string | undefined;
		if (network === "none") {
			const probe = await this.#probe(current, name, signal);
			if (!probe.ok) return probe;
			user = `${probe.value.uid}:${probe.value.gid}`;
			drift.push(...probeNetworkDrift(probe.value));
			if (want.runtime !== undefined) drift.push(...runtimeDrift(want.runtime, probe.value.kernel));
			notes.push(...probeNotes(probe.value, network));
		}
		// Which way init fenced its programs, as hello read it back: said once a way other than the plain one was taken.
		if (starting && current.hello.fence === "userns-netns") {
			notes.push(`fence: userns-netns: init made its programs' network namespace inside a user namespace of its own, as root on ${want.runtime ?? "this machine"} may not make one itself`);
		}
		const said = user === undefined ? {} : { user };
		if (archil === undefined) return drift.length === 0 ? { ...ok(notes), ...said } : this.#fail("refused", `it did not match its spec: ${drift.join("; ")}`);
		const mount = await readArchilMount(current.client, archil, { name, timeoutMs: this.#timeouts.helloMs, ...(signal ? { signal } : {}) });
		if (!mount.ok) return mount;
		drift.push(...mountDrift(archil.expected, mount.value));
		const read = mount.value === undefined ? {} : { mount: mount.value };
		return drift.length === 0 ? { ...ok(notes), ...read, ...said } : this.#fail("refused", `it did not match its spec: ${drift.join("; ")}`);
	}

	/** The shared Archil steps (archilMount) through root, with the takeover of this provider's lower epochs. */
	#mountArchil(root: ArchilRoot, computer: ComputerRef, { mount, run, epoch }: { mount: ArchilMount; run: string; epoch: number }, signal?: AbortSignal): Promise<Result<void>> {
		return archilMount({
			root,
			mount,
			self: computer,
			releaseOlder: () => releaseOlder(this, run, epoch, signal ? { signal } : {}),
			timeoutMs: this.#timeouts.mountMs,
			...(signal ? { signal } : {}),
		});
	}

	/** What the daemon must report: the user given (uid:gid), or, with none, any one user that is not root. */
	#daemonExpected(user?: string): DaemonExpected {
		const { kind, groups } = this.capabilities();
		const [uid, gid] = user === undefined ? [] : user.split(":");
		return { version: VERSION, ...(uid === undefined || gid === undefined ? {} : { uid, gid }), arch: this.host.facts.arch, kind, groups };
	}

	/** One stdio bridge into the machine, after hello, unchecked. */
	#open(ref: ComputerRef, signal?: AbortSignal, helloMs = this.#timeouts.helloMs): Promise<Opened> {
		return openBridge(this.host, ref.id, { argv: hostedCommands().stdio, name: ref.name, version: VERSION, requestMs: this.#timeouts.requestMs, helloMs, ...(signal ? { signal } : {}) });
	}

	/** #open, tried again while the bridge finds no daemon listening, until hello or helloMs in all. */
	async #openWhenListening(ref: ComputerRef, signal?: AbortSignal): Promise<Opened> {
		const until = Date.now() + this.#timeouts.helloMs;
		for (;;) {
			const opened = await this.#open(ref, signal, Math.max(1, until - Date.now()));
			if (opened.ok || !opened.notListening || signal?.aborted || Date.now() + LISTEN_RETRY_MS >= until) return opened;
			await pause(LISTEN_RETRY_MS, signal);
		}
	}

	/** `computerd probe` through the daemon, so it runs as the computer's own user. */
	async #probe(connection: ComputerConnection, name: string, signal?: AbortSignal): Promise<Result<ProbeReport>> {
		const { probeMs } = this.#timeouts;
		const argv = [DAEMON_IN_COMPUTER, "probe", ...this.#probeTargets.flatMap((target) => ["--connect", target])];
		const ran = await connection.client.call("exec.run", { argv, timeoutMs: probeMs }, { signal: bounded(probeMs + CALL_SLACK_MS, signal) });
		if (!ran.ok) {
			if (signal?.aborted) return this.#fail("aborted", `the probe in ${name} was aborted`);
			if (ran.error.code === "aborted") return this.#fail("timeout", `the probe in ${name} did not answer within ${seconds(probeMs)}`);
			return this.#fail(ran.error.code, `the probe in ${name} failed: ${ran.error.message}`);
		}
		const { exitCode, stdout, stderr, timedOut } = ran.value;
		if (timedOut) return this.#fail("timeout", `the probe in ${name} did not end within ${seconds(probeMs)}`);
		if (exitCode !== 0) return this.#fail("refused", `the probe in ${name} exited with ${exitCode}: ${Buffer.from(stderr, "base64").toString("utf8").trim().slice(0, 300)}`);
		const report = probeReportOf(stdout);
		return "not" in report ? this.#fail("refused", `the probe in ${name} ${report.not}`) : ok(report);
	}

	/**
	 * Create waits until the listing shows the new computer on two consecutive polls at least listedStableMs apart (and on
	 * every poll between), so list() shows it once create returns: a listing that showed it once and then not starts over.
	 */
	async #waitListed(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const { listedMs, listMs, pollMs, listedStableMs } = this.#timeouts;
		const until = Date.now() + listedMs;
		let since: number | undefined;
		for (let hits = 0; ; ) {
			const listed = await this.#call("the listing by name", (ctx) => this.host.list({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: ref.name }, ctx), listMs, signal);
			if (!listed.ok) return listed;
			if (listed.value.some((machine) => machine.id === ref.id)) {
				hits += 1;
				since ??= Date.now();
			} else [hits, since] = [0, undefined];
			if (hits >= LISTED_ROUNDS && since !== undefined && Date.now() - since >= listedStableMs) return ok(undefined);
			if (Date.now() >= until) return this.#fail("timeout", `the computer was not listed within ${seconds(listedMs)} of its creation`);
			await pause(Math.min(LISTED_POLL_MS, LISTED_POLL_MAX_MS, pollMs), signal);
			if (signal?.aborted) return this.#fail("aborted", "create was aborted while it waited for the listing");
		}
	}

	/** This provider's machine for ref, as the vendor reads it, or why not. */
	async #own(ref: ComputerRef, signal?: AbortSignal): Promise<Result<Machine>> {
		const found = await this.#get(ref.id, signal);
		if (!found.ok) return found.error.code === "not_found" ? this.#fail("not_found", `no ${this.#label} computer is ${ref.name} (${ref.id})`) : found;
		if (found.value === undefined) return this.#fail("not_found", `no ${this.#label} computer is ${ref.name} (${ref.id})`);
		if (!ours(found.value.labels, ref.name)) return this.#fail("not_found", `no ${this.#label} computer named ${ref.name} has the id ${ref.id}`);
		return ok(found.value);
	}

	/** Why ref is not a computer's ref of this provider, or undefined. */
	#refProblem(ref: ComputerRef): string | undefined {
		if (typeof ref?.name !== "string" || !NAME.test(ref.name)) return `${String(ref?.name)} is not the name of ${a(this.#label)} computer (computer-<12 hex digits>)`;
		if (typeof ref.id !== "string" || !MACHINE_ID.test(ref.id)) return `${String(ref.id)} is not ${a(this.#label)} machine id`;
		return undefined;
	}

	/** The live view: screen.watch on a connection of the watch's own (daemonWatch); a linux computer has no screen. */
	watch(ref: ComputerRef, handlers: ScreenWatchHandlers, options?: WatchOptions): Promise<Result<ScreenWatch>> {
		return daemonWatch(this, ref, handlers, options);
	}

	async connect(ref: ComputerRef): Promise<Result<ComputerConnection>> {
		const problem = this.#refProblem(ref);
		if (problem) return this.#fail("invalid", problem);
		const found = await this.#own(ref);
		if (!found.ok) return found;
		if (found.value.state !== "running") return this.#fail("refused", `${ref.name} is ${found.value.state}, not running: its daemon does not run`);
		const opened = await this.#open(ref);
		if (!opened.ok) return opened;
		const { kind, groups } = this.capabilities();
		const drifted = helloDrift(opened.value.hello, { version: VERSION, kind, groups, arch: this.host.facts.arch, fence: true });
		// An Archil computer's client syncs the run's folder after every call that may change it, before it answers.
		if (drifted.length === 0) return recordedArchil(found.value.labels) === undefined ? opened : ok({ ...opened.value, client: syncingClient(opened.value.client) });
		await opened.value.close();
		return this.#fail("refused", `the daemon in ${ref.name} does not match this provider: ${drifted.join("; ")}`);
	}

	async attach(ref: { id: string } | { labels: Record<string, string> }, { signal }: AttachContext = {}): Promise<Result<AttachedComputer>> {
		const given = (typeof ref === "object" && ref !== null ? ref : {}) as { id?: unknown; labels?: unknown };
		if ((given.id === undefined) === (given.labels === undefined)) return this.#fail("invalid", "attach takes { id } or { labels }, one of them");
		if (given.id !== undefined) {
			const id = given.id;
			if (typeof id !== "string" || !MACHINE_ID.test(id)) return this.#fail("invalid", `${String(id)} is not ${a(this.#label)} machine id`);
			const found = await this.#get(id, signal);
			if (!found.ok) return found.error.code === "not_found" ? this.#fail("not_found", `no ${this.#label} computer has the id ${id}`) : found;
			if (found.value === undefined || !ours(found.value.labels)) return this.#fail("not_found", `no ${this.#label} computer has the id ${id}`);
			return this.#attached(found.value, signal);
		}
		const problem = filterProblem(given.labels);
		if (problem) return this.#fail("invalid", problem);
		const labels = given.labels as Record<string, string>;
		if (Object.keys(labels).length === 0) return this.#fail("invalid", "attach by labels needs at least one label");
		const listed = await this.list(labels, { ...(signal ? { signal } : {}) });
		if (!listed.ok) return listed;
		const text = JSON.stringify(labels);
		if (listed.value.length === 0) return this.#fail("not_found", `no ${this.#label} computer has the labels ${text}`);
		if (listed.value.length > 1) return this.#fail("invalid", `${listed.value.length} computers match the labels ${text}: ${listed.value.map((info) => info.ref.name).join(", ")}`);
		const found = await this.#own((listed.value[0] as ComputerInfo).ref, signal);
		if (!found.ok) return found;
		return this.#attached(found.value, signal);
	}

	/**
	 * The read-back of a computer attach did not make: its spec read back from the vendor and held to what check()
	 * allows, and, when it runs, its daemon, as at create. One that drifted is refused and left as it is.
	 */
	async #attached(machine: Machine, signal?: AbortSignal): Promise<Result<AttachedComputer>> {
		const name = machine.labels[NAME_LABEL] as string;
		const ref = { id: machine.id, name };
		const found: string[] = [];
		const deadline = deadlineOf(machine);
		if (deadline === undefined) found.push(`deadline: the label ${DEADLINE_LABEL} reads ${show(machine.labels[DEADLINE_LABEL])}, not the ISO time create writes`);
		const archil = recordedArchil(machine.labels);
		const network = this.#toolsNetwork(machine);
		if (typeof network === "object") found.push(`network: ${policyWords(network)}, which this provider never makes`);
		const resolved = machine.image?.resolved;
		const image = machine.labels[IMAGE_LABEL] ?? resolved ?? "";
		// The size the vendor reads back is held to check() where the vendor takes it in a spec, and reported either way.
		const taken = new Set(this.host.facts.specFields ?? []);
		const cpus = machine.size?.cpus;
		const memoryMb = machine.size?.memoryMb;
		const sized = { ...(taken.has("cpus") && cpus !== undefined ? { cpus } : {}), ...(taken.has("memoryMb") && memoryMb !== undefined ? { memoryMb } : {}) };
		const spec = { image, lifetimeMs: 1, network: typeof network === "object" ? "open" : network, labels: callerLabels(machine.labels), ...sized } as ComputerSpec;
		found.push(...this.check(spec).map(({ field, message }) => `${field}: ${message}, read back from the computer`));
		// The vendor's own create options read back, as create holds them (#machineDrift).
		found.push(...(machine.drift ?? []));
		let kind: AttachedComputer["spec"]["kind"];
		let notes: string[] = [];
		let mount: MountReadBack | undefined;
		let user: string | undefined;
		if (machine.state === "running") {
			const opened = await this.#open(ref, signal);
			if (!opened.ok) return opened;
			try {
				// A host that takes a spec's user made this computer's daemon run as the one its spec named: read back, never root
				// (an Archil computer's is the tool user); every other runs as the provider's daemon user.
				const want = this.#takesUser() ? (archil === undefined ? {} : { user: ARCHIL_USER }) : { user: `${this.#uid}:${this.#gid}` };
				const inside = await this.#checkInside(opened.value, name, network, false, want, signal, archil);
				if (!inside.ok && inside.error.code !== "refused") return inside;
				if (!inside.ok) found.push(inside.error.message.replace(/^it did not match its spec: /, ""));
				else {
					notes = inside.value;
					mount = inside.mount;
					user = inside.user;
				}
			} finally {
				await opened.value.close();
			}
			kind = opened.value.hello.kind;
		} else if (archil !== undefined) found.push(`mount: ${name} is ${machine.state}, so its mount cannot be read back from inside`);
		if (found.length > 0) return this.#fail("refused", `the computer ${name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		return ok({
			...ref,
			spec: {
				image,
				...(resolved !== undefined && resolved !== image ? { snapshot: resolved } : {}),
				user: (this.#takesUser() ? user : undefined) ?? `${this.#uid}:${this.#gid}`,
				network: spec.network,
				...(cpus === undefined ? {} : { cpus }),
				...(memoryMb === undefined ? {} : { memoryMb }),
				workdir: WORK,
				...(deadline === undefined ? {} : { deadline }),
				...(kind === undefined ? {} : { kind }),
				...(mount === undefined ? {} : { mount }),
				...(machine.gpu === undefined ? {} : { gpu: machine.gpu }),
			},
			...(notes.length > 0 ? { notes } : {}),
		});
	}

	/**
	 * Settings' test: the host's own, or one list by the adapter's label, counted, which makes nothing; a refused key is
	 * unauthorized, a vendor not reached unreachable, the message never carrying a key.
	 */
	async testConnection({ signal }: CallContext = {}): Promise<Result<{ detail: string }>> {
		const { requestMs, listMs } = this.#timeouts;
		const tested = this.host.testConnection?.bind(this.host);
		if (tested) return countTestedAs(this.#label, await this.#call(`${this.#label}'s test`, (ctx) => tested(ctx), requestMs, signal));
		const listed = await this.#call("the listing", (ctx) => this.host.list({ [COMPUTER_LABEL]: "1" }, ctx), listMs, signal);
		return countTested(this.#label, listed.ok ? ok({ count: listed.value.filter((machine) => ours(machine.labels)).length }) : listed);
	}

	/**
	 * Every computer this provider made that carries all of these labels, running or stopped, each one's network read
	 * back. One deadline, listMs from the call, bounds every page and every read-back.
	 */
	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const problem = filterProblem(labels);
		if (problem) return this.#fail("invalid", problem);
		const { listMs } = this.#timeouts;
		const listed = await this.#call("the listing", (ctx) => this.host.list({ ...labels, [COMPUTER_LABEL]: "1" }, ctx), listMs, signal);
		if (!listed.ok) return listed.error.code === "timeout" ? this.#fail("timeout", `list did not finish within ${seconds(listMs)}: ${listed.error.message}`) : listed;
		const infos: ComputerInfo[] = [];
		for (const machine of listed.value) {
			if (!ours(machine.labels) || !Object.entries(labels).every(([key, value]) => machine.labels[key] === value)) continue;
			if (machine.state !== "running" && machine.state !== "stopped") continue;
			// list runs nothing in a computer: an Archil computer's mount is the one its label records, under its epoch label.
			const archil = recordedArchil(machine.labels);
			infos.push({
				ref: { id: machine.id, name: machine.labels[NAME_LABEL] as string },
				labels: { ...machine.labels },
				deadline: deadlineOf(machine),
				state: machine.state,
				network: this.#toolsNetwork(machine),
				...(archil === undefined ? {} : { mount: archil.expected }),
			});
		}
		return ok(infos);
	}

	/** The vendor reads the policy back (or the probe stands for it). A change is refused: the network is fixed at create. */
	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		const problem = this.#refProblem(ref);
		if (problem) return this.#fail("invalid", problem);
		const fixed = `${a(this.#label)} computer's network is fixed at create: create a new computer`;
		if (policy !== undefined && policy !== "none") {
			const wider = policy === "open" || (typeof policy === "object" && policy !== null && "allow" in policy);
			return this.#fail("refused", wider ? `${OWN_NETWORK_ONLY}; ${fixed}` : `${fixed}; a network is "none"`);
		}
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		let read = this.#toolsNetwork(found.value);
		// Its tools' none is read from inside, as the tool user, where the vendor's network is root's (an Archil computer's)
		// or the vendor reads none back: the daemon's own network namespace's live interfaces are lo alone, none can be
		// raised (computerd probe), and no probe target answers.
		const inside = (recordedArchil(found.value.labels) !== undefined || !this.host.facts.networkReadBack) && found.value.state === "running";
		if (read === "none" && inside) {
			const opened = await this.#open(ref, signal);
			if (!opened.ok) return opened;
			try {
				const drift = await readOwnNetwork(opened.value.client, this.#timeouts.helloMs, bounded(this.#timeouts.helloMs, signal));
				if (!drift.ok) return this.#fail(drift.error.code, `${ref.name}: ${drift.error.message}`);
				if (drift.value.length > 0) read = { other: drift.value.join("; ") };
				const probe = await this.#probe(opened.value, ref.name, signal);
				if (!probe.ok) return probe;
				if (probe.value.reached.length > 0) read = { other: `its tools' network was created none, yet from inside an answer came back from ${probe.value.reached.join(", ")}` };
			} finally {
				await opened.value.close();
			}
		}
		if (policy === undefined || policy === read) return ok(read);
		return this.#fail("refused", `${fixed}: ${ref.name} reads back network ${policyWords(read)}, not ${policy}`);
	}

	/**
	 * The tools' network as the vendor's policy shows it: the vendor's own (none where it reads none back), except for an
	 * Archil computer, whose open vendor network is root's, to reach Archil: its tools' network is init's own, none.
	 */
	#toolsNetwork(machine: Machine): NetworkPolicy {
		const vendor = this.host.facts.networkReadBack ? (machine.network ?? { other: `${this.#label} read no network back` }) : "none";
		if (recordedArchil(machine.labels) === undefined) return vendor;
		if (vendor === "open" || !this.host.facts.networkReadBack) return "none";
		return { other: `an Archil computer whose ${this.#label} network reads ${policyWords(vendor)}, not the open one create makes for root to reach Archil` };
	}

	/** One extend of a computer at a time, each reading the deadline the one before it left. */
	async #extendSerial(ref: ComputerRef, ttlMs: number, signal?: AbortSignal): Promise<Result<{ deadline: Date }>> {
		const problem = this.#refProblem(ref);
		if (problem) return this.#fail("invalid", problem);
		if (!isWhole(ttlMs) || ttlMs <= 0) return this.#fail("invalid", "extend takes ttlMs, a whole number of milliseconds above 0");
		const before = this.#extending.get(ref.id) ?? Promise.resolve();
		const mine = before.then(() => this.#extend(ref, ttlMs, signal));
		const done = mine.then(
			() => {},
			() => {},
		);
		this.#extending.set(ref.id, done);
		try {
			return await mine;
		} finally {
			if (this.#extending.get(ref.id) === done) this.#extending.delete(ref.id);
		}
	}

	/**
	 * Moves the deadline to now + ttlMs, refusing one earlier than it is (before any vendor call), never past create's time plus the cap (init's maximum):
	 * the vendor's timer (setTimer, then read back) or the janitor's label (setLabels) first, then init's own deadline, to
	 * the end the vendor reads back. The deadline returned is the one init took.
	 */
	async #extend(ref: ComputerRef, ttlMs: number, signal?: AbortSignal): Promise<Result<{ deadline: Date }>> {
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		const machine = found.value;
		if (machine.state !== "running") return this.#fail("refused", `${ref.name} is ${machine.state}, not running`);
		const most = isoOf(machine.labels[MAX_LABEL]);
		if (most === undefined) return this.#fail("refused", `${ref.name}'s label ${MAX_LABEL} reads ${show(machine.labels[MAX_LABEL])}, so the most it may live is unknown`);
		const current = deadlineOf(machine) ?? machine.endsAt;
		const now = Date.now();
		const target = now + ttlMs;
		if (target > most.getTime()) {
			return this.#fail("limit", `${new Date(target).toISOString()} is past ${most.toISOString()}, the most this computer may live: create's time plus this provider's ${seconds(this.#maxLifetimeMs)} cap`);
		}
		if (current !== undefined && target < current.getTime()) {
			return this.#fail("refused", `${new Date(target).toISOString()} is earlier than ${current.toISOString()}, the deadline ${ref.name} has now: an extend moves the deadline later, never earlier`);
		}
		if (current !== undefined && target === current.getTime()) return ok({ deadline: current });
		const { requestMs } = this.#timeouts;
		let end: Date;
		const setTimer = this.host.setTimer?.bind(this.host);
		if (this.host.facts.lifetime === "vendor" && setTimer) {
			const moved = await this.#call(`${this.#label}'s timer of ${ref.name}`, (ctx) => setTimer(ref.id, { end: new Date(target), most }, ctx), requestMs, signal);
			if (!moved.ok) return moved.error.code === "limit" ? moved : this.#fail(moved.error.code, `${this.#label}'s timer did not move, so nothing did: ${moved.error.message}`);
			const after = await this.#get(ref.id, signal);
			if (!after.ok || after.value?.endsAt === undefined) {
				const why = after.ok ? `${ref.name} read back with no end` : after.error.message;
				return this.#fail(after.ok ? "gone" : after.error.code, `${this.#label}'s timer was asked to move, and reading it back failed: ${why}; init's deadline did not move`);
			}
			end = after.value.endsAt;
		} else {
			const setLabels = this.host.setLabels?.bind(this.host);
			if (!setLabels) return this.#fail("unsupported", `${a(this.#label)} computer's deadline cannot move`);
			end = new Date(target);
			const moved = await this.#call(`the deadline label of ${ref.name}`, (ctx) => setLabels(ref.id, { [DEADLINE_LABEL]: end.toISOString() }, ctx), requestMs, signal);
			if (!moved.ok) return this.#fail(moved.error.code, `the deadline label did not move, so nothing did: ${moved.error.message}`);
		}
		const opened = await this.#open(ref, signal);
		if (!opened.ok) return this.#fail(opened.error.code, `${ref.name}'s end moved to ${end.toISOString()}, and init's deadline did not: ${opened.error.message}`);
		try {
			// The vendor's end is its clock, and the call's own transit adds to it: init's never goes past the maximum it was given.
			const at = new Date(Math.min(end.getTime(), most.getTime())).toISOString();
			const extended = await opened.value.client.call("deadline.extend", { at }, { signal: bounded(this.#timeouts.helloMs, signal) });
			if (!extended.ok) return this.#fail(extended.error.code, `${ref.name}'s end moved to ${end.toISOString()}, and init's deadline did not: ${extended.error.message}`);
			const answered = Date.parse(extended.value.at);
			return ok({ deadline: new Date(Number.isNaN(answered) ? at : answered) });
		} finally {
			await opened.value.close();
		}
	}

	/**
	 * delete reads the machine back to check it is this provider's, then deletes it, both never signalled, so a release
	 * after an abort, or one aborted during the read, still sends the delete; it is idempotent: one the vendor no longer
	 * has is ok. The vendor answers a delete before the machine is gone, so release then waits (#settle) until the vendor
	 * reads it gone and no longer lists it, within goneMs and the caller's signal, the one step the signal ends. A running
	 * Archil computer lets go of the run's folder first (archilRelease: the final sync through computerd, then checkin as
	 * root); the delete runs whatever that answers. A folder not let go cleanly loses nothing (every call that changed it
	 * synced, and the next claim revokes the hold), so it is said through onNote, and the release succeeds once the
	 * machine is gone. stop, where the host declares it, stops the machine and keeps it.
	 */
	async release(ref: ComputerRef, how: ReleaseHow, { signal }: ReleaseContext = {}): Promise<Result<void>> {
		const problem = this.#refProblem(ref);
		if (problem) return this.#fail("invalid", problem);
		if (how === "detach") return this.#fail("unsupported", `the ${this.#label} provider keeps no computer for an agent (it declares no persistence), so release detach is refused: release it with delete`);
		if (how !== "stop" && how !== "delete") return this.#fail("invalid", `release is "stop" or "delete", not ${String(how)}`);
		const stop = this.host.stop?.bind(this.host);
		if (how === "stop" && !(stop && this.host.facts.release.includes("stop"))) return this.#fail("unsupported", `${a(this.#label)} computer has no stop that this provider declares: release it with delete`);
		const found = await this.#get(ref.id);
		if (!found.ok) return found.error.code === "not_found" ? ok(undefined) : found;
		if (found.value === undefined) return ok(undefined);
		if (!ours(found.value.labels, ref.name)) return this.#fail("not_found", `no ${this.#label} computer is ${ref.name} (${ref.id}): the machine is not this provider's, so it is left as it is`);
		// A stop and a delete alike let go of a running Archil computer's folder first: a stopped one holds no folder.
		const letGo = recordedArchil(found.value.labels) !== undefined && found.value.state === "running" ? await this.#letGo(ref, signal) : ok(undefined);
		let done: Result<void>;
		if (how === "stop" && stop) done = await this.#call(`the stop of ${ref.name}`, (ctx) => stop(ref.id, ctx), this.#timeouts.goneMs, signal);
		else {
			this.#end(ref.name);
			const killed = await this.#kill(ref.id);
			done = killed.ok ? await this.#settle(ref, signal) : killed;
		}
		if (letGo.ok) return done;
		if (!done.ok) return this.#fail(done.error.code, `${done.error.message}; and ${letGo.error.message}`);
		this.#onNote?.({ computer: ref.name, note: `${ref.name} was ${how === "stop" ? "stopped" : "deleted"}, and ${letGo.error.message}` });
		return done;
	}

	/** A running Archil computer's folder let go: the final sync through a connection when it answers, then checkin as root. */
	async #letGo(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const opened = await this.#open(ref, signal);
		try {
			return await archilRelease({ root: rootOf(this.host, ref.id, ref.name), client: opened.ok ? opened.value.client : undefined, timeoutMs: this.#timeouts.mountMs, ...(signal ? { signal } : {}) });
		} finally {
			if (opened.ok) await opened.value.close();
		}
	}

	/**
	 * Waits, through waitUntil, until the vendor reads the machine gone (get answers none, or a state that is neither
	 * running, stopped nor starting) and its name's listing no longer shows it, twice running. Pauses double from pollMs
	 * to 5 s, bounded by goneMs and the caller's signal; a failed read ends the wait with that error.
	 */
	async #settle(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const settled = await settleGone(this.host, ref, { ...this.#timeouts, ...(signal ? { signal } : {}) });
		return settled;
	}
}

/**
 * Waits until the host reads a machine gone and no longer lists it under its name, twice running (see #settle). Shared
 * with the live sweep, which waits the same way.
 */
export async function settleGone(
	host: MachineHost,
	ref: ComputerRef,
	{ requestMs, listMs, pollMs, goneMs, signal }: Pick<HostedTimeouts, "requestMs" | "listMs" | "pollMs" | "goneMs"> & { signal?: AbortSignal },
): Promise<Result<void>> {
	const fail = failOf(host);
	type Read = { failed: Result<never> } | { settled: true } | { last: string };
	let agreed = 0;
	let last = "unread";
	const read = async (readSignal: AbortSignal): Promise<Read> => {
		const got = await hostCall(host, `the read of ${ref.id}`, (ctx) => host.get(ref.id, ctx), requestMs, readSignal);
		if (!got.ok && got.error.code !== "not_found") {
			if (got.error.code === "aborted") return { last };
			return { failed: fail(got.error.code, `release of ${ref.name}: reading it back failed (${got.error.message}); it last read ${last}`) };
		}
		const state = got.ok ? got.value?.state : undefined;
		last = state ?? "gone (not found)";
		if (state !== undefined && alive(state)) {
			agreed = 0;
			return { last };
		}
		const listed = await hostCall(host, "the listing by name", (ctx) => host.list({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: ref.name }, ctx), listMs, readSignal);
		if (!listed.ok) {
			if (listed.error.code === "aborted") return { last };
			return { failed: fail(listed.error.code, `release of ${ref.name}: the listing failed (${listed.error.message}); it last read ${last}`) };
		}
		if (listed.value.some((machine) => machine.id === ref.id)) {
			agreed = 0;
			last = `${last}, still listed`;
			return { last };
		}
		return ++agreed >= LISTED_ROUNDS ? { settled: true } : { last };
	};
	const waited = await waitUntil(read, (state) => !("last" in state), {
		boundMs: goneMs,
		...(signal ? { signal } : {}),
		minMs: Math.min(pollMs, RELEASE_POLL_MAX_MS),
		maxMs: RELEASE_POLL_MAX_MS,
		what: `${ref.name} to be gone after its delete`,
		describe: (state) => ("last" in state ? `the vendor read it ${state.last}` : "done"),
	});
	if (!waited.ok) return waited;
	return "failed" in waited.value ? waited.value.failed : ok(undefined);
}

/**
 * The order #converge keeps by: the oldest first, by createdAt when every machine has one, else by id; ties by id. The
 * same machines give the same order on every instance.
 */
function oldestFirst(machines: Machine[]): (a: Machine, b: Machine) => number {
	const at = (machine: Machine) => (machine.createdAt instanceof Date ? machine.createdAt.getTime() : Number.NaN);
	const dated = machines.every((machine) => !Number.isNaN(at(machine)));
	const byId = (a: Machine, b: Machine) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	return (a, b) => (dated && at(a) !== at(b) ? at(a) - at(b) : byId(a, b));
}

/** What the read-back inside a computer holds it to, beside its spec: its daemon's user and its runtime. */
interface Expected {
	user?: string;
	runtime?: "vm" | "gvisor";
}

/** The probe's kernel against the runtime declared: gVisor exactly where the host runs one (a pid1 host's GPU), a VM's elsewhere. */
function runtimeDrift(runtime: "vm" | "gvisor", kernel: string): string[] {
	const gvisor = /gvisor/i.test(kernel);
	if (runtime === "vm" && gvisor) return [`runtime: declared vm, read back gVisor (the kernel reports ${JSON.stringify(kernel)})`];
	if (runtime === "gvisor" && !gvisor) return [`runtime: declared gVisor (a GPU computer), read back another kernel (${JSON.stringify(kernel)})`];
	return [];
}

/** A host's own test, its words kept: unauthorized and unreachable as the shared rule reads them. */
function countTestedAs(label: string, tested: Result<{ detail: string }>): Result<{ detail: string }> {
	return tested.ok ? tested : countTested(label, tested);
}

function labelProblem(key: string, value: unknown, rule?: RegExp): string | undefined {
	if (typeof value !== "string") return `the label ${key} must be a string`;
	if (key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)}: a NUL byte cannot be sent to the vendor`;
	if (key === "") return "a label name must be non-empty";
	if (key === COMPUTER_LABEL || key.startsWith(`${COMPUTER_LABEL}.`)) return `the label ${key} is in the provider's own namespace (${COMPUTER_LABEL})`;
	if (key === ARCHIL_MOUNT_LABEL) return `the label ${key} is the provider's own: it records an Archil computer's mount`;
	if (rule !== undefined && !rule.test(key)) return `the label name ${JSON.stringify(key)} is not one the vendor takes (${rule.source})`;
	return undefined;
}

/** "a" or "an" before a vendor's name, by its first letter. */
function a(label: string): string {
	return `${/^[AEIOU]/i.test(label) ? "an" : "a"} ${label}`;
}

/** The shared machine-host adapter: host's machines as a ComputerProvider (see HostedProvider). */
export function hostedProvider(host: MachineHost, options: HostedOptions): HostedProvider {
	return new HostedProvider(host, options);
}
