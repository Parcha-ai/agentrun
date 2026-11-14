// The Modal host: Modal sandboxes on the VM runtime, and on gVisor for a GPU computer (Modal's one GPU runtime), every
// call through the host's own Modal JS SDK client, whose types it imports as types only (erased at build: nothing loads at
// import). A Modal sandbox's command is its main process, so computerd is pid1: the sandbox's command is the
// shared entrypoint, which waits for the daemon and becomes init, and Modal finishes the sandbox when init exits. Modal
// has no file API, so the daemon goes in through exec's stdin; it has no kill for an exec (closing stdin ends one), and
// reads no network back, so the probe from inside stands for network none. The rest of the computer is the shared
// machine-host adapter's (./hosted/provider.ts). Every SDK fact below is cited in the README's Modal section, from
// modal-client@64880502 (js/src) and Modal's docs.
import type { App, Image, ModalClient, Sandbox, SandboxCreateParams } from "modal";
import { MODAL, MODAL_DEFAULT_IMAGE, MODAL_GPU } from "./descriptors/modal.js";
import { COMPUTER_LABEL, DEADLINE_LABEL, DEFAULT_CPUS, DEFAULT_MEMORY_MB, WORK } from "./drift.js";
import type { HostCall, HostFacts, Machine, MachineHost, MachineProcess, MachineRequest } from "./host.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, IMAGE_LABEL, MAX_LABEL, NAME_LABEL } from "./hosted/provider.js";
import { codeOfError, words } from "./hosted/process.js";
import { isWhole } from "./hosted/values.js";
import type { KindCapabilities } from "./kinds.js";
import { RUN_LABEL } from "./labels.js";
import type { MountKind } from "./mount.js";
import { ARCHIL_MOUNT_LABEL, type ArchilMount, archilLabels } from "./mount-archil.js";
import type { ComputerSpec, GpuCapability, GpuSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, failFor, ok, type Result } from "./result.js";

/** This module's failures: one with code vendor names Modal. */
const fail = failFor("modal");

/**
 * The SDK's own types, imported as types only: erased at build, so nothing loads the SDK from here. The host passes its
 * own client (or the constructor), which these name.
 */
export type ModalSdk = object;
type SdkClient = ModalClient;

/** The Modal provider's options: the client and the app, then the shared adapter's (HostedOptions). */
export interface ModalProviderOptions extends Omit<HostedOptions, "label" | "kind" | "desktop" | "maxLifetimeMs"> {
	/** The host's Modal client. */
	sdk: ModalSdk;
	/** The Modal App the sandboxes live in; made when missing. */
	app: string;
	/** The longest lifetime check takes, in ms: at most 24 hours, Modal's longest timeout, which is the default. */
	maxLifetimeMs?: number;
	timeouts?: Partial<HostedTimeouts>;
}

/** The mount kinds a Modal computer takes, as capabilities().mount declares them: the run's folder on an Archil disk. */
export const MOUNT: readonly MountKind[] = MODAL.mounts;

/** The runtime a Modal sandbox runs under: vm, or gvisor for a GPU computer (Modal offers GPUs on gVisor only). */
export type ModalRuntime = "vm" | "gvisor";

/** A copy of its descriptor's MODAL_GPU, so no caller can change the provider's own. */
const modalGpuCapability = (): GpuCapability => ({ ...MODAL_GPU, types: [...MODAL_GPU.types], mounts: [] });
/** A GPU as the SDK takes it: the type, then :count past one ("T4", "H100:8"). */
const modalGpu = ({ type, count }: GpuSpec) => (count === 1 ? type : `${type}:${count}`);

/** The machine kind, groups and GPUs of its one configuration (its descriptor's): a linux computer, with GPUs when asked. */
export const CAPABILITIES: readonly KindCapabilities[] = MODAL.capabilities;

/** The SDK's default server (modal-client@64880502:js/src/config.ts:143). */
export const MODAL_DEFAULT_SERVER_URL = "https://api.modal.com:443";

/** What modalClient gives the SDK's ModalClient: the token, explicitly, so the SDK fills none of it in. */
export interface ModalClientParams {
	tokenId: string;
	tokenSecret: string;
}

/** The SDK's ModalClient constructor, or a stand-in for one. */
export type ModalClientConstructor = new (params: ModalClientParams) => unknown;

/** What modalClient takes: the token, the server it goes to, and the SDK's client class. */
export interface ModalClientOptions {
	/** The Modal token's id and secret. Serve passes its MODAL_TOKEN_ID and MODAL_TOKEN_SECRET; the conformance module the token it reads. */
	tokenId: string;
	tokenSecret: string;
	/** The server the token goes to; default the SDK's, https://api.modal.com:443. */
	serverUrl?: string;
	/** The SDK's ModalClient; imported from the host's modal package by default. */
	ModalClient?: ModalClientConstructor;
}

/** What create() takes: the provider's options, the client's in place of the SDK. */
export interface ModalCreateOptions extends Omit<ModalProviderOptions, "sdk">, ModalClientOptions {}

/** Not a literal, so no type checker or bundler resolves the SDK from this package. */
const MODAL_PACKAGE: string = "modal";

/** The construction now running, or the last one: the next waits for it, so two never overlap. */
let constructing: Promise<unknown> = Promise.resolve();

/**
 * A Modal client given the token passed in, and nothing of the environment: a tokenId and tokenSecret passed to
 * ModalClient replace what the environment or the profile held, and clear any OAuth credentials (client.ts:124-148), so a
 * MODAL_TOKEN_ID or ~/.modal.toml on the host is never used. The key goes only to options.serverUrl, else the SDK's
 * default (config.ts:143). ModalClient cannot take a server explicitly: it declares `endpoint` (client.ts:51) and never
 * reads it, and the control-plane client is made from the profile's serverUrl (client.ts:131, 175, 281), which getProfile
 * takes from MODAL_SERVER_URL before any profile's server_url (config.ts:140-143), the profile being MODAL_PROFILE's or the
 * active one in MODAL_CONFIG_PATH or ~/.modal.toml (config.ts:76-82, 126-137).
 *
 * So this is the library's one touch of the environment, a guard and not a setting (README, Settings): an ambient
 * MODAL_SERVER_URL is refused, and MODAL_SERVER_URL is set to the chosen server only while the client is constructed,
 * and put back after, so no profile can redirect the key. process.env is the whole process's: constructions run one at a
 * time, each waiting for the last, so none sees another's server. The modal package is the host's: it is imported only
 * here.
 */
export async function modalClient({ tokenId, tokenSecret, serverUrl = MODAL_DEFAULT_SERVER_URL, ModalClient }: ModalClientOptions): Promise<ModalSdk> {
	if (typeof tokenId !== "string" || tokenId === "" || typeof tokenSecret !== "string" || tokenSecret === "") {
		throw new Error("the Modal provider needs options.tokenId and options.tokenSecret, a Modal token: it reads none from the environment, so the caller passes it");
	}
	if (typeof serverUrl !== "string" || !URL.canParse(serverUrl)) throw new Error("options.serverUrl is the Modal server's URL, such as https://api.modal.com:443");
	const ambient = `the Modal provider refuses to start while MODAL_SERVER_URL is set: the SDK would send the key there. Unset it, and pass the server as options.serverUrl if it is not ${MODAL_DEFAULT_SERVER_URL}`;
	if (process.env.MODAL_SERVER_URL) throw new Error(ambient);
	const Client = ModalClient ?? ((await import(MODAL_PACKAGE)) as { ModalClient: ModalClientConstructor }).ModalClient;
	// getProfile reads MODAL_SERVER_URL from process.env when the client is constructed (client.ts:123), and the
	// control-plane client is made then (client.ts:175); afterwards process.env is as it was. One construction at a time.
	const turn = constructing.then(() => {
		if (process.env.MODAL_SERVER_URL) throw new Error(ambient);
		const before = process.env.MODAL_SERVER_URL;
		process.env.MODAL_SERVER_URL = serverUrl;
		try {
			return new Client({ tokenId, tokenSecret }) as ModalSdk;
		} finally {
			if (before === undefined) delete process.env.MODAL_SERVER_URL;
			else process.env.MODAL_SERVER_URL = before;
		}
	});
	constructing = turn.catch(() => undefined);
	return turn;
}

/**
 * A ModalProvider from its options alone: the client as modalClient makes it from the token and server passed in, and
 * the app (required). It reads no environment but the guard modalClient keeps: serve passes its MODAL_TOKEN_ID,
 * MODAL_TOKEN_SECRET and AGENTRUN_BOX_APP, the conformance module the settings it reads. The app and the token are
 * checked before any client is made, and neither is ever echoed.
 */
export async function create(options: ModalCreateOptions): Promise<ModalProvider> {
	const { tokenId, tokenSecret, serverUrl, ModalClient, ...rest } = options ?? ({} as ModalCreateOptions);
	if (typeof rest.app !== "string" || rest.app.trim() === "") throw new Error("options.app, the Modal app its sandboxes live in, is required");
	const sdk = await modalClient({ tokenId, tokenSecret, ...(serverUrl === undefined ? {} : { serverUrl }), ...(ModalClient ? { ModalClient } : {}) });
	return new ModalProvider({ ...rest, sdk });
}

/** The conformance CLI's module for Modal: its live switch, the run's 30-minute cap and the drifted twin. */
export const conformance = () => import("./conformance/modal.js");

/** An image Modal already holds, by its id, as box/build-modal.py prints it: opened with images.fromId, never pulled. */
const MODAL_IMAGE_ID = /^im-[A-Za-z0-9]+$/;
/** "A Sandbox can carry up to 10 tags" (guide/sandboxes#tagging): the adapter's own labels count among them. */
const MAX_TAGS = 10;
/** Modal holds a sandbox's tags, their names and values together, to 512 bytes: a create past it is refused at Modal
 *  ("a sandbox's cumulative tags size (533 bytes) cannot exceed 512 bytes", 11-12). */
const MAX_TAG_BYTES = 512;
/** "a timeout of up to 24 hours" (guide/sandboxes#timeouts). */
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Modal's own default request (guide/sandbox-resources, "Pay for what you use"): a spec's sizes are limits, as in Docker. */
const CPU_REQUEST = 0.125;
const MEMORY_REQUEST_MIB = 128;
/** "1 core = 2 vCPUs" (guide/sandbox-resources): a spec's cpus are CPUs, Modal's cpu is physical cores. */
const CPUS_PER_CORE = 2;
/**
 * Modal's bounds over the adapter's: a create builds the image layer and waits for the sandbox to be scheduled, a
 * terminate is asynchronous, and the daemon is streamed in through exec.
 */
const MODAL_TIMEOUTS: Partial<HostedTimeouts> = { requestMs: 60_000, createMs: 600_000, uploadMs: 300_000, listMs: 120_000, goneMs: 120_000, pollMs: 500, mountMs: 120_000 };
/** An Archil folder agents/<agent>/runs/<run>/work, the shape the shared check holds it to. */
const FOLDER = /^agents\/([^/]+)\/runs\/([^/]+)\/work$/;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isLabels = (value: unknown): value is Record<string, string> =>
	typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((one) => typeof one === "string");

/** The SDK names its errors (js/src/errors.ts); a call that failed on the wire carries a gRPC status code. */
function codeOf(error: unknown): ComputerErrorCode {
	const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
	if (name === "NotFoundError" || code === 5) return "not_found";
	if (name === "InvalidError" || code === 3) return "invalid";
	// gRPC's UNAUTHENTICATED and PERMISSION_DENIED: a token Modal refused.
	if (code === 16 || code === 7) return "denied";
	// gRPC's FAILED_PRECONDITION on an exec: the sandbox is ending on its own ("Modal Sandbox is shutting down", from
	// TaskExecStart, when its command, init, has exited). Gone, so create waits to read why.
	if (code === 9) return "gone";
	return "vendor";
}


/**
 * The tags a sandbox carries for a machine's labels. Every label is its own tag, with one exception that keeps an
 * Archil computer within Modal's 512 bytes: the mount label's folder, agents/<agent>/runs/<run>/work, names the run its
 * agentrun.run label holds, so the tag records the agent alone, and labelsOf puts the folder back.
 */
export function tagsOf(labels: Record<string, string>): Record<string, string> {
	const tags = { ...labels };
	const text = labels[ARCHIL_MOUNT_LABEL];
	if (text === undefined) return tags;
	let mount: Record<string, unknown> | null;
	try {
		mount = JSON.parse(text) as Record<string, unknown> | null;
	} catch {
		return tags;
	}
	const { kind, disk, region, folder } = mount ?? {};
	const found = typeof folder === "string" ? FOLDER.exec(folder) : null;
	// Only a label exactly as the adapter writes it (archilLabels) is shortened, so labelsOf gives back the same text.
	if (found === null || found[2] !== labels[RUN_LABEL] || text !== archilLabels({ kind: "archil", disk, region, folder } as ArchilMount)[ARCHIL_MOUNT_LABEL]) return tags;
	tags[ARCHIL_MOUNT_LABEL] = JSON.stringify({ kind, disk, region, agent: found[1] });
	return tags;
}

/** A sandbox's labels from its tags: tagsOf undone. */
export function labelsOf(tags: Record<string, string>): Record<string, string> {
	const labels = { ...tags };
	const text = tags[ARCHIL_MOUNT_LABEL];
	const run = tags[RUN_LABEL];
	if (text === undefined || run === undefined) return labels;
	try {
		const { kind, disk, region, agent, ...rest } = (JSON.parse(text) ?? {}) as Record<string, unknown>;
		if (kind !== "archil" || typeof disk !== "string" || typeof region !== "string" || typeof agent !== "string" || Object.keys(rest).length > 0) return labels;
		Object.assign(labels, archilLabels({ kind: "archil", disk, region, folder: `agents/${agent}/runs/${run}/work` } as ArchilMount));
	} catch {
		// Not the shortened mount: the tag as it is.
	}
	return labels;
}

/** The bytes Modal counts of `tags`: every name and value, in UTF-8. */
const tagBytes = (tags: Record<string, string>): number => Object.entries(tags).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);

/** A sandbox's tags as the adapter would make them of spec: its labels, the adapter's own, its name and deadline as long as create's. */
function tagsForSpec(spec: ComputerSpec): Record<string, string> {
	const at = new Date(0).toISOString();
	const own = { [COMPUTER_LABEL]: "1", [NAME_LABEL]: "computer-000000000000", [DEADLINE_LABEL]: at, [IMAGE_LABEL]: spec.image, [MAX_LABEL]: at };
	return tagsOf({ ...spec.labels, ...own, ...(spec.mount?.kind === "archil" ? archilLabels(spec.mount) : {}) });
}

/** Why tags are past Modal's bound, or undefined. */
function tagProblem(tags: Record<string, string>): string | undefined {
	const bytes = tagBytes(tags);
	if (bytes <= MAX_TAG_BYTES) return undefined;
	const sizes = Object.entries(tags).map(([key, value]) => `${key} ${Buffer.byteLength(key) + Buffer.byteLength(value)}`).join(", ");
	return `a Modal sandbox's tags come to at most ${MAX_TAG_BYTES} bytes, names and values together, and this computer's would come to ${bytes} (${sizes}): give a shorter image, mount folder or labels`;
}

/** Modal's sandboxes as a MachineHost (../host.ts). */
class ModalHost implements MachineHost {
	readonly id = "modal";
	readonly facts: HostFacts;
	readonly #sdk: SdkClient;
	readonly #appName: string;
	/** Each sandbox create or a read gave, by id: let go of at its delete. */
	readonly #sandboxes = new Map<string, Sandbox>();
	#app: App | undefined;

	constructor(sdk: SdkClient, app: string) {
		this.#sdk = sdk;
		this.#appName = app;
		this.facts = {
			// The sandbox's command is the entrypoint, which becomes init: Modal finishes the sandbox when that main process
			// exits (sandbox.ts:384-388), so init's exit ends the computer.
			daemon: "pid1",
			// A GPU computer runs on gVisor, Modal's one GPU runtime (gpu.isolation): vm is every other computer's.
			isolation: "vm",
			lifetime: "vendor",
			maxLifetimeMs: MAX_LIFETIME_MS,
			// Images must be linux/amd64 (guide/existing-images).
			arch: "amd64",
			// No listener of Modal's own inside a sandbox is documented, so none is declared.
			vendorAgentPorts: [],
			networkReadBack: false,
			network: [...MODAL.network],
			mounts: [...MOUNT],
			release: ["delete"],
			gpu: modalGpuCapability(),
			// Never root: each connection is Modal's exec of the stdio bridge, as Modal's root, outside the daemon.
			user: ["uid"],
			specFields: ["cpus", "memoryMb", "user"],
			labelRules: { max: MAX_TAGS },
			runtime: (req) => (req.gpu === undefined ? "vm" : "gvisor"),
		};
	}

	errorCode(error: unknown): ComputerErrorCode {
		return codeOf(error);
	}

	/** The app, looked up (and made when missing) once per provider; a failed lookup is tried again next time. */
	async #theApp(): Promise<App> {
		this.#app ??= await this.#sdk.apps.fromName(this.#appName, { createIfMissing: true });
		return this.#app;
	}

	/** The sandbox with an id: the one create gave, or sandboxes.fromId, which throws NotFoundError for one Modal does not know. */
	async #sandbox(id: string): Promise<Sandbox> {
		return this.#sandboxes.get(id) ?? this.#sdk.sandboxes.fromId(id);
	}

	/**
	 * Modal's own rules of a spec, over the adapter's: an image Modal can pull or holds (no option, no space), sizes in
	 * the units Modal takes, and the sandbox's tags within Modal's 512 bytes. No call.
	 */
	check(spec: Partial<ComputerSpec>): Refusal[] {
		const refusals: Refusal[] = [];
		const refuse = (field: string, message: string) => refusals.push({ field, message });
		const { image, cpus, memoryMb, labels, mount } = spec;
		if (typeof image === "string" && (image.startsWith("-") || /\s/.test(image))) {
			refuse("image", `an image is a registry tag for linux/amd64 that Modal can pull, such as ${MODAL_DEFAULT_IMAGE}, or an image Modal holds by its id (im-...)`);
		}
		if (cpus !== undefined && !(isNumber(cpus) && cpus >= CPU_REQUEST * CPUS_PER_CORE)) {
			refuse("cpus", `cpus must be a number of CPUs of at least ${CPU_REQUEST * CPUS_PER_CORE}: Modal counts physical cores, 2 CPUs each, and requests ${CPU_REQUEST} of one by default`);
		}
		if (memoryMb !== undefined && !(isWhole(memoryMb) && memoryMb > 0)) refuse("memoryMb", "memoryMb must be a whole number of MiB above 0");
		const archil = mount === undefined || (mount?.kind === "archil" && ["disk", "region", "folder"].every((key) => typeof (mount as unknown as Record<string, unknown>)[key] === "string"));
		if (refusals.length === 0 && typeof image === "string" && (labels === undefined || isLabels(labels)) && archil) {
			const problem = tagProblem(tagsForSpec(spec as ComputerSpec));
			if (problem) refuse(mount === undefined ? "labels" : "mount", problem);
		}
		return refusals;
	}

	/**
	 * sandboxes.create in the app: the request's image (an im- id opened by fromId, else a registry tag) with HOME and the
	 * workdir the computer's home, the entrypoint as its command, the lifetime as its timeout in the whole seconds the
	 * SDK takes, the spec's sizes as limits over Modal's small default request, no network unless the adapter asks open
	 * (an Archil computer's root, to reach Archil), and the labels as its tags.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<Result<{ id: string }>> {
		void ctx;
		if (req.command === undefined) return fail("invalid", "a Modal sandbox's command is the entrypoint the adapter gives a pid1 host, and the request has none");
		const tags = tagsOf(req.labels);
		const problem = tagProblem(tags);
		if (problem) return fail("refused", problem);
		let base: Image;
		if (MODAL_IMAGE_ID.test(req.image)) {
			const fromId = this.#sdk.images.fromId;
			if (typeof fromId !== "function") return fail("invalid", `the image ${req.image} is a Modal image id, and options.sdk has no images.fromId to open it: pass the SDK's own ModalClient`);
			base = await fromId.call(this.#sdk.images, req.image);
		} else base = this.#sdk.images.fromRegistry(req.image);
		const cpus = req.cpus ?? DEFAULT_CPUS;
		const memoryMb = req.memoryMb ?? DEFAULT_MEMORY_MB;
		const cpuLimit = cpus / CPUS_PER_CORE;
		const params: SandboxCreateParams = {
			runtime: this.facts.runtime?.(req) ?? "vm",
			...(req.gpu === undefined ? {} : { gpu: modalGpu(req.gpu) }),
			command: [...req.command],
			timeoutMs: Math.ceil((req.lifetimeMs ?? 0) / 1000) * 1000,
			workdir: WORK,
			cpu: Math.min(CPU_REQUEST, cpuLimit),
			cpuLimit,
			memoryMiB: Math.min(MEMORY_REQUEST_MIB, memoryMb),
			memoryLimitMiB: memoryMb,
			...(req.network === "none" ? { blockNetwork: true as const } : {}),
			tags,
		};
		const image = base.dockerfileCommands([`ENV HOME=${WORK}`, `WORKDIR ${WORK}`]);
		const sandbox = await this.#sdk.sandboxes.create(await this.#theApp(), image, params);
		this.#sandboxes.set(sandbox.sandboxId, sandbox);
		return ok({ id: sandbox.sandboxId });
	}

	/**
	 * The sandbox as a machine: running while poll reads null (sandbox.ts:2761-2771), its labels from its tags. One that
	 * has finished, or that Modal no longer knows, is none: a finished sandbox cannot run again. Modal reads no network,
	 * size or GPU back.
	 */
	async get(id: string, ctx: HostCall): Promise<Result<Machine | undefined>> {
		void ctx;
		return ok(await this.#machine(await this.#sandbox(id)));
	}

	/** One sandbox read: none once it has finished or Modal no longer knows it. */
	async #machine(sandbox: Sandbox): Promise<Machine | undefined> {
		try {
			if ((await sandbox.poll()) !== null) return undefined;
			return { id: sandbox.sandboxId, labels: labelsOf(await sandbox.getTags()), state: "running" };
		} catch (error) {
			if (codeOf(error) === "not_found") return undefined;
			throw error;
		}
	}

	/**
	 * Every running sandbox in the app whose tags carry these labels: Modal's list asks for running sandboxes only
	 * (includeFinished: false, sandbox.ts:1135-1140), yet one terminated a moment ago is still listed, so each is polled,
	 * and one finished or no longer known is left out. One bound, ctx.timeoutMs, for the listing and every read.
	 */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Result<Machine[]>> {
		const until = Date.now() + ctx.timeoutMs;
		const app = await this.#theApp();
		// The mount label is a tag of another text (tagsOf): the listing filters by the rest, and the adapter by all.
		const { [ARCHIL_MOUNT_LABEL]: _mount, ...filter } = labels;
		const iterator = this.#sdk.sandboxes.list({ appId: app.appId, tags: filter })[Symbol.asyncIterator]();
		const machines: Machine[] = [];
		try {
			for (;;) {
				if (Date.now() >= until) return fail("timeout", `sandboxes.list read ${machines.length} sandboxes, and did not finish within ${ctx.timeoutMs / 1000} s`);
				const next = await iterator.next();
				if (next.done) break;
				const machine = await this.#machine(next.value);
				if (machine !== undefined) machines.push(machine);
			}
		} finally {
			Promise.resolve(iterator.return?.()).catch(() => {});
		}
		return ok(machines);
	}

	/**
	 * terminate, which returns before Modal has ended the sandbox (sandbox.ts:1292-1296): the adapter waits for it to be
	 * gone. One Modal no longer knows (not_found, done to the adapter), or one that had finished when terminate failed, is done.
	 */
	async delete(id: string, ctx: HostCall): Promise<Result<void>> {
		void ctx;
		const sandbox = await this.#sandbox(id).finally(() => this.#sandboxes.delete(id));
		try {
			await sandbox.terminate();
		} catch (error) {
			if (codeOf(error) === "not_found") throw error;
			const finished = await sandbox.poll().then(
				(code) => code !== null,
				(polled: unknown) => codeOf(polled) === "not_found",
			);
			if (!finished) throw error;
		}
		return ok(undefined);
	}

	/**
	 * exec in binary mode, as root (Modal containers always run as root), outside computerd. Without stdin, it is closed
	 * at once. Modal has no kill for an exec: kill closes its stdin, which ends the stdio bridge and anything else that
	 * reads it.
	 */
	async exec(id: string, argv: readonly string[], { stdin }: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>> {
		void ctx;
		const sandbox = await this.#sandbox(id);
		const program = await sandbox.exec([...argv], { mode: "binary" });
		const close = () => program.stdin.close().catch(() => {});
		if (!stdin) await close();
		return ok({
			stdout: program.stdout,
			stderr: program.stderr,
			write: (bytes) => program.stdin.writeBytes(bytes),
			end: () => program.stdin.close(),
			wait: () => program.wait(),
			kill: async () => void (await close()),
		});
	}

	/**
	 * Settings' test: the app read without making it (createIfMissing false), which makes nothing, where a listing would
	 * make the app. An app not made yet is a connection all the same: the token was taken, and the first computer makes it.
	 */
	async testConnection(ctx: HostCall): Promise<Result<{ detail: string }>> {
		void ctx;
		try {
			await this.#sdk.apps.fromName(this.#appName, { createIfMissing: false });
			return ok({ detail: `Modal answered: the app ${this.#appName} is there` });
		} catch (error) {
			if (codeOf(error) === "not_found") return ok({ detail: `Modal answered: no app ${this.#appName} yet; the first computer makes it` });
			return fail(codeOfError(this, error), `apps.fromName ${this.#appName} failed: ${words(error)}`);
		}
	}
}

/**
 * Computers that are Modal sandboxes on the VM runtime, or on gVisor with a GPU, on the shared adapter. The daemon is
 * streamed in through an exec's stdin right after create, while the sandbox's command, the entrypoint, waits for it and
 * then becomes `computerd init`. A connection is `computerd stdio` through exec, so a computer with network none is still
 * reached. Modal ends each sandbox at its timeout, so the lifetime is the vendor's. A spec may size a computer (cpus,
 * memoryMb) and name the uid its programs run as, never root.
 */
export class ModalProvider extends HostedProvider {
	constructor(options: ModalProviderOptions) {
		const { app, maxLifetimeMs = MAX_LIFETIME_MS, timeouts = {}, ...rest } = options ?? ({} as ModalProviderOptions);
		const sdk = options?.sdk as SdkClient | undefined;
		const lacks = [
			["apps.fromName", sdk?.apps?.fromName],
			["images.fromRegistry", sdk?.images?.fromRegistry],
			["sandboxes.create", sdk?.sandboxes?.create],
			["sandboxes.fromId", sdk?.sandboxes?.fromId],
			["sandboxes.list", sdk?.sandboxes?.list],
		].filter(([, fn]) => typeof fn !== "function");
		if (lacks.length > 0) throw new Error(`options.sdk must be a Modal client; it lacks ${lacks.map(([name]) => name).join(", ")}`);
		if (typeof app !== "string" || app.trim() === "") throw new Error("options.app, the Modal app's name, is required");
		if (!isWhole(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > MAX_LIFETIME_MS) {
			throw new Error(`maxLifetimeMs must be a whole number of ms above 0 and at most 24 hours (${MAX_LIFETIME_MS} ms), Modal's longest timeout`);
		}
		super(new ModalHost(sdk as SdkClient, app), { ...rest, label: "Modal", kind: "linux", maxLifetimeMs, timeouts: { ...MODAL_TIMEOUTS, ...timeouts } });
	}
}
