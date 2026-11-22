// The shared machine-host adapter: new HostedProvider(host, options) is a whole ComputerProvider over a vendor's
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
import { ATTACH_EGRESS_ENV, ATTACH_PATH, type AttachHub, attachEgressOf, DAEMON_PATH, type MachineTokens } from "../attach.js";
import { CreateRequests, endedWords, otherSpecWords, readBackDiffer } from "../create-requests.js";
import { mountsOf, syncs } from "../descriptor.js";
import { type DesktopOptions, desktopOf, startDisplay } from "../desktop.js";
import { COMPUTER_LABEL, DAEMON_IN_COMPUTER, DEADLINE_LABEL, helloDrift, type ProbeReport, probeNetworkDrift, probeNotes, probeReportOf, show, WORK } from "../drift.js";
import { BACKSTOP_MARGIN_MS, type HostCall, type HostFacts, type Machine, type MachineHost, type MachineRequest } from "../host.js";
import { readOwnNetwork, TOOL_USER } from "../isolation.js";
import { releaseOlder } from "../janitor.js";
import type { KindCapabilities } from "../kinds.js";
import { EPOCH_LABEL, epochOf, RUN_LABEL } from "../labels.js";
import { checkMount, type MountKind, type MountReadBack, type Unmounted } from "../mount.js";
import {
	ARCHIL_TOOL_UID,
	type ArchilEgress,
	type ArchilMount,
	type ArchilRoot,
	archilEgressOf,
	archilLabels,
	archilMount,
	archilRefusals,
	archilRelease,
	archilSync,
	claimEpoch,
	MOUNT_LABEL,
	mountDrift,
	type ProviderNote,
	type RecordedFolder,
	readMount,
	recordedFolder as recordedFolderOf,
	recordedMount,
	SYNC_LABELS,
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
	type ComputerResources,
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
import type { DaemonMethod, DaemonMethods } from "../protocol.js";
import { type ComputerError, failFor, ok, type Result } from "../result.js";
import { daemonWatch, type ScreenWatch, type ScreenWatchHandlers, type WatchOptions } from "../screen-watch.js";
import { countTested } from "../test-connection.js";
import { waitUntil } from "../wait.js";
import { bounded, CALL_SLACK_MS, hostCall, type Opened, openBridge, pause, rootOf, runToExit, seconds, uploadThroughExec, words } from "./process.js";
import { isWhole, PACKED_NAME, packLabels, unpackLabels } from "./values.js";
import { EGRESS_POLICY, EGRESS_PROXY_USER, EGRESS_RELAY, HOSTED_ALLOW, NETWORK_LABEL, networkFormOf, networkOfForm, networkRefusal, throughProxy } from "./network.js";
import { ARCHIL_GATE, closedSocketsOf, type DaemonExpected, daemonDrift, type HostedCommands, hostedCommands, initFlags, installerOf } from "./scripts.js";

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
	/** One whole listing, every page; each listed machine's get after it has requestMs. */
	listMs: number;
	/** From a delete to get answering none for the machine. */
	goneMs: number;
	/**
	 * The first pause between two reads while release waits; the pauses double up to 5 s. The longest pause between two
	 * listings while create waits for the new computer to show: those start at 150 ms and double up to it.
	 */
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
	/**
	 * The egress gateway an Archil computer's archil client reaches Archil through, `<IPv4 gateway>:<mount lane>:<data
	 * lane>` such as 192.0.2.40:18100:42050 (archilEgressOf): for a vendor whose machines reach Archil only through it.
	 * Given to the helper's mount and revoke. Unset or empty, the client reaches Archil as the machine's network allows.
	 */
	archilEgress?: string;
	/**
	 * The relay a dial machine reaches this server through, `<IPv4 relay>:<port>` such as 192.0.2.40:18443
	 * (attachEgressOf): for a vendor whose machines reach only addresses the operator allows. A dial machine is booted with
	 * it as AGENTRUN_ATTACH_EGRESS, and its daemon fetch and attach socket both open TCP to it, speaking TLS and HTTP to
	 * the public host through it. Unset or empty, they go to the public host; a host whose machines don't dial ignores it.
	 */
	attachEgress?: string;
	/** What a host whose facts.connect is "dial" needs: create refuses without it, before any call to the vendor, in words
	 *  that name serve's one-process start (a runner apart from the server has none). */
	dial?: HostedDial;
}

/** The server a dial host's machines reach, and what it holds of them (MachineHost facts.connect "dial"). */
export interface HostedDial {
	/**
	 * The server's public address, AGENTRUN_PUBLIC_URL: https://, which the vendor's machines must reach (http:// only on
	 * 127.0.0.1, for tests). They dial its /v2/computers/attach and fetch the daemon from its /v2/computers/daemon, which
	 * serves the build at this provider's daemonPath. Empty or unset: create refuses, in words.
	 */
	url?: string;
	/** The server's machine tokens: one minted at each create, revoked at its delete. */
	tokens: MachineTokens;
	/** The server's AttachHub, which the server's attach route gives each minted machine's socket. */
	hub: Pick<AttachHub, "online" | "connection" | "revoke">;
}

const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const NAME_LABEL = `${COMPUTER_LABEL}.name`;
/** The image create was asked for: a vendor may report another name for it (a template's id). */
export const IMAGE_LABEL = `${COMPUTER_LABEL}.image`;
/** The most extend may move the deadline to: create's time plus the cap, by this machine's clock, as init was given. */
export const MAX_LABEL = `${COMPUTER_LABEL}.max-deadline`;
/** A GPU computer's GPUs, type:count: a retry and attach read them here, so no vendor need read them back. */
export const GPU_LABEL = `${COMPUTER_LABEL}.gpu`;
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
/** The adapter's timeouts, the caller's over its defaults: what a host reads for its own requestMs or pollMs. */
export const timeoutsOf = (timeouts: Partial<HostedTimeouts> = {}): HostedTimeouts => ({ ...DEFAULTS, ...timeouts });
/** The user an Archil computer's tools run as: the image's agentrun-tool, with no sudo and no capability. */
const ARCHIL_USER = `${ARCHIL_TOOL_UID}:${ARCHIL_TOOL_UID}`;
const RELEASE_POLL_MAX_MS = 5_000;
const LISTED_POLL_MS = 150;
const LISTED_ROUNDS = 2;
const LISTEN_RETRY_MS = 250;
const START_POLL_MS = 500;
/** How much of agentrun-dial's output a dial timeout carries (MachineHost.dialLog): its last lines, cut to these characters. */
const DIAL_LOG_LINES = 10;
const DIAL_LOG_CHARS = 800;
/**
 * The computerd build a hosted machine of arch runs: HostedProvider's default daemonPath, and the file serve's daemon
 * route serves, so the sha256 a dial machine checks (AGENTRUN_DAEMON_SHA256) is this file's.
 */
export function hostedDaemonPath(arch: "amd64" | "arm64"): string {
	return fileURLToPath(new URL(`../computerd-linux-${arch}`, import.meta.url));
}

/** The dial creates in flight per request name, keyed by the server's AttachHub (#inTurn). */
const DIAL_TURNS = new WeakMap<object, Map<string, Promise<void>>>();
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
/** The spec's fields the adapter passes on or holds itself: a size goes in the request, for the host's check to refuse. */
const SPEC_FIELDS = new Set(["image", "lifetimeMs", "network", "labels", "mount", "gpu", "owner", "cpus", "memoryMb"]);

const policyWords = (policy: NetworkPolicy) => (typeof policy === "string" ? policy : "other" in policy ? policy.other : JSON.stringify(policy));
/** What makes a computer's labels smaller, in words: the list only where its network is one. */
const shorterWords = (labels: Record<string, string>) => `give a shorter image, mount folder${labels[NETWORK_LABEL]?.startsWith("allow:") ? ", network list" : ""} or labels`;
const alive = (state: Machine["state"]) => state !== "gone";
/** The codes of a create the vendor refused, which made nothing. */
const REFUSED_CREATE: ReadonlySet<ComputerError["code"]> = new Set(["invalid", "denied", "limit", "not_found", "refused", "unauthorized", "exists"]);
/**
 * Whether a create that failed with code may have made a machine, so the request's name is swept. A refusal made
 * nothing: a machine under the name then is another's (exists: another instance's create of the request), never
 * deleted. Any other failure (the vendor's, a timeout) may have made one, answered in time or after create gave up.
 */
export const mayHaveMade = (code: ComputerError["code"]) => !REFUSED_CREATE.has(code);

/** An ISO time a label holds, or undefined when it is missing or not the ISO time create writes. */
export function isoOf(written: string | undefined): Date | undefined {
	const at = written === undefined ? Number.NaN : Date.parse(written);
	return Number.isNaN(at) || new Date(at).toISOString() !== written ? undefined : new Date(at);
}

/**
 * When a machine ends: its deadline label, as the vendor reads it back. A vendor that keeps no label change reads it
 * as the end its timer moved to (E2B's get), so a restarted provider reads an extend all the same.
 */
export const deadlineOf = (machine: Pick<Machine, "labels">): Date | undefined => isoOf(machine.labels[DEADLINE_LABEL]);

/** Only a machine this adapter made counts: its label, a name of its making, and the name asked for when one is. */
export const ours = (labels: Record<string, string> | undefined, name?: string) =>
	labels?.[COMPUTER_LABEL] === "1" && NAME.test(labels[NAME_LABEL] ?? "") && (name === undefined || labels[NAME_LABEL] === name);

/** The mount (an Archil mount, a synced folder) a computer's agentrun.mount label records, or undefined when it has none. */
function recordedFolder(labels: Record<string, string> | undefined): RecordedFolder | undefined {
	if (labels?.[MOUNT_LABEL] === undefined) return undefined;
	const mount = recordedMount(labels);
	return recordedFolderOf(labels, mount === undefined ? { other: `the label ${MOUNT_LABEL} records a mount this provider never makes` } : { mount });
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

/** The GPUs a machine's GPU_LABEL records (type:count), as a spec's gpu field; none where it records none. */
function gpuOf(written: string | undefined): { gpu?: { type: string; count: number } } {
	const at = written?.lastIndexOf(":") ?? -1;
	if (written === undefined || at < 1) return {};
	const count = Number(written.slice(at + 1));
	return isWhole(count) ? { gpu: { type: written.slice(0, at), count } } : {};
}

/** The caller's labels of a machine: every one but the adapter's own namespace and the mount's. */
const callerLabels = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).filter(([key]) => key !== COMPUTER_LABEL && !key.startsWith(`${COMPUTER_LABEL}.`) && key !== MOUNT_LABEL));

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
}

type Extend = (ref: ComputerRef, ttlMs: number, context?: CallContext) => Promise<Result<{ deadline: Date }>>;

/** The shared adapter's provider: a ComputerProvider whose vendor is host. */
export class HostedProvider implements ComputerProvider {
	readonly id: string;
	readonly version = VERSION;
	/** The vendor's machines, for the live sweep (conformance/sweep.ts); nothing else reaches past the provider to them. */
	readonly host: MachineHost;
	readonly extend?: Extend;
	/** The host's descriptor's configuration of this provider's kind: its groups and GPUs. */
	readonly #configuration: KindCapabilities;
	readonly #label: string;
	readonly #fail: ReturnType<typeof failFor>;
	readonly #daemonPath: string;
	readonly #kind: "desktop" | "linux";
	readonly #desktop: Required<DesktopOptions> | undefined;
	readonly #maxLifetimeMs: number;
	readonly #uid: string;
	readonly #gid: string;
	readonly #timeouts: HostedTimeouts;
	readonly #probeTargets: string[];
	readonly #onNote: ProviderNote | undefined;
	readonly #archilEgress: ArchilEgress | undefined;
	readonly #attachEgress: string | undefined;
	/** Each create in flight, and the names of the computers this provider ended (create-requests.ts). In memory alone:
	 *  past it, and past this process, the vendor's listing is what holds. */
	readonly #requests = new CreateRequests();
	/** Each computer's last extend, by machine id, while one runs: the next waits for it. */
	readonly #extending = new Map<string, Promise<void>>();
	/** What the vendor said a machine this create made was given (Machine.resources), by machine id, from its read once it
	 *  ran (#prepare) until the create answers with it (#createOnce). */
	readonly #given = new Map<string, ComputerResources>();
	/** A dial host's server: what its machines reach, and what holds their tokens and sockets. */
	readonly #dial: HostedDial | undefined;
	/** The host's descriptor's mounts as its machines reach this server (mountsOf): a dial host's take no Archil mount. */
	readonly #mounts: { mounts: MountKind[]; unmounted: Unmounted };

	constructor(host: MachineHost, options: HostedOptions) {
		const {
			kind = "linux",
			desktop = {},
			maxLifetimeMs = host.facts.maxLifetimeMs,
			daemonPath = hostedDaemonPath(host.facts.arch),
			daemonUser = TOOL_USER,
			timeouts = {},
			probeTargets = DEFAULT_PROBE_TARGETS,
			onNote,
			archilEgress,
			attachEgress,
		} = options;
		const { id, label, capabilities } = host.descriptor;
		if (kind !== "desktop" && kind !== "linux") throw new Error(`kind is desktop or linux, not ${String(kind)}`);
		const configuration = capabilities.find((one) => one.kind === kind);
		if (configuration === undefined) throw new Error(`${label} offers no ${kind} computer`);
		this.id = id;
		this.host = host;
		this.#configuration = configuration;
		this.#label = label;
		this.#fail = failFor(id);
		this.#onNote = onNote;
		this.#archilEgress = archilEgress === undefined || archilEgress === "" ? undefined : archilEgressOf(archilEgress);
		this.#attachEgress = attachEgress === undefined || attachEgress === "" ? undefined : attachEgressOf(attachEgress);
		if (!isWhole(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > host.facts.maxLifetimeMs) {
			throw new Error(`maxLifetimeMs must be a whole number of ms above 0 and at most ${host.facts.maxLifetimeMs} ms, the longest ${label} keeps a computer`);
		}
		// Every connection of a dial host's machine goes over the socket it dials: nothing reaches into it from here.
		if (host.facts.connect === "dial" && (host.exec || host.upload)) throw new Error(`${label}'s machines dial this server (facts.connect "dial"), so its host has no exec and no upload: leave them out`);
		const user = USER.exec(daemonUser);
		if (user === null || Number(user[1]) > MAX_ID || Number(user[2]) > MAX_ID) throw new Error(`the daemon user ${daemonUser} must be uid:gid in numbers, such as 1000:1000`);
		// The numbers, not the text: "00" is root as much as "0" is.
		if (Number(user[1]) === 0 || Number(user[2]) === 0) throw new Error(`the daemon user ${daemonUser} is root or in root's group; ${a(label)} computer's daemon runs as neither`);
		const merged = timeoutsOf(timeouts);
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
		this.#dial = host.facts.connect === "dial" ? options.dial : undefined;
		// The descriptor's keyed mounts are the host's already (Daytona's): no key is read here.
		this.#mounts = mountsOf(host.descriptor, () => false, host.facts.connect === "dial");
		// Extend only where the end can follow it: the host moves its timer or its deadline label.
		if (host.extend) this.extend = (ref, ttlMs, context) => this.#extendSerial(ref, ttlMs, context?.signal);
	}

	/** The computer's facts, from the descriptor, the host's facts and the adapter's options alone. */
	capabilities(): ComputerCapabilities {
		const { facts, descriptor } = this.host;
		const { gpu } = this.#configuration;
		return {
			kind: this.#kind,
			lifetime: facts.lifetime,
			network: [...descriptor.network],
			// A list is the egress proxy's, init's own (./network.ts): Docker's bounds and ports.
			...(descriptor.network.includes("allow") ? { allow: structuredClone(HOSTED_ALLOW) } : {}),
			// The probe and the proxy's policy from inside are the network's truth: no vendor's read of it is taken.
			networkReadBack: false,
			isolation: facts.isolation,
			os: "linux",
			daemon: facts.daemon,
			groups: [...this.#configuration.groups],
			maxLifetimeMs: this.#maxLifetimeMs,
			release: ["delete"],
			// A synced folder is derived for this configuration alone (descriptor.ts syncs), whatever the descriptor's list
			// says: a dial machine takes one too, its /workspace made by the box image's agentrun-dial.
			mount: [...this.#mounts.mounts.filter((kind) => kind !== "sync"), ...(syncs(descriptor, this.#configuration) ? (["sync"] as const) : [])],
			vendorAgentPorts: [...facts.vendorAgentPorts],
			...(gpu === undefined ? {} : { gpu: structuredClone(gpu) }),
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
		// An Archil mount's own rules hold only where the provider takes one; elsewhere checkMount's refusal says why alone.
		const archil = (mount as { kind?: unknown } | undefined)?.kind === "archil" && (capabilities.mount ?? []).includes("archil");
		refusals.push(...checkMount(mount, capabilities.mount ?? [], this.#mounts.unmounted), ...(archil ? archilRefusals(given as unknown as ComputerSpec) : []));
		// A synced folder reads back under the run's claim epoch, as an Archil mount does: nothing in the computer holds one.
		if ((mount as { kind?: unknown } | undefined)?.kind === "sync" && (capabilities.mount ?? []).includes("sync")) {
			const epoch = epochOf(typeof labels === "object" && labels !== null ? (labels as Record<string, string>) : undefined);
			if (!epoch.ok) refuse("labels", `a synced folder is made under the run's claim epoch: the label ${EPOCH_LABEL} is required (${epoch.error.message})`);
		}
		const daemonUser = `${this.#uid}:${this.#gid}`;
		const asked = this.#takesUser ? given.user : undefined;
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
			} else if (throughProxy(network) && user.split(":").includes(String(EGRESS_PROXY_USER))) {
				refuse("user", `the egress proxy of a network open or a list runs as uid and gid ${EGRESS_PROXY_USER} (nobody), so its programs' user may be neither; ask for another uid, such as 1000:1000`);
			}
		} else if (archil && daemonUser !== ARCHIL_USER) {
			refuse(
				"mount",
				`a computer with an Archil mount runs its tools as agentrun-tool, ${ARCHIL_USER}, the user its image makes with no way to root; this provider's daemon user is ${daemonUser}: make it with daemonUser ${ARCHIL_USER}`,
			);
		}
		if (typeof image !== "string" || image === "" || image.includes("\0")) refuse("image", `an image is required: the name of ${a(label)} image`);
		refusals.push(...checkTenure(given, capabilities, label));
		// Only the forms the descriptor declares, each one this computer enforces; any other is refused, never widened.
		const networkProblem = networkRefusal(label, capabilities.network, network);
		if (networkProblem) refuse("network", networkProblem);
		const entries = labels === undefined ? [] : typeof labels === "object" && labels !== null && !Array.isArray(labels) ? Object.entries(labels) : undefined;
		const bad = entries === undefined ? "labels must map names to strings" : entries.map(([key, value]) => labelProblem(key, value)).find(Boolean);
		if (bad) refuse("labels", bad);
		else if (typeof image === "string" && (!archil || ["disk", "region", "folder"].every((key) => typeof (mount as Record<string, unknown>)[key] === "string"))) {
			const over = this.#labelsOver(given as unknown as ComputerSpec);
			if (over) refuse(archil && over.bytes ? "mount" : "labels", over.why);
		}
		refusals.push(...checkGpu(given.gpu, capabilities, mount));
		for (const [field, value] of Object.entries(given)) {
			if (SPEC_FIELDS.has(field) || (field === "user" && this.#takesUser) || value === undefined) continue;
			if (field === "pids") refuse(field, `${a(label)} computer has the size of its image: name an image of the size you need, not ${field}`);
			else if (field === "user") refuse(field, `${a(label)} computer's daemon runs as the provider's daemon user (${daemonUser}), never as one a spec names`);
			else if (field === "workdir") refuse(field, `${a(label)} computer works in ${WORK}, its home; a spec cannot name another`);
			else refuse(field, `${a(label)} computer does not support ${field}`);
		}
		if (this.host.check) refusals.push(...this.host.check(given as Partial<ComputerSpec>));
		return refusals;
	}

	/** Whether the host's machines dial this server (facts.connect "dial"): every connection goes over that socket. */
	get #dialing(): boolean {
		return this.host.facts.connect === "dial";
	}

	/**
	 * Where a dial host's machines reach this server: its attach route as ws(s) and its daemon route, from dial.url, an
	 * https address (http only on 127.0.0.1, for tests); or the refusal of a create, in words, where it has none or where
	 * the provider was given no dial (no hub, so no process to take the machine's socket).
	 */
	#dialed(): { attach: string; daemon: string; dial: HostedDial } | { problem: string } {
		if (this.#dial === undefined) {
			// No dial: a runner in a process of its own (serve's runner subcommand, the image's server-and-runner). The fix is
			// the one a paired computer's refusal names (serve's workspace/attached-computers.ts ONE_PROCESS_FIX).
			return {
				problem: `${this.#label} machines dial in to this server, and this runner runs in a process of its own, with no attach hub to take their socket: start the image with the server options alone, without server-and-runner (outside the image: agentrun-serve without --no-runner)`,
			};
		}
		const url = this.#dial.url;
		const at = URL.canParse(url ?? "") ? new URL(url as string) : undefined;
		if (at === undefined || !(at.protocol === "https:" || (at.protocol === "http:" && at.hostname === "127.0.0.1"))) {
			return {
				problem: `${this.#label} machines dial this server, and it has no public https address: set AGENTRUN_PUBLIC_URL to one the internet reaches (a tunnel such as cloudflared or tailscale funnel works), or use a provider whose host has exec`,
			};
		}
		// From the parsed address, whose scheme and host are lowercase: "HTTPS://Example.com/" is https://example.com.
		const path = at.pathname.replace(/\/+$/, "");
		return {
			attach: `${at.protocol === "https:" ? "wss:" : "ws:"}//${at.host}${path}${ATTACH_PATH}`,
			daemon: `${at.origin}${path}${DAEMON_PATH}?arch=${this.host.facts.arch}`,
			dial: this.#dial,
		};
	}

	/**
	 * A dial machine's token revoked, then its socket closed, best effort: the token first, so a redial while the revoke
	 * is written can't stay attached after the close. A token not revoked is refused past backstopAt.
	 */
	async #revoke(name: string): Promise<void> {
		const dial = this.#dial;
		if (dial === undefined) return;
		const { requestMs } = this.#timeouts;
		const said = (why: string) => this.#onNote?.({ computer: name, note: `its machine token could not be revoked (${why}): it is refused past the machine's backstop either way` });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// Bounded by requestMs: a store that never answers must not hold the socket open or the vendor's delete back.
			const late = await Promise.race([dial.tokens.revoke(name).then(() => false), new Promise<true>((done) => (timer = setTimeout(done, requestMs, true)))]);
			if (late) said(`the token store did not answer within ${requestMs / 1000} s`);
		} catch (error) {
			said(words(error));
		} finally {
			clearTimeout(timer);
			dial.hub.revoke(name, `${name} was deleted`);
		}
	}

	/**
	 * The server's words for a refusal of the machine's dial (MachineTokens refused), or undefined: while none is kept, and
	 * when the token store errs, or does not answer within ms or before signal aborts (the wait goes on to createMs as before).
	 */
	async #dialRefused(name: string, ms: number, signal?: AbortSignal): Promise<string | undefined> {
		const dial = this.#dial;
		if (dial === undefined) return undefined;
		const done = new AbortController();
		try {
			const bound = pause(ms, signal ? AbortSignal.any([signal, done.signal]) : done.signal).then(() => undefined);
			return await Promise.race([dial.tokens.refused(name), bound]);
		} catch {
			return undefined;
		} finally {
			done.abort();
		}
	}

	/** Whether the host takes a spec's user (facts.user): then a computer's daemon runs as the one a spec names. */
	get #takesUser(): boolean {
		return this.host.facts.user !== undefined;
	}

	/** Who one create's daemon runs as, uid:gid: the spec's user where the host takes one, else the provider's daemon user. */
	#userOf(spec: ComputerSpec): string {
		return (this.#takesUser ? specUserOf(spec.user) : undefined) ?? `${this.#uid}:${this.#gid}`;
	}

	/**
	 * Why a spec's labels, with the adapter's own (#labelsOf, as create gives them, each deadline an ISO time at its
	 * longest), are more, or come to more bytes, or pack into more, than the vendor takes (facts.labels); undefined when
	 * they fit.
	 */
	#labelsOver(spec: ComputerSpec): { bytes: boolean; why: string } | undefined {
		const { count, bytes: max, packed } = this.host.facts.labels ?? {};
		// Stand-ins as long as create's name and deadlines and as mixed, fixed so a spec's answer never changes (attach and a
		// retry check the spec again): a packed map deflates them as it does create's, give or take a byte, and create packs
		// its own before the host's call (#stored).
		const name = "computer-5f3a9c1e7b2d";
		const labels = this.#labelsOf(spec, name, "2026-11-16T04:15:29.481Z", "2026-11-17T04:05:29.481Z");
		if (packed) {
			const fit = this.#stored(labels, name);
			return "problem" in fit ? { bytes: true, why: fit.problem } : undefined;
		}
		const keys = Object.keys(labels);
		if (count !== undefined && keys.length > count) {
			// labelProblem refuses a caller's label of the adapter's names, so the two never overlap.
			const own = keys.length - Object.keys(spec.labels ?? {}).length;
			return { bytes: false, why: `${a(this.#label)} computer carries at most ${count} labels, the adapter's own among them, and this one's would carry ${keys.length}, ${own} of them the adapter's: give at most ${count - own} labels` };
		}
		if (max === undefined) return undefined;
		const sizes = Object.entries(labels).map(([key, value]) => [key, Buffer.byteLength(key) + Buffer.byteLength(value)] as const);
		const bytes = sizes.reduce((sum, [, size]) => sum + size, 0);
		if (bytes <= max) return undefined;
		return { bytes: true, why: `${a(this.#label)} computer's labels come to at most ${max} bytes, names and values together, and this computer's would come to ${bytes} (${sizes.map(([key, size]) => `${key} ${size}`).join(", ")}): ${shorterWords(labels)}` };
	}

	/** The labels as the host is given them: packed where it declares facts.labels.packed, else as they are; or why they don't fit packed, in words. */
	#stored(labels: Record<string, string>, name: string): { labels: Record<string, string> } | { problem: string } {
		const room = packedRoom(this.host);
		if (room === undefined) return { labels };
		const fit = packLabels(labels, name, room);
		return "problem" in fit ? { problem: `${a(this.#label)} computer keeps its labels packed, and ${fit.problem}: ${shorterWords(labels)}` } : fit;
	}

	/** A host call bounded by ms, the caller's signal when given. */
	#call<T>(what: string, run: (ctx: HostCall) => Promise<T>, ms: number, signal?: AbortSignal): Promise<Result<T>> {
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
		// Before any call to the vendor, so a machine that could never reach this server is never made or billed.
		const dialed = this.#dialing ? this.#dialed() : undefined;
		if (dialed !== undefined && "problem" in dialed) return this.#fail("refused", dialed.problem);
		const refusals = this.check(spec);
		return this.#requests.create(spec, context, {
			refuse: (code, message) => this.#fail(code, message),
			...(refusals.length > 0 ? { refused: refusals.map(({ field, message }) => `${field}: ${message}`).join("; ") } : {}),
			// The checks #again makes of a computer listed already, made here of the spec in flight: what it gives is shared
			// only with a create that asks the same.
			userOf: (asked) => this.#userOf(asked),
			make: (name) => (dialed === undefined ? this.#createOnce(spec, name, context.signal) : this.#inTurn(dialed.dial.hub, name, context.signal, () => this.#createOnce(spec, name, context.signal))),
		});
	}

	/**
	 * A dial create of one request after any other of it on this server, whichever provider instance makes it. A
	 * machine's token and socket go by the request's name, so two machines of one request must never dial at once: the
	 * second create finds the first's computer instead (#createOnce). One server process is what dial asks for. A caller
	 * that aborts while it waits stops waiting; the turn after it still waits for the create before it.
	 */
	async #inTurn(hub: object, name: string, signal: AbortSignal | undefined, make: () => Promise<Result<CreatedComputer>>): Promise<Result<CreatedComputer>> {
		const turns = DIAL_TURNS.get(hub) ?? new Map<string, Promise<void>>();
		DIAL_TURNS.set(hub, turns);
		const before = turns.get(name) ?? Promise.resolve();
		let done = () => {};
		const mine = before.then(() => new Promise<void>((resolve) => (done = resolve)));
		turns.set(name, mine);
		try {
			if ((await untilAborted(before.then(() => true), [signal])) === undefined) {
				return this.#fail("aborted", "create was aborted while another create of this request was in flight");
			}
			return await make();
		} finally {
			// Once before has settled: a turn that stopped waiting holds the next one no longer than the create before it.
			void before.then(() => done());
			void mine.then(() => {
				if (turns.get(name) === mine) turns.delete(name);
			});
		}
	}

	/** A request's computer given up on or deleted: its request is refused from now on. */
	#end(name: string): void {
		this.#requests.end(name);
	}

	/** How spec's labels differ from labels, a computer's of this request (seen: "read back", or "in flight"), in words. */
	#labelDiffer(spec: ComputerSpec, name: string, labels: Record<string, string>, seen: string): string[] {
		const asked = this.#labelsOf(spec, name, labels[DEADLINE_LABEL] ?? "", labels[MAX_LABEL] ?? "");
		const differ = Object.entries(asked)
			// The GPUs' label is read back as the spec's gpu, held where the user and network are (#again).
			.filter(([key, value]) => key !== DEADLINE_LABEL && key !== MAX_LABEL && key !== GPU_LABEL && labels[key] !== value)
			.map(([key, value]) => `label ${key}: asked ${show(value)}, ${seen} ${show(labels[key])}`);
		const extra = Object.keys(callerLabels(labels)).filter((key) => !Object.hasOwn(asked, key));
		if (extra.length > 0) differ.push(`labels ${extra.join(", ")}: ${seen}, never asked for`);
		return differ;
	}

	/** taken: the vendor refused this create's name as one a machine has (exists), so the name's machine is read once more. */
	async #createOnce(spec: ComputerSpec, name: string, signal?: AbortSignal, taken?: Result<never>): Promise<Result<CreatedComputer>> {
		const listed = await foundBy(this.host, "the listing by the request's name", byName(name), this.#timeouts, signal);
		if (!listed.ok) return listed;
		const found = listed.value.filter((machine) => ours(machine.labels, name));
		if (found.length > 1) return this.#fail("exists", `${found.length} machines carry the name ${name} (${found.map((m) => m.id).join(", ")}): create with a new request id`);
		if (found.length === 1) return this.#again(spec, name, found[0] as Machine, signal);
		if (taken) return taken;
		const launched = await this.#launch(spec, name, signal);
		if (!launched.ok) return launched.error.code === "exists" ? this.#createOnce(spec, name, signal, launched) : launched;
		const { ref, made } = launched.value;
		// From here the machine exists: every step takes the caller's signal, and a failure or an abort deletes it.
		// Another provider instance's create of this request may have made one too (#converge): the oldest is kept.
		const first = await this.#converge(name, ref.id, signal);
		if (first.ok && first.value !== undefined && first.value.id !== ref.id) return this.#again(spec, name, first.value, signal);
		const prepared = await this.#prepare(spec, ref, made, signal);
		const given = this.#given.get(ref.id);
		this.#given.delete(ref.id);
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
		return ok({ ...ref, ...(prepared.value.length > 0 ? { notes: prepared.value } : {}), ...(given === undefined ? {} : { resources: given }) });
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
		const listed = await foundBy(this.host, "the listing by the request's name", byName(name), this.#timeouts, signal);
		if (!listed.ok) return listed;
		const holders = listed.value.filter((machine) => ours(machine.labels, name) && alive(machine.state));
		if (!holders.some((machine) => machine.id !== mine)) return ok(undefined);
		if (!holders.some((machine) => machine.id === mine)) {
			const read = await this.#get(mine, signal);
			if (read.ok && read.value !== undefined && alive(read.value.state)) holders.push(read.value);
		}
		const [kept, ...others] = holders.sort(oldestFirst(holders));
		for (const other of others) {
			const { letGo, gone } = await this.#remove({ id: other.id, name }, other, signal);
			if (!letGo.ok) this.#onNote?.({ computer: name, note: `${other.id}, a second machine of one request, was deleted, and ${letGo.error.message}` });
			if (!gone.ok) return this.#fail(gone.error.code, `${holders.length} machines carry the name ${name}: ${kept?.id}, the oldest, is kept, and ${other.id} could not be deleted (${gone.error.message})`);
		}
		return ok(kept);
	}

	/**
	 * A create of a request whose computer is listed already: the same create, the computer as it is, read by get (a
	 * listing may leave its network out); see create.
	 */
	async #again(spec: ComputerSpec, name: string, first: Machine, signal?: AbortSignal): Promise<Result<CreatedComputer>> {
		const until = Date.now() + this.#timeouts.createMs;
		const read = await this.#get(first.id, signal);
		if (!read.ok) return read;
		let machine = read.value;
		let last: { code: ComputerError["code"]; message: string } | undefined;
		for (;;) {
			if (machine === undefined || (machine.state !== "starting" && machine.state !== "running")) return this.#fail("exists", endedWords(name));
			const deadline = deadlineOf(machine);
			if (deadline !== undefined && deadline.getTime() <= Date.now()) return this.#fail("exists", endedWords(name));
			if (machine.state === "running") {
				const differ = this.#labelDiffer(spec, name, machine.labels, "read back");
				if (differ.length > 0) return this.#fail("exists", otherSpecWords(name, "was made", differ));
				const attached = await this.#attached(machine, signal);
				// The image, an Archil mount and the GPUs are in the labels; the user and the network are read back. No vendor
				// shows a drift in a size.
				const drift = attached.ok ? readBackDiffer({ ...spec, network: networkOfForm(formOf(spec.network)) as NetworkSpec, user: this.#userOf(spec) }, attached.value.spec, ["user", "network", "gpu"]) : [];
				if (drift.length > 0) return this.#fail("exists", otherSpecWords(name, "was made", drift));
				// What the vendor gave it, from this read of it running, as a fresh create answers it (#prepare): a retry, or
				// another instance's computer adopted, is priced by the same figures.
				if (attached.ok) return ok({ id: attached.value.id, name: attached.value.name, ...(attached.value.notes ? { notes: attached.value.notes } : {}), ...(machine.resources ? { resources: machine.resources } : {}) });
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

	/**
	 * The labels create gives a computer: the caller's, the adapter's own, and its mount's (never an Archil token). The
	 * most its deadline may reach only where the host can extend it, the label's one reader: a host with no extend (Modal,
	 * Daytona) spends none of its label bytes on it (Modal's 512 hold the box image's tag beside an Archil mount's label).
	 */
	#labelsOf(spec: ComputerSpec, name: string, deadline: string, maxDeadline: string): Record<string, string> {
		const network = formOf(spec.network);
		return {
			...spec.labels,
			[COMPUTER_LABEL]: "1",
			[NAME_LABEL]: name,
			[DEADLINE_LABEL]: deadline,
			[IMAGE_LABEL]: spec.image,
			...(this.host.extend ? { [MAX_LABEL]: maxDeadline } : {}),
			...(network === "" ? {} : { [NETWORK_LABEL]: network }),
			...(spec.mount?.kind === "archil" ? archilLabels(spec.mount) : spec.mount?.kind === "sync" ? SYNC_LABELS : {}),
			...(typeof spec.gpu?.type === "string" && typeof spec.gpu.count === "number" ? { [GPU_LABEL]: `${spec.gpu.type}:${spec.gpu.count}` } : {}),
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
		// check() packed stand-ins; these deflate a byte apart from them, so the host is never given labels that don't fit.
		const stored = this.#stored(labels, name);
		if ("problem" in stored) return this.#fail("refused", `labels: ${stored.problem}`);
		const archil = spec.mount?.kind === "archil";
		const user = this.#userOf(spec);
		// A desktop whose host runs a window manager has computerd start it (init --window-manager).
		const windowManager = this.#desktop !== undefined && this.host.facts.windowManager === true;
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
			rootOnly: this.host.facts.rootOnly ?? [],
			network: formOf(spec.network),
			// A synced folder's /workspace, the computer's user's, made by install before init.
			workspace: spec.mount?.kind === "sync",
			windowManager,
		});
		const backstopAt = new Date(now + this.#maxLifetimeMs + BACKSTOP_MARGIN_MS).toISOString();
		const run = spec.labels?.[RUN_LABEL];
		const boot = this.#dialing ? await this.#boot(name, backstopAt, { deadline, user, maxDeadline, network: formOf(spec.network), windowManager }, sha256, typeof run === "string" ? run : undefined) : undefined;
		if (boot !== undefined && !boot.ok) return boot;
		const request: MachineRequest = {
			name,
			image: spec.image,
			labels: stored.labels,
			lifetimeMs,
			backstopAt,
			// The machine has egress where its tools' network is open or a list, which init's proxy holds to the public
			// internet (./network.ts), and where an Archil computer's root reaches Archil. Its tools' none is init's own
			// either way, read back by the probe from inside, as the tool user. A dial machine's root reaches this server.
			egress: archil || throughProxy(spec.network) || boot !== undefined,
			...(this.host.facts.daemon === "pid1" && boot === undefined ? { command: commands.entrypoint } : {}),
			...(boot === undefined ? {} : { boot: { env: boot.value } }),
			...(spec.gpu === undefined ? {} : { gpu: spec.gpu }),
			...(spec.cpus === undefined ? {} : { cpus: spec.cpus }),
			...(spec.memoryMb === undefined ? {} : { memoryMb: spec.memoryMb }),
			...(this.#takesUser && spec.user !== undefined ? { user } : {}),
		};
		const { createMs } = this.#timeouts;
		// Never signalled, only raced: an aborted call could leave a machine made whose id never came back. One that lands
		// after this gave up is deleted by its id; one that fails after it, by its name where it may have made one.
		const created = await hostCall(this.host, `${this.#label}'s create`, (ctx) => this.host.create(request, { timeoutMs: ctx.timeoutMs }), createMs, signal, (made) =>
			made.ok ? this.#kill(made.value.id) : mayHaveMade(made.error.code) ? this.#deleteNamed(name) : undefined,
		);
		if (!created.ok) {
			// A machine of this create's that lands after this never dials: its token goes with the create.
			await this.#revoke(name);
			const { code, message } = created.error;
			if (code === "aborted" || code === "timeout") {
				this.#end(name);
				return this.#fail(code, `${message}; a machine it makes after this is deleted as it lands, and ${this.#label} ends it by ${deadline} either way`);
			}
			if (!mayHaveMade(code)) return created;
			this.#end(name);
			const swept = await this.#deleteNamed(name);
			return this.#fail(code, `${this.#label} did not create the machine: ${message}${swept}`);
		}
		this.#requests.made(name);
		return ok({ ref: { id: created.value.id, name }, made: { deadline, maxDeadline, labels, daemon, sha256, commands, user } });
	}

	/**
	 * A dial machine's environment (MachineRequest.boot.env, spec/computer/attach.md): its own token, minted here to stop
	 * at backstopAt and naming the run its labels name (`run`), where it dials and fetches the daemon, the daemon's
	 * sha256, and init's flags as start gives them.
	 */
	async #boot(name: string, backstopAt: string, init: Parameters<typeof initFlags>[0], sha256: string, run: string | undefined): Promise<Result<Record<string, string>>> {
		const dialed = this.#dialed();
		if ("problem" in dialed) return this.#fail("refused", dialed.problem);
		let token: string;
		try {
			token = await dialed.dial.tokens.mint(name, { kind: this.#kind, os: "linux", arch: this.host.facts.arch, expiresAt: new Date(backstopAt), ...(run !== undefined ? { run } : {}) });
		} catch (error) {
			return this.#fail("refused", `minting ${name}'s machine token failed, so ${this.#label} was not called: ${words(error)}`);
		}
		return ok({
			AGENTRUN_ATTACH_URL: dialed.attach,
			AGENTRUN_ATTACH_TOKEN: token,
			AGENTRUN_DAEMON_URL: dialed.daemon,
			AGENTRUN_DAEMON_SHA256: sha256,
			AGENTRUN_INIT_ARGS: initFlags(init).join(" "),
			// A desktop's init gets its display as the exec path's start gives it: DISPLAY, which agentrun-dial passes on.
			...(this.#desktop === undefined ? {} : { DISPLAY: this.#desktop.display }),
			// The relay the machine reaches this server through: agentrun-dial's fetch and computerd attach both dial it.
			...(this.#attachEgress === undefined ? {} : { [ATTACH_EGRESS_ENV]: this.#attachEgress }),
		});
	}

	/** Deletes a machine create gives up on, then waits, under the caller's signal, until get answers none for it. */
	async #abandon(ref: ComputerRef, error: { code: ComputerError["code"]; message: string; vendor?: string }, signal?: AbortSignal, mounted = false): Promise<Result<never>> {
		this.#end(ref.name);
		// A computer create made whole (its Archil folder mounted) lets go of the folder first, as release does.
		const read = mounted ? await this.#get(ref.id) : undefined;
		const { gone } = await this.#remove(ref, read?.ok ? read.value : undefined, signal);
		// The delete is never signalled, so an abort is the wait's, after the delete took.
		const after = gone.ok
			? "was deleted"
			: gone.error.code === "aborted"
				? `was deleted, and the wait for it to go was aborted; ${this.#label} ends it at its deadline if the delete did not take`
				: `could not be deleted (${gone.error.message}); it ends at its deadline`;
		return this.#fail(error.code, `the computer ${ref.name} ${after}: ${error.message}`);
	}

	/**
	 * Every machine carrying a name create gave, deleted and read back gone: for a create that may have made one whose
	 * id never came (mayHaveMade), never after a refusal, where a machine under the name is another's. The
	 * listing shows a new machine a moment after the vendor makes it, so it is read for the name until one shows or
	 * listedMs passes, as create's own wait reads it. Best effort, in words.
	 */
	async #deleteNamed(name: string): Promise<string> {
		const { listedMs, pollMs } = this.#timeouts;
		const until = Date.now() + listedMs;
		let found: Machine[];
		for (let delay = Math.min(LISTED_POLL_MS, pollMs); ; delay = Math.min(delay * 2, pollMs)) {
			const listed = await foundBy(this.host, "the listing by name", byName(name), this.#timeouts);
			if (!listed.ok) return `; a machine named ${name} may be left (${listed.error.message}), which ends at its deadline`;
			found = listed.value.filter((machine) => ours(machine.labels, name));
			if (found.length > 0 || Date.now() >= until) break;
			await pause(Math.min(delay, until - Date.now()));
		}
		if (found.length === 0) return `; no machine named ${name} was listed within ${seconds(listedMs)}, and any it made ends at its deadline`;
		const said: string[] = [];
		for (const machine of found) {
			const { gone } = await this.#remove({ id: machine.id, name }, undefined);
			said.push(gone.ok ? `${machine.id} was deleted and read back gone` : `${machine.id} may be left (${gone.error.message}), which ends at its deadline`);
		}
		return `; the machine named ${name} it made: ${said.join("; ")}`;
	}

	/** The host's delete, never signalled: a delete that cleans up after an abort must outlive it. Not found is done. */
	async #kill(id: string): Promise<Result<void>> {
		const killed = await this.#call(`the delete of ${id}`, (ctx) => this.host.delete(id, ctx), this.#timeouts.requestMs);
		if (!killed.ok && killed.error.code !== "not_found") return killed;
		return ok(undefined);
	}

	/** The pause between two reads of a machine that is starting: the next read comes after it, within createMs. */
	#startPollMs(): number {
		return Math.min(START_POLL_MS, this.#timeouts.pollMs * 10);
	}

	/** The host's get, bounded by requestMs; a machine the vendor reports as not found is none. */
	#get(id: string, signal?: AbortSignal): Promise<Result<Machine | undefined>> {
		return readMachine(this.host, id, this.#timeouts.requestMs, signal);
	}

	/** The machine running, read while it starts (within createMs); gone or failed is refused in words. */
	async #running(ref: ComputerRef, signal?: AbortSignal): Promise<Result<Machine>> {
		const until = Date.now() + this.#timeouts.createMs;
		for (;;) {
			// Its labels are read after this, as written (#prepare).
			const read = await readMachine(this.host, ref.id, this.#timeouts.requestMs, signal);
			if (!read.ok) return read;
			const machine = read.value;
			// A machine the vendor failed is gone in its words: the create stops in them, not at createMs.
			if (machine?.why !== undefined && machine.state === "gone") return this.#fail("vendor", `${this.#label} could not start ${ref.name}: ${machine.why}`);
			if (machine === undefined || machine.state === "gone") return this.#fail("gone", `${ref.name} was gone before it ran`);
			if (machine.state !== "starting") return ok(machine);
			if (Date.now() + this.#startPollMs() >= until) return this.#fail("timeout", `${ref.name} did not start within ${seconds(this.#timeouts.createMs)}`);
			await pause(this.#startPollMs(), signal);
			if (signal?.aborted) return this.#fail("aborted", "create was aborted while the machine started");
		}
	}

	/**
	 * Every way a machine, as the vendor reads it back, differs from what create asked for: its labels and its state. The
	 * rest is read from inside (the daemon, the probe). Pure: no call.
	 */
	#machineDrift(machine: Machine, labels: Record<string, string>): string[] {
		const found: string[] = [];
		for (const [key, value] of Object.entries(labels)) if (machine.labels[key] !== value) found.push(`label ${key}: declared ${show(value)}, read back ${show(machine.labels[key])}`);
		if (machine.state !== "running") found.push(`state: declared "running", read back ${show(machine.state)}`);
		return found;
	}

	/**
	 * Everything between the vendor's answer and a computer that passed the read-back, whose value is what the read-back
	 * recorded that does not refuse it (notes).
	 */
	async #prepare(spec: ComputerSpec, ref: ComputerRef, { labels, daemon, sha256, commands, user }: Made, signal?: AbortSignal): Promise<Result<string[]>> {
		const { uploadMs, execMs } = this.#timeouts;
		const running = await this.#running(ref, signal);
		if (!running.ok) return running;
		if (running.value.resources !== undefined) this.#given.set(ref.id, running.value.resources);
		const drift = this.#machineDrift(running.value, labels);
		if (drift.length > 0) return this.#fail("refused", `it did not match its spec: ${drift.join("; ")}`);
		const gpu = spec.gpu !== undefined;
		const want: Expected = { user, isolation: (gpu ? this.#configuration.gpu?.isolation : undefined) ?? this.host.facts.isolation, gpu };
		// A dial machine's agentrun-dial fetched the daemon, held it to AGENTRUN_DAEMON_SHA256 (this create's daemon's) and
		// started init itself: the drift check holds by that sha, so nothing is installed or read back here.
		if (this.#dialing) return this.#start(spec, ref, commands, want, signal);
		// Before anything of this create's is in the machine: what root runs is root's alone (the Archil helper's sha256,
		// read at the mount's preflight, is read after this).
		if ((this.host.facts.rootOnly ?? []).length > 0) {
			const closed = await runToExit(this.host, ref.id, commands.rootOnly, { ms: execMs, ...(signal ? { signal } : {}), what: `making system paths root's alone in ${ref.name}` });
			if (!closed.ok) return closed;
			if (closed.value.exitCode !== 0) return this.#fail("refused", `making system paths root's alone failed (exit ${closed.value.exitCode}): ${`${closed.value.stdout} ${closed.value.stderr}`.trim().slice(0, 300)}`);
		}
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
			const done = await this.#start(spec, ref, commands, want, signal);
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
		const closed: string[] = [];
		if (this.host.facts.daemon === "child" && !this.#dialing) {
			// The session buses in /tmp, closed to the computer's user before any program of its runs.
			const shut = await runToExit(this.host, ref.id, commands.sockets, { ms: this.#timeouts.execMs, ...(signal ? { signal } : {}), what: `closing the session buses in /tmp in ${ref.name}` });
			if (!shut.ok) return shut;
			if (shut.value.exitCode !== 0) return this.#fail("refused", `closing the session buses in /tmp to the computer's user failed (exit ${shut.value.exitCode}): ${`${shut.value.stdout} ${shut.value.stderr}`.trim().slice(0, 300)}`);
			const found = closedSocketsOf(shut.value.stdout);
			if (found.length > 0) closed.push(`session buses in /tmp closed to the computer's user: ${found.join(", ")}`);
			const init = await runToExit(this.host, ref.id, commands.start, { ms: this.#timeouts.execMs, ...(signal ? { signal } : {}), what: `starting the daemon in ${ref.name}` });
			if (!init.ok) return init;
			if (init.value.exitCode !== 0) return this.#fail("refused", `starting the daemon failed (exit ${init.value.exitCode}): ${`${init.value.stdout} ${init.value.stderr}`.trim().slice(0, 500)}`);
		}
		const opened = this.#dialing ? await this.#whenDialed(ref, signal) : await this.#openWhenListening(ref, signal);
		if (!opened.ok) {
			if (opened.error.code === "aborted" || this.#dialing) return opened;
			const why = await this.#initWords(ref);
			return this.#fail(opened.error.code, `the daemon did not answer: ${opened.error.message}${why ? `; init wrote: ${why}` : ""}`);
		}
		let notes: string[];
		try {
			const mount = spec.mount?.kind === "archil" ? { kind: "archil" as const, disk: spec.mount.disk, region: spec.mount.region, folder: spec.mount.folder } : spec.mount?.kind === "sync" ? spec.mount : undefined;
			const expected = mount === undefined ? undefined : recordedFolderOf(spec.labels, { mount });
			const inside = await this.#checkInside(opened.value, ref.name, networkOfForm(formOf(spec.network)), true, want, signal, expected);
			if (!inside.ok) return inside;
			notes = inside.value;
		} finally {
			await opened.value.close();
		}
		const listed = await this.#waitListed(ref, signal);
		return listed.ok ? ok([...closed, ...notes]) : listed;
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
	 * refuses on an answer and records a silent accept in the notes it returns; and, for an Archil computer or a synced
	 * folder, the mount read back from inside, held to the one expected. want.user is the uid:gid the daemon runs as (undefined: read back,
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
		folder?: RecordedFolder,
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
		if (typeof network === "string" || !("other" in network)) {
			const read = await this.#networkDrift(current, name, network, signal);
			if (!read.ok) return read;
			user = `${read.value.probe.uid}:${read.value.probe.gid}`;
			drift.push(...read.value.drift, ...runtimeDrift(want, read.value.probe.kernel));
			notes.push(...probeNotes(read.value.probe, network));
		}
		// Which way init fenced its programs, as hello read it back: said once a way other than the plain one was taken.
		if (starting && current.hello.fence === "userns-netns") {
			notes.push(`fence: userns-netns: init made its programs' network namespace inside a user namespace of its own, as root on ${want.isolation ?? "this machine"} may not make one itself`);
		}
		const said = user === undefined ? {} : { user };
		if (folder === undefined) return drift.length === 0 ? { ...ok(notes), ...said } : this.#fail("refused", `it did not match its spec: ${drift.join("; ")}`);
		const mount = await readMount(current.client, folder, { name, timeoutMs: this.#timeouts.helloMs, ...(signal ? { signal } : {}) });
		if (!mount.ok) return mount;
		drift.push(...mountDrift(folder.expected, mount.value));
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
			...(this.#archilEgress ? { egress: this.#archilEgress } : {}),
			...(signal ? { signal } : {}),
		});
	}

	/** What the daemon must report: the user given (uid:gid), or, with none, any one user that is not root. */
	#daemonExpected(user?: string): DaemonExpected {
		const { kind, groups } = this.capabilities();
		const [uid, gid] = user === undefined ? [] : user.split(":");
		return { version: VERSION, ...(uid === undefined || gid === undefined ? {} : { uid, gid }), arch: this.host.facts.arch, kind, groups };
	}

	/** One stdio bridge into the machine, after hello, unchecked; its client says so once the machine is deleted. */
	async #open(ref: ComputerRef, signal?: AbortSignal, helloMs = this.#timeouts.helloMs): Promise<Opened> {
		const { requestMs } = this.#timeouts;
		if (this.#dialing) {
			// A dial machine's connection is over the socket it dialed, which the hub holds under its name: a drop fails the
			// calls in flight gone, and the first call after a redial is refused gone (attach.ts, AttachHub.connection).
			const connection = this.#dial?.hub.connection(ref.name);
			if (connection === undefined) return this.#fail("gone", `${ref.name} is not attached to this server now: its computerd dials back on its own, so try again shortly`);
			// The hub holds the hello of the machine's dial; a desktop's display answered after it, so each open asks again,
			// as a bridge's open does.
			const hello = await connection.client.call("hello", { client: `@parcha/agentrun-computer ${VERSION}` }, { signal: bounded(helloMs, signal) });
			if (!hello.ok) {
				await connection.close();
				return hello.error.code === "aborted" && !signal?.aborted ? this.#fail("timeout", `the daemon in ${ref.name} did not answer hello within ${seconds(helloMs)}`) : hello;
			}
			return ok(deletedSaid(this.host, ref, this.#label, requestMs, { ...connection, hello: hello.value }));
		}
		const opened = await openBridge(this.host, ref.id, { argv: hostedCommands().stdio, name: ref.name, version: VERSION, requestMs, helloMs, ...(signal ? { signal } : {}) });
		return opened.ok ? ok(deletedSaid(this.host, ref, this.#label, requestMs, opened.value)) : opened;
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

	/**
	 * A dial machine's first connection: its socket waited for in the hub, from its start, within createMs. One that never
	 * dials (a server it cannot reach, a daemon whose sha256 it refused, a hello the hub refused) fails timeout, naming the
	 * address it was given. One the server refused in words (a relay to this runner it could not make, MachineTokens
	 * refused) fails refused in those words as the read answers. The read, one at a time, bounded by requestMs, the time
	 * left and the signal, holds no poll of the hub back, and the hub is read once more before a timeout: a socket there
	 * wins. Create then deletes one that failed.
	 */
	async #whenDialed(ref: ComputerRef, signal?: AbortSignal): Promise<Opened> {
		const { createMs, requestMs } = this.#timeouts;
		const until = Date.now() + createMs;
		let reading: Promise<string | undefined> | undefined;
		for (;;) {
			const opened = await this.#open(ref, signal);
			if (opened.ok) return opened;
			const left = until - Date.now();
			if (left <= 0) {
				const dialed = this.#dialed();
				const to = "problem" in dialed ? "this server" : dialed.attach;
				const through = this.#attachEgress === undefined ? "" : ` through ${this.#attachEgress}`;
				return this.#fail("timeout", `${ref.name} did not dial ${to}${through} within ${seconds(createMs)}: the machine must reach that address, and run agentrun-dial (the box image's entrypoint while AGENTRUN_ATTACH_URL is set, or the provider's own start of it)${await this.#dialWords(ref, signal)}`);
			}
			const polled = pause(Math.min(this.#startPollMs(), left), signal).then(() => false as const);
			reading ??= this.#dialRefused(ref.name, Math.min(requestMs, left), signal);
			const read = await Promise.race([reading, polled]);
			if (read !== false) {
				reading = undefined;
				if (read !== undefined) return this.#fail("refused", `the server refused ${read}`);
				await polled;
			}
			if (signal?.aborted) return this.#fail("aborted", `create was aborted while it waited for ${ref.name} to dial`);
		}
	}

	/**
	 * A dial timeout's last words: what the host's dialLog read of agentrun-dial, its last DIAL_LOG_LINES lines within
	 * DIAL_LOG_CHARS characters, or that it never started. Nothing for a host without dialLog, or a read that fails,
	 * outlasts requestMs or is cut by the create's signal, so a cancel never waits on it.
	 */
	async #dialWords(ref: ComputerRef, signal?: AbortSignal): Promise<string> {
		const { dialLog } = this.host;
		if (dialLog === undefined) return "";
		const read = await this.#call(`the dial log of ${ref.name}`, (ctx) => dialLog.call(this.host, ref.id, ctx), this.#timeouts.requestMs, signal);
		if (!read.ok) return "";
		if (read.value === undefined) return "; agentrun-dial never started";
		const lines = read.value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
		return lines.length === 0 ? "; agentrun-dial wrote nothing" : `; agentrun-dial said: ${lines.slice(-DIAL_LOG_LINES).join(" | ").slice(-DIAL_LOG_CHARS)}`;
	}

	/**
	 * Its tools' network as they meet it, against the one create made: the probe, as the computer's own user. Under none,
	 * no target answers. Under open or a list, still none answers directly (their own loopback alone), init's relay
	 * answers (the one way out, to the proxy), and the proxy's policy beside its socket holds the form create asked for.
	 */
	async #networkDrift(connection: ComputerConnection, name: string, network: NetworkSpec, signal?: AbortSignal): Promise<Result<{ drift: string[]; probe: ProbeReport }>> {
		if (network === "none") {
			const probe = await this.#probe(connection, name, signal);
			return probe.ok ? ok({ drift: probeNetworkDrift(probe.value), probe: probe.value }) : probe;
		}
		const probe = await this.#probe(connection, name, signal, [...this.#probeTargets, EGRESS_RELAY]);
		if (!probe.ok) return probe;
		const form = formOf(network);
		const drift: string[] = [];
		const direct = probe.value.reached.filter((target) => target !== EGRESS_RELAY);
		if (direct.length > 0) drift.push(`network: declared ${form} through the egress proxy alone, read back a direct answer from ${direct.join(", ")}`);
		if (!probe.value.reached.includes(EGRESS_RELAY)) drift.push(`network: declared ${form} through the egress proxy, and init's relay at ${EGRESS_RELAY} did not answer from inside`);
		const { helloMs } = this.#timeouts;
		const policy = await connection.client.call("files.read", { path: EGRESS_POLICY }, { signal: bounded(helloMs, signal) });
		if (!policy.ok) {
			if (policy.error.code === "aborted") return signal?.aborted ? this.#fail("aborted", `reading ${EGRESS_POLICY} in ${name} was aborted`) : this.#fail("timeout", `reading ${EGRESS_POLICY} in ${name} did not answer within ${seconds(helloMs)}`);
			drift.push(`network: declared ${form}, and the egress proxy's policy ${EGRESS_POLICY} could not be read: ${policy.error.message}`);
		} else {
			const served = Buffer.from(policy.value.data, "base64").toString("utf8");
			if (served !== `${form}\n`) drift.push(`network: declared ${form}, the egress proxy serves ${show(served.trim().slice(0, 300))}`);
		}
		return ok({ drift, probe: probe.value });
	}

	/** `computerd probe` through the daemon, so it runs as the computer's own user: to targets, the configured ones by default. */
	async #probe(connection: ComputerConnection, name: string, signal?: AbortSignal, targets: readonly string[] = this.#probeTargets): Promise<Result<ProbeReport>> {
		const { probeMs } = this.#timeouts;
		const argv = [DAEMON_IN_COMPUTER, "probe", ...targets.flatMap((target) => ["--connect", target])];
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
	 * The polls are 150 ms apart at first, the pause doubling up to pollMs, so a vendor slow to list costs a few calls.
	 */
	async #waitListed(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		const { listedMs, listMs, pollMs, listedStableMs } = this.#timeouts;
		const until = Date.now() + listedMs;
		let since: number | undefined;
		for (let hits = 0, delay = Math.min(LISTED_POLL_MS, pollMs); ; delay = Math.min(delay * 2, pollMs)) {
			const listed = await listedBy(this.host, "the listing by name", byName(ref.name), listMs, signal);
			if (!listed.ok) return listed;
			if (listed.value.some((machine) => machine.id === ref.id)) {
				hits += 1;
				since ??= Date.now();
			} else [hits, since] = [0, undefined];
			if (hits >= LISTED_ROUNDS && since !== undefined && Date.now() - since >= listedStableMs) return ok(undefined);
			if (Date.now() >= until) return this.#fail("timeout", `the computer was not listed within ${seconds(listedMs)} of its creation`);
			await pause(Math.min(delay, until - Date.now()), signal);
			if (signal?.aborted) return this.#fail("aborted", "create was aborted while it waited for the listing");
		}
	}

	/** This provider's machine for ref, as the vendor reads it, or why not. */
	async #own(ref: ComputerRef, signal?: AbortSignal): Promise<Result<Machine>> {
		const found = await this.#get(ref.id, signal);
		if (!found.ok) return found;
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
		// A machine on its way out (past its deadline or released, the vendor still deleting it) is gone, not merely stopped.
		if (found.value.state === "gone") return this.#fail("gone", `${ref.name} passed its deadline or was released: it is going`);
		if (found.value.state !== "running") return this.#fail("refused", `${ref.name} is ${found.value.state}, not running: its daemon does not run`);
		const opened = await this.#open(ref);
		if (!opened.ok) return opened;
		const { kind, groups } = this.capabilities();
		// A desktop whose display is down says linux (an X server that died): drift, on dial as on exec.
		const drifted = helloDrift(opened.value.hello, { version: VERSION, kind, groups, arch: this.host.facts.arch, fence: true });
		// An Archil computer's client syncs the run's folder after every call that may change it, before it answers. A synced
		// folder's sync is its runner's (the sink is serve's), which wraps the client itself.
		if (drifted.length === 0) return recordedFolder(found.value.labels)?.mount?.kind !== "archil" ? opened : ok({ ...opened.value, client: syncingClient(opened.value.client, archilSync(opened.value.client)) });
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
			if (!found.ok) return found;
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
		const folder = recordedFolder(machine.labels);
		// Its tools' network as create recorded it, read from inside (#checkInside: the probe, and the proxy's policy):
		// no vendor's read of it is taken.
		const network = networkOfForm(machine.labels[NETWORK_LABEL]);
		const image = machine.labels[IMAGE_LABEL] ?? "";
		const spec = { image, lifetimeMs: 1, network, labels: callerLabels(machine.labels) } as ComputerSpec;
		found.push(...this.check(spec).map(({ field, message }) => `${field}: ${message}, read back from the computer`));
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
				const want = this.#takesUser ? (folder?.mount?.kind !== "archil" ? {} : { user: ARCHIL_USER }) : { user: `${this.#uid}:${this.#gid}` };
				const inside = await this.#checkInside(opened.value, name, network, false, want, signal, folder);
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
		} else if (folder !== undefined) found.push(`mount: ${name} is ${machine.state}, so its mount cannot be read back from inside`);
		if (found.length > 0) return this.#fail("refused", `the computer ${name} does not match this provider, so attach refuses it and it is left as it is: ${found.join("; ")}`);
		return ok({
			...ref,
			spec: {
				image,
				user: (this.#takesUser ? user : undefined) ?? `${this.#uid}:${this.#gid}`,
				network,
				workdir: WORK,
				...(deadline === undefined ? {} : { deadline }),
				...(kind === undefined ? {} : { kind }),
				...(mount === undefined ? {} : { mount }),
				...gpuOf(machine.labels[GPU_LABEL]),
			},
			...(notes.length > 0 ? { notes } : {}),
		});
	}

	/**
	 * Settings' test: one list by the adapter's label, its computers counted as the listing reads them (no get of each),
	 * which makes nothing; a refused key is unauthorized, a vendor not reached unreachable, the message never carrying a key.
	 */
	async testConnection({ signal }: CallContext = {}): Promise<Result<{ detail: string }>> {
		const listed = await listedBy(this.host, "the listing", { [COMPUTER_LABEL]: "1" }, this.#timeouts.listMs, signal);
		const counted = (machine: Machine) => ours(machine.labels) && alive(machine.state);
		return countTested(this.#label, listed.ok ? ok({ count: listed.value.filter(counted).length }) : listed);
	}

	/**
	 * Every computer this provider made that carries all of these labels, running or stopped: the listing finds them, and
	 * a get of each reads its state, labels and end (foundBy). Its network is the one its label records, as create made
	 * it (none without one); attach and network() read it from inside.
	 */
	async list(labels: Record<string, string>, { signal }: CallContext = {}): Promise<Result<ComputerInfo[]>> {
		const problem = filterProblem(labels);
		if (problem) return this.#fail("invalid", problem);
		const { listMs } = this.#timeouts;
		const listed = await foundBy(this.host, "the listing", { ...labels, [COMPUTER_LABEL]: "1" }, this.#timeouts, signal);
		if (!listed.ok) return listed.error.code === "timeout" ? this.#fail("timeout", `list did not finish within ${seconds(listMs)}: ${listed.error.message}`) : listed;
		const infos: ComputerInfo[] = [];
		for (const machine of listed.value) {
			if (!ours(machine.labels) || (machine.state !== "running" && machine.state !== "stopped")) continue;
			// list runs nothing in a computer: a computer's mount is the one its label records, under its epoch label.
			const folder = recordedFolder(machine.labels);
			infos.push({
				ref: { id: machine.id, name: machine.labels[NAME_LABEL] as string },
				labels: { ...machine.labels },
				deadline: deadlineOf(machine),
				state: machine.state,
				network: networkOfForm(machine.labels[NETWORK_LABEL]),
				...(folder === undefined ? {} : { mount: folder.expected }),
			});
		}
		return ok(infos);
	}

	/** The probe and the proxy's policy read the network back from inside. A change is refused: it is fixed at create. */
	async network(ref: ComputerRef, policy?: NetworkSpec, { signal }: CallContext = {}): Promise<Result<NetworkPolicy>> {
		const problem = this.#refProblem(ref);
		if (problem) return this.#fail("invalid", problem);
		const fixed = `${a(this.#label)} computer's network is fixed at create: create a new computer`;
		const refused = policy === undefined ? undefined : networkRefusal(this.#label, this.capabilities().network, policy);
		if (refused) return this.#fail("refused", `${refused}; ${fixed}`);
		const found = await this.#own(ref, signal);
		if (!found.ok) return found;
		const recorded = networkOfForm(found.value.labels[NETWORK_LABEL]);
		let read: NetworkPolicy = recorded;
		// Its tools' network is read from inside, as the tool user, whatever the vendor's network is (an Archil computer's
		// root reaches Archil, an open one's proxy the internet): the daemon's own network namespace's live interfaces are
		// lo alone, none can be raised (computerd probe), no probe target answers directly, and an open or listed one's
		// relay and proxy serve what its label records.
		if (found.value.state === "running" && (typeof recorded === "string" || !("other" in recorded))) {
			const opened = await this.#open(ref, signal);
			if (!opened.ok) return opened;
			try {
				const own = await readOwnNetwork(opened.value.client, this.#timeouts.helloMs, bounded(this.#timeouts.helloMs, signal));
				if (!own.ok) return this.#fail(own.error.code, `${ref.name}: ${own.error.message}`);
				const drift = await this.#networkDrift(opened.value, ref.name, recorded, signal);
				if (!drift.ok) return drift;
				const found = [...own.value, ...drift.value.drift];
				if (found.length > 0) read = { other: `its tools' network was created ${policyWords(recorded)}, yet from inside: ${found.join("; ")}` };
			} finally {
				await opened.value.close();
			}
		}
		if (policy === undefined || isDeepStrictEqual(networkOfForm(formOf(policy)), read)) return ok(read);
		return this.#fail("refused", `${fixed}: ${ref.name} reads back network ${policyWords(read)}, not ${policyWords(policy)}`);
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
	 * Moves the deadline to now + ttlMs, refusing one earlier than it is (before any vendor call), never past create's time
	 * plus the cap (init's maximum): the host's extend first (its timer or its deadline label), then the end it reads back
	 * (get, deadlineOf), then init's own deadline, to that end. The deadline returned is the one init took. A host that
	 * keeps labels in the machine has no extend (the constructor).
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
		const extend = this.host.extend?.bind(this.host);
		if (!extend) return this.#fail("unsupported", `${a(this.#label)} computer's deadline cannot move`);
		const moved = await this.#call(`${this.#label}'s end of ${ref.name}`, (ctx) => extend(ref.id, new Date(target), ctx), this.#timeouts.requestMs, signal);
		if (!moved.ok) return moved.error.code === "limit" ? moved : this.#fail(moved.error.code, `${this.#label} did not move ${ref.name}'s end, so nothing did: ${moved.error.message}`);
		const after = await this.#get(ref.id, signal);
		const end = after.ok && after.value !== undefined ? deadlineOf(after.value) : undefined;
		if (end === undefined) {
			const why = !after.ok ? after.error.message : after.value === undefined ? `${ref.name} is gone` : `${ref.name} reads back no deadline`;
			return this.#fail(!after.ok ? after.error.code : after.value === undefined ? "gone" : "refused", `${this.#label} was asked to move ${ref.name}'s end, and reading it back failed: ${why}; init's deadline did not move`);
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
	 * has is ok. The vendor answers a delete before the machine is gone, so release then waits (#settle) until get
	 * answers none (twice running), within goneMs and the caller's signal, the one step the signal ends. A running
	 * Archil computer lets go of the run's folder first (archilRelease: the final sync through computerd, then checkin as
	 * root); the delete runs whatever that answers. A folder not let go cleanly loses nothing (every call that changed it
	 * synced, and the next claim revokes the hold), so it is said through onNote, and the release succeeds once the
	 * machine is gone. A computer here is deleted, never stopped: release stop is refused in words.
	 */
	async release(ref: ComputerRef, how: ReleaseHow, { signal }: ReleaseContext = {}): Promise<Result<void>> {
		const problem = this.#refProblem(ref);
		if (problem) return this.#fail("invalid", problem);
		if (how === "detach") return this.#fail("unsupported", `the ${this.#label} provider keeps no computer for an agent (it declares no persistence), so release detach is refused: release it with delete`);
		if (how === "stop") return this.#fail("unsupported", `${a(this.#label)} computer is deleted, never stopped and kept: release it with delete`);
		if (how !== "delete") return this.#fail("invalid", `release is "delete", not ${String(how)}`);
		const found = await this.#get(ref.id);
		if (!found.ok) return found;
		if (found.value === undefined) {
			// Gone already (deleted by hand, or the vendor's timer): its token and socket still go.
			await this.#revoke(ref.name);
			return ok(undefined);
		}
		if (!ours(found.value.labels, ref.name)) return this.#fail("not_found", `no ${this.#label} computer is ${ref.name} (${ref.id}): the machine is not this provider's, so it is left as it is`);
		this.#end(ref.name);
		const { letGo, gone: done } = await this.#remove(ref, found.value, signal);
		if (letGo.ok) return done;
		if (!done.ok) return this.#fail(done.error.code, `${done.error.message}; and ${letGo.error.message}`);
		this.#onNote?.({ computer: ref.name, note: `${ref.name} was deleted, and ${letGo.error.message}` });
		return done;
	}

	/**
	 * The one delete: machine's folder let go first (where it is a running Archil computer, as read; none for undefined),
	 * then the host's delete, then the wait until get answers none for it. The callers word what failed.
	 */
	async #remove(ref: ComputerRef, machine: Machine | undefined, signal?: AbortSignal): Promise<{ letGo: Result<void>; gone: Result<void> }> {
		const letGo = await this.#letGoOf(ref, machine, signal);
		await this.#revoke(ref.name);
		const killed = await this.#kill(ref.id);
		return { letGo, gone: killed.ok ? await this.#settle(ref, signal) : killed };
	}

	/**
	 * #letGo where machine, as read, is a running Archil computer: a stopped one holds no folder, and a synced folder's
	 * final delta is its runner's, before it releases.
	 */
	#letGoOf(ref: ComputerRef, machine: Machine | undefined, signal?: AbortSignal): Promise<Result<void>> {
		const folder = machine === undefined ? undefined : recordedFolder(machine.labels);
		return folder !== undefined && folder.mount?.kind !== "sync" && machine?.state === "running" ? this.#letGo(ref, signal) : Promise.resolve(ok(undefined));
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

	/** Waits until the vendor reads the machine gone after its delete (settle). */
	#settle(ref: ComputerRef, signal?: AbortSignal): Promise<Result<void>> {
		return settle(this.host, ref, { ...this.#timeouts, ...(signal ? { signal } : {}) });
	}
}

/** The labels a listing by one computer's name asks for. */
const byName = (name: string): Record<string, string> => ({ [COMPUTER_LABEL]: "1", [NAME_LABEL]: name });

/** The room of a host that keeps its labels packed (facts.labels.packed), or undefined. */
function packedRoom(host: MachineHost): NonNullable<HostFacts["labels"]> | undefined {
	const room = host.facts.labels;
	return room?.packed ? room : undefined;
}

/** A machine as the host read it, with a packed host's labels unpacked: none where it holds no packed map (not the adapter's). */
const unpacked = (host: MachineHost, machine: Machine): Machine => (packedRoom(host) === undefined ? machine : { ...machine, labels: unpackLabels(machine.labels) ?? {} });

/**
 * The host's listing by labels, bounded by ms: only the machines that carry every one of them, since a vendor's listing
 * may answer more (MachineHost.list). A packed host is asked for PACKED_NAME alone, the name's where one is asked, and
 * its machines' labels unpacked.
 */
export async function listedBy(host: MachineHost, what: string, labels: Record<string, string>, ms: number, signal?: AbortSignal): Promise<Result<Machine[]>> {
	const name = labels[NAME_LABEL];
	const asked = packedRoom(host) === undefined ? labels : name === undefined ? {} : { [PACKED_NAME]: name };
	const listed = await hostCall(host, what, (ctx) => host.list(asked, ctx), ms, signal);
	return listed.ok ? ok(listed.value.map((machine) => unpacked(host, machine)).filter((machine) => carries(machine, labels))) : listed;
}

/** Whether a machine carries every one of these labels. */
const carries = (machine: Machine, labels: Record<string, string>) => Object.entries(labels).every(([key, value]) => machine.labels?.[key] === value);

/**
 * The listing finds, get answers (MachineHost.list): the machines the host's listing by labels names, each read now by
 * readMachine, within requestMs. One the vendor no longer has (not found) is dropped, and so is one whose get carries
 * not every label. A get that fails fails the whole listing.
 */
export async function foundBy(host: MachineHost, what: string, labels: Record<string, string>, { listMs, requestMs }: Pick<HostedTimeouts, "listMs" | "requestMs">, signal?: AbortSignal): Promise<Result<Machine[]>> {
	const listed = await listedBy(host, what, labels, listMs, signal);
	if (!listed.ok) return listed;
	const reads = await Promise.all(listed.value.map(({ id }) => readMachine(host, id, requestMs, signal)));
	const found: Machine[] = [];
	for (const read of reads) {
		if (!read.ok) return read;
		if (read.value !== undefined && carries(read.value, labels)) found.push(read.value);
	}
	return ok(found);
}

/**
 * The host's get of one machine, bounded by ms, a packed host's labels unpacked: a machine the vendor reports as not
 * found is none, never an error.
 */
async function readMachine(host: MachineHost, id: string, ms: number, signal?: AbortSignal): Promise<Result<Machine | undefined>> {
	const read = await hostCall(host, `the read of ${id}`, (ctx) => host.get(id, ctx), ms, signal);
	if (!read.ok) return read.error.code === "not_found" ? ok(undefined) : read;
	return ok(read.value === undefined ? undefined : unpacked(host, read.value));
}

/** What reading answers, or undefined once a signal aborts first: a caller that stopped waiting never waits on a read. */
function untilAborted<T>(reading: Promise<T>, signals: readonly (AbortSignal | undefined)[]): Promise<T | undefined> {
	const given = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (given.length === 0) return reading;
	const signal = AbortSignal.any(given);
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((settle) => {
		const onAbort = () => settle(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		reading.then((value) => {
			signal.removeEventListener("abort", onAbort);
			settle(value);
		});
	});
}

/**
 * A connection that says its computer was deleted (the vendor's own API can delete it mid-run). Once its client answers
 * gone (the stream ended or failed), the machine is read once, and that one read answers every call in flight at that
 * moment and every later call. A machine the vendor no longer has, or reads gone with no why (going), makes each of them
 * not_found in these words; one still there, a failed one, or a read that failed, leaves the client's own answer, as does
 * a caller's abort or a close during the read. A call with no answer by its own timeout answers timeout at once, as the
 * client says; the machine is read beside it, and a deleted one ends the connection, so every call still waiting on the
 * hung transport and every later call answers not_found. A connection its caller closed is never read back.
 */
function deletedSaid(host: MachineHost, ref: ComputerRef, label: string, requestMs: number, connection: ComputerConnection): ComputerConnection {
	const { client } = connection;
	const closing = new AbortController();
	let deleted: ComputerError | undefined;
	let ended: Promise<ComputerError | undefined> | undefined;
	let checking: Promise<ComputerError | undefined> | undefined;
	const read = async (): Promise<ComputerError | undefined> => {
		const got = await readMachine(host, ref.id, requestMs, closing.signal);
		// Gone with no why is being deleted; a failed machine (gone with its why) keeps the client's own answer.
		if (got.ok && (got.value === undefined || (got.value.state === "gone" && got.value.why === undefined)) && deleted === undefined && !closing.signal.aborted) {
			const how = got.value === undefined ? `${label} no longer has it` : `${label} reads it going`;
			deleted = { code: "not_found", message: `the computer ${ref.name} (${ref.id}) was deleted: ${how}` };
			// Every call still waiting on the transport settles now, with these words, as later ones do.
			void connection.close();
		}
		return deleted;
	};
	const close = () => {
		closing.abort();
		return connection.close();
	};
	return {
		...connection,
		client: {
			async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options?: { signal?: AbortSignal }): Promise<Result<DaemonMethods[M]["result"]>> {
				if (deleted) return { ok: false, error: deleted };
				const answered = await client.call(method, params, options);
				if (answered.ok) return answered;
				if (deleted) return { ok: false, error: deleted };
				if (closing.signal.aborted) return answered;
				if (answered.error.code === "timeout") {
					checking ??= read().finally(() => (checking = undefined));
					return answered;
				}
				if (answered.error.code !== "gone") return answered;
				const found = await untilAborted((ended ??= read()), [options?.signal, closing.signal]);
				return found ? { ok: false, error: found } : answered;
			},
			close() {
				void close();
			},
		},
		close,
	};
}

/**
 * Waits, through waitUntil, until get answers none for a machine after its delete, twice running: the vendor no longer
 * has it. A machine read gone is still going (a vendor still destroying it), so it holds the wait like any other state.
 * A listing may show a deleted machine for a while (MachineHost.list), so it is not read. Pauses double from pollMs to
 * 5 s, bounded by goneMs and the caller's signal; a failed read ends the wait with that error. Shared with the live sweep.
 */
export async function settle(
	host: MachineHost,
	ref: ComputerRef,
	{ requestMs, pollMs, goneMs, signal }: Pick<HostedTimeouts, "requestMs" | "pollMs" | "goneMs"> & { signal?: AbortSignal },
): Promise<Result<void>> {
	const fail = failFor(host.descriptor.id);
	type Read = { failed: Result<never> } | { settled: true } | { last: string };
	let agreed = 0;
	let last = "unread";
	const read = async (readSignal: AbortSignal): Promise<Read> => {
		const got = await readMachine(host, ref.id, requestMs, readSignal);
		if (!got.ok) {
			if (got.error.code === "aborted") return { last };
			return { failed: fail(got.error.code, `release of ${ref.name}: reading it back failed (${got.error.message}); it last read ${last}`) };
		}
		const state = got.value?.state;
		last = state ?? "gone (not found)";
		if (state !== undefined) {
			agreed = 0;
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

/** What the read-back inside a computer holds it to, beside its spec: its daemon's user and the isolation declared. */
interface Expected {
	user?: string;
	/** The isolation declared for this computer: a GPU computer's own where its GPUs declare one (Modal's gVisor). */
	isolation?: ComputerCapabilities["isolation"];
	gpu?: boolean;
}

/** The probe's kernel against the isolation declared: gVisor exactly where it says gvisor, never where it says vm. */
function runtimeDrift({ isolation, gpu }: Expected, kernel: string): string[] {
	const gvisor = /gvisor/i.test(kernel);
	if (isolation === "vm" && gvisor) return [`runtime: declared vm, read back gVisor (the kernel reports ${JSON.stringify(kernel)})`];
	if (isolation === "gvisor" && !gvisor) return [`runtime: declared gVisor${gpu ? " (a GPU computer)" : ""}, read back another kernel (${JSON.stringify(kernel)})`];
	return [];
}

function labelProblem(key: string, value: unknown): string | undefined {
	if (typeof value !== "string") return `the label ${key} must be a string`;
	if (key.includes("\0") || value.includes("\0")) return `the label ${JSON.stringify(key)}: a NUL byte cannot be sent to the vendor`;
	if (key === "") return "a label name must be non-empty";
	if (key === COMPUTER_LABEL || key.startsWith(`${COMPUTER_LABEL}.`)) return `the label ${key} is in the provider's own namespace (${COMPUTER_LABEL})`;
	if (key === MOUNT_LABEL) return `the label ${key} is the provider's own: it records a computer's mount`;
	return undefined;
}

/** "a" or "an" before a vendor's name, by its first letter. */
function a(label: string): string {
	return `${/^[AEIOU]/i.test(label) ? "an" : "a"} ${label}`;
}

/** A spec's network as init's form (networkFormOf): "" for none, and for a network check() refuses. */
function formOf(network: unknown): string {
	try {
		return networkFormOf(network as NetworkSpec);
	} catch {
		return "";
	}
}
