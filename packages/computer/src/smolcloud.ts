// The smol cloud host: machines on smol cloud (https://smolmachines.com), each a microVM booted from an OCI image,
// over its REST API (https://api.smolmachines.com, a Bearer key). The exec is a resumable exec started interactive
// (POST /v1/machines/{id}/execs): the machine's node owns the process, its output is read by offset with a long poll
// (GET .../execs/{execId}?after=N&wait=25), stdout and stderr apart and the exit code last, stdin is numbered base64
// frames (POST .../stdin, at most 64 KiB each, resent safely), and DELETE kills it. Labels are smol cloud's own (32 at
// most, listed with ?label=k=v, changed with PATCH .../labels); the idle stop is off (autoStopSeconds 0) and the delete
// timer (ttlSeconds) is set to the request's backstop. The rest of the computer is the shared machine-host adapter's.
import { randomBytes } from "node:crypto";
import { boxImageRef } from "./box-image.js";
import { SMOLCLOUD } from "./descriptors/smolcloud.js";
import { DEADLINE_LABEL, DEFAULT_CPUS, DEFAULT_MEMORY_MB, show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { type FramedEvent, framedExec } from "./hosted/framed-exec.js";
import { networkFormOf } from "./hosted/network.js";
import { orThrow, pause } from "./hosted/process.js";
import { HostedProvider, type HostedOptions } from "./hosted/provider.js";
import { httpsBase, jsonOf, type Rest, rest } from "./hosted/rest.js";
import { shellLine } from "./hosted/scripts.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import { ok, type Result } from "./result.js";

/** The smol cloud provider's options: the key, then the shared adapter's (HostedOptions). */
export interface SmolcloudProviderOptions extends Omit<HostedOptions, "kind" | "desktop"> {
	/** The smol cloud API key. The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/** The REST API, https alone; default https://api.smolmachines.com. */
	apiUrl?: string;
	/** The fetch every call goes through; default the global one. */
	fetch?: typeof fetch;
}

export async function create(options: SmolcloudProviderOptions): Promise<SmolcloudProvider> {
	return new SmolcloudProvider(options);
}

export const conformance = () => import("./conformance/smolcloud.js");

const DEFAULT_API_URL = "https://api.smolmachines.com";
/** smol cloud never ends a machine itself once its idle stop is off: the janitor's cap. */
const DAY_MS = 24 * 60 * 60_000;
/** Every machine's name starts with this, so an account's own machines and a computer's are told apart. */
const NAME_PREFIX = "agr-";
/** A stdin frame's bytes: under the API's 64 KiB, base64 or not. */
const FRAME_BYTES = 48 * 1024;
/** One long poll: the API holds it up to 25 s; the call's bound is past that. */
const POLL_WAIT_S = 25;
const POLL_MS = 40_000;
const STDIN_MS = 30_000;
/** How long the output read waits out reads that fail before it gives up: a control plane down this long is down. */
const READ_GIVE_UP_MS = 5 * 60_000;

/** smol cloud's label name (validate.rs label_key) and the most characters of a label's value. */
const LABEL_KEY = /^[a-z0-9]([a-z0-9._/-]{0,61}[a-z0-9])?$/;
const LABEL_VALUE_CHARS = 255;
/** A string's length as smol cloud counts it: in characters (code points), not UTF-16 units or bytes. */
const chars = (text: string) => [...text].length;

/** A machine as GET /v1/machines answers it (OpenAPI MachineInfo), as far as this host reads it. */
interface CloudMachine {
	id: string;
	state: string;
	labels?: Record<string, string>;
	createdAt?: string;
	error?: string | null;
}

/** One read of a resumable exec (OpenAPI ResumableExec). */
interface ExecRead {
	output?: { stream: string; data: string }[];
	next?: number;
	done?: boolean;
	exitCode?: number | null;
	lost?: unknown;
}

/** smol cloud's states (machines.rs) as the adapter's; deleted is a record that won't come back, so none. */
const STATES: Readonly<Record<string, Machine["state"] | undefined>> = {
	creating: "starting",
	started: "running",
	created: "stopped",
	stopped: "stopped",
	pausing: "stopped",
	paused: "stopped",
	error: "gone",
	deleting: "gone",
	deleted: undefined,
};

function machineOf(one: CloudMachine): Machine | undefined {
	if (!(one.state in STATES)) return { id: one.id, labels: { ...(one.labels ?? {}) }, state: "stopped", why: `smol cloud reads its state as ${one.state}` };
	const state = STATES[one.state];
	if (state === undefined) return undefined;
	const created = one.createdAt ? new Date(one.createdAt) : undefined;
	return {
		id: one.id,
		labels: { ...(one.labels ?? {}) },
		state,
		...(created && !Number.isNaN(created.getTime()) ? { createdAt: created } : {}),
		...(state === "gone" && one.error ? { why: one.error } : {}),
	};
}

class SmolcloudHost implements MachineHost {
	readonly descriptor = SMOLCLOUD;
	readonly facts: HostFacts = {
		daemon: "child",
		isolation: "microvm",
		lifetime: "janitor",
		maxLifetimeMs: DAY_MS,
		// Placement is pinned to amd64 at create (source.arch), so the daemon uploaded matches the node.
		arch: "amd64",
		// smol cloud's agent in the guest is reached over vsock, not TCP.
		vendorAgentPorts: [],
		labels: { count: 32 },
	};
	readonly #api: Rest;

	constructor(options: { apiKey: string; apiUrl: string; fetch?: typeof fetch }) {
		const { apiKey } = options;
		this.#api = rest({
			base: options.apiUrl,
			headers: () => ({ Authorization: `Bearer ${apiKey}`, Accept: "application/json" }),
			vendor: "smolcloud",
			...(options.fetch ? { fetch: options.fetch } : {}),
			timeoutMs: 30_000,
			retry: { attempts: 3, baseMs: 500 },
			// The error body is RFC 9457 problem details: its detail is the words (OpenAPI ErrorResponse). The account's cap
			// on machines at once answers 422, its code the status's own, so it is read by its words.
			explain: ({ status, bytes, what }) => {
				const detail = (jsonOf(bytes) as { detail?: unknown } | null)?.detail;
				const words = typeof detail === "string" ? detail : "";
				return { ...(words.startsWith("concurrency limit reached") ? { code: "limit" as const } : {}), message: `${what} answered ${status}${words ? `: ${words}` : ""}` };
			},
		});
	}

	async #call<T>(method: string, path: string, json: unknown, ctx: HostCall, extra: { retry?: boolean; named?: boolean; bytes?: Uint8Array<ArrayBuffer> } = {}): Promise<T> {
		const answer = orThrow(await this.#api.call(method, this.#api.url(path), { ...(json === undefined ? {} : { json }), timeoutMs: ctx.timeoutMs, ...extra }, ctx.signal));
		return jsonOf(answer.bytes) as T;
	}

	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const made = await this.#call<CloudMachine>(
			"POST",
			"/v1/machines",
			{
				name: `${NAME_PREFIX}${req.name}`,
				source: { type: "image", reference: req.image, arch: this.facts.arch },
				labels: req.labels,
				resources: { cpus: req.cpus ?? DEFAULT_CPUS, memoryMb: req.memoryMb ?? DEFAULT_MEMORY_MB },
				autoStopSeconds: 0,
				ttlSeconds: Math.max(1, Math.ceil((Date.parse(req.backstopAt) - Date.now()) / 1000)),
				start: true,
			},
			ctx,
			{ named: true },
		);
		return { id: made.id };
	}

	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		return machineOf(await this.#call<CloudMachine>("GET", `/v1/machines/${encodeURIComponent(id)}`, undefined, ctx, { retry: true }));
	}

	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const query = Object.entries(labels).map(([key, value]) => `label=${encodeURIComponent(`${key}=${value}`)}`);
		const listed = await this.#call<CloudMachine[]>("GET", `/v1/machines${query.length > 0 ? `?${query.join("&")}` : ""}`, undefined, ctx, { retry: true });
		return listed.map(machineOf).filter((one): one is Machine => one !== undefined);
	}

	async delete(id: string, ctx: HostCall): Promise<void> {
		await this.#call("DELETE", `/v1/machines/${encodeURIComponent(id)}`, undefined, ctx, { retry: true });
	}

	exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		const base = `/v1/machines/${encodeURIComponent(id)}/execs`;
		let seq = 0;
		// Aborted by kill() before its DELETE, so the output read stops even when the DELETE cannot reach smol cloud.
		const killed = new AbortController();
		const frame = (execId: string, json: object) => this.#call("POST", `${base}/${execId}/stdin`, { seq: ++seq, ...json }, { timeoutMs: STDIN_MS }, { retry: true });
		return framedExec<string>(
			{
				start: async (argv, ctx) => {
					const execId = `agr${randomBytes(12).toString("hex")}`;
					// smol cloud refuses an argv with an empty word (400 "command arguments cannot be empty"), which the adapter's
					// scripts pass for an unset option: such an argv runs as one quoted line under /bin/sh -c.
					const command = argv.includes("") ? ["/bin/sh", "-c", `exec ${shellLine(argv)}`] : argv;
					// Safe to send again: smol cloud answers a start retried with the same execId with the session the first try made,
					// never running the command twice (its OpenAPI, POST /v1/machines/{id}/execs).
					await this.#call("POST", base, { execId, command, interactive: true }, ctx, { retry: true });
					return execId;
				},
				events: (execId) => this.#events(base, execId, killed.signal),
				write: async (execId, text) => {
					const bytes = Buffer.from(text, "utf8");
					for (let at = 0; at < bytes.length; at += FRAME_BYTES) await frame(execId, { data: bytes.subarray(at, at + FRAME_BYTES).toString("base64") });
				},
				end: async (execId) => void (await frame(execId, { eof: true })),
				kill: async (execId) => {
					killed.abort();
					await this.#call("DELETE", `${base}/${execId}`, undefined, { timeoutMs: STDIN_MS }, { retry: true });
				},
			},
			argv,
			ctx,
		);
	}

	/**
	 * A resumable exec's output from its start, read by offset; its exit code last, when it ended with one. It ends when
	 * killed aborts, and throws once no read has been answered for READ_GIVE_UP_MS.
	 */
	async *#events(base: string, execId: string, killed: AbortSignal): AsyncGenerator<FramedEvent> {
		let after = 0;
		let answeredAt = Date.now();
		for (;;) {
			let read: ExecRead;
			try {
				read = await this.#call<ExecRead>("GET", `${base}/${execId}?after=${after}&wait=${POLL_WAIT_S}`, undefined, { timeoutMs: POLL_MS, signal: killed }, { retry: true });
			} catch (error) {
				if (killed.aborted) return;
				const code = error instanceof HostError ? error.code : "vendor";
				if (code === "not_found") return;
				// A node or control that restarts keeps the output: read again from the same offset.
				if (code !== "timeout" && code !== "vendor" && code !== "limit") throw error;
				if (Date.now() - answeredAt >= READ_GIVE_UP_MS) {
					throw new Error(`smol cloud answered no read of exec ${execId}'s output for ${READ_GIVE_UP_MS / 60_000} minutes, so it is read no more: the last answer was ${(error as Error).message}`);
				}
				await pause(1_000, killed);
				continue;
			}
			answeredAt = Date.now();
			if (read.lost) throw new Error(`smol cloud no longer holds part of exec ${execId}'s output: ${JSON.stringify(read.lost)}`);
			for (const chunk of read.output ?? []) yield { stream: chunk.stream === "stderr" ? "stderr" : "stdout", base64: chunk.data };
			if (typeof read.next === "number") after = read.next;
			if (read.done) {
				if (typeof read.exitCode === "number") yield { exit: read.exitCode };
				return;
			}
		}
	}

	/** The daemon's upload through the files API (PUT .../files/{path}), not exec's stdin: 8 MiB there takes about 40 s. */
	async upload(id: string, path: string, bytes: Uint8Array, ctx: HostCall): Promise<void> {
		const guest = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
		await this.#call("PUT", `/v1/machines/${encodeURIComponent(id)}/files/${guest}`, undefined, ctx, { retry: true, bytes: new Uint8Array(bytes) });
	}

	/** The janitor's deadline label, moved (PATCH .../labels changes the keys it names alone). */
	async extend(id: string, endsAt: Date, ctx: HostCall): Promise<void> {
		await this.#call("PATCH", `/v1/machines/${encodeURIComponent(id)}/labels`, { labels: { [DEADLINE_LABEL]: endsAt.toISOString() } }, ctx);
	}

	/**
	 * An image is an OCI reference; labels are what smol cloud takes (validate.rs): a name of 1 to 63 of a-z, 0-9 and
	 * ._/-, starting and ending with a letter or digit, and a value of at most 255 characters, the image and the network
	 * list among them (the adapter stores both as label values). Their count, the adapter's own among them, is the
	 * adapter's to check (facts.labels).
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, labels, network } = spec;
		if (image !== undefined && (typeof image !== "string" || image.trim() === "")) refusals.push({ field: "image", message: "a smol cloud image is an OCI reference, such as alpine:3.20" });
		else if (typeof image === "string" && chars(image) > LABEL_VALUE_CHARS) refusals.push({ field: "image", message: `smol cloud keeps the image in a label of at most ${LABEL_VALUE_CHARS} characters, and this one has ${chars(image)}` });
		const entries = labels !== null && typeof labels === "object" ? Object.entries(labels) : [];
		const keys = entries.filter(([key]) => !LABEL_KEY.test(key)).map(([key]) => show(key));
		if (keys.length > 0) refusals.push({ field: "labels", message: `smol cloud takes label names of 1 to 63 of a-z, 0-9 and ._/-, starting and ending with a letter or digit: ${keys.join(", ")}` });
		const long = entries.filter(([, value]) => typeof value === "string" && chars(value) > LABEL_VALUE_CHARS).map(([key, value]) => `${show(key)} has ${chars(value)}`);
		if (long.length > 0) refusals.push({ field: "labels", message: `smol cloud takes label values of at most ${LABEL_VALUE_CHARS} characters: ${long.join(", ")}` });
		let form = "";
		try {
			form = network === undefined ? "" : networkFormOf(network);
		} catch {
			// A network the adapter refuses itself, in its own words.
		}
		if (chars(form) > LABEL_VALUE_CHARS) refusals.push({ field: "network", message: `smol cloud keeps the network list in a label of at most ${LABEL_VALUE_CHARS} characters, and this one comes to ${chars(form)}: name fewer hosts` });
		return refusals;
	}
}

export class SmolcloudProvider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it): the box image the release publishes, by its
	 * public registry tag (box-image.ts). No call: smol cloud pulls it at each create.
	 */
	async prepareImage(): Promise<Result<string>> {
		return ok(boxImageRef());
	}

	constructor(options: SmolcloudProviderOptions) {
		const { apiKey, apiUrl = DEFAULT_API_URL, fetch, maxLifetimeMs = DAY_MS, ...rest } = options ?? ({} as SmolcloudProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the smol cloud API key, is required: the provider reads no environment, so the caller passes it");
		super(new SmolcloudHost({ apiKey, apiUrl: httpsBase(apiUrl, "the smol cloud API URL"), ...(fetch ? { fetch } : {}) }), { ...rest, maxLifetimeMs });
	}
}
