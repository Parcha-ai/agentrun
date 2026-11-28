// The Render host: a Linux sandbox on a Render Sandbox in the operator's Render workspace, over Render's REST API
// (https://api.render.com/v1, a Bearer API key). Render runs a command in a sandbox through a run token's URL
// (runs/sync, answered once the command ends; runs/stream, its output as events), with no stdin, which can't carry the
// stdio bridge, so this host has none: its sandboxes dial the server (facts.connect "dial"). The sandbox boots the box
// image, imported once into the workspace as a sandbox build (prepareImage), with MachineRequest.boot.env as its env but
// AGENTRUN_ATTACH_URL. Render's API names no command a sandbox runs at its start (sandboxPOST has none, and nothing of
// the image's CMD), so create waits for the sandbox to run and starts agentrun-dial itself, in one runs/sync call that
// detaches it (setsid): it fetches the server's computerd, checks its sha256, starts init and dials the attach route with
// the machine's own token, which stays in the sandbox's env. The rest of the computer is the shared machine-host
// adapter's (./hosted/provider.ts).
//
// Render's sandboxes carry no labels: a sandbox's name (computer-<12 hex>-r<run hash>-e<epoch>) gives the adapter's own
// two and says whose run and epoch it may be, and create writes every label to a file in the sandbox, root's alone, which
// get and list read back through runs/sync where a label asked is not the name's, and keep for the whole process: a
// computer's labels never change (Render moves no timeout, so there is no extend). That read needs a healthy guest, so
// one that fails, or has no answer within the call's own bound, gives get the name's two: enough for release to find and
// terminate a wedged sandbox, never a reason it is left to bill to its timeout. A listing by a label beyond the name's
// fails closed on it instead, naming the sandbox: it can't tell whether that one is a match. A listing by run reads only
// the sandboxes whose name has the run's hash (and the epoch asked), so only the run's own can fail it.
//
// Every vendor fact below is from @renderinc/sdk 1.11.0's OpenAPI schema (dist/generated/schema.d.ts, S) or its client
// (dist/sandboxes/index.js, C), a live probe (11-25: root, HOME=/root, a Render kernel, egress https, and a command
// started under setsid by runs/sync living on after the call), or the live Core run (11-25, packages/serve/scripts/
// dial-conformance.mjs: the sandbox's env reaches a runs/sync command, root makes network namespaces in the microVM, the
// builds API imports the public ghcr.io box image with no credential, and a process escaped with setsid ends with the
// sandbox's release). One none of these settles says unverified.
import { createHash } from "node:crypto";
import { boxImageRef, boxRecipeHash } from "./box-image.js";
import { RENDER } from "./descriptors/render.js";
import { COMPUTER_LABEL, DEFAULT_CPUS, DEFAULT_MEMORY_MB, show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineRequest } from "./host.js";
import { codeOfError, orThrow, pause, seconds, until, untilAborted } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, mayHaveMade, NAME_LABEL, timeoutsOf } from "./hosted/provider.js";
import { allPages, jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { dialLaunch } from "./hosted/scripts.js";
import { dateOf, isWhole } from "./hosted/values.js";
import { EPOCH_LABEL, RUN_LABEL, runHash } from "./labels.js";
import type { CallContext, ComputerResources, ComputerSpec, Refusal } from "./provider.js";
import { failFor, ok, type Result, vendorFail } from "./result.js";

/** A sandbox as Render answers one (S, sandbox), as far as this host reads it. */
interface RenderSandbox {
	id: string;
	name?: string | null;
	status: string;
	plan?: string;
	timeoutSeconds?: number;
	createdAt?: string;
}

/** A sandbox build as Render answers one (S, sandboxBuild): an OCI image converted for sandboxes, async. */
interface RenderBuild {
	id: string;
	status?: string;
	failureReason?: string | null;
	failureCode?: string | null;
}

/** The box build's find-or-import: its name or its error once settled, whether it imports, and the callers to tell when it does. */
interface BuildFlight {
	answer: Promise<{ name: string } | { error: unknown }>;
	importing: boolean;
	toTell: Set<() => void>;
}

/**
 * The box build's find-or-import under way in this process, by workspace, key and box image (owner id, the key's
 * keyTag, build name, image tag): every provider of the workspace and key joins it, one of another key (a wrong one's
 * 401) never, and it is dropped once it settles. Render's own POST answers a build of the same name and digest already
 * pending, running or succeeded (S, create-sandbox-build), so this saves the calls, not a second build.
 */
const FLIGHTS = new Map<string, BuildFlight>();

/** A key as a map key: the first 16 hex digits of its sha256, never the key. */
const keyTag = (apiKey: string) => createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 16);

/** What this process keeps of a workspace's sandboxes, whichever provider made or read them (serve makes one per claim). */
interface Kept {
	/**
	 * Each computer's labels once known, by sandbox id: written by create, or read from the labels file once. Let go when
	 * get reads the sandbox terminated or not found, or a listing no longer shows it (Render ended it at its timeout).
	 */
	labels: Map<string, Record<string, string>>;
	/**
	 * The sandboxes terminated from this process, until Render reads them gone (let go as labels are): Render may read one
	 * running for a while after its terminate, and its guest, ending, is never read for labels.
	 */
	ending: Set<string>;
}

/** Kept, by workspace (owner id). */
const KEPT = new Map<string, Kept>();

function keptOf(owner: string): Kept {
	let kept = KEPT.get(owner);
	if (kept === undefined) KEPT.set(owner, (kept = { labels: new Map(), ending: new Set() }));
	return kept;
}

/** What runs/sync answers once its command has ended (the live probe; C reads the stream's exit event's exit_code). */
interface RunAnswer {
	stdout: string;
	stderr: string;
	exit: number;
}

/** The Render provider's options: the key and the workspace, then the shared adapter's (HostedOptions). */
export interface RenderProviderOptions extends Omit<HostedOptions, "desktop" | "maxLifetimeMs"> {
	/** A Render API key that may make sandboxes in the workspace. The caller passes it; this provider reads no environment. */
	apiKey: string;
	/** The workspace (owner) its sandboxes are made in and listed from: tea-… for a team, usr-… for a person. */
	ownerId: string;
	/** The fetch every call goes through; default the global one. */
	fetch?: typeof fetch;
	/** The longest lifetime check takes, in ms: at most a day, the default. */
	maxLifetimeMs?: number;
	timeouts?: Partial<HostedTimeouts>;
}

const API_URL = "https://api.render.com";
/**
 * S: ownerId, a workspace id (tea-… for a team, usr-… for a person). Held to an id's characters alone, since it goes in
 * every query: whether it names a workspace the key reaches is Render's answer to the first call.
 */
const OWNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** S: sandboxBuildId, sbb-…; a build's name may not start with sbb- (S, sandbox-groups/{id}/builds), so this reads as an id. */
const BUILD_ID = /^sbb-[a-z0-9]{10,40}$/;
/** A build's name, 1 to 255 characters (S); held to letters, digits, dots, underscores and hyphens, so an OCI path is not one. */
const BUILD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/**
 * A computer's sandbox name: the adapter's name for it (computer-<12 hex>, computerNameFor), then -r<its run's hash>
 * and -e<its epoch> where its labels carry them, as Orgo's names do (orgo-names.ts): at most 57 characters of Render's 64
 * (S, sandboxPOST name). Only a sandbox named so is one of its computers.
 */
const SANDBOX_NAME = /^(computer-[0-9a-f]{12})(?:-r([a-z2-7]{16}))?(?:-e(0|[1-9][0-9]{0,15}))?$/;

/** The run's hash a sandbox of these labels is named with: "" for none. */
function runPart(labels: Record<string, string>): string {
	const run = labels[RUN_LABEL];
	return typeof run === "string" && run !== "" ? runHash(run) : "";
}

/** The epoch a sandbox of these labels is named with: "" for none, or one that is not a whole number. */
function epochPart(labels: Record<string, string>): string {
	const epoch = labels[EPOCH_LABEL];
	return typeof epoch === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(epoch) ? epoch : "";
}

/** A computer's sandbox name for create's request: its name, then its run label's hash and its epoch label where they are one. */
function sandboxName({ name, labels }: Pick<MachineRequest, "name" | "labels">): string {
	const run = runPart(labels);
	const epoch = epochPart(labels);
	return `${name}${run === "" ? "" : `-r${run}`}${epoch === "" ? "" : `-e${epoch}`}`;
}

/**
 * The whole sandbox name a listing asks for, where it asks the adapter's name, a run and a whole-number epoch: Render's
 * own exact name filter then finds it, no page of the workspace's other sandboxes read. Undefined where it asks less.
 */
function wholeName(labels: Record<string, string>): string | undefined {
	const name = labels[NAME_LABEL];
	if (name === undefined || runPart(labels) === "" || epochPart(labels) === "") return undefined;
	return sandboxName({ name, labels });
}

/**
 * Where a labels file says another run or epoch than its sandbox's name, why, in words; undefined where it agrees. The
 * name is Render's, set at create; the file is the guest's root's to rewrite, so one that disagrees is not read.
 */
function misnamed(parts: NonNullable<ReturnType<typeof nameParts>>, file: Record<string, string>): string | undefined {
	const found: string[] = [];
	if ((parts.run ?? "") !== runPart(file)) found.push(`run: the name's run hash ${show(parts.run)} is not the labels file's run ${show(file[RUN_LABEL])}`);
	if ((parts.epoch ?? "") !== epochPart(file)) found.push(`epoch: the name says ${show(parts.epoch)}, the labels file ${show(file[EPOCH_LABEL])}`);
	return found.length === 0 ? undefined : found.join("; ");
}

/** What a sandbox's name says: the adapter's name, the run's hash and the epoch; undefined for a sandbox not named as a computer. */
function nameParts(name: unknown): { computer: string; run?: string; epoch?: string } | undefined {
	const match = typeof name === "string" ? SANDBOX_NAME.exec(name) : null;
	if (match === null) return undefined;
	return { computer: match[1] as string, ...(match[2] ? { run: match[2] } : {}), ...(match[3] !== undefined ? { epoch: match[3] } : {}) };
}

/**
 * Whether a sandbox so named can carry these labels: one of a name, a run or an epoch other than those asked can't, so
 * a listing never reads its guest, and a guest that can't answer refuses no listing it could not be in. A run's own
 * sandboxes always have its hash, so a hash another run shares (16 base32 letters, 80 bits) only adds a sandbox to be
 * read, whose file then says its run, or which fails the listing closed: it never leaves one of the run's out.
 */
function mayCarry(parts: NonNullable<ReturnType<typeof nameParts>>, labels: Record<string, string>): boolean {
	const name = labels[NAME_LABEL];
	const run = labels[RUN_LABEL];
	const epoch = labels[EPOCH_LABEL];
	return (name === undefined || parts.computer === name) && (run === undefined || parts.run === runHash(run)) && (epoch === undefined || parts.epoch === epoch);
}
/** S, sandboxPlan: the sizes a sandbox takes, smallest first. */
const PLANS = [
	{ plan: "1c-2g", cpus: 1, memoryMb: 2048 },
	{ plan: "2c-4g", cpus: 2, memoryMb: 4096 },
	{ plan: "4c-8g", cpus: 4, memoryMb: 8192 },
	{ plan: "8c-16g", cpus: 8, memoryMb: 16_384 },
] as const;
/** S, timeoutSeconds: 0 (none) or 60 to 2592000; the sandbox ends when it elapses. */
const LEAST_TIMEOUT_S = 60;
/** Render ends a sandbox at its timeout, up to 30 days (S); a computer's cap here is a day, as Fly's and Agent37's. */
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
/** One page of a listing (S, limitParam: 1 to 100). */
const PAGE = 100;
const MAX_PAGES = 100;
/** How many labels files a listing reads at once: each is a run token and a runs/sync call, and a workspace's runs are rate limited (S, 429RateLimit). */
const LABEL_READS = 4;
/** S, sandboxBuildStatus: a build of these has, or will have, the box image; failed is imported again. */
const BUILD_LIVE = ["succeeded", "pending", "running"] as const;
/** How long the box image's import may take (C's own wait for an image is 10 minutes; the box image is about 400 MB). */
const BUILD_MS = 30 * 60_000;
/** How long a failed create's terminate of the sandbox it made may take: create's own bound may be spent by then. */
const TERMINATE_MS = 30_000;
/** S, 429RateLimit: a 429 is sent again after 1, 2 and 4 s. */
const RETRY = { attempts: 4, baseMs: 1_000 };
/** A file read's exit when the file is not there. */
const MISSING = 3;
/** Where create leaves the computer's labels, root's alone (its directory 0700, umask 077). */
const LABELS_DIR = "/var/lib/agentrun-computer";
const LABELS_FILE = `${LABELS_DIR}/labels.json`;
/** agentrun-dial's launch script (dialLaunch's line), its output and its exit code, root's alone. */
const DIAL_DIR = "/run/agentrun-dial";
const DIAL_SCRIPT = `${DIAL_DIR}/launch`;
const DIAL_LOG = `${DIAL_DIR}/log`;
const DIAL_EXIT = `${DIAL_DIR}/exit`;
/** How much of agentrun-dial's log dialLog reads: its end. */
const LOG_BYTES = 65_536;

/** A file written whole: base64 through printf, to <path>.new, then moved over <path>. */
const writeFile = (path: string, text: string) => `printf %s '${Buffer.from(text, "utf8").toString("base64")}' | base64 -d > ${path}.new && mv -f ${path}.new ${path}`;
/** A file read: exits MISSING when it is not there. */
const readFile = (path: string, read = "cat") => `[ -f ${path} ] || exit ${MISSING}; ${read} ${path}`;
/**
 * agentrun-dial's start from its launch script, detached: a session of its own (setsid), no hangup, stdin closed, its
 * output to DIAL_LOG and its exit code to DIAL_EXIT once it ends, so the runs/sync call returns at once.
 */
const START = `rm -f ${DIAL_EXIT} && { setsid nohup sh -c 'sh ${DIAL_SCRIPT}; echo $? > ${DIAL_EXIT}' > ${DIAL_LOG} 2>&1 < /dev/null & }`;

/** create's one run: the labels file, the launch script with the attach URL (the token stays in the env), the start. */
function launchLine(labels: Record<string, string>, attach: string): string {
	return ["umask 077", `mkdir -p ${LABELS_DIR} ${DIAL_DIR}`, writeFile(LABELS_FILE, JSON.stringify(labels)), writeFile(DIAL_SCRIPT, dialLaunch({ attach })), START].join(" && ");
}

/** The smallest plan holding the size asked; none asked, the adapter's default of 2 CPUs and 4 GiB. */
function planOf(cpus: number | undefined, memoryMb: number | undefined): string | undefined {
	const want = cpus === undefined && memoryMb === undefined ? { cpus: DEFAULT_CPUS, memoryMb: DEFAULT_MEMORY_MB } : { cpus: cpus ?? 0, memoryMb: memoryMb ?? 0 };
	return PLANS.find((one) => one.cpus >= want.cpus && one.memoryMb >= want.memoryMb)?.plan;
}

/** What a plan gives, as its name says it (Nc-Mg); none for another. */
function resourcesOf(plan: string | undefined): { resources?: ComputerResources } {
	const sized = /^(\d+)c-(\d+)g$/.exec(plan ?? "");
	return sized ? { resources: { cpus: Number(sized[1]), memoryMb: Number(sized[2]) * 1024 } } : {};
}

/**
 * Render's statuses (S, sandboxStatus) as the adapter's: creating and resuming are starting, suspending and suspended
 * stopped (listed, so a release still ends them), errored gone. terminated is a sandbox that is no more: null, as get and
 * list answer none for it.
 */
function stateOf(status: string): Machine["state"] | undefined | null {
	if (status === "running") return "running";
	if (status === "creating" || status === "resuming") return "starting";
	if (status === "suspending" || status === "suspended") return "stopped";
	if (status === "errored") return "gone";
	if (status === "terminated") return null;
	return undefined;
}

/** A sandbox as the adapter reads one, with the labels read for it; undefined for one terminated. */
function machineOf(found: RenderSandbox, labels: Record<string, string>): Machine | undefined {
	const state = stateOf(found.status);
	if (state === null) return undefined;
	const created = dateOf(found.createdAt);
	const timeout = found.timeoutSeconds;
	const ends = created && isWhole(timeout) && timeout > 0 ? new Date(created.getTime() + timeout * 1000) : undefined;
	const why =
		state === undefined
			? `Render reads the sandbox's status ${show(found.status)}, which this provider does not know`
			: found.status === "errored"
				? `Render reads the sandbox ${found.id} errored, with no reason given`
				: undefined;
	return {
		id: found.id,
		labels,
		state: state ?? "gone",
		...(created ? { createdAt: created } : {}),
		...(ends ? { endsAt: ends } : {}),
		...(why ? { why } : {}),
		...resourcesOf(found.plan),
	};
}

/** Whether an id Render answered can be one path segment: any string but none, `.` and `..` (which a URL resolves away). */
const segmentable = (id: unknown): id is string => typeof id === "string" && id !== "" && id !== "." && id !== "..";

/**
 * A sandbox id as one path segment, encoded: Render's ids read sbx-… (S, sandboxId), but one of another form is still
 * read and terminated by it, never left running because this host did not know the form. One that can't be a segment
 * is no sandbox: not_found.
 */
function sandboxPath(id: string): string {
	if (!segmentable(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not a Render sandbox id`);
	return encodeURIComponent(id);
}

/** Each of items through `each`, at most `most` at once, the answers in the items' order. */
async function eachAtMost<T, R>(items: readonly T[], most: number, each: (item: T) => Promise<R>): Promise<R[]> {
	const answers: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const at = next++;
			answers[at] = await each(items[at] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(most, items.length) }, worker));
	return answers;
}

/** Render's error body (S, error): { id?, message?, code? }. */
function explain({ status, bytes, what }: { status: number; bytes: Uint8Array; what: string }) {
	const body = jsonOf(bytes) as { message?: unknown } | null;
	const said = typeof body?.message === "string" && body.message !== "" ? `: ${body.message}` : "";
	return { message: `${what} answered ${status}${said}` };
}

/** The last words of a run's output, for a failure: its stderr, else its stdout. */
const lastWords = ({ stdout, stderr }: RunAnswer) => (stderr.trim() || stdout.trim()).slice(-300);

/** Render Sandboxes as a dial MachineHost (../host.ts): no exec, no upload. */
class RenderHost implements MachineHost {
	readonly descriptor = RENDER;
	readonly facts: HostFacts = {
		// agentrun-dial starts init as its child; nothing is started through exec.
		daemon: "child",
		// The live probe read a kernel of Render's own (uname: 6.18.51-render1+), so each sandbox is a VM of its own.
		isolation: "microvm",
		// Render ends a sandbox at its timeoutSeconds (S), which create sets to the lifetime.
		lifetime: "vendor",
		maxLifetimeMs: MAX_LIFETIME_MS,
		// The box image is built for amd64 alone (release.yml's box job), and the live Core run ran it and its amd64 daemon.
		arch: "amd64",
		// Unverified: the agent that answers runs inside the sandbox listens where S does not say. None declared.
		vendorAgentPorts: [],
		// The sandbox dials the server: Render's runs take no stdin (S: runs/{sync,stream} take { command }), so there is
		// no exec and no upload here. Its descriptor's (connectOf).
		connect: RENDER.connect,
		// A sandbox's name carries its run's hash and its epoch (sandboxName): a create's sweeps for the sandbox it made ask
		// for both, so list asks Render for the whole name rather than reading the workspace's every page.
		labels: { named: true },
	};
	readonly #api: Rest;
	readonly #apiKey: string;
	readonly #owner: string;
	readonly #fetch: typeof fetch;
	readonly #pollMs: number;
	/** What this process keeps of the workspace's sandboxes (KEPT): every provider of the workspace shares it. */
	readonly #labels: Kept["labels"];
	readonly #ending: Kept["ending"];
	/** The box build's name once Render read it succeeded: prepareImage asks no more. */
	#built: string | undefined;

	constructor(options: { apiKey: string; ownerId: string; fetch: typeof fetch; pollMs: number }) {
		this.#apiKey = options.apiKey;
		this.#owner = options.ownerId;
		this.#fetch = options.fetch;
		this.#pollMs = options.pollMs;
		this.#api = this.#client(API_URL, () => this.#apiKey);
		({ labels: this.#labels, ending: this.#ending } = keptOf(this.#owner));
	}

	/** A REST client whose every call carries `bearer()` as its Bearer token: the API key, or one run's token. */
	#client(base: string, bearer: () => string): Rest {
		return rest({ base, headers: () => ({ Authorization: `Bearer ${bearer()}`, Accept: "application/json" }), vendor: RENDER.id, fetch: this.#fetch, timeoutMs: 30_000, retry: RETRY, explain });
	}

	/** One API call, bounded by ctx: its JSON answer (null for none), or a HostError in Render's words. */
	async #call(method: "GET" | "POST", path: string, init: RestInit, ctx: HostCall): Promise<unknown> {
		return orThrow(await this.#api.json(method, this.#api.url(path), { ...init, timeoutMs: ctx.timeoutMs }, ctx.signal));
	}

	/** The workspace as a query, which every sandbox call names (C names it on each). */
	#owned(path: string, query: Record<string, string> = {}): string {
		return `${path}?${new URLSearchParams({ ownerId: this.#owner, ...query })}`;
	}

	/**
	 * One command run in the sandbox: a run token (POST /v1/sandboxes/{id}/runs/sync/token, S: "Send the command to the
	 * URL in the response, using the token as the bearer token"), then the command to its URL. `once`: a run that got
	 * no answer is never sent again, since it may have run; a read is.
	 */
	async #run(id: string, command: string, ctx: HostCall, once = false): Promise<RunAnswer> {
		const end = Date.now() + ctx.timeoutMs;
		const minted = (await this.#call("POST", this.#owned(`/v1/sandboxes/${sandboxPath(id)}/runs/sync/token`), { retry: true }, ctx)) as { uri?: unknown; token?: unknown; method?: unknown } | null;
		const { uri, token } = minted ?? {};
		if (typeof uri !== "string" || !uri.startsWith("https://") || typeof token !== "string" || token === "") throw new HostError("vendor", `Render answered no https run URL and token for the sandbox ${id}`);
		const plane = this.#client(new URL(uri).origin, () => token);
		const method = typeof minted?.method === "string" ? minted.method : "POST";
		const answer = orThrow(await plane.json(method, uri, { json: { command }, timeoutMs: Math.max(1, end - Date.now()), retry: once ? (status) => status === 429 : true }, ctx.signal)) as { stdout?: unknown; stderr?: unknown; exit_code?: unknown } | null;
		if (!isWhole(answer?.exit_code)) throw new HostError("vendor", `Render's run in ${id} answered no exit code: ${show(answer?.exit_code)}`);
		return { stdout: typeof answer.stdout === "string" ? answer.stdout : "", stderr: typeof answer.stderr === "string" ? answer.stderr : "", exit: answer.exit_code };
	}

	/**
	 * A sandbox's labels: the ones this process knows, else its name's, else its labels file's, read once through runs/sync
	 * and kept. `need`: a listing's labels; when the name's hold every one asked, no file is read. The name's are the
	 * computer's and its name, and, for a listing by the whole name (wholeName), the run and epoch asked, which that name
	 * is made of (the run by its 80-bit hash). A sandbox not named as a computer carries none; one not running, one
	 * terminated from this process, or one with no file yet, its name's. A file whose run or epoch is not the name's
	 * (misnamed) is not read: the guest's root rewrote it. The read is held to `end` (epoch ms, the call's own bound): one
	 * that fails, disagrees with the name, or has no answer by then gives the name's, kept for nothing, so the next read
	 * tries again, with `unread`, why: get answers the name's (release needs no more), and a listing fails closed on it.
	 * Only the caller's own abort throws.
	 */
	async #labelsOf(found: RenderSandbox, ctx: HostCall, end: number, need?: Record<string, string>, whole = false): Promise<{ labels: Record<string, string>; unread?: string }> {
		const parts = nameParts(found.name);
		if (parts === undefined) return { labels: {} };
		const known = this.#labels.get(found.id);
		if (known !== undefined) return { labels: known };
		const own: Record<string, string> = { [COMPUTER_LABEL]: "1", [NAME_LABEL]: parts.computer, ...(whole && need ? { [RUN_LABEL]: need[RUN_LABEL] as string, [EPOCH_LABEL]: need[EPOCH_LABEL] as string } : {}) };
		if ((need !== undefined && Object.keys(need).every((key) => key in own)) || found.status !== "running" || this.#ending.has(found.id)) return { labels: own };
		const late = { labels: own, unread: `no answer within ${seconds(ctx.timeoutMs)}` };
		const left = end - Date.now();
		if (left <= 0) return late;
		const bound = AbortSignal.timeout(left);
		let file: Record<string, string> | undefined;
		try {
			file = await this.#labelsFile(found.id, { timeoutMs: left, signal: ctx.signal ? AbortSignal.any([ctx.signal, bound]) : bound });
		} catch (error) {
			if (ctx.signal?.aborted) throw error;
			return bound.aborted ? late : { labels: own, unread: error instanceof Error ? error.message : String(error) };
		}
		if (file === undefined) return { labels: own };
		const differs = misnamed(parts, file);
		if (differs !== undefined) return { labels: own, unread: `the labels file of ${found.id} does not match its name ${found.name}: ${differs}` };
		const labels = { ...file, ...own };
		this.#labels.set(found.id, labels);
		return { labels };
	}

	/** The labels file read through runs/sync: undefined when it is not there yet; a read that fails throws in words. */
	async #labelsFile(id: string, ctx: HostCall): Promise<Record<string, string> | undefined> {
		const read = await this.#run(id, readFile(LABELS_FILE), ctx);
		if (read.exit === MISSING) return undefined;
		if (read.exit !== 0) throw new HostError("vendor", `reading the labels file of ${id} exited ${read.exit}: ${lastWords(read)}`);
		const parsed = jsonOf(new TextEncoder().encode(read.stdout));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
			throw new HostError("vendor", `the labels file of ${id} is not a JSON map of strings`);
		}
		return parsed as Record<string, string>;
	}

	/** A sandbox Render reads gone: its labels and its terminate are let go. */
	#forget(id: string): void {
		this.#labels.delete(id);
		this.#ending.delete(id);
	}

	/**
	 * Any Render build by its name or id (S: buildName, "the newest successful build with this name in the sandbox
	 * group"; buildId), and a size Render's plans hold (S, sandboxPlan). Render's base image ("default", a create that
	 * names no build) has no agentrun-dial, so it can't be one.
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, cpus, memoryMb } = spec;
		const most = PLANS[PLANS.length - 1];
		if (typeof image === "string" && !(BUILD_ID.test(image) || (BUILD_NAME.test(image) && image !== "default" && !image.startsWith("sbb-")))) {
			refusals.push({ field: "image", message: "an image is the name or id of a Render sandbox build that holds agentrun-dial: the box image's, which prepareImage() imports (agentrun-box-<tag>), or one of your own FROM it; Render's base image (default) has none" });
		}
		if (cpus !== undefined && !(isWhole(cpus) && cpus > 0 && cpus <= most.cpus)) refusals.push({ field: "cpus", message: `a Render sandbox has at most ${most.cpus} CPUs (plans ${PLANS.map(({ plan }) => plan).join(", ")})` });
		if (memoryMb !== undefined && !(isWhole(memoryMb) && memoryMb > 0 && memoryMb <= most.memoryMb)) refusals.push({ field: "memoryMb", message: `a Render sandbox has at most ${most.memoryMb} MiB (plans ${PLANS.map(({ plan }) => plan).join(", ")})` });
		return refusals;
	}

	/**
	 * POST /v1/sandboxes (S, sandboxPOST): the workspace, the request's name with its run's hash and epoch (sandboxName),
	 * the smallest plan holding its size, the lifetime as timeoutSeconds (at least 60), no idle suspension (0), egress
	 * allow-all (the sandbox must reach the server; the computer's own programs keep to init's network), the boot env but
	 * AGENTRUN_ATTACH_URL as its env, and the build. Only a 429, a refusal that made nothing, is sent again: a create that
	 * got no answer may have made a sandbox, which the adapter finds by its name. Then, once the sandbox reads running
	 * within ctx.timeoutMs, one runs/sync call writes the labels file and starts agentrun-dial, the URL in its launch
	 * script. A sandbox that errors or ends first, a launch that fails, or a bound passed, throws: a create that made a
	 * machine to the adapter, which deletes it by its name. A refusal after the sandbox exists (a run token's 429s past
	 * every retry, limit; a 401, denied) the adapter reads as a create that made nothing (mayHaveMade), so this terminates
	 * the sandbox by its id first and throws the refusal in its own code. req.backstopAt is left: Render's timeout ends the
	 * sandbox.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const end = Date.now() + ctx.timeoutMs;
		if (req.boot === undefined) throw new HostError("invalid", "a Render sandbox dials the server, and the request has no boot env for it");
		const { AGENTRUN_ATTACH_URL: attach, ...env } = req.boot.env;
		if (typeof attach !== "string" || attach === "") throw new HostError("invalid", "a Render sandbox dials the server, and the boot env names no AGENTRUN_ATTACH_URL");
		const made = (await this.#call(
			"POST",
			"/v1/sandboxes",
			{
				json: {
					ownerId: this.#owner,
					name: sandboxName(req),
					plan: planOf(req.cpus, req.memoryMb),
					timeoutSeconds: Math.max(LEAST_TIMEOUT_S, Math.ceil(req.lifetimeMs / 1000)),
					idleTimeoutSeconds: 0,
					networkPolicy: { type: "allow-all" },
					env,
					...(BUILD_ID.test(req.image) ? { buildId: req.image } : { buildName: req.image }),
				},
				retry: (status) => status === 429,
			},
			ctx,
		)) as RenderSandbox | null;
		const id = made?.id;
		if (!segmentable(id)) throw new HostError("vendor", `POST /v1/sandboxes answered no sandbox id: ${show(id)}`);
		this.#labels.set(id, { ...req.labels });
		try {
			await this.#untilRunning(made as RenderSandbox, end, ctx);
			const ran = await this.#run(id, launchLine(req.labels, attach), { ...ctx, timeoutMs: Math.max(1, end - Date.now()) }, true);
			if (ran.exit !== 0) throw new HostError("vendor", `starting agentrun-dial in ${id} exited ${ran.exit}: ${lastWords(ran)}`);
		} catch (error) {
			if (!(error instanceof HostError) || mayHaveMade(error.code)) throw error;
			throw await this.#unmade(id, error);
		}
		return { id };
	}

	/** The sandbox a failed create made, terminated by its id: the step's error in its own code, the terminate's outcome added. */
	async #unmade(id: string, error: HostError): Promise<HostError> {
		let outcome: string;
		try {
			await this.delete(id, { timeoutMs: TERMINATE_MS });
			outcome = `the sandbox ${id} it made was terminated`;
		} catch (failed) {
			outcome =
				failed instanceof HostError && failed.code === "not_found"
					? `the sandbox ${id} it made is gone`
					: `the sandbox ${id} it made could not be terminated (${failed instanceof Error ? failed.message : String(failed)}); Render ends it at its timeout`;
		}
		return new HostError(error.code, `${error.message}; ${outcome}`);
	}

	/** Reads the sandbox until it runs, pollMs apart, by `end`: errored or terminated first throws vendor, the end timeout. */
	async #untilRunning(posted: RenderSandbox, end: number, ctx: HostCall): Promise<void> {
		for (let found = posted; found.status !== "running"; ) {
			if (found.status === "errored" || found.status === "terminated") throw new HostError("vendor", `Render reads the sandbox ${found.id} ${found.status}, so agentrun-dial was not started`);
			if (Date.now() + this.#pollMs >= end) throw new HostError("timeout", `the sandbox ${found.id} did not read running within ${seconds(ctx.timeoutMs)} (it reads ${found.status}), so agentrun-dial was not started`);
			await pause(this.#pollMs, ctx.signal);
			if (ctx.signal?.aborted) throw new HostError("aborted", `the wait for the sandbox ${found.id} to run was aborted`);
			found = (await this.#call("GET", this.#owned(`/v1/sandboxes/${sandboxPath(found.id)}`), { retry: true }, { ...ctx, timeoutMs: Math.max(1, end - Date.now()) })) as RenderSandbox;
		}
	}

	/**
	 * GET /v1/sandboxes/{id}; 404 is not_found, which the adapter reads as none, and a terminated sandbox is none: either
	 * lets go of what this process kept of it. Its labels are read within this call's own bound (#labelsOf), and a read that
	 * fails gives the name's two: enough for the adapter to know its computer and release it.
	 */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const end = Date.now() + ctx.timeoutMs;
		let found: RenderSandbox | null;
		try {
			found = (await this.#call("GET", this.#owned(`/v1/sandboxes/${sandboxPath(id)}`), { retry: true }, ctx)) as RenderSandbox | null;
		} catch (error) {
			if (error instanceof HostError && error.code === "not_found") this.#forget(id);
			throw error;
		}
		if (typeof found?.status !== "string") throw new HostError("vendor", `GET /v1/sandboxes/${id} answered no status`);
		if (found.status === "terminated") {
			this.#forget(id);
			return undefined;
		}
		return machineOf(found, (await this.#labelsOf(found, ctx, end)).labels);
	}

	/**
	 * GET /v1/sandboxes?ownerId (S, list-sandboxes: terminated ones left out unless asked), every page by its last item's
	 * cursor while a page is full. Render filters by an exact name alone, and a sandbox's name carries its run and epoch
	 * beside the adapter's: a listing that asks all three (wholeName, as a create's sweeps for the sandbox it made do) asks
	 * Render for that name, and the name's labels hold all three, so no file is read; any other is matched here, over
	 * every page (MAX_PAGES at most, then it fails). Only sandboxes named as computers whose name may carry the
	 * labels asked (mayCarry: the adapter's name, the run's hash and the epoch); a label asked that is not the name's is
	 * read from each running one's labels file (#labelsOf), LABEL_READS at once, all within this call's own bound, and only
	 * those that carry every label asked are answered. A file that can't be read by then fails the listing closed, once
	 * every read has ended, naming each such sandbox and why: the listing can't tell whether it carries the labels asked,
	 * and leaving it out would let a run's listing miss a newer epoch's fence or call a partial cleanup whole (janitor.ts
	 * releaseOlder). So only a sandbox that may be the run's can fail a listing by run: another run's is never read. A
	 * listing by the name alone reads no file, and a sandbox terminated from this process is never read, so neither fails
	 * so. What this process kept of a sandbox a listing of the whole workspace no longer shows is let go: Render ended it,
	 * at its timeout or by another's hand.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const end = Date.now() + ctx.timeoutMs;
		const whole = wholeName(labels);
		// Only what was kept before the listing began is let go: a sandbox made while it ran may not be on its pages.
		const kept = [...new Set([...this.#labels.keys(), ...this.#ending])];
		const listed = orThrow(
			await allPages<RenderSandbox>(
				async (cursor) => {
					const query = { limit: String(PAGE), ...(whole === undefined ? {} : { name: whole }), ...(cursor === undefined ? {} : { cursor }) };
					const page = await this.#api.json("GET", this.#api.url(this.#owned("/v1/sandboxes", query)), { retry: true, timeoutMs: ctx.timeoutMs }, ctx.signal);
					if (!page.ok) return page;
					if (!Array.isArray(page.value)) return vendorFail(RENDER.id, "GET /v1/sandboxes answered no list");
					const rows = page.value as Array<{ sandbox?: RenderSandbox; cursor?: unknown } | null>;
					const items = rows.flatMap((row) => (typeof row?.sandbox?.id === "string" && typeof row.sandbox.status === "string" ? [row.sandbox] : []));
					const last = rows.at(-1)?.cursor;
					return ok({ items, ...(rows.length === PAGE && typeof last === "string" ? { next: last } : {}) });
				},
				MAX_PAGES,
				{ vendor: RENDER.id, what: "Render's sandbox listing" },
			),
		);
		const live = listed.filter((found) => found.status !== "terminated");
		if (whole === undefined) {
			const shown = new Set(live.map(({ id }) => id));
			for (const id of kept) if (!shown.has(id)) this.#forget(id);
		}
		const ours = live.filter((found) => {
			const parts = nameParts(found.name);
			return parts !== undefined && mayCarry(parts, labels);
		});
		const read = await eachAtMost(ours, LABEL_READS, async (found) => ({ found, ...(await this.#labelsOf(found, ctx, end, labels, whole !== undefined)) }));
		const unread = read.flatMap(({ found, unread: why }) => (why === undefined ? [] : [`${found.id}: ${why}`]));
		if (unread.length > 0) {
			const asked = Object.entries(labels).filter(([key]) => key !== COMPUTER_LABEL && key !== NAME_LABEL);
			const carry = unread.length === 1 ? "it carries" : "they carry";
			throw new HostError("vendor", `could not read the labels of ${unread.join("; ")}; the listing can't tell whether ${carry} ${asked.map(([key, value]) => `${key}=${value}`).join(", ")}`);
		}
		return read.flatMap(({ found, labels: carried }) => (Object.entries(labels).every(([key, value]) => carried[key] === value) ? (machineOf(found, carried) ?? []) : []));
	}

	/**
	 * POST /v1/sandboxes/{id}/terminate (S: 204, also for one already terminated); a 404 is done to the adapter. What this
	 * process kept of it stays until get reads it gone: Render may read it running a while yet, and its labels still
	 * answer. It is marked ending for every provider of the workspace, so none reads its guest meanwhile.
	 */
	async delete(id: string, ctx: HostCall): Promise<void> {
		try {
			await this.#call("POST", this.#owned(`/v1/sandboxes/${sandboxPath(id)}/terminate`), { retry: true }, ctx);
		} catch (error) {
			if (error instanceof HostError && error.code === "not_found") this.#forget(id);
			throw error;
		}
		this.#ending.add(id);
	}

	/** The end of what agentrun-dial wrote, through runs/sync; undefined where it was never started. */
	async dialLog(id: string, ctx: HostCall): Promise<string | undefined> {
		const read = await this.#run(id, readFile(DIAL_LOG, `tail -c ${LOG_BYTES}`), ctx);
		if (read.exit === MISSING) return undefined;
		if (read.exit !== 0) throw new HostError("vendor", `reading agentrun-dial's log in ${id} exited ${read.exit}: ${lastWords(read)}`);
		return read.stdout;
	}

	/** agentrun-dial's exit code, which its start writes once it has ended; undefined while it runs, or never started. */
	async dialExit(id: string, ctx: HostCall): Promise<number | undefined> {
		const read = await this.#run(id, readFile(DIAL_EXIT), ctx);
		if (read.exit === MISSING) return undefined;
		if (read.exit !== 0) throw new HostError("vendor", `reading agentrun-dial's exit in ${id} exited ${read.exit}: ${lastWords(read)}`);
		const code = read.stdout.trim();
		return /^\d{1,3}$/.test(code) ? Number(code) : undefined;
	}

	/** agentrun-dial started once more from create's launch script (the same attach URL; the token is the sandbox's env still). */
	async redial(id: string, ctx: HostCall): Promise<void> {
		const ran = await this.#run(id, `[ -f ${DIAL_SCRIPT} ] || exit ${MISSING}; umask 077 && ${START}`, ctx, true);
		if (ran.exit === MISSING) throw new HostError("not_found", `no agentrun-dial was started in the sandbox ${id}, so it is not started again`);
		if (ran.exit !== 0) throw new HostError("vendor", `starting agentrun-dial again in ${id} exited ${ran.exit}: ${lastWords(ran)}`);
	}

	/** The workspace's default sandbox group (S, list-sandbox-groups), read a page at a time by cursor until it is found. */
	async #defaultGroup(ctx: HostCall): Promise<string> {
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const rows = await this.#call("GET", `/v1/sandbox-groups?${new URLSearchParams({ ownerId: this.#owner, limit: String(PAGE), ...(cursor === undefined ? {} : { cursor }) })}`, { retry: true }, ctx);
			if (!Array.isArray(rows)) throw new HostError("vendor", "GET /v1/sandbox-groups answered no list");
			const listed = rows as Array<{ sandboxGroup?: { id?: unknown; isDefault?: unknown }; cursor?: unknown } | null>;
			const group = listed.find((row) => row?.sandboxGroup?.isDefault === true)?.sandboxGroup?.id;
			if (group !== undefined) {
				if (typeof group !== "string" || !/^[a-z0-9-]{1,64}$/.test(group)) throw new HostError("vendor", `Render answered a default sandbox group whose id is ${show(group)}`);
				return group;
			}
			const next = listed.at(-1)?.cursor;
			if (listed.length < PAGE || typeof next !== "string" || next === "" || seen.has(next)) break;
			seen.add(next);
			cursor = next;
		}
		throw new HostError("vendor", `Render answered no default sandbox group for the workspace ${this.#owner}`);
	}

	/**
	 * The box image as a build of the workspace's default sandbox group (the group a create that names none uses, S),
	 * named agentrun-box-<recipe hash>, so a new recipe is a new build. Concurrent callers in this process share one
	 * find-or-import per workspace, key and box image (FLIGHTS), whichever provider they call through (serve makes one per
	 * claim), forgotten once it settles. `building` is told once, before the wait on an import, its own or one under way
	 * when it joined; a caller's signal ends its own wait alone: the import's wait goes on, within BUILD_MS, for the next
	 * caller.
	 */
	async boxBuild(building: () => void, signal: AbortSignal | undefined): Promise<string> {
		if (this.#built !== undefined) return this.#built;
		if (signal?.aborted) throw new HostError("aborted", "the wait for the box build was aborted before it began");
		const key = JSON.stringify([this.#owner, keyTag(this.#apiKey), boxBuildName(), boxImageRef()]);
		let flight = FLIGHTS.get(key);
		if (flight === undefined) {
			const started = this.#fly();
			FLIGHTS.set(key, (flight = started));
			void started.answer.then(() => {
				if (FLIGHTS.get(key) === started) FLIGHTS.delete(key);
			});
		}
		const tell = () => {
			try {
				building();
			} catch {
				// The caller's listener is its own: a throw changes nothing here.
			}
		};
		if (flight.importing) tell();
		else flight.toTell.add(tell);
		try {
			const settled = await untilAborted(flight.answer, [signal]);
			if (settled === undefined) throw new HostError("aborted", "the wait for the box build was aborted; its import goes on for the next caller");
			if ("error" in settled) throw settled.error;
			return (this.#built = settled.name);
		} finally {
			flight.toTell.delete(tell);
		}
	}

	/** A find-or-import through this host's API key: it never rejects (its error is its answer). */
	#fly(): BuildFlight {
		const flight: BuildFlight = { answer: Promise.resolve({ error: undefined }), importing: false, toTell: new Set() };
		const importing = () => {
			flight.importing = true;
			for (const tell of flight.toTell) tell();
		};
		flight.answer = this.#findOrImport(importing).then(
			(name) => ({ name }),
			(error: unknown) => ({ error }),
		);
		return flight;
	}

	/**
	 * The box build found or imported, held to no caller: a build of its name that succeeded is the answer; one pending
	 * or running (an import another call or process started, or a POST whose answer was lost) is waited for (GET
	 * …/builds?name&status=succeeded&status=pending&status=running, newest first; an array is one key per status, as C's
	 * openapi-fetch sends it). Else POST …/builds { name, sourceImage } imports the box image's public tag (S: "converts a
	 * container image into an image that sandboxes can use"), and Render's answer is read until it succeeded or failed.
	 * `importing` is told before either wait. Render pulls the public ghcr.io image with no credential (the live Core
	 * run's import took 104 s); a tag the release has not published yet is Render's 400, "source image unavailable".
	 */
	async #findOrImport(importing: () => void): Promise<string> {
		const name = boxBuildName();
		const ctx = { timeoutMs: 30_000 };
		const group = await this.#defaultGroup(ctx);
		const builds = `/v1/sandbox-groups/${group}/builds`;
		const query = new URLSearchParams([["name", name], ...BUILD_LIVE.map((status) => ["status", status]), ["limit", String(PAGE)]]);
		const listed = await this.#call("GET", `${builds}?${query}`, { retry: true }, ctx);
		const found = (Array.isArray(listed) ? (listed as Array<{ build?: RenderBuild } | null>) : []).flatMap((row) => (row?.build ? [row.build] : []));
		if (found.some(({ status }) => status === "succeeded")) return name;
		importing();
		let build: RenderBuild | null | undefined = found.find(({ id, status }) => (status === "pending" || status === "running") && typeof id === "string" && BUILD_ID.test(id));
		build ??= (await this.#call("POST", builds, { json: { name, sourceImage: boxImageRef() }, retry: (status) => status === 429 }, ctx)) as RenderBuild | null;
		const id = build?.id;
		if (typeof id !== "string" || !BUILD_ID.test(id)) throw new HostError("vendor", `POST ${builds} answered no build id: ${show(id)}`);
		const settled = (one: RenderBuild | null | undefined) => {
			if (one?.status === "succeeded") return true;
			if (one?.status === "failed") throw new HostError("vendor", `Render's build ${id} failed: ${one.failureReason || one.failureCode || "no reason given"}`);
			return undefined;
		};
		if (!settled(build)) await until(`Render's build ${id}`, { end: Date.now() + BUILD_MS, pollMs: this.#pollMs }, async () => settled((build = (await this.#call("GET", `${builds}/${id}`, { retry: true }, ctx)) as RenderBuild | null)));
		return name;
	}
}

/** The box image's build name: agentrun-box-<recipe hash>, as the box image's own tag is. */
const boxBuildName = () => `agentrun-box-${boxRecipeHash()}`;

const fail = failFor(RENDER.id);

/** A RenderProvider from its options alone; it reads no environment (serve passes the saved RENDER_API_KEY and RENDER_WORKSPACE_ID). */
export function create(options: RenderProviderOptions): RenderProvider {
	return new RenderProvider(options);
}

/** The conformance CLI's module for Render: its settings, and its dialKit that refuses off the public server. */
export const conformance = () => import("./conformance/render.js");

/**
 * Computers that are Render Sandboxes, on the shared adapter, each dialing the server that made it: a server with no
 * public https address (AGENTRUN_PUBLIC_URL) refuses a create in words before Render is called. Kind linux.
 */
export class RenderProvider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it): the box image as a build of the workspace's
	 * default sandbox group (RenderHost.boxBuild), found or imported. ok with the build's name; onWait is told "build"
	 * once, before an import, never when the workspace has one.
	 */
	async prepareImage(context: CallContext & { onWait?: (making: "build" | "pull", tag: string) => void } = {}): Promise<Result<string>> {
		const name = boxBuildName();
		try {
			return ok(await (this.host as RenderHost).boxBuild(() => context.onWait?.("build", name), context.signal));
		} catch (error) {
			return fail(codeOfError(this.host, error), `the box image as the Render build ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	constructor(options: RenderProviderOptions) {
		const { apiKey, ownerId, fetch: fetcher = globalThis.fetch, timeouts = {}, ...rest } = options ?? ({} as RenderProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, a Render API key, is required: the provider reads no environment, so the caller passes it");
		if (typeof ownerId !== "string" || !OWNER_ID.test(ownerId)) throw new Error(`options.ownerId is the Render workspace its sandboxes live in (tea-… for a team, usr-… for a person), not ${JSON.stringify(ownerId)}`);
		if (typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		super(new RenderHost({ apiKey, ownerId, fetch: fetcher, pollMs: timeoutsOf(timeouts).pollMs }), { ...rest, timeouts });
	}
}
