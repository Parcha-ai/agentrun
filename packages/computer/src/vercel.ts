// The Vercel Sandbox host: a Linux sandbox on a Firecracker microVM, over Vercel's REST API (a Bearer token, the team
// as ?teamId=, the project in each call). Sources: D = vercel.com/docs/sandbox, S = @vercel/sandbox 5.0.0, Vercel's own
// client, whose calls this host makes. A sandbox's native name is the request's, so the machine's id is its name. Made
// with persistent false (D persistent-sandboxes), it has the one session create starts, which every command and the
// timer go through. The exec is a detached command (S runCommand): its NDJSON log stream, stdin by offset, and a kill,
// as framedExec's pieces. Tags are 5 at most (D tags), so the labels are packed.
//
// Unverified until the live run: root makes a network namespace in the microVM; the log stream keeps a character
// written in two pieces whole and stays open through 75 s of silence; a create whose name the project holds answers
// 409 (read as exists); a sandbox's end is its session's start plus its timeout; no vendor agent listens on TCP.
import { boxRecipeHash } from "./box-image.js";
import { VERCEL } from "./descriptors/vercel.js";
import { DEFAULT_CPUS } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { type FramedEvent, framedExec } from "./hosted/framed-exec.js";
import { orThrow, pause } from "./hosted/process.js";
import { HostedProvider, type HostedOptions } from "./hosted/provider.js";
import { allPages, jsonOf, ndjson, type Rest, type RestInit, rest } from "./hosted/rest.js";
import { dateOf } from "./hosted/values.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import { ok, type Result } from "./result.js";

/** The Vercel provider's options: the token, the team and the project, then the shared adapter's (HostedOptions). */
export interface VercelProviderOptions extends Omit<HostedOptions, "kind" | "desktop"> {
	/** A Vercel access token of the team. The caller passes it; this provider never reads it from the environment. */
	token: string;
	/** The team the sandboxes bill to (team_...): every call names it. */
	teamId: string;
	/** The project the sandboxes and the box image live in (prj_...). */
	projectId: string;
	/** The fetch every call goes through; default the global one. */
	fetch?: typeof fetch;
}

export async function create(options: VercelProviderOptions): Promise<VercelProvider> {
	return new VercelProvider(options);
}

export const conformance = () => import("./conformance/vercel.js");

const API_URL = "https://api.vercel.com";
/** Every computer's name starts with this (MachineRequest.name), so a listing asks for the project's computers alone. */
const NAME_PREFIX = "computer-";
/** A session's longest life on Pro and Enterprise (D pricing, runtime limits); Hobby's is 45 minutes. */
const DAY_MS = 24 * 60 * 60_000;
/** A stdin write's bytes: the SDK's own chunk (S, 512 KiB), its base64 under the API's 1 MB body. */
const STDIN_BYTES = 512 * 1024;
const CALL_MS = 30_000;
/** Reads of a command's output that fail running, after which it is read no more: a control plane down that long is down. */
const READ_TRIES = 10;
/** The box image as the operator pushes it to the project's registry (PROVIDERS.md, "Your image"): a tag of its recipe. */
export const boxVercelImage = (): string => `agentrun-box:${boxRecipeHash()}`;
/** A registry reference (D images, "Image references"): [vcr.vercel.com/][team/project/]repository[:tag|@sha256:digest];
 * a team slug has no dot, so another registry's host (ghcr.io/...) is not read as a team. */
const IMAGE = /^(vcr\.vercel\.com\/)?([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[0-9a-f]{64})?$/;

/** A sandbox and its session as the API answers them (S validators Sandbox, Session), as far as this host reads them. */
type VercelSandbox = { name: string; status: string; createdAt?: number; currentSessionId: string; tags?: Record<string, string> };
type VercelSession = { id: string; status: string; timeout: number; requestedAt?: number; startedAt?: number; stopReason?: string };
type LogLine = { stream: "stdout" | "stderr"; data: string } | { stream: "error"; data: { code?: string; message?: string } };
/** A command as the exec pieces hold it: its session, its id, and the stdin bytes written so far (each write's offset). */
type Command = { session: string; id: string; offset: number; killed: AbortController };

/** Vercel's statuses (S Session status) as the adapter's: a sandbox made non-persistent never runs again once it stops. */
const STATES: Readonly<Record<string, Machine["state"]>> = { pending: "starting", running: "running", stopping: "gone", snapshotting: "gone", stopped: "gone", failed: "gone", aborted: "gone" };

function machineOf(sandbox: VercelSandbox, session?: VercelSession): Machine {
	const state = STATES[sandbox.status];
	const created = dateOf(sandbox.createdAt);
	const started = session?.startedAt ?? session?.requestedAt;
	return {
		id: sandbox.name,
		labels: { ...(sandbox.tags ?? {}) },
		// One Vercel reads in a status this host doesn't know is listed, so the janitor still ends it.
		state: state ?? "stopped",
		...(state === undefined ? { why: `Vercel reads its status as ${sandbox.status}` } : state === "gone" && session?.stopReason ? { why: session.stopReason } : {}),
		...(created ? { createdAt: created } : {}),
		...(started !== undefined && session ? { endsAt: new Date(started + session.timeout) } : {}),
	};
}

class VercelHost implements MachineHost {
	readonly descriptor = VERCEL;
	// VCR serves Sandbox a linux/amd64 build alone (D images). Unverified: no page names a listener of Vercel's in the VM
	// (the exec pre-check prints them). 5 tags, a value 256 characters at most (D tags): the packed map's.
	readonly facts: HostFacts = { daemon: "child", isolation: "microvm", lifetime: "vendor", maxLifetimeMs: DAY_MS, arch: "amd64", vendorAgentPorts: [], labels: { count: 5, packed: { valueBytes: 256 } } };
	readonly #api: Rest;
	readonly #query: Record<string, string>;
	/** Each sandbox's session, as create, get and list read it: persistent false, so it never changes. */
	readonly #sessions = new Map<string, string>();

	constructor(options: { token: string; teamId: string; projectId: string; fetch?: typeof fetch }) {
		const { token, teamId, projectId } = options;
		this.#query = { teamId, projectId };
		this.#api = rest({
			base: API_URL,
			headers: () => ({ Authorization: `Bearer ${token}`, Accept: "application/json" }),
			vendor: "vercel",
			...(options.fetch ? { fetch: options.fetch } : {}),
			timeoutMs: CALL_MS,
			retry: { attempts: 3, baseMs: 500 },
			// The error body is {error: {code, message}} (S base-client ErrorResponseBody). An image VCR is still preparing
			// answers image_not_ready (D images): a wait, not a refusal.
			explain: ({ status, bytes, what }) => {
				const error = (jsonOf(bytes) as { error?: { code?: unknown; message?: unknown } } | null)?.error;
				const words = [error?.code, error?.message].filter((part) => typeof part === "string" && part !== "").join(": ");
				return { ...(error?.code === "image_not_ready" ? { code: "timeout" as const } : {}), message: `${what} answered ${status}${words ? `: ${words}` : ""}` };
			},
		});
	}

	async #call<T>(method: string, path: string, query: Record<string, string>, ctx: HostCall, init: RestInit = {}): Promise<T> {
		const url = `${this.#api.url(path)}?${new URLSearchParams({ teamId: this.#query.teamId, ...query })}`;
		return jsonOf(orThrow(await this.#api.call(method, url, { timeoutMs: ctx.timeoutMs, ...init }, ctx.signal)).bytes) as T;
	}

	#read(sandbox: VercelSandbox, session?: VercelSession): Machine {
		this.#sessions.set(sandbox.name, sandbox.currentSessionId);
		return machineOf(sandbox, session);
	}

	/**
	 * POST /v3/sandboxes (S createSandbox): the request's name, the image, the lifetime as the session's timeout,
	 * persistent false, the size, the packed labels as tags, and the vendor's deny-all where the machine needs no egress
	 * (D firewall: optional hardening under init's fence). Vercel answers once the session runs. A 429 alone is sent again;
	 * a create that got no answer may have made the sandbox, which the adapter finds by its name.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const { projectId } = this.#query;
		const body = { projectId, name: req.name, image: req.image, timeout: req.lifetimeMs, persistent: false, ports: [], resources: { vcpus: req.cpus ?? DEFAULT_CPUS }, tags: req.labels, ...(req.egress ? {} : { networkPolicy: { mode: "deny-all" } }) };
		try {
			const made = await this.#call<{ sandbox: VercelSandbox }>("POST", "/v3/sandboxes", {}, ctx, { json: body, named: true, retry: (status) => status === 429 });
			this.#read(made.sandbox);
		} catch (error) {
			// D images: a reference the project can't reach answers not_found.
			if (!(error instanceof HostError) || error.code !== "not_found") throw error;
			throw new HostError("invalid", `${error.message}: is the image ${req.image} in the project's registry? The box image is pushed once with \`vercel vcr build docker . ${boxVercelImage()} --push\` in box/`);
		}
		return { id: req.name };
	}

	/** GET /v2/sandboxes/{name} with resume=false, which never wakes it (S getSandbox); a 404 is none. */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const read = await this.#call<{ sandbox: VercelSandbox; session: VercelSession }>("GET", `/v2/sandboxes/${encodeURIComponent(id)}`, { projectId: this.#query.projectId, resume: "false" }, ctx, { retry: true });
		return this.#read(read.sandbox, read.session);
	}

	/** GET /v2/sandboxes, every page: the project's computers by name prefix, and by the one tag where one is asked (S filters by one). */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		const tag = Object.entries(labels);
		const query = { project: this.#query.projectId, namePrefix: NAME_PREFIX, ...(tag.length === 1 ? { tags: `${tag[0]?.[0]}:${tag[0]?.[1]}` } : {}) };
		const page = async (cursor?: string) => {
			const read = await this.#call<{ sandboxes: VercelSandbox[]; pagination?: { next?: string | null } }>("GET", "/v2/sandboxes", { ...query, ...(cursor ? { cursor } : {}) }, ctx, { retry: true });
			return ok({ items: read.sandboxes, ...(read.pagination?.next ? { next: read.pagination.next } : {}) });
		};
		return orThrow(await allPages<VercelSandbox>(page, 100, { vendor: "vercel", what: "GET /v2/sandboxes" })).map((sandbox) => this.#read(sandbox));
	}

	/** DELETE /v2/sandboxes/{name}, which stops a running one first; one Vercel no longer has is done. */
	async delete(id: string, ctx: HostCall): Promise<void> {
		await this.#call("DELETE", `/v2/sandboxes/${encodeURIComponent(id)}`, { projectId: this.#query.projectId }, ctx, { retry: true, accept: (status) => status === 404 || (status >= 200 && status < 300) });
		this.#sessions.delete(id);
	}

	async #session(id: string, ctx: HostCall): Promise<string> {
		if (!this.#sessions.has(id)) await this.get(id, ctx);
		return this.#sessions.get(id) as string;
	}

	exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		const path = (cmd: Command, rest = "") => `/v2/sandboxes/sessions/${cmd.session}/cmd/${cmd.id}${rest}`;
		/** One stdin call (S writeCommandStdin): with its offset, Vercel skips bytes it has, so it is safe to send again. */
		const stdin = async (cmd: Command, json: { data?: string; close?: true }, bytes = 0) => {
			await this.#call("POST", path(cmd, "/stdin"), {}, { timeoutMs: CALL_MS }, { json: { ...json, offset: cmd.offset }, retry: true });
			cmd.offset += bytes;
		};
		return framedExec<Command>(
			{
				// As root through sudo, argv as its words (no shell line), stdin attached (S runCommand, detached).
				start: async ([command, ...args], ctx) => {
					const session = await this.#session(id, ctx);
					const started = await this.#call<{ command: { id: string } }>("POST", `/v2/sandboxes/sessions/${session}/cmd`, {}, ctx, { json: { command, args, sudo: true, attachStdin: true } });
					return { session, id: started.command.id, offset: 0, killed: new AbortController() };
				},
				events: (cmd) => this.#events(cmd, path(cmd)),
				write: async (cmd, text) => {
					const bytes = Buffer.from(text, "utf8");
					for (let at = 0; at < bytes.length; at += STDIN_BYTES) {
						const part = bytes.subarray(at, at + STDIN_BYTES);
						await stdin(cmd, { data: part.toString("base64") }, part.length);
					}
				},
				end: (cmd) => stdin(cmd, { close: true }),
				kill: async (cmd) => {
					cmd.killed.abort();
					await this.#call("POST", path(cmd, "/kill"), {}, { timeoutMs: CALL_MS }, { json: { signal: 9 } });
				},
			},
			argv,
			ctx,
		);
	}

	/**
	 * A command's output (GET .../logs, NDJSON {stream, data} lines, as text), then its exit code (GET the command:
	 * exitCode once it ended). A stream that ends or drops while the command runs is read again: Vercel answers it from
	 * the start, so the characters already given each stream are skipped (S getLogsStream). A stream can end before the
	 * command's last write, so once the command read finds it exited the logs are read once more before the exit. An
	 * `error` line is the command's end in Vercel's words (the sandbox stopped); READ_TRIES failed reads in a row end it too.
	 */
	async *#events(cmd: Command, path: string): AsyncGenerator<FramedEvent> {
		const given = { stdout: 0, stderr: 0 };
		const ctx = { timeoutMs: CALL_MS, signal: cmd.killed.signal };
		let exit: number | undefined;
		for (let failed = 0; ; ) {
			try {
				const skip = { ...given };
				const { body } = orThrow(await this.#api.stream("GET", `${this.#api.url(`${path}/logs`)}?teamId=${encodeURIComponent(this.#query.teamId)}`, { timeoutMs: CALL_MS }, ctx.signal));
				for await (const line of ndjson(body) as AsyncIterable<LogLine>) {
					if (line.stream === "error") throw new HostError("gone", `Vercel ended command ${cmd.id}'s output: ${[line.data.code, line.data.message].filter(Boolean).join(": ")}`);
					const cut = Math.min(skip[line.stream], line.data.length);
					skip[line.stream] -= cut;
					const text = line.data.slice(cut);
					if (text === "") continue;
					given[line.stream] += text.length;
					yield { stream: line.stream, text };
				}
				if (exit !== undefined) return yield { exit };
				const { command } = await this.#call<{ command: { exitCode: number | null } }>("GET", path, {}, ctx, { retry: true });
				failed = 0;
				if (typeof command.exitCode === "number") {
					exit = command.exitCode;
					continue;
				}
			} catch (error) {
				if (cmd.killed.signal.aborted) return;
				if ((error instanceof HostError && error.code === "gone") || ++failed >= READ_TRIES) throw error;
			}
			await pause(1_000, cmd.killed.signal);
		}
	}

	/**
	 * Moves the session's end by the difference (POST .../extend-timeout, S extendTimeout); never earlier. Past the plan's
	 * cap (D pricing: 45 minutes on Hobby, 24 hours on Pro) Vercel refuses, a limit.
	 */
	async extend(id: string, endsAt: Date, ctx: HostCall): Promise<void> {
		const now = (await this.get(id, ctx))?.endsAt;
		const duration = endsAt.getTime() - (now?.getTime() ?? endsAt.getTime());
		if (duration <= 0) return;
		try {
			await this.#call("POST", `/v2/sandboxes/sessions/${await this.#session(id, ctx)}/extend-timeout`, {}, ctx, { json: { duration } });
		} catch (error) {
			if (!(error instanceof HostError) || error.code !== "invalid") throw error;
			throw new HostError("limit", `Vercel moves a sandbox's end no further: ${error.message}`);
		}
	}

	/** An image is a registry reference; a size is 1 or an even 2 to 8 vCPUs, with 2048 MiB a vCPU and no other memory (S sandbox.ts). */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, cpus, memoryMb } = spec;
		if (typeof image === "string" && !IMAGE.test(image)) refusals.push({ field: "image", message: `a Vercel image is a Vercel Container Registry reference: ${boxVercelImage()} in the project, or team/project/repository:tag` });
		if (cpus !== undefined && !(cpus === 1 || (typeof cpus === "number" && Number.isInteger(cpus) && cpus >= 2 && cpus <= 8 && cpus % 2 === 0))) refusals.push({ field: "cpus", message: "a Vercel sandbox has 1, 2, 4, 6 or 8 vCPUs" });
		const fixed = 2048 * (typeof cpus === "number" ? cpus : DEFAULT_CPUS);
		if (memoryMb !== undefined && memoryMb !== fixed) refusals.push({ field: "memoryMb", message: `a Vercel sandbox has 2048 MiB a vCPU, so ${fixed} here: name cpus, not memoryMb` });
		return refusals;
	}
}

export class VercelProvider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it): the box image as the project's registry holds it,
	 * agentrun-box:<recipe hash>, pushed once by the operator (PROVIDERS.md, "Your image"). No call: Vercel resolves the
	 * tag at each create, and a project without it refuses the create in words that say how to push it.
	 */
	async prepareImage(): Promise<Result<string>> {
		return ok(boxVercelImage());
	}

	constructor(options: VercelProviderOptions) {
		const { token, teamId, projectId, fetch, maxLifetimeMs = DAY_MS, ...rest } = options ?? ({} as VercelProviderOptions);
		if (typeof token !== "string" || token === "") throw new Error("options.token, a Vercel access token, is required: the provider reads no environment, so the caller passes it");
		for (const [name, value] of [["teamId", teamId], ["projectId", projectId]] as const) {
			if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`options.${name} is required: the Vercel ${name === "teamId" ? "team" : "project"} id, such as ${name === "teamId" ? "team_abc123" : "prj_abc123"}`);
		}
		super(new VercelHost({ token, teamId, projectId, ...(fetch ? { fetch } : {}) }), { ...rest, maxLifetimeMs });
	}
}
