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
// Render's sandboxes carry no labels: a sandbox's name (computer-<12 hex>) gives the adapter's own two, and create writes
// every label to a file in the sandbox, root's alone, which get and list read back through runs/sync where a label asked
// is not the name's, and keep: a computer's labels never change (Render moves no timeout, so there is no extend).
//
// Every vendor fact below is from @renderinc/sdk 1.11.0's OpenAPI schema (dist/generated/schema.d.ts, S) or its client
// (dist/sandboxes/index.js, C), a live probe (11-25: root, HOME=/root, a Render kernel, egress https, and a command
// started under setsid by runs/sync living on after the call), or the live Core run (11-25, packages/serve/scripts/
// dial-conformance.mjs: the sandbox's env reaches a runs/sync command, root makes network namespaces in the microVM, the
// builds API imports the public ghcr.io box image with no credential, and a process escaped with setsid ends with the
// sandbox's release). One none of these settles says unverified.
import { boxImageRef, boxRecipeHash } from "./box-image.js";
import { RENDER } from "./descriptors/render.js";
import { COMPUTER_LABEL, DEFAULT_CPUS, DEFAULT_MEMORY_MB, show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineRequest } from "./host.js";
import { codeOfError, orThrow, pause, seconds, until } from "./hosted/process.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, NAME_LABEL, timeoutsOf } from "./hosted/provider.js";
import { allPages, jsonOf, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { dialLaunch } from "./hosted/scripts.js";
import { dateOf, isWhole } from "./hosted/values.js";
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
/** S: sandboxId, "sbx-1cd4gcph1rs3idesc73a2b2mg"; held to that form before it reaches a path. */
const SANDBOX_ID = /^sbx-[a-z0-9]{10,40}$/;
/** S: sandboxBuildId, sbb-…; a build's name may not start with sbb- (S, sandbox-groups/{id}/builds), so this reads as an id. */
const BUILD_ID = /^sbb-[a-z0-9]{10,40}$/;
/** A build's name, 1 to 255 characters (S); held to letters, digits, dots, underscores and hyphens, so an OCI path is not one. */
const BUILD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** The name the adapter gives a computer (provider.ts computerName): only a sandbox named so is one of its computers. */
const COMPUTER_NAME = /^computer-[0-9a-f]{12}$/;
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
/** How long the box image's import may take (C's own wait for an image is 10 minutes; the box image is about 400 MB). */
const BUILD_MS = 30 * 60_000;
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

/** An id held to Render's form before it reaches a path: not_found else. */
function sandboxId(id: string): string {
	if (!SANDBOX_ID.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not a Render sandbox id`);
	return id;
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
	};
	readonly #api: Rest;
	readonly #apiKey: string;
	readonly #owner: string;
	readonly #fetch: typeof fetch;
	readonly #pollMs: number;
	/** Each computer's labels once known, by sandbox id: written by create, or read from the labels file once. */
	readonly #labels = new Map<string, Record<string, string>>();
	/** The box build's name once Render read it succeeded: prepareImage asks no more. */
	#built: string | undefined;

	constructor(options: { apiKey: string; ownerId: string; fetch: typeof fetch; pollMs: number }) {
		this.#apiKey = options.apiKey;
		this.#owner = options.ownerId;
		this.#fetch = options.fetch;
		this.#pollMs = options.pollMs;
		this.#api = this.#client(API_URL, () => this.#apiKey);
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
		const minted = (await this.#call("POST", this.#owned(`/v1/sandboxes/${sandboxId(id)}/runs/sync/token`), { retry: true }, ctx)) as { uri?: unknown; token?: unknown; method?: unknown } | null;
		const { uri, token } = minted ?? {};
		if (typeof uri !== "string" || !uri.startsWith("https://") || typeof token !== "string" || token === "") throw new HostError("vendor", `Render answered no https run URL and token for the sandbox ${id}`);
		const plane = this.#client(new URL(uri).origin, () => token);
		const method = typeof minted?.method === "string" ? minted.method : "POST";
		const answer = orThrow(await plane.json(method, uri, { json: { command }, timeoutMs: Math.max(1, end - Date.now()), retry: once ? (status) => status === 429 : true }, ctx.signal)) as { stdout?: unknown; stderr?: unknown; exit_code?: unknown } | null;
		if (!isWhole(answer?.exit_code)) throw new HostError("vendor", `Render's run in ${id} answered no exit code: ${show(answer?.exit_code)}`);
		return { stdout: typeof answer.stdout === "string" ? answer.stdout : "", stderr: typeof answer.stderr === "string" ? answer.stderr : "", exit: answer.exit_code };
	}

	/**
	 * A sandbox's labels: the ones this host knows, else its name's, else its labels file's, read once through runs/sync
	 * and kept. `need`: a listing's labels; when the name's hold every one asked, no file is read. A sandbox not named as a
	 * computer carries none; one not running, or with no file yet, its name's. A read that fails throws, so a listing
	 * never answers as though the sandbox were not there.
	 */
	async #labelsOf(found: RenderSandbox, ctx: HostCall, need?: Record<string, string>): Promise<Record<string, string>> {
		const name = found.name;
		if (typeof name !== "string" || !COMPUTER_NAME.test(name)) return {};
		const known = this.#labels.get(found.id);
		if (known !== undefined) return known;
		const own = { [COMPUTER_LABEL]: "1", [NAME_LABEL]: name };
		if ((need !== undefined && Object.keys(need).every((key) => key in own)) || found.status !== "running") return own;
		const read = await this.#run(found.id, readFile(LABELS_FILE), ctx);
		if (read.exit === MISSING) return own;
		if (read.exit !== 0) throw new HostError("vendor", `reading the labels file of ${found.id} exited ${read.exit}: ${lastWords(read)}`);
		const parsed = jsonOf(new TextEncoder().encode(read.stdout));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
			throw new HostError("vendor", `the labels file of ${found.id} is not a JSON map of strings`);
		}
		const labels = { ...(parsed as Record<string, string>), ...own };
		this.#labels.set(found.id, labels);
		return labels;
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
	 * POST /v1/sandboxes (S, sandboxPOST): the workspace, the request's name, the smallest plan holding its size, the
	 * lifetime as timeoutSeconds (at least 60), no idle suspension (0), egress allow-all (the sandbox must reach the
	 * server; the computer's own programs keep to init's network), the boot env but AGENTRUN_ATTACH_URL as its env, and
	 * the build. Only a 429, a refusal that made nothing, is sent again: a create that got no answer may have made a
	 * sandbox, which the adapter finds by its name. Then, once the sandbox reads running within ctx.timeoutMs, one
	 * runs/sync call writes the labels file and starts agentrun-dial, the URL in its launch script. A sandbox that errors
	 * or ends first, a launch that fails, or a bound passed, throws: a create that made a machine to the adapter, which
	 * deletes it by its name. req.backstopAt is left: Render's timeout ends the sandbox.
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
					name: req.name,
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
		if (typeof id !== "string" || !SANDBOX_ID.test(id)) throw new HostError("vendor", `POST /v1/sandboxes answered no sandbox id: ${show(id)}`);
		this.#labels.set(id, { ...req.labels });
		await this.#untilRunning(made as RenderSandbox, end, ctx);
		const ran = await this.#run(id, launchLine(req.labels, attach), { ...ctx, timeoutMs: Math.max(1, end - Date.now()) }, true);
		if (ran.exit !== 0) throw new HostError("vendor", `starting agentrun-dial in ${id} exited ${ran.exit}: ${lastWords(ran)}`);
		return { id };
	}

	/** Reads the sandbox until it runs, pollMs apart, by `end`: errored or terminated first throws vendor, the end timeout. */
	async #untilRunning(posted: RenderSandbox, end: number, ctx: HostCall): Promise<void> {
		for (let found = posted; found.status !== "running"; ) {
			if (found.status === "errored" || found.status === "terminated") throw new HostError("vendor", `Render reads the sandbox ${found.id} ${found.status}, so agentrun-dial was not started`);
			if (Date.now() + this.#pollMs >= end) throw new HostError("timeout", `the sandbox ${found.id} did not read running within ${seconds(ctx.timeoutMs)} (it reads ${found.status}), so agentrun-dial was not started`);
			await pause(this.#pollMs, ctx.signal);
			if (ctx.signal?.aborted) throw new HostError("aborted", `the wait for the sandbox ${found.id} to run was aborted`);
			found = (await this.#call("GET", this.#owned(`/v1/sandboxes/${found.id}`), { retry: true }, { ...ctx, timeoutMs: Math.max(1, end - Date.now()) })) as RenderSandbox;
		}
	}

	/** GET /v1/sandboxes/{id}; 404 is not_found, which the adapter reads as none, and a terminated sandbox is none. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const found = (await this.#call("GET", this.#owned(`/v1/sandboxes/${sandboxId(id)}`), { retry: true }, ctx)) as RenderSandbox | null;
		if (typeof found?.status !== "string") throw new HostError("vendor", `GET /v1/sandboxes/${id} answered no status`);
		if (found.status === "terminated") return undefined;
		return machineOf(found, await this.#labelsOf(found, ctx));
	}

	/**
	 * GET /v1/sandboxes?ownerId (S, list-sandboxes: terminated ones left out unless asked), by name where the name is
	 * asked ("exactly this name"), every page by its last item's cursor while a page is full. Only sandboxes named as
	 * computers; a label asked that is not the name's is read from each running one's labels file (#labelsOf), and only
	 * those that carry every label asked are answered. A file that can't be read fails the listing in words: a listing
	 * that left the sandbox out would read as no such computer.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const name = labels[NAME_LABEL];
		const listed = orThrow(
			await allPages<RenderSandbox>(
				async (cursor) => {
					const page = await this.#api.json("GET", this.#api.url(this.#owned("/v1/sandboxes", { limit: String(PAGE), ...(name === undefined ? {} : { name }), ...(cursor === undefined ? {} : { cursor }) })), { retry: true, timeoutMs: ctx.timeoutMs }, ctx.signal);
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
		const ours = listed.filter((found) => found.status !== "terminated" && typeof found.name === "string" && COMPUTER_NAME.test(found.name));
		const read = await Promise.all(
			ours.map(async (found) => {
				const carried = await this.#labelsOf(found, ctx, labels);
				return Object.entries(labels).every(([key, value]) => carried[key] === value) ? machineOf(found, carried) : undefined;
			}),
		);
		return read.flatMap((machine) => machine ?? []);
	}

	/** POST /v1/sandboxes/{id}/terminate (S: 204, also for one already terminated); a 404 is done to the adapter. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		await this.#call("POST", this.#owned(`/v1/sandboxes/${sandboxId(id)}/terminate`), { retry: true }, ctx);
		this.#labels.delete(id);
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
	 * named agentrun-box-<recipe hash>, so a new recipe is a new build: a succeeded one of that name is kept (GET
	 * …/builds?name&status=succeeded), else POST …/builds { name, sourceImage } imports the box image's public tag (S: "converts
	 * a container image into an image that sandboxes can use"), and Render's answer is read until it succeeded or failed.
	 * `building` is told before the import. Render pulls the public ghcr.io image with no credential (the live Core run's
	 * import took 104 s); a tag the release has not published yet is Render's 400, "source image unavailable".
	 */
	async boxBuild(building: () => void, signal: AbortSignal | undefined): Promise<string> {
		if (this.#built !== undefined) return this.#built;
		const name = boxBuildName();
		const ctx = { timeoutMs: 30_000, ...(signal ? { signal } : {}) };
		const group = await this.#defaultGroup(ctx);
		const builds = `/v1/sandbox-groups/${group}/builds`;
		const found = await this.#call("GET", `${builds}?${new URLSearchParams({ name, status: "succeeded", limit: "1" })}`, { retry: true }, ctx);
		if (Array.isArray(found) && found.length > 0) return (this.#built = name);
		building();
		let build = (await this.#call("POST", builds, { json: { name, sourceImage: boxImageRef() }, retry: (status) => status === 429 }, ctx)) as RenderBuild | null;
		const id = build?.id;
		if (typeof id !== "string" || !BUILD_ID.test(id)) throw new HostError("vendor", `POST ${builds} answered no build id: ${show(id)}`);
		const settled = (one: RenderBuild | null) => {
			if (one?.status === "succeeded") return true;
			if (one?.status === "failed") throw new HostError("vendor", `Render's build ${id} failed: ${one.failureReason || one.failureCode || "no reason given"}`);
			return undefined;
		};
		if (!settled(build)) await until(`Render's build ${id}`, { end: Date.now() + BUILD_MS, pollMs: this.#pollMs, signal }, async () => settled((build = (await this.#call("GET", `${builds}/${id}`, { retry: true }, ctx)) as RenderBuild | null)));
		return (this.#built = name);
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
