// The boxd host: boxd machines (KVM microVMs, Ubuntu 24.04) as a MachineHost, through @boxd-sh/sdk (an optional dependency), of
// which this file names only the slice it calls (every fact from 0.3.1's dist/*.d.ts) and imports nothing at load.
// boxd's agent runs every command in a machine, so computerd is a child. The daemon, the bridge, the probe, idempotent
// create, extend and delete-then-wait-gone are the shared adapter's (./hosted/provider.ts). A desktop starts from a
// snapshot of boxd's own image with a stock app added, which prepareImage() builds once in the key's org.
import { createHash, randomBytes } from "node:crypto";
import { BOXD, BOXD_DEFAULT_IMAGE } from "./descriptors/boxd.js";
import { DEADLINE_LABEL, show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { CALL_SLACK_MS, codeOfError, orThrow, pause, race, runChecked, until } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, mayHaveMade } from "./hosted/provider.js";
import { httpsBase } from "./hosted/rest.js";
import { shellLine } from "./hosted/scripts.js";
import { dateOf } from "./hosted/values.js";
import type { CallContext, ComputerSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, failFor, ok, type Result } from "./result.js";
import { vendorSdk } from "./vendor-sdk.js";

/** A machine as the SDK reports it (Machine, models.d.ts), as far as this host reads it. */
export interface BoxdMachine {
	id: string;
	name: string;
	status: string;
	labels: Record<string, string>;
	org: { id: string; name: string } | null;
	createdAt: Date | null;
}

/** A streamed exec (ExecStream, exec.d.ts): stdout is the stream itself. */
export interface BoxdExecStream extends AsyncIterable<Uint8Array> {
	readonly stderr: AsyncIterable<Uint8Array>;
	write(data: Uint8Array): void;
	end(): void;
	wait(): Promise<number>;
	close(): void;
}

/** The SDK's machines namespace, as far as this host calls it (Machines, machines.d.ts). */
export interface BoxdMachines {
	/** deleteAfter: seconds from now until boxd deletes the machine, whatever it is doing. */
	create(params: { name: string; org?: string; labels?: Record<string, string>; isolated: true; config: { autoSuspendTimeout: 0; vcpu?: number; memory?: string }; fromSnapshot?: string; deleteAfter?: number }): Promise<BoxdMachine>;
	get(id: string): Promise<BoxdMachine>;
	list(params: { org?: string; labels: Record<string, string> }): Promise<Iterable<BoxdMachine>>;
	delete(id: string): Promise<void>;
	streamExec(id: string, params: { command: string }): BoxdExecStream;
	readonly files: { upload(id: string, path: string, data: Uint8Array): Promise<number> };
	waitUntilReady(id: string, params: { timeout: number }): Promise<BoxdMachine>;
	setEgressAllow(id: string, entries: string[]): Promise<string[]>;
	setAutoHibernateTimeout(id: string, seconds: number): Promise<void>;
	updateLabels(id: string, params: { set: Record<string, string> }): Promise<Record<string, string>>;
}

/** A snapshot as the SDK reads one (Snapshot, models.d.ts), as far as this host reads it. */
export interface BoxdSnapshot {
	name: string;
	/** "pending" until the capture lands, then "ready" or "failed" (ArtifactStatus). */
	status: string;
	/** True unless its bytes are on a worker's disk: boxd makes no machine from it until boxd's operator unarchives it. */
	archived: boolean;
	storage: string;
}

/** The SDK's snapshots namespace, as far as this host calls it (Snapshots, snapshots.d.ts). */
export interface BoxdSnapshots {
	/** Captures a running machine (memory and disk) under the name; answers before the capture lands. */
	create(machine: string, name: string): Promise<unknown>;
	get(name: string, params: { org?: string }): Promise<BoxdSnapshot>;
}

/** The SDK's Boxd class: given the key, the address and the region ("" is home) so it reads none from the environment. */
export type BoxdClientClass = new (options: { apiKey: string; baseURL: string; region: string; timeout: number; maxRetries?: number }) => { readonly machines: BoxdMachines; readonly snapshots: BoxdSnapshots };

export interface BoxdProviderOptions extends HostedOptions {
	/** The boxd API key: the caller passes it; the provider never reads it from the environment or puts it in a computer. */
	apiKey: string;
	Boxd: BoxdClientClass;
	/** The org (name or id) machines are made in and listed from. Unset: the key's own. */
	org?: string;
	/** "fra", "nyc", ... Unset: the API's home region. */
	region?: string;
	/** https alone; default https://boxd.sh:9443, the SDK's own. */
	baseUrl?: string;
	/** A boxd size, both or neither: 1 and 4G, 2 and 8G, 4 and 16G, 8 and 32G. Unset: the org's default. */
	vcpu?: number;
	memory?: string;
}

export type BoxdOptions = Omit<BoxdProviderOptions, "Boxd"> & { Boxd?: BoxdClientClass };

/** A BoxdProvider from its options alone; throws in words when the key is missing, never echoing one. */
export async function create(options: BoxdOptions): Promise<BoxdProvider> {
	const { apiKey, Boxd: given, ...rest } = options ?? ({} as BoxdOptions);
	if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the boxd API key, is required: the provider reads no environment, so the caller passes it");
	const Boxd = given ?? (await vendorSdk<{ Boxd: BoxdClientClass }>(BOXD.label, "@boxd-sh/sdk")).Boxd;
	return new BoxdProvider({ ...rest, apiKey, Boxd });
}

/** The conformance CLI's module for boxd. */
export const conformance = () => import("./conformance/boxd.js");

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_BASE_URL = "https://boxd.sh:9443";
/** The adapter's default requestMs and createMs: the SDK bounds a call by its client's timeout, so each client takes one. */
const REQUEST_MS = 30_000;
const CREATE_MS = 120_000;
const SIZES: Readonly<Record<number, string>> = { 1: "4G", 2: "8G", 4: "16G", 8: "32G" };
/** "default", boxd's own image, or a snapshot's name. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 1 to 63 of a-z0-9._/- (Machines.updateLabels); "boxd/" is boxd's own. */
const LABEL_KEY = /^(?!boxd\/)[a-z0-9._/-]{1,63}$/;
/** boxd's in-machine agent, which carries the SDK's exec and file calls. */
const AGENT_PORT = 57073;
/** The image's own user, which boxd's exec runs as (with passwordless sudo): init refuses to start beside its processes. */
const IMAGE_UID = 1000;
/** Standby (suspended) wakes on the next call, and a migration keeps the machine: both run. */
const STATES: Readonly<Record<string, Machine["state"]>> = {
	...{ pending: "starting", starting: "starting", running: "running", suspended: "running", migrating: "running" },
	...{ hibernated: "stopped", stopped: "stopped", failed: "gone", destroyed: "gone" },
};

/** Mozilla's APT signing key (fingerprint 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3), where the recipe keeps it, and its sha256. */
const MOZILLA_KEY = "/etc/apt/keyrings/packages.mozilla.org.asc";
const MOZILLA_KEY_SHA256 = "3ecc63922b7795eb23fdc449ff9396f9114cb3cf186d6f5b53ad4cc3ebfbb11f";

/**
 * What a desktop needs that boxd's own image lacks (Xvfb, xdotool and Thunar are the image's already): Xfce's text
 * editor and terminal (mousepad and xfce4-terminal, from Ubuntu's universe) and Firefox ESR, from Mozilla's APT
 * repository, since Ubuntu 24.04's firefox is a snap and a microVM runs no snapd. Mozilla's key is held to its sha256
 * before apt reads anything it signs. Each program and desktop file is checked. Run as root on a build machine of boxd's
 * own image, with no single quote in it (it goes in one pair). The snapshot's name carries this recipe's hash, so a
 * new recipe is a new snapshot.
 */
const DESKTOP_RECIPE = [
	"set -e",
	"export DEBIAN_FRONTEND=noninteractive",
	"apt-get update -qq",
	"apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null",
	"install -d -m 0755 /etc/apt/keyrings",
	`curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o ${MOZILLA_KEY}`,
	`echo "${MOZILLA_KEY_SHA256}  ${MOZILLA_KEY}" | sha256sum -c --quiet - || { echo "the APT signing key from packages.mozilla.org is not the one this recipe pins" >&2; exit 1; }`,
	`echo "deb [signed-by=${MOZILLA_KEY}] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list`,
	'printf "Package: *\\nPin: origin packages.mozilla.org\\nPin-Priority: 1000\\n" > /etc/apt/preferences.d/mozilla',
	"apt-get update -qq",
	"apt-get install -y -qq --no-install-recommends mousepad xfce4-terminal firefox-esr >/dev/null",
	'for x in mousepad xfce4-terminal firefox-esr; do command -v "$x" >/dev/null || { echo "the desktop has no $x" >&2; exit 1; }; done',
	'for app in org.xfce.mousepad xfce4-terminal firefox-esr; do test -f "/usr/share/applications/$app.desktop" || { echo "the desktop has no desktop file $app.desktop" >&2; exit 1; }; done',
	"rm -rf /var/lib/apt/lists/*",
].join("\n");

/** The desktop snapshot this package's recipe names: agentrun-desktop-<12 hex of the recipe's sha256>. */
export const boxdDesktopSnapshot = (): string => `agentrun-desktop-${createHash("sha256").update(DESKTOP_RECIPE).digest("hex").slice(0, 12)}`;

/** A build, all of it (boot, the recipe, the capture); its machine's delete timer, so a build left by a crash ends. */
const BUILD_MS = 30 * 60_000;
const BUILD_TTL_S = 2 * 60 * 60;
/** The pause between two reads of something boxd is making or deleting. */
const BUILD_POLL_MS = 2_000;
/** The most a build machine's cleanup waits for it to read gone. */
const GONE_MS = 120_000;
/** The pause before a wait for a machine boxd read not found just after its create, as the SDK's own wait polls. */
const NOT_YET_MS = 500;

/** The error with words added to its message (one that cannot be written stays as it was): the error is what the caller gets. */
function withWords(error: unknown, words: string): unknown {
	if (error instanceof Error) {
		try {
			error.message = `${error.message}${words}`;
		} catch {
			// A read-only message: the error goes on as it is.
		}
	}
	return error;
}

/** A machine as the adapter reads one: its labels, its state, and when boxd made it. */
function machineOf(machine: BoxdMachine): Machine {
	const state = STATES[machine.status];
	const created = dateOf(machine.createdAt);
	return {
		id: machine.id,
		labels: { ...machine.labels },
		state: state ?? "gone",
		...(created ? { createdAt: created } : {}),
		...(state === "gone" || state === undefined ? { why: `boxd reads its status as ${show(machine.status)}` } : {}),
	};
}

/** boxd's machines as a MachineHost (../host.ts). */
class BoxdHost implements MachineHost {
	readonly descriptor = BOXD;
	readonly facts: HostFacts = {
		daemon: "child",
		isolation: "microvm",
		// boxd ends a machine only at the delete timer create sets at req.backstopAt, and sets no cap.
		lifetime: "janitor",
		maxLifetimeMs: 30 * DAY_MS,
		arch: "amd64",
		vendorAgentPorts: [AGENT_PORT],
	};

	constructor(
		readonly machines: BoxdMachines,
		/** For create alone: bounded by createMs, and never sent twice. */
		readonly creator: BoxdMachines,
		readonly snapshots: BoxdSnapshots,
		readonly options: { org?: string; size?: { vcpu: number; memory: string }; kind: "desktop" | "linux" },
	) {}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	/**
	 * An isolated machine (on none of the org's networks) with no standby, which would freeze a quiet computer. Once it is
	 * ready: nothing out (the allowlist ["none"]) and no hibernation, since boxd's idle timers watch traffic and a computer
	 * may have none. A not found while boxd comes to read the new machine is waited past (#ready). A step after the
	 * machine exists that throws an error the adapter reads as a create that may have made
	 * one (mayHaveMade: vendor, timeout) is the adapter's to clean up: it sweeps the request's name, finds this machine and
	 * deletes it (a timeout's once this call settles). Deleted here first, the sweep would find none and keep listing, and
	 * delete a second create's machine of the same request instead. A refusal (limit, denied, ...) the adapter reads as a
	 * create that made nothing, so the step deletes the machine by its id (best effort) and throws its own error, the
	 * delete's outcome added in words. boxd's delete timer, written in the same call that makes the machine, ends it at
	 * req.backstopAt, so it ends even when the server that made it is gone.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		if (req.egress) throw new HostError("invalid", "a boxd computer reaches nothing outside, and this request asks it to");
		const { org, size } = this.options;
		const made = await this.creator.create({
			name: req.name,
			...(org === undefined ? {} : { org }),
			labels: req.labels,
			isolated: true,
			config: { autoSuspendTimeout: 0, ...size },
			...(req.image === BOXD_DEFAULT_IMAGE ? {} : { fromSnapshot: req.image }),
			deleteAfter: Math.ceil((Date.parse(req.backstopAt) - Date.now()) / 1000),
		});
		try {
			await this.#ready(made.id, ctx.timeoutMs, ctx.signal);
			await this.machines.setEgressAllow(made.id, ["none"]);
			await this.machines.setAutoHibernateTimeout(made.id, 0);
		} catch (error) {
			if (mayHaveMade(codeOfError(this, error))) throw error;
			throw await this.#unmade(made.id, error);
		}
		return { id: made.id };
	}

	/**
	 * waitUntilReady on a machine create just answered with, within ms, through boxd's not found: boxd can read such a
	 * machine as not found for a moment (live creates read "VM not found" about a second in, and a delete by id right
	 * after read not found too while the machine was there), so a not found is waited past, NOT_YET_MS apart. One still
	 * not found when ms run out is a timeout: the adapter's sweep by name settles it, where a delete by id would read not
	 * found and leave it. The first wait takes ms whole, each one after it what is left.
	 */
	async #ready(id: string, ms: number, signal?: AbortSignal): Promise<void> {
		const end = Date.now() + ms;
		let timeout = ms;
		for (;;) {
			try {
				await this.machines.waitUntilReady(id, { timeout });
				return;
			} catch (error) {
				if (codeOf(error) !== "not_found") throw error;
				if (signal?.aborted) throw new HostError("aborted", `the wait for the machine ${id} was aborted`);
				if (Date.now() + NOT_YET_MS >= end) {
					throw new HostError("timeout", `boxd made the machine ${id}, then read it not found until the wait for it ended (${error instanceof Error ? error.message : String(error)})`);
				}
				await pause(NOT_YET_MS, signal);
				timeout = Math.max(1, end - Date.now());
			}
		}
	}

	/** The machine a failed create made, deleted by its id; the step's own error comes back, the delete's outcome in its message. */
	async #unmade(id: string, error: unknown): Promise<unknown> {
		let outcome: string;
		try {
			await this.delete(id);
			outcome = `the machine ${id} it made was deleted`;
		} catch (failed) {
			outcome = `the machine ${id} it made could not be deleted (${failed instanceof Error ? failed.message : String(failed)})`;
		}
		return withWords(error, `; ${outcome}`);
	}

	/** machines.get takes an id alone, so a machine of another org is none of this provider's. Not found is none (adapter). */
	async get(id: string): Promise<Machine | undefined> {
		const { org } = this.options;
		const machine = await this.machines.get(id);
		return org === undefined || machine.org?.name === org || machine.org?.id === org ? machineOf(machine) : undefined;
	}

	async list(labels: Record<string, string>): Promise<Machine[]> {
		const { org } = this.options;
		const listed = await this.machines.list({ ...(org === undefined ? {} : { org }), labels });
		return [...listed].map(machineOf);
	}

	/** Not found is ok. */
	async delete(id: string): Promise<void> {
		try {
			await this.machines.delete(id);
		} catch (error) {
			if (codeOf(error) !== "not_found") throw error;
		}
	}

	/** One streamExec, its line the argv quoted. boxd runs it as the image's user; the adapter's scripts sudo to root. */
	async exec(id: string, argv: readonly string[]): Promise<MachineProcess> {
		const stream = this.machines.streamExec(id, { command: shellLine(argv) });
		return {
			stdout: stream,
			stderr: stream.stderr,
			write: async (bytes) => stream.write(bytes),
			end: async () => stream.end(),
			wait: () => stream.wait().catch(() => -1),
			// The server kills the process group (TERM, then KILL); close is safe twice (exec.d.ts).
			kill: async () => stream.close(),
		};
	}

	async upload(id: string, path: string, bytes: Uint8Array): Promise<void> {
		await this.machines.files.upload(id, path, bytes);
	}

	/** The janitor's deadline label; the adapter holds it to the most the machine may live and reads it back. */
	async extend(id: string, endsAt: Date): Promise<void> {
		await this.machines.updateLabels(id, { set: { [DEADLINE_LABEL]: endsAt.toISOString() } });
	}

	/**
	 * The desktop snapshot of this name in the org: found ready, or one being made waited for; else built once
	 * (`building` told first). A build makes an isolated machine of boxd's own image with no labels (a restore carries a
	 * snapshot's labels over to every machine made from it) and boxd's delete timer at BUILD_TTL_S, runs DESKTOP_RECIPE
	 * as root through the image user's passwordless sudo, captures the machine under the name, and waits until the
	 * capture is ready. A cancelled caller makes no machine, and stops waiting for one to start. The machine is deleted
	 * after, pass, fail or cancel, and waited gone, so a sweep after the build finds none of it; one that can't be is said
	 * (after the build's own error, when it failed). The snapshot stays: it is the org's image for every desktop. One that
	 * failed, or that boxd archived, is refused in words: delete it, then call again. Two first builds that race (two
	 * servers, one org) each pay for a build machine, and both captures land under the one name (boxd keeps the latest).
	 */
	async desktopSnapshot(name: string, building: () => void, signal: AbortSignal | undefined): Promise<string> {
		const end = Date.now() + BUILD_MS;
		const found = await this.#snapshot(name, end, signal);
		if (found !== null) return found;
		if (signal?.aborted) throw new HostError("aborted", `the build of the boxd snapshot ${name} was aborted before its machine was made`);
		building();
		// Named before the create, so a create whose reply is lost leaves a machine the cleanup still finds.
		const machine = `agentrun-desktop-build-${randomBytes(4).toString("hex")}`;
		const made = new Set<string>();
		let built: { name: string } | { error: unknown };
		try {
			built = { name: await this.#build(machine, made, name, end, signal) };
		} catch (error) {
			built = { error };
		}
		const left = await this.#gone(machine, made);
		if ("error" in built) throw left === undefined ? built.error : withWords(built.error, `; ${left}`);
		if (left !== undefined) throw new HostError("vendor", `the boxd snapshot ${name} is ready, but ${left}: call again to start from the snapshot`);
		return built.name;
	}

	/**
	 * The build itself, on a machine of this name (its id put in `ids` as create answers it): made, started (a cancel stops
	 * the wait), the recipe, the capture read ready.
	 */
	async #build(machine: string, ids: Set<string>, name: string, end: number, signal: AbortSignal | undefined): Promise<string> {
		const { org } = this.options;
		const made = await this.creator.create({
			name: machine,
			...(org === undefined ? {} : { org }),
			isolated: true,
			config: { autoSuspendTimeout: 0 },
			deleteAfter: BUILD_TTL_S,
		});
		ids.add(made.id);
		const ms = Math.max(1, end - Date.now());
		orThrow(await race(this, this.#ready(made.id, ms, signal), `the build machine ${made.id}'s start`, ms + CALL_SLACK_MS, signal));
		const what = `the desktop recipe (mousepad) on the build machine ${made.id}`;
		await runChecked(this, made.id, ["sudo", "-n", "sh", "-c", DESKTOP_RECIPE], { ms: Math.max(1, end - Date.now()), signal, what });
		await this.snapshots.create(made.id, name);
		const ready = await this.#snapshot(name, end, signal);
		if (ready === null) throw new HostError("vendor", `boxd took the snapshot ${name} of ${made.id}, then read none by that name`);
		return ready;
	}

	/** The snapshot's name once boxd reads it ready (a pending one waited for), null when boxd has none by it; failed or archived throws in words. */
	#snapshot(name: string, end: number, signal: AbortSignal | undefined): Promise<string | null> {
		const { org } = this.options;
		return until(`the boxd snapshot ${name}`, { end, pollMs: BUILD_POLL_MS, signal }, async () => {
			let read: BoxdSnapshot;
			try {
				read = await this.snapshots.get(name, org === undefined ? {} : { org });
			} catch (error) {
				if (codeOf(error) === "not_found") return null;
				throw error;
			}
			if (read.archived) throw new HostError("refused", `the boxd snapshot ${name} is archived (storage ${show(read.storage)}), and boxd makes no machine from it until its operator unarchives it: delete it, then call again to build it anew`);
			if (read.status === "ready") return name;
			if (read.status === "pending") return undefined;
			throw new HostError("vendor", `the boxd snapshot ${name} is ${show(read.status)}, not ready: delete it, then call again to build it anew`);
		});
	}

	/**
	 * The build's machines, each deleted once and read gone through get, GONE_MS at most: the ids create answered (`made`),
	 * which a lagging list can't hide, and every machine of the build's name in the org's list (it has no label to list it
	 * by), which finds one whose create reply was lost. Not the caller's to cancel: a cancelled build is cleaned up too.
	 * Undefined once none is left, else what is left in words (boxd's delete timer, set at create, ends it).
	 */
	async #gone(machine: string, made: ReadonlySet<string>): Promise<string | undefined> {
		const { org } = this.options;
		const asked = new Set<string>();
		try {
			await until(`the build machine ${machine}'s delete`, { end: Date.now() + GONE_MS, pollMs: BUILD_POLL_MS }, async () => {
				const listed = await this.machines.list({ ...(org === undefined ? {} : { org }), labels: {} });
				let left = 0;
				for (const id of new Set([...made, ...[...listed].filter((one) => one.name === machine).map((one) => one.id)])) {
					if (!asked.has(id)) {
						asked.add(id);
						await this.delete(id);
					}
					if (!(await this.#readGone(id))) left += 1;
				}
				return left === 0 ? true : undefined;
			});
			return undefined;
		} catch (error) {
			return `its build machine ${machine} could not be deleted (${error instanceof Error ? error.message : String(error)}), and boxd's delete timer ends it within ${BUILD_TTL_S / 3600} h`;
		}
	}

	/** Whether get reads the machine gone: not found, or in a state that is gone. */
	async #readGone(id: string): Promise<boolean> {
		try {
			return STATES[(await this.machines.get(id)).status] === "gone";
		} catch (error) {
			if (codeOf(error) === "not_found") return true;
			throw error;
		}
	}

	/**
	 * An image is "default" or a snapshot's name, and a desktop's is a snapshot; the size is the provider's (vcpu,
	 * memory), never the spec's; a label name is one boxd takes.
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = (["cpus", "memoryMb"] as const)
			.filter((field) => spec[field] !== undefined)
			.map((field) => ({ field, message: `a boxd computer's size is the provider's vcpu and memory options, not the spec's ${field}` }));
		const { image, labels } = spec;
		if (typeof image === "string" && image !== "") {
			if (!IMAGE.test(image)) refusals.push({ field: "image", message: `an image is "${BOXD_DEFAULT_IMAGE}" (boxd's own Ubuntu 24.04), or the name of a boxd snapshot` });
			else if (image === BOXD_DEFAULT_IMAGE && this.options.kind === "desktop") {
				refusals.push({ field: "image", message: `a boxd desktop starts from a snapshot with a desktop app, and boxd's own image lists none of the stock ones (Xfce's text editor and terminal, xterm): name ${boxdDesktopSnapshot()}, which prepareImage() builds, or a snapshot of your own` });
			} else if (image !== BOXD_DEFAULT_IMAGE && this.options.size) refusals.push({ field: "image", message: `a machine restored from a snapshot has the snapshot's size, and this provider names one: it takes only "${BOXD_DEFAULT_IMAGE}"` });
		}
		const keys = labels !== null && typeof labels === "object" ? Object.keys(labels).filter((key) => !LABEL_KEY.test(key)) : [];
		if (keys.length > 0) refusals.push({ field: "labels", message: `boxd takes label names of 1 to 63 of a-z, 0-9 and ._/-, not starting boxd/: ${keys.map((key) => show(key)).join(", ")}` });
		return refusals;
	}
}

/** The SDK names its errors (errors.d.ts); an APIStatusError carries its gRPC code (3 invalid argument, 4 deadline
 *  exceeded, 8 resource exhausted, 9 failed precondition, 14 unavailable). */
function codeOf(error: unknown): ComputerErrorCode {
	const { name, grpcCode } = (error ?? {}) as { name?: unknown; grpcCode?: unknown };
	if (name === "AbortError") return "aborted";
	if (name === "NotFoundError" || name === "MachineFileNotFoundError") return "not_found";
	if (name === "AuthenticationError" || name === "PermissionDeniedError" || name === "RegionNotEnabledError") return "denied";
	if (name === "RateLimitError" || grpcCode === 8) return "limit";
	// boxd keeps a name to one machine: a create of a name another create took.
	if (name === "ConflictError") return "exists";
	if (name === "APIConnectionError" || grpcCode === 4 || grpcCode === 14) return "timeout";
	if (grpcCode === 3) return "invalid";
	if (grpcCode === 9) return "refused";
	return "vendor";
}

/**
 * Computers that are boxd machines, on the shared adapter. A spec's image is "default" or a boxd snapshot's name. A
 * server starts a sandbox from boxd's own image, and a desktop from the snapshot prepareImage() answers.
 */
export class BoxdProvider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it). A sandbox: boxd's own image, with no call. A
	 * desktop: the desktop snapshot (boxdDesktopSnapshot) in the key's org, found or built once (BoxdHost.desktopSnapshot),
	 * so a new recipe is a new snapshot; onWait is told "build" once, before a build, never when the org has it.
	 */
	async prepareImage(context: CallContext & { onWait?: (making: "build" | "pull", tag: string) => void } = {}): Promise<Result<string>> {
		if (this.capabilities().kind !== "desktop") return ok(BOXD_DEFAULT_IMAGE);
		const name = boxdDesktopSnapshot();
		const host = this.host as BoxdHost;
		try {
			return ok(await host.desktopSnapshot(name, () => context.onWait?.("build", name), context.signal));
		} catch (error) {
			return failFor(this.id)(codeOfError(host, error), `boxd's desktop snapshot ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	constructor(options: BoxdProviderOptions) {
		const { apiKey, Boxd, org, region = "", baseUrl = DEFAULT_BASE_URL, vcpu, memory, maxLifetimeMs = DAY_MS, ...rest } = options;
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("a boxd API key is required");
		if (typeof Boxd !== "function") throw new Error("options.Boxd must be the @boxd-sh/sdk package's Boxd class");
		if ((vcpu !== undefined || memory !== undefined) && SIZES[vcpu as number] !== memory) throw new Error(`vcpu ${String(vcpu)} with memory ${String(memory)} is not one of boxd's sizes: 1 and 4G, 2 and 8G, 4 and 16G or 8 and 32G`);
		if (Number(rest.daemonUser?.split(":")[0]) === IMAGE_UID) throw new Error(`the daemon user ${rest.daemonUser} is the uid of the machine's own user, whose processes init refuses to run beside; choose another, such as 2510:2510`);
		const kind = rest.kind === "desktop" ? "desktop" : "linux";
		if (kind === "desktop" && vcpu !== undefined) throw new Error("a boxd desktop starts from a snapshot, which keeps the size it was captured at: name no vcpu or memory for kind desktop");
		const client = { apiKey, baseURL: httpsBase(baseUrl, "the boxd API URL"), region };
		const { machines, snapshots } = new Boxd({ ...client, timeout: rest.timeouts?.requestMs ?? REQUEST_MS });
		const creator = new Boxd({ ...client, timeout: rest.timeouts?.createMs ?? CREATE_MS, maxRetries: 0 }).machines;
		const size = vcpu === undefined ? undefined : { vcpu, memory: memory as string };
		super(new BoxdHost(machines, creator, snapshots, { org, size, kind }), { ...rest, maxLifetimeMs });
	}
}
