// The Agent37 host: Agent37 Cloud instances (kind linux, or kind desktop on our box template, agentrun-box-<hash>, whose Xvfb
// the adapter starts through the daemon), each a whole VM by default (type "vm"), or a gVisor sandbox
// (type "default"). The control plane is Agent37's REST API over fetch (https://api.agent37.com/v1, a Bearer key);
// every command (the daemon's upload, its install, init's start, the stdio bridge) goes over SSH, as root, through the
// host's own ssh2 package, of which this package names only the slice it uses (Ssh2Module) and imports nothing at load.
// Agent37 has no SSH port on the internet: the SSH stream rides a binary WebSocket to wss://{id}-22022.agent37.app,
// which the edge opens for the workspace key in X-Agent37-Key (npm agent37@0.4.1 src/cli.js, wsHandshake and runTunnel),
// and the instance's sshd then takes the workspace's registered SSH key. Agent37's REST exec is one-shot (no stdin,
// output only at its end), so it is not used. The rest of the computer is the shared machine-host adapter's
// (./hosted/provider.ts). Every vendor fact here is cited in the README's Agent37 section.
import { createHash } from "node:crypto";
import { Duplex } from "node:stream";
import { boxImageRef, boxRecipeHash } from "./box-image.js";
import { AGENT37, AGENT37_BASE_TEMPLATE } from "./descriptors/agent37.js";
import { DEADLINE_LABEL, show } from "./drift.js";
import { type HostCall, HostError, type HostFacts, type Machine, type MachineHost, type MachineProcess, type MachineRequest } from "./host.js";
import { orThrow } from "./hosted/process.js";
import { jsonOf, type Rest, rest } from "./hosted/rest.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts } from "./hosted/provider.js";
import { pemOf, type Ssh2Module, SshExec, SshTunnelError, type SshTunnel } from "./hosted/ssh-exec.js";
import { dateOf, DOMAIN, isWhole } from "./hosted/values.js";
import type { CallContext, ComputerSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, failFor, ok, type Result } from "./result.js";

/** A WebSocket as this provider uses one: Node's global WebSocket (undici), which takes headers, or the same slice. */
export interface WebSocketLike {
	binaryType: string;
	readonly readyState: number;
	readonly bufferedAmount: number;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "close" | "error", listener: (event: { code?: number; reason?: string; message?: string }) => void): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export type WebSocketClass = new (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

/** One Agent37 instance as the REST API answers it (docs: agents-api/instances/object), as far as this provider reads it. */
export interface Agent37Instance {
	id: string;
	status: string;
	status_reason?: { code?: string; message?: string } | null;
	template?: string;
	image_digest?: string | null;
	type?: string;
	region?: string;
	resources?: { cpu?: number; memory?: number; disk?: number };
	public_ports?: unknown[];
	name?: string | null;
	metadata?: Record<string, string> | null;
	auto_sleep?: boolean;
	network?: unknown;
	created?: number;
}

/** What Agent37 runs an instance on: a VM with its own kernel, or a gVisor sandbox (docs: agents-api/vm-instances). */
export type Agent37Type = "vm" | "default";
/** Where an instance runs (docs: agents-api/instances/create, region). */
export type Agent37Region = "us" | "eu" | "ap-south";

/** The Agent37 provider's options: the key, the SSH key and ssh2, then the shared adapter's (HostedOptions). */
export interface Agent37ProviderOptions extends Omit<HostedOptions, "maxLifetimeMs"> {
	/** The workspace's API key (sk_live_...). The caller passes it; this provider never reads it from the environment. */
	apiKey: string;
	/**
	 * The private half of an SSH key registered on the same workspace (POST /v1/ssh-keys), in OpenSSH or PEM form: its
	 * contents, never a path. Every command reaches an instance over SSH as root with it.
	 */
	sshKey: string;
	/** The ssh2 package: the host's own, or anything with the same slice. */
	ssh2: Ssh2Module;
	/** The fetch every REST call goes through; default the global one. */
	fetch?: typeof fetch;
	/** The WebSocket the SSH stream rides; default Node's global one. */
	WebSocket?: WebSocketClass;
	/** Agent37's REST API; default https://api.agent37.com. */
	apiUrl?: string;
	/** The domain an instance's ports answer under, {id}-{port}.<domain>; default agent37.app. */
	proxyDomain?: string;
	/** vm (default): a whole VM with its own kernel; default: Agent37's gVisor sandbox. */
	type?: Agent37Type;
	/** us (default), eu or ap-south; outside us, type vm alone. */
	region?: Agent37Region;
	/**
	 * linux (default): no screen; desktop: an X server started through the daemon (Xvfb on :0 unless options.desktop says
	 * otherwise), so the spec's image is a template that has one: our box template, which prepareImage() registers.
	 */
	kind?: "desktop" | "linux";
	/** The longest lifetime check takes: 24 h by default, the janitor's cap; Agent37 itself never ends an instance. */
	maxLifetimeMs?: number;
	timeouts?: Partial<HostedTimeouts>;
}

/** What create() takes: the provider's options, ssh2 optional (default the host's ssh2 package). */
export interface Agent37Options extends Omit<Agent37ProviderOptions, "ssh2"> {
	ssh2?: Ssh2Module;
}

/** Not a literal, so no type checker or bundler resolves ssh2 from this package. */
const SSH2_PACKAGE: string = "ssh2";
const DEFAULT_API_URL = "https://api.agent37.com";
const DEFAULT_PROXY_DOMAIN = "agent37.app";
/** The port the platform's sshd answers on inside every instance, reached as {id}-22022.<domain> (cli.js:21, 720). */
export const AGENT37_SSH_PORT = 22022;
/** The platform's web terminal (ttyd), a root shell for whoever reaches it: seen listening on every VM. */
const AGENT37_TTYD_PORT = 7681;
/** An instance id: ten lowercase letters and digits, its DNS label (docs: instances/object; cli.js:19). */
const INSTANCE_ID = /^[a-z0-9]{10}$/;
/** A template name (cli.js:18), with an optional @<version> pin (docs: templates, pin a template version). */
const TEMPLATE = /^[a-z][a-z0-9-]{1,62}(@[A-Za-z0-9._-]{1,64})?$/;
const DAY_MS = 24 * 60 * 60_000;
/** The instance shapes Agent37 makes, cpu and memory in GB (docs: instance-sizing): 4 vCPU is every type's ceiling. */
const SHAPES: ReadonlyArray<{ cpu: number; memory: number }> = [
	{ cpu: 2, memory: 4 },
	{ cpu: 4, memory: 8 },
	{ cpu: 4, memory: 16 },
	{ cpu: 4, memory: 32 },
];
const MAX_CPUS = 4;
/**
 * metadata's cap, serialized (docs: instances/edit, "up to 4 KB serialized"): check() holds the names and values to it,
 * and create the JSON, its quotes and commas too.
 */
const METADATA_MAX_BYTES = 4096;
/** A VM boots inside the create's POST, which answers once it runs (docs: instances/create, Defaults). */
const DEFAULT_CREATE_MS = 300_000;
/** How much a tunnel may hold unsent before a write waits for it (the WebSocket's bufferedAmount). */
const TUNNEL_HIGH_WATER = 1024 * 1024;
const TUNNEL_POLL_MS = 10;
/**
 * A registration copies the image into the workspace's storage before it answers, "up to a few minutes for a large
 * image" (docs: templates, Register a workspace template): the POST's bound, and the wait on another's registration.
 */
const REGISTER_MS = 15 * 60_000;
/** One read of a template. */
const TEMPLATE_READ_MS = 30_000;
/** How often a template another registration is making is read again. */
const TEMPLATE_POLL_MS = 1_000;

/** An id held to Agent37's form before it reaches a URL or a host name (an id is also a DNS label here): not_found else. */
function instanceId(id: string): string {
	if (!INSTANCE_ID.test(id)) throw new HostError("not_found", `${JSON.stringify(id)} is not an Agent37 instance id (ten lowercase letters and digits)`);
	return id;
}

/** The envelope's code: { error: { code } } on the Sandbox API, a flat { error: "<code>" } on transport errors (docs: errors). */
function envelopeOf(body: unknown): { code?: string; message?: string } {
	const error = (body as { error?: unknown } | null)?.error;
	if (typeof error === "string") return { code: error, ...(typeof (body as { message?: unknown }).message === "string" ? { message: (body as { message: string }).message } : {}) };
	if (typeof error === "object" && error !== null) {
		const { code, message } = error as { code?: unknown; message?: unknown };
		return { ...(typeof code === "string" ? { code } : {}), ...(typeof message === "string" ? { message } : {}) };
	}
	return {};
}

/** Agent37's codes (docs: errors, Sandbox API codes), each as a ComputerErrorCode; any other is the vendor's. */
const CODES: Record<string, ComputerErrorCode> = {
	not_found: "not_found",
	invalid_api_key: "denied",
	ip_not_allowed: "denied",
	forbidden: "denied",
	invalid_request: "invalid",
	image_too_large: "invalid",
	insufficient_balance: "limit",
	instance_limit_reached: "limit",
	tier_limit: "limit",
	no_capacity: "limit",
	capacity_unavailable: "limit",
	rate_limited: "limit",
};

function codeOf(error: unknown): ComputerErrorCode {
	const { level } = (error ?? {}) as { level?: unknown };
	if (error instanceof HostError) return error.code;
	// ssh2 names the stage that failed (lib/client.js): the instance's sshd refused the key, or the handshake timed out.
	if (level === "client-authentication") return "denied";
	if (level === "client-timeout") return "timeout";
	return "vendor";
}

/** Agent37's statuses (docs: instances/object, Statuses) as the adapter's states; failed, deleting and deleted are gone (get answers none for deleted). */
function stateOf(status: string): Machine["state"] | undefined {
	if (status === "running") return "running";
	if (["provisioning", "starting", "waking", "restarting", "updating"].includes(status)) return "starting";
	if (["stopping", "stopped", "sleeping"].includes(status)) return "stopped";
	if (["failed", "deleting", "deleted"].includes(status)) return "gone";
	return undefined;
}

/** An instance as the adapter reads a machine: its state (a status it does not know is gone, in words), labels, start. */
function machineOf(instance: Agent37Instance): Machine {
	const state = stateOf(instance.status);
	// A failed instance always carries a why, Agent37's or ours, so create stops on it as vendor, never as gone.
	const why =
		instance.status_reason?.message ??
		(state === undefined ? `Agent37 reads the status ${show(instance.status)}, which this provider does not know` : instance.status === "failed" ? "Agent37 reads the instance failed, with no reason given" : undefined);
	const created = dateOf(instance.created, "s");
	return {
		id: instance.id,
		labels: { ...(instance.metadata ?? {}) },
		state: state ?? "gone",
		...(created ? { createdAt: created } : {}),
		...(why === undefined || (state !== undefined && state !== "gone") ? {} : { why }),
	};
}

/** The shape a request's cpus and memoryMb ask for, or undefined when they ask for none of Agent37's. */
function shapeOf(cpus: number | undefined, memoryMb: number | undefined): { cpu: number; memory: number } | undefined {
	return SHAPES.find((shape) => (cpus === undefined || shape.cpu === cpus) && (memoryMb === undefined || shape.memory * 1024 === memoryMb));
}

const SHAPE_WORDS = SHAPES.map(({ cpu, memory }) => `${cpu} CPUs with ${memory * 1024} MiB`).join(", ");

/**
 * A WebSocket's binary stream as a Duplex for ssh2: what the socket gives is read, a write is one binary frame, and a
 * write waits while the socket holds more than TUNNEL_HIGH_WATER unsent. Its end closes the socket.
 */
function tunnelOf(ws: WebSocketLike, host: string): { duplex: Duplex; opened: Promise<void> } {
	let open = false;
	const duplex = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, done) {
			if (ws.readyState !== 1) return done(new SshTunnelError(`the SSH tunnel to ${host} is closed`));
			try {
				ws.send(chunk);
			} catch (error) {
				return done(error as Error);
			}
			const wait = () => {
				if (ws.readyState !== 1) done(new SshTunnelError(`the SSH tunnel to ${host} closed while it sent`));
				else if (ws.bufferedAmount <= TUNNEL_HIGH_WATER) done();
				else setTimeout(wait, TUNNEL_POLL_MS);
			};
			wait();
		},
		final(done) {
			try {
				ws.close(1000);
			} catch {
				// Closed already.
			}
			done();
		},
		destroy(error, done) {
			try {
				ws.close(1000);
			} catch {
				// Closed already.
			}
			done(error);
		},
	});
	ws.addEventListener("message", ({ data }) => {
		if (data instanceof ArrayBuffer) duplex.push(Buffer.from(data));
		else if (ArrayBuffer.isView(data)) duplex.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
		else if (typeof data === "string") duplex.push(Buffer.from(data, "utf8"));
	});
	const opened = new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => {
			open = true;
			resolve();
		});
		ws.addEventListener("error", (event) => {
			const error = new SshTunnelError(`the SSH tunnel to ${host} failed${open ? "" : " to open"}${event.message ? `: ${event.message}` : ""}`);
			if (!open) reject(error);
			else duplex.destroy(error);
		});
		ws.addEventListener("close", ({ code, reason }) => {
			if (!open) reject(new SshTunnelError(`the SSH tunnel to ${host} was refused (closed with ${code ?? "no code"}${reason ? `: ${reason}` : ""}); the edge opens it for the workspace's API key alone`));
			else duplex.push(null);
		});
	});
	opened.catch(() => {});
	return { duplex, opened };
}

/** Agent37's instances as a MachineHost (../host.ts). */
class Agent37Host implements MachineHost {
	readonly descriptor = AGENT37;
	readonly facts: HostFacts;
	readonly #apiKey: string;
	readonly #ssh: SshExec;
	readonly #client: Rest;
	readonly #WebSocket: WebSocketClass;
	readonly #proxyDomain: string;
	readonly #declared: { type: Agent37Type; region: Agent37Region };

	constructor(options: { apiKey: string; sshKey: string; ssh2: Ssh2Module; fetch: typeof fetch; WebSocket: WebSocketClass; apiUrl: string; proxyDomain: string; type: Agent37Type; region: Agent37Region }) {
		this.#apiKey = options.apiKey;
		this.#ssh = new SshExec({ ssh2: options.ssh2, loginOf: () => ({ username: "root", privateKey: options.sshKey }), tunnelOf: (id) => this.#tunnel(id) });
		this.#client = rest({
			base: options.apiUrl,
			headers: () => ({ Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" }),
			vendor: "agent37",
			fetch: options.fetch,
			timeoutMs: 30_000, // every call gives its own: ctx.timeoutMs
			explain: ({ status, bytes, what }) => {
				const { code, message } = envelopeOf(jsonOf(bytes));
				const known = code === undefined ? undefined : CODES[code];
				return { ...(known === undefined ? {} : { code: known }), message: `${what} answered ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}` };
			},
		});
		this.#WebSocket = options.WebSocket;
		this.#proxyDomain = options.proxyDomain;
		this.#declared = { type: options.type, region: options.region };
		this.facts = {
			daemon: "child",
			// The adapter holds the probe's kernel to it: gVisor's for type default, never for a VM.
			isolation: options.type === "vm" ? "vm" : "gvisor",
			lifetime: "janitor",
			maxLifetimeMs: DAY_MS,
			arch: "amd64",
			vendorAgentPorts: [AGENT37_SSH_PORT, AGENT37_TTYD_PORT],
			// The box template is the box image (box/Dockerfile), which has xfwm4: the apps an agent opens are framed and focused.
			windowManager: true,
			labels: { bytes: METADATA_MAX_BYTES },
		};
	}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	/** The SSH stream to an instance's sshd: a binary WebSocket the edge opens for the workspace key (cli.js wsHandshake), as a Duplex. */
	#tunnel(id: string): SshTunnel {
		const host = `${id}-${AGENT37_SSH_PORT}.${this.#proxyDomain}`;
		const ws = new this.#WebSocket(`wss://${host}/`, { headers: { "X-Agent37-Key": this.#apiKey } });
		ws.binaryType = "arraybuffer";
		return { ...tunnelOf(ws, host), host };
	}

	/** argv as root over SSH (hosted/ssh-exec.ts): one connection per instance through its tunnel, shared by its execs. */
	async exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		return this.#ssh.exec(instanceId(id), argv, ctx);
	}

	/** One REST call, bounded by ctx: its JSON answer; a failure throws a HostError in Agent37's words. */
	async #rest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body: object | undefined, ctx: HostCall): Promise<T> {
		const answer = orThrow(await this.#client.call(method, this.#client.url(path), { ...(body === undefined ? {} : { json: body }), timeoutMs: ctx.timeoutMs }, ctx.signal));
		const parsed = jsonOf(answer.bytes);
		if (parsed === null) throw new HostError("vendor", `${method} ${path} answered ${answer.status} with no JSON body`);
		return parsed as T;
	}

	/** An Agent37 template is a name, with an optional @<version>; a size is one of Agent37's four shapes. The adapter holds metadata to 4 KB (facts.labels.bytes). */
	check(given: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const { image, cpus, memoryMb } = given;
		if (typeof image === "string" && image !== "" && !TEMPLATE.test(image)) {
			refusals.push({ field: "image", message: `an image is the name of an Agent37 template, optionally pinned as name@version, such as "${AGENT37_BASE_TEMPLATE}"` });
		}
		if (cpus !== undefined && (!isWhole(cpus) || cpus > MAX_CPUS)) {
			refusals.push({ field: "cpus", message: `an Agent37 instance has at most ${MAX_CPUS} CPUs, and Agent37 gives 4 for a larger ask without saying so: ask for 2 or 4` });
		} else if ((cpus !== undefined || memoryMb !== undefined) && shapeOf(cpus, memoryMb) === undefined) {
			refusals.push({ field: cpus !== undefined && !SHAPES.some((shape) => shape.cpu === cpus) ? "cpus" : "memoryMb", message: `an Agent37 instance is one of its shapes: ${SHAPE_WORDS}` });
		}
		return refusals;
	}

	/**
	 * POST /v1/instances: the template, the type and region, the size when the spec asks one, the request's name as the
	 * instance's name, the labels as metadata, deny-all (or allow-all where the adapter asks egress: an Archil computer's root, or the
	 * egress proxy of a network open or a list), auto-sleep off and
	 * no public port. It answers once the instance runs (docs: instances/create, Defaults).
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }> {
		const bytes = Buffer.byteLength(JSON.stringify(req.labels));
		if (bytes > METADATA_MAX_BYTES) throw new HostError("invalid", `Agent37 holds an instance's metadata to ${METADATA_MAX_BYTES} bytes as JSON, and this one's would be ${bytes}: give shorter labels`);
		const shape = req.cpus !== undefined || req.memoryMb !== undefined ? shapeOf(req.cpus, req.memoryMb) : undefined;
		const made = await this.#rest<Agent37Instance>(
			"POST",
			"/v1/instances",
			{
				template: req.image,
				type: this.#declared.type,
				region: this.#declared.region,
				...(shape === undefined ? {} : { resources: { cpu: shape.cpu, memory: shape.memory } }),
				name: req.name,
				metadata: req.labels,
				network: req.egress ? "allow-all" : "deny-all",
				auto_sleep: false,
				public_ports: [],
			},
			ctx,
		);
		if (typeof made?.id !== "string" || !INSTANCE_ID.test(made.id)) throw new HostError("vendor", `POST /v1/instances answered no instance id: ${show(made?.id)}`);
		return { id: made.id };
	}

	/** GET /v1/instances/{id}; 404 is not_found, which the adapter reads as none, as is status deleted (docs: instances/get). */
	async get(id: string, ctx: HostCall): Promise<Machine | undefined> {
		const instance = await this.#rest<Agent37Instance>("GET", `/v1/instances/${instanceId(id)}`, undefined, ctx);
		// A deleted instance is one Agent37 no longer has, as a 404 is: the wait after a delete ends on it.
		return instance.status === "deleted" ? undefined : machineOf(instance);
	}

	/**
	 * GET /v1/instances: the whole workspace in one answer, newest first, each the full instance object (docs:
	 * instances/list). Agent37 filters nothing: the adapter matches the labels. An answer that says it has more is refused.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]> {
		void labels;
		const listed = await this.#rest<{ data?: unknown; has_more?: unknown; next_cursor?: unknown }>("GET", "/v1/instances", undefined, ctx);
		if (!Array.isArray(listed?.data)) throw new HostError("vendor", "GET /v1/instances answered no data list");
		if (listed.has_more === true || (listed.next_cursor !== undefined && listed.next_cursor !== null)) {
			throw new HostError("vendor", "GET /v1/instances answered a page with more after it, which Agent37 documents none of: this provider would miss machines");
		}
		return (listed.data as Agent37Instance[]).filter((instance) => typeof instance?.id === "string").map(machineOf);
	}

	/**
	 * DELETE /v1/instances/{id}, never signalled; a repeat answers 404, which the adapter reads as done (docs:
	 * instances/delete). Once taken, this host's SSH connections to the instance are ended, channels and all.
	 */
	async delete(id: string, ctx: HostCall): Promise<void> {
		const path = `/v1/instances/${instanceId(id)}`;
		try {
			await this.#rest("DELETE", path, undefined, { timeoutMs: ctx.timeoutMs });
		} catch (error) {
			// A 404 means the instance is gone already: its connections end too, then the adapter reads not_found as done.
			if (error instanceof HostError && error.code === "not_found") this.#ssh.closeAll(id);
			throw error;
		}
		this.#ssh.closeAll(id);
	}

	/** The janitor's deadline label moved: GET, then PATCH of the whole metadata, which replaces the stored object (docs: instances/edit). */
	async extend(id: string, endsAt: Date, ctx: HostCall): Promise<void> {
		const path = `/v1/instances/${instanceId(id)}`;
		const instance = await this.#rest<Agent37Instance>("GET", path, undefined, ctx);
		await this.#rest("PATCH", path, { metadata: { ...(instance.metadata ?? {}), [DEADLINE_LABEL]: endsAt.toISOString() } }, ctx);
	}

	/** GET /v1/templates/{name}: whether the workspace has it (404: it has not), else a HostError in Agent37's words. */
	async #hasTemplate(name: string, signal: AbortSignal | undefined): Promise<boolean> {
		const read = orThrow(await this.#client.call("GET", this.#client.url(`/v1/templates/${name}`), { timeoutMs: TEMPLATE_READ_MS, accept: (status) => status === 200 || status === 404 }, signal));
		return read.status === 200;
	}

	/**
	 * The workspace template `name`, made from the public image `imageRef` when the workspace has none (docs: templates):
	 * GET it; on a 404, `registering` is told, then POST /v1/templates { name, image_ref }, which answers once Agent37 has
	 * copied the image into the workspace. A 409 is another registration of the name, which this waits for, reading the
	 * template until the workspace has it. Throws a HostError in Agent37's words.
	 */
	async template(name: string, imageRef: string, registering: () => void, signal: AbortSignal | undefined): Promise<void> {
		if (await this.#hasTemplate(name, signal)) return;
		registering();
		const json = { name, image_ref: imageRef, description: `AgentRun's box image ${imageRef}, registered by the server that first needed it` };
		const posted = orThrow(await this.#client.call("POST", this.#client.url("/v1/templates"), { json, timeoutMs: REGISTER_MS, accept: (status) => (status >= 200 && status < 300) || status === 409 }, signal));
		if (posted.status !== 409) return;
		const end = Date.now() + REGISTER_MS;
		while (!(await this.#hasTemplate(name, signal))) {
			if (Date.now() > end) throw new HostError("timeout", `another registration of ${name} was not done within ${REGISTER_MS / 60_000} minutes`);
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					clearTimeout(timer);
					reject(new HostError("aborted", `the wait on another registration of ${name} was aborted`));
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", done);
					resolve();
				}, TEMPLATE_POLL_MS);
				if (signal?.aborted) done();
				else signal?.addEventListener("abort", done, { once: true });
			});
		}
	}
}

/**
 * An Agent37Provider from its options alone; it reads no environment. The key is options.apiKey and the SSH key
 * options.sshKey, nowhere else (serve passes its AGENT37_API_KEY and AGENT37_SSH_KEY, the conformance module what it
 * reads), and ssh2 is the host's package unless given. Throws in words when an option is missing or wrong, never echoing a key.
 */
export async function create(options: Agent37Options): Promise<Agent37Provider> {
	const { ssh2: given, ...rest } = options ?? ({} as Agent37Options);
	// ssh2 is CommonJS: its Client is a named export of the module, and of its default.
	const loaded = given ?? ((await import(SSH2_PACKAGE)) as Partial<Ssh2Module> & { default?: Ssh2Module });
	const ssh2 = typeof loaded.Client === "function" ? (loaded as Ssh2Module) : (loaded as { default?: Ssh2Module }).default;
	return new Agent37Provider({ ...rest, ssh2: ssh2 as Ssh2Module });
}

/** The conformance CLI's module for Agent37: its live switch, the run's cap, its template and the drifted twin. */
export const conformance = () => import("./conformance/agent37.js");

const fail = failFor(AGENT37.id);

/**
 * Computers that are Agent37 instances, on the shared adapter. A spec's image is an Agent37 template's name, such as
 * "agent37-base", Agent37's plain Linux. A server starts every one from the template prepareImage() answers: our box
 * image, registered in the key's own workspace.
 */
export class Agent37Provider extends HostedProvider {
	/**
	 * The provider contract's prepareImage (its descriptor declares it): the box image the release publishes
	 * (box-image.ts), as the workspace template agentrun-box-<recipe hash>, registered from the public image the first
	 * time the workspace needs it, so a new recipe is a new template and the one before is left as it is. ok with the
	 * template's name; onWait is told "pull" once, before a registration it waits on, never when the workspace has it.
	 * A sandbox and a desktop start from the same image.
	 */
	async prepareImage(context: CallContext & { onWait?: (making: "build" | "pull", tag: string) => void } = {}): Promise<Result<string>> {
		const name = `agentrun-box-${boxRecipeHash()}`;
		const ref = boxImageRef();
		let registering = false;
		try {
			await (this.host as Agent37Host).template(
				name,
				ref,
				() => {
					registering = true;
					context.onWait?.("pull", ref);
				},
				context.signal,
			);
			return ok(name);
		} catch (error) {
			const said = error instanceof Error ? error.message : String(error);
			return fail(codeOf(error), registering ? `registering ${ref} as the Agent37 template ${name}: ${said}` : `reading the Agent37 template ${name}: ${said}`);
		}
	}

	constructor(options: Agent37ProviderOptions) {
		const {
			apiKey,
			sshKey,
			ssh2,
			fetch: fetcher = globalThis.fetch,
			WebSocket = globalThis.WebSocket as unknown as WebSocketClass,
			apiUrl = DEFAULT_API_URL,
			proxyDomain = DEFAULT_PROXY_DOMAIN,
			type = "vm",
			region = "us",
			timeouts = {},
			...rest
		} = options ?? ({} as Agent37ProviderOptions);
		if (typeof apiKey !== "string" || apiKey === "") throw new Error("options.apiKey, the Agent37 API key, is required: the provider reads no environment, so the caller passes it");
		const privateKey = typeof sshKey === "string" ? pemOf(sshKey) : undefined;
		if (privateKey === undefined) throw new Error("options.sshKey must be the contents of an SSH private key (-----BEGIN ... PRIVATE KEY-----), never a path");
		if (typeof (ssh2 as { Client?: unknown } | null)?.Client !== "function") throw new Error("options.ssh2 must be the ssh2 package (its Client class): the host installs it, as it does e2b");
		if (typeof fetcher !== "function") throw new Error("options.fetch must be a function, as the global fetch is");
		if (typeof WebSocket !== "function") throw new Error("options.WebSocket must be a WebSocket class that takes headers, as Node's global one does");
		let api: URL;
		try {
			api = new URL(apiUrl);
		} catch {
			throw new Error(`apiUrl must be an https URL such as ${DEFAULT_API_URL}, not ${JSON.stringify(apiUrl)}`);
		}
		if (api.protocol !== "https:" || api.search !== "" || api.hash !== "") throw new Error(`apiUrl must be an https URL such as ${DEFAULT_API_URL}, not ${JSON.stringify(apiUrl)}`);
		if (typeof proxyDomain !== "string" || !DOMAIN.test(proxyDomain)) throw new Error(`proxyDomain must be a host name such as ${DEFAULT_PROXY_DOMAIN}, not ${JSON.stringify(proxyDomain)}`);
		if (type !== "vm" && type !== "default") throw new Error(`type is vm or default, not ${JSON.stringify(type)}`);
		if (region !== "us" && region !== "eu" && region !== "ap-south") throw new Error(`region is us, eu or ap-south, not ${JSON.stringify(region)}`);
		if (region !== "us" && type !== "vm") throw new Error(`Agent37 runs type default in us alone: ${region} takes type vm`);
		const host = new Agent37Host({ apiKey, sshKey: privateKey, ssh2, fetch: fetcher, WebSocket, apiUrl: api.href.replace(/\/+$/, ""), proxyDomain, type, region });
		super(host, { ...rest, timeouts: { createMs: DEFAULT_CREATE_MS, ...timeouts } });
	}
}

/** The workspace a key reaches, in words, for the sweep's scope: the key's sha256 prefix, never the key. */
export function workspaceOf(apiKey: string, apiUrl: string = DEFAULT_API_URL): string {
	return `the Agent37 workspace of the key sha256:${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12)} at ${apiUrl.replace(/\/+$/, "")}`;
}
