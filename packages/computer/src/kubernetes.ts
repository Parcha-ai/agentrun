// The Kubernetes host: a computer is a pod in one namespace, reached through the Kubernetes API alone. Two object models:
// - pod (default): a plain Pod per computer, made from options.image (or the image a spec names), its runtime class
//   (gVisor's, where the cluster has one) and its size; the pod's main process only sleeps.
// - claim: a SandboxClaim of kubernetes-sigs/agent-sandbox (extensions.agents.x-k8s.io/v1beta1) against a
//   SandboxWarmPool, whose SandboxTemplate (the cluster operator's) gives the pod. The claim binds a Sandbox
//   (agents.x-k8s.io/v1beta1), which names its pod.
// Either way the computer daemon is a child: Kubernetes' exec (the kubelet's, through the API server) is the root channel
// the shared adapter (./hosted/provider.ts) installs, starts and bridges the daemon through, and an upload goes through
// exec too. The container runs as root, as the adapter's install needs; init drops its programs to the tool user, in a
// network namespace of their own (--own-network; on gVisor inside a user namespace, daemon/internal/daemon/userns.go).
//
// The adapter's labels are kept in one annotation (agentrun.labels, JSON): a Kubernetes label value takes no colon, so
// a deadline cannot be one. Two real labels let a listing select: agentrun.computer=1 and the request's name.
import { fileURLToPath } from "node:url";
import { KUBERNETES as KUBERNETES_DESCRIPTOR, KUBERNETES_DEFAULT_IMAGE, KUBERNETES_NO_ARCHIL } from "./descriptors/kubernetes.js";
import { COMPUTER_LABEL } from "./drift.js";
import type { HostCall, HostFacts, Machine, MachineHost, MachineProcess, MachineRequest } from "./host.js";
import { HostedProvider, type HostedOptions, type HostedTimeouts, NAME_LABEL } from "./hosted/provider.js";
import type { KindCapabilities } from "./kinds.js";
import { EXEC_PROTOCOLS, execStatus, KUBERNETES, type KubeAnswer, type KubeStream, type KubeTransport, kubeTransport } from "./kubernetes-api.js";
import { type KubernetesConnectOptions, resolveEndpoint } from "./kubernetes-auth.js";
import type { MountKind } from "./mount.js";
import type { ComputerSpec, Refusal } from "./provider.js";
import { type ComputerErrorCode, fail, failAs, failFor, ok, type Result, vendorFail } from "./result.js";
import { countTested } from "./test-connection.js";

const kubeFail = failFor(KUBERNETES);

/** The annotation an adapter's labels live in, as one JSON object of strings. */
export const LABELS_ANNOTATION = "agentrun.labels";
/** agent-sandbox's claim and sandbox API groups, as the target cluster serves them (agent-sandbox v1.0). */
export const CLAIM_API = "extensions.agents.x-k8s.io/v1beta1";
export const SANDBOX_API = "agents.x-k8s.io/v1beta1";
/** The annotation a Sandbox names its pod by; absent, the pod has the Sandbox's name. */
export const POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";
/** The cluster autoscaler's: "false" keeps it from evicting the pod to remove its node mid-run. */
const SAFE_TO_EVICT = "cluster-autoscaler.kubernetes.io/safe-to-evict";
/** The pod's one container in the pod model. */
export const CONTAINER = "computer";
/**
 * The pod's main process in the pod model: it only waits, and ends at once on SIGTERM, so a delete takes no grace.
 * POSIX sh: no `sleep infinity`, which not every BusyBox has.
 */
export const SLEEPER = ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"];

/** Container waiting reasons that waiting will not mend: the image or the pod's configuration is wrong. */
const CONFIG_REASONS = new Set(["ImagePullBackOff", "ErrImagePull", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError", "ErrImageNeverPull", "RunContainerError"]);
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REQUEST_MS = 30_000;
const PAGE = 100;
const MAX_PAGES = 100;
/** Each message of an upload's or a write's stdin is at most this many bytes. */
const CHUNK = 64 * 1024;

export const MOUNT: readonly MountKind[] = KUBERNETES_DESCRIPTOR.mounts;
export const CAPABILITIES: readonly KindCapabilities[] = KUBERNETES_DESCRIPTOR.capabilities;

export type KubernetesObject = "pod" | "claim";

/** The Kubernetes provider's options: how it reaches the API (KubernetesConnectOptions), what it makes, then the shared adapter's. */
export interface KubernetesProviderOptions extends KubernetesConnectOptions, Omit<HostedOptions, "label" | "kind" | "desktop" | "timeouts" | "archilEgress"> {
	/** The namespace every computer is made in. Default the kubeconfig context's or the service account's, else "default". */
	namespace?: string;
	/** pod (default) or claim; claim needs warmPool. */
	object?: KubernetesObject;
	/** The pod model's image when a spec names "default": a container image reference the cluster can pull. */
	image?: string;
	/** The claim model's SandboxWarmPool when a spec names "default". */
	warmPool?: string;
	/** The pod model's RuntimeClass, such as gvisor (GKE Sandbox) or runsc. Default the cluster's default runtime. */
	runtimeClass?: string;
	/** The pod model's node selector and tolerations, for a node pool of its own, as JSON text or objects. */
	nodeSelector?: string | Record<string, string>;
	tolerations?: string | object[];
	/**
	 * The pod model's extra container capabilities, such as SYS_ADMIN, as a list or comma-separated text. Under gVisor
	 * none is needed: init makes its programs' network inside a user namespace. On a runc node whose kernel refuses that
	 * (Ubuntu's apparmor_restrict_unprivileged_userns), init needs CAP_SYS_ADMIN to make it, which it then drops.
	 */
	addCapabilities?: string | string[];
	/** The container the claim model's exec reaches; default the pod's first. */
	container?: string;
	/** Go's name for the nodes' architecture, which hello must report. Default amd64. */
	arch?: "amd64" | "arm64";
	/** For tests: every call goes through it. Default the API reached over node:https. */
	transport?: KubeTransport;
	timeouts?: Partial<HostedTimeouts & { requestMs: number }>;
}

/** A provider from its options alone; it reads no environment. Throws in words when an option is missing or wrong, never echoing a token. */
export function create(options: KubernetesProviderOptions): KubernetesProvider {
	return new KubernetesProvider(options ?? ({} as KubernetesProviderOptions));
}

/** The conformance CLI's module for Kubernetes. */
export const conformance = () => import("./conformance/kubernetes.js");

interface Meta {
	name?: string;
	namespace?: string;
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
	creationTimestamp?: string;
	deletionTimestamp?: string;
	resourceVersion?: string;
}

interface ContainerStatus {
	name?: string;
	state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string; message?: string; exitCode?: number } };
}

interface Pod {
	metadata?: Meta;
	spec?: { containers?: Array<{ name?: string; image?: string; resources?: { limits?: Record<string, string>; requests?: Record<string, string> } }>; runtimeClassName?: string; activeDeadlineSeconds?: number };
	status?: { phase?: string; reason?: string; message?: string; conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>; containerStatuses?: ContainerStatus[] };
}

interface Claim {
	metadata?: Meta;
	spec?: { warmPoolRef?: { name?: string } };
	status?: { sandbox?: { name?: string }; conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }> };
}

interface Sandbox {
	metadata?: Meta;
	status?: { conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }> };
}

/** The adapter's labels, from the annotation; {} when it holds none or not JSON of strings. */
function labelsOf(meta: Meta | undefined): Record<string, string> {
	const raw = meta?.annotations?.[LABELS_ANNOTATION];
	if (raw === undefined) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	} catch {
		return {};
	}
}

/** A Kubernetes quantity of CPU as a number of CPUs ("2", "1500m"); undefined for another shape. */
function cpusOf(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const milli = /^(\d+)m$/.exec(value);
	if (milli) return Number(milli[1]) / 1000;
	return /^\d+(\.\d+)?$/.test(value) ? Number(value) : undefined;
}

/** A Kubernetes quantity of memory in MiB ("512Mi", "4Gi"); undefined for another shape. */
function memoryMbOf(value: string | undefined): number | undefined {
	const found = value === undefined ? null : /^(\d+)(Mi|Gi|Ki)?$/.exec(value);
	if (found === null) return undefined;
	const amount = Number(found[1]);
	return found[2] === "Gi" ? amount * 1024 : found[2] === "Mi" ? amount : found[2] === "Ki" ? Math.floor(amount / 1024) : Math.floor(amount / (1024 * 1024));
}

/** A pod's state as the adapter reads a machine's, and the pod's own words when it failed. */
function podState(pod: Pod): { state: Machine["state"]; why?: string } {
	if (pod.metadata?.deletionTimestamp) return { state: "going" };
	const phase = pod.status?.phase;
	for (const status of pod.status?.containerStatuses ?? []) {
		const waiting = status.state?.waiting;
		if (waiting?.reason !== undefined && CONFIG_REASONS.has(waiting.reason)) return { state: "failed", why: `container ${status.name ?? "?"} is ${waiting.reason}${waiting.message ? `: ${waiting.message.slice(0, 300)}` : ""}` };
	}
	if (phase === "Running") {
		const ready = pod.status?.conditions?.find((one) => one.type === "Ready")?.status === "True";
		return { state: ready ? "running" : "starting" };
	}
	if (phase === "Succeeded" || phase === "Failed") {
		const terminated = pod.status?.containerStatuses?.find((one) => one.state?.terminated)?.state?.terminated;
		return { state: "failed", why: `the pod ended (${phase}${pod.status?.reason ? `, ${pod.status.reason}` : ""}${terminated?.reason ? `, its container ${terminated.reason}` : ""})${pod.status?.message ? `: ${pod.status.message.slice(0, 300)}` : ""}` };
	}
	const unschedulable = pod.status?.conditions?.find((one) => one.type === "PodScheduled" && one.status === "False");
	return unschedulable?.message ? { state: "starting", why: unschedulable.message.slice(0, 300) } : { state: "starting" };
}

/** A stream fed as the exec delivers, read as an async iterable until it ends or fails. */
function feed(): { push(bytes: Uint8Array): void; end(error?: Error): void; iterable: AsyncIterable<Uint8Array> } {
	const queue: Uint8Array[] = [];
	let ended = false;
	let failure: Error | undefined;
	let wake: (() => void) | undefined;
	const nudge = () => {
		const waiting = wake;
		wake = undefined;
		waiting?.();
	};
	return {
		push(bytes) {
			if (ended || bytes.length === 0) return;
			queue.push(bytes);
			nudge();
		},
		end(error) {
			if (ended) return;
			ended = true;
			failure = error;
			nudge();
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					const next = queue.shift();
					if (next !== undefined) yield next;
					else if (failure !== undefined) throw failure;
					else if (ended) return;
					else await new Promise<void>((done) => (wake = done));
				}
			},
		},
	};
}

/**
 * One exec as a MachineProcess: channel 0 stdin, 1 stdout, 2 stderr, 3 the exit status (the exec is over once it comes,
 * whether or not the close follows: some API front ends never send the close after binary output). v5 ends stdin with
 * its close message (255, 0); v4 cannot, and end() says so.
 */
export function processOf(stream: KubeStream): MachineProcess {
	const out = feed();
	const err = feed();
	let settle!: (code: number) => void;
	let reject!: (error: Error) => void;
	const exited = new Promise<number>((resolve, fail) => {
		settle = resolve;
		reject = fail;
	});
	exited.catch(() => {});
	let finished = false;
	const finish = (code: number | Error) => {
		if (finished) return;
		finished = true;
		out.end();
		err.end();
		if (typeof code === "number") settle(code);
		else reject(code);
		stream.close();
	};
	stream.onMessage((channel, bytes) => {
		if (channel === 1) out.push(bytes);
		else if (channel === 2) err.push(bytes);
		else if (channel === 3 && bytes.length > 0) {
			const status = execStatus(bytes);
			if ("code" in status) finish(status.code);
			else {
				// The command never ran (not found, not executable): its words on stderr, and 127 as a shell gives.
				err.push(new TextEncoder().encode(`${status.failure}\n`));
				finish(127);
			}
		}
	});
	stream.onEnd((error) => finish(new Error(`the exec stream ended before the command's exit status came${error ? `: ${error.message}` : ""}`)));
	let writing: Promise<void> = Promise.resolve();
	return {
		stdout: out.iterable,
		stderr: err.iterable,
		write(bytes) {
			writing = writing.then(async () => {
				if (finished) throw new Error("the command has ended");
				for (let at = 0; at < bytes.length; at += CHUNK) await stream.send(0, bytes.subarray(at, at + CHUNK));
			});
			return writing;
		},
		end() {
			writing = writing.then(async () => {
				if (finished) return;
				if (stream.protocol !== EXEC_PROTOCOLS[0]) throw new Error(`the API server speaks ${stream.protocol}, which cannot end a command's stdin: the cluster's Kubernetes is older than 1.30`);
				await stream.send(255, new Uint8Array([0]));
			});
			return writing;
		},
		wait: () => exited,
		async kill() {
			finish(new Error("the command was killed"));
		},
	};
}

/** The Kubernetes machines of one namespace, as a MachineHost (./host.ts). */
export class KubernetesHost implements MachineHost {
	readonly id = "kubernetes";
	readonly facts: HostFacts;
	readonly #api: KubeTransport;
	readonly #namespace: string;
	readonly #object: KubernetesObject;
	readonly #image: string | undefined;
	readonly #warmPool: string | undefined;
	readonly #runtimeClass: string | undefined;
	readonly #nodeSelector: Record<string, string> | undefined;
	readonly #tolerations: object[] | undefined;
	readonly #container: string | undefined;
	readonly #capabilities: string[];
	readonly #requestMs: number;
	/** Each claim's pod, once read running: its name and container. Let go of at its delete. */
	readonly #pods = new Map<string, { pod: string; container: string }>();

	constructor(options: { api: KubeTransport; namespace: string; object: KubernetesObject; image?: string; warmPool?: string; runtimeClass?: string; nodeSelector?: Record<string, string>; tolerations?: object[]; container?: string; capabilities?: string[]; arch: "amd64" | "arm64"; maxLifetimeMs: number; requestMs: number }) {
		this.#api = options.api;
		this.#namespace = options.namespace;
		this.#object = options.object;
		this.#image = options.image;
		this.#warmPool = options.warmPool;
		this.#runtimeClass = options.runtimeClass;
		this.#nodeSelector = options.nodeSelector;
		this.#tolerations = options.tolerations;
		this.#container = options.container;
		this.#capabilities = options.capabilities ?? [];
		this.#requestMs = options.requestMs;
		// daemon child: exec is the kubelet's, reached through the API server; nothing in the pod listens for it, so no
		// vendor port. lifetime janitor: the deadline label, init's own deadline, and the pod's activeDeadlineSeconds (or
		// the claim's shutdownTime) at the most a computer may live, as a backstop. The pod's network is the cluster's; the
		// programs' is init's own, read back by the probe (networkReadBack false).
		this.facts = {
			daemon: "child",
			isolation: options.runtimeClass !== undefined && /gvisor|runsc/i.test(options.runtimeClass) ? "gvisor" : "container",
			lifetime: "janitor",
			maxLifetimeMs: options.maxLifetimeMs,
			arch: options.arch,
			vendorAgentPorts: [],
			networkReadBack: false,
			network: [...KUBERNETES_DESCRIPTOR.network],
			mounts: [...MOUNT],
			unmounted: { ...KUBERNETES_DESCRIPTOR.unmounted },
			release: ["delete"],
			...(options.object === "pod" ? { specFields: ["cpus", "memoryMb"] as Array<"cpus" | "memoryMb"> } : {}),
		};
	}

	errorCode(error: unknown): ComputerErrorCode {
		const name = (error as { name?: unknown } | null)?.name;
		if (name === "AbortError") return "aborted";
		if (name === "TimeoutError") return "timeout";
		return "vendor";
	}

	/** The image a spec names, as this host makes it: the pod model's image, or the claim model's warm pool. */
	#imageOf(image: string): string | undefined {
		if (image !== KUBERNETES_DEFAULT_IMAGE) return image;
		return this.#object === "pod" ? this.#image : this.#warmPool;
	}

	check(spec: ComputerSpec): Refusal[] {
		const image = (spec as { image?: unknown } | null)?.image;
		if (typeof image !== "string" || image === "") return [];
		const made = this.#imageOf(image);
		if (made === undefined) {
			return [{ field: "image", message: this.#object === "pod" ? `"${KUBERNETES_DEFAULT_IMAGE}" names the provider's image, and none is set: set the image option (the server's AGENTRUN_KUBERNETES_IMAGE), or name an image` : `"${KUBERNETES_DEFAULT_IMAGE}" names the provider's warm pool, and none is set: set the warmPool option (KUBERNETES_WARM_POOL), or name a SandboxWarmPool` }];
		}
		if (this.#object === "claim" && !DNS_SUBDOMAIN.test(made)) return [{ field: "image", message: `a Kubernetes claim's image is the name of a SandboxWarmPool in the namespace (lowercase letters, digits, - and .), not ${JSON.stringify(made)}` }];
		if (this.#object === "pod" && /[\s\x00-\x1f]/.test(made)) return [{ field: "image", message: "an image reference has no whitespace or control characters" }];
		return [];
	}

	#path(kind: "pods" | "sandboxclaims" | "sandboxes", name = ""): string {
		const tail = name === "" ? "" : `/${encodeURIComponent(name)}`;
		if (kind === "pods") return `/api/v1/namespaces/${encodeURIComponent(this.#namespace)}/pods${tail}`;
		const api = kind === "sandboxclaims" ? CLAIM_API : SANDBOX_API;
		return `/apis/${api}/namespaces/${encodeURIComponent(this.#namespace)}/${kind}${tail}`;
	}

	/** One object by name; undefined for a 404. */
	async #read<T>(kind: "pods" | "sandboxclaims" | "sandboxes", name: string, ctx: Pick<HostCall, "timeoutMs" | "signal">): Promise<Result<T | undefined>> {
		const got = await this.#api.call("GET", this.#path(kind, name), { timeoutMs: Math.min(ctx.timeoutMs, this.#requestMs), ...(ctx.signal ? { signal: ctx.signal } : {}), accept: (status) => status === 404 || (status >= 200 && status < 300) });
		if (!got.ok) return got;
		return ok(got.value.status === 404 ? undefined : (got.value.body as T));
	}

	/** The metadata create gives an object: the selector labels, and every adapter label in the annotation. */
	#metadataOf(req: MachineRequest): Meta {
		return {
			name: req.name,
			namespace: this.#namespace,
			labels: { [COMPUTER_LABEL]: "1", [NAME_LABEL]: req.name },
			annotations: { [LABELS_ANNOTATION]: JSON.stringify(req.labels) },
		};
	}

	/**
	 * Makes the pod, or the claim, named req.name: a name the namespace already holds is exists (409), and makes nothing.
	 * Not retried: a create that fails after reaching the API may have made the object, and the adapter finds it by name.
	 */
	async create(req: MachineRequest, ctx: HostCall): Promise<Result<{ id: string }>> {
		const image = this.#imageOf(req.image);
		if (image === undefined) return fail("invalid", `image ${JSON.stringify(req.image)} names no image this provider is given`);
		const backstopS = Math.ceil(this.facts.maxLifetimeMs / 1000);
		let made: Result<KubeAnswer>;
		if (this.#object === "pod") {
			const limits = {
				...(req.cpus !== undefined ? { cpu: String(req.cpus) } : {}),
				...(req.memoryMb !== undefined ? { memory: `${req.memoryMb}Mi` } : {}),
			};
			const pod = {
				apiVersion: "v1",
				kind: "Pod",
				metadata: { ...this.#metadataOf(req), annotations: { ...this.#metadataOf(req).annotations, [SAFE_TO_EVICT]: "false" } },
				spec: {
					restartPolicy: "Never",
					// The pod holds no credential of the cluster's and no service's address: its programs reach nothing of it.
					automountServiceAccountToken: false,
					enableServiceLinks: false,
					terminationGracePeriodSeconds: 5,
					// The most a computer may live, whatever the janitor does: the kubelet ends the pod then.
					activeDeadlineSeconds: backstopS,
					...(this.#runtimeClass ? { runtimeClassName: this.#runtimeClass } : {}),
					...(this.#nodeSelector ? { nodeSelector: this.#nodeSelector } : {}),
					...(this.#tolerations ? { tolerations: this.#tolerations } : {}),
					containers: [
						{
							name: CONTAINER,
							image,
							command: SLEEPER,
							// Root, as the adapter's install and init need: init drops its programs to the tool user itself.
							securityContext: { runAsUser: 0, runAsGroup: 0, ...(this.#capabilities.length > 0 ? { capabilities: { add: this.#capabilities } } : {}) },
							...(Object.keys(limits).length > 0 ? { resources: { requests: limits, limits } } : {}),
						},
					],
				},
			};
			made = await this.#api.call("POST", this.#path("pods"), { json: pod, timeoutMs: ctx.timeoutMs });
		} else {
			const claim = {
				apiVersion: CLAIM_API,
				kind: "SandboxClaim",
				metadata: this.#metadataOf(req),
				spec: {
					warmPoolRef: { name: image },
					additionalPodMetadata: { annotations: { [SAFE_TO_EVICT]: "false" } },
					// The most a computer may live, whatever the janitor does: agent-sandbox deletes the claim then.
					lifecycle: { shutdownTime: new Date(Date.now() + backstopS * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), shutdownPolicy: "Delete" },
				},
			};
			made = await this.#api.call("POST", this.#path("sandboxclaims"), { json: claim, timeoutMs: ctx.timeoutMs });
		}
		if (!made.ok) {
			if (made.error.code === "exists") return kubeFail("exists", `the namespace ${this.#namespace} already has a ${this.#object === "pod" ? "pod" : "SandboxClaim"} named ${req.name}: ${made.error.message}`);
			if (made.error.code === "not_found" && this.#object === "claim") return failAs(made.error, `${made.error.message}: the cluster serves no SandboxClaim (${CLAIM_API}); install kubernetes-sigs/agent-sandbox with its extensions, or use the pod object model`, "invalid");
			if (made.error.code === "denied") return failAs(made.error, `${made.error.message}: the provider's identity needs create, get, list, delete and patch on ${this.#object === "pod" ? "pods" : "sandboxclaims"}, get on sandboxes and pods, and create on pods/exec in ${this.#namespace}`);
			return made;
		}
		return ok({ id: req.name });
	}

	/** The pod of a machine, by its id: the pod itself, or the claim's Sandbox's pod. */
	async #observe(id: string, ctx: Pick<HostCall, "timeoutMs" | "signal">): Promise<Result<{ meta: Meta; pod?: Pod; claim?: Claim; why?: string } | undefined>> {
		if (this.#object === "pod") {
			const pod = await this.#read<Pod>("pods", id, ctx);
			if (!pod.ok || pod.value === undefined) return pod as Result<undefined>;
			return ok({ meta: pod.value.metadata ?? {}, pod: pod.value });
		}
		const claim = await this.#read<Claim>("sandboxclaims", id, ctx);
		if (!claim.ok || claim.value === undefined) return claim as Result<undefined>;
		const meta = claim.value.metadata ?? {};
		const sandboxName = claim.value.status?.sandbox?.name;
		const claimWhy = claim.value.status?.conditions?.find((one) => one.type === "Ready" && one.status !== "True");
		const why = claimWhy?.message ?? claimWhy?.reason;
		if (!sandboxName) return ok({ meta, claim: claim.value, ...(why ? { why } : {}) });
		const sandbox = await this.#read<Sandbox>("sandboxes", sandboxName, ctx);
		if (!sandbox.ok) return sandbox;
		if (sandbox.value === undefined) return ok({ meta, claim: claim.value, ...(why ? { why } : {}) });
		const podName = sandbox.value.metadata?.annotations?.[POD_NAME_ANNOTATION] || sandboxName;
		const pod = await this.#read<Pod>("pods", podName, ctx);
		if (!pod.ok) return pod;
		return ok({ meta, claim: claim.value, ...(pod.value ? { pod: pod.value } : {}), ...(why ? { why } : {}) });
	}

	#machineOf(found: { meta: Meta; pod?: Pod; claim?: Claim; why?: string }): Machine {
		const { meta, pod, claim } = found;
		const made = Date.parse(meta.creationTimestamp ?? "");
		const state = meta.deletionTimestamp ? { state: "going" as const } : pod === undefined ? { state: "starting" as const, ...(found.why ? { why: found.why } : {}) } : podState(pod);
		const container = pod?.spec?.containers?.find((one) => one.name === (this.#container ?? CONTAINER)) ?? pod?.spec?.containers?.[0];
		const limits = container?.resources?.limits ?? {};
		const cpus = cpusOf(limits.cpu);
		const memoryMb = memoryMbOf(limits.memory);
		const resolved = claim ? claim.spec?.warmPoolRef?.name : container?.image;
		return {
			id: meta.name ?? "",
			labels: labelsOf(meta),
			...state,
			...(resolved ? { image: { resolved } } : {}),
			...(Number.isNaN(made) ? {} : { createdAt: new Date(made) }),
			...(this.#object === "pod" && (cpus !== undefined || memoryMb !== undefined) ? { size: { ...(cpus !== undefined ? { cpus } : {}), ...(memoryMb !== undefined ? { memoryMb } : {}) } } : {}),
		};
	}

	async get(id: string, ctx: HostCall): Promise<Result<Machine | undefined>> {
		const found = await this.#observe(id, ctx);
		if (!found.ok) return found;
		return ok(found.value === undefined ? undefined : this.#machineOf(found.value));
	}

	/** Every object of the namespace with the selector labels (the request's name too, when asked), every page, filtered by the rest. */
	async list(labels: Record<string, string>, ctx: HostCall): Promise<Result<Machine[]>> {
		const selector = [`${COMPUTER_LABEL}=1`, ...(labels[NAME_LABEL] ? [`${NAME_LABEL}=${labels[NAME_LABEL]}`] : [])].join(",");
		const until = Date.now() + ctx.timeoutMs;
		const items: Array<Pod | Claim> = [];
		let next: string | undefined;
		for (let page = 0; ; page++) {
			if (page >= MAX_PAGES) return vendorFail(KUBERNETES, `the listing ran past ${MAX_PAGES} pages`);
			const left = until - Date.now();
			if (left <= 0) return { ok: false, error: { code: "timeout", message: `the listing did not finish within ${ctx.timeoutMs / 1000} s`, transient: true } };
			const listed = await this.#api.call("GET", this.#path(this.#object === "pod" ? "pods" : "sandboxclaims"), { query: { labelSelector: selector, limit: String(PAGE), continue: next }, timeoutMs: Math.min(left, this.#requestMs), ...(ctx.signal ? { signal: ctx.signal } : {}) });
			if (!listed.ok) return listed;
			const body = listed.value.body as { items?: unknown; metadata?: { continue?: unknown } } | undefined;
			if (!Array.isArray(body?.items)) return vendorFail(KUBERNETES, "the listing is not a list of objects");
			items.push(...(body.items as Array<Pod | Claim>));
			next = typeof body.metadata?.continue === "string" && body.metadata.continue !== "" ? body.metadata.continue : undefined;
			if (next === undefined) break;
		}
		const machines: Machine[] = [];
		for (const item of items) {
			const meta = item.metadata ?? {};
			const own = labelsOf(meta);
			if (!Object.entries(labels).every(([key, value]) => own[key] === value)) continue;
			if (this.#object === "pod") {
				machines.push(this.#machineOf({ meta, pod: item as Pod }));
				continue;
			}
			const found = await this.#observe(meta.name ?? "", { timeoutMs: Math.max(1, until - Date.now()), ...(ctx.signal ? { signal: ctx.signal } : {}) });
			if (!found.ok) return found;
			if (found.value !== undefined) machines.push(this.#machineOf(found.value));
		}
		return ok(machines);
	}

	/** Deletes the pod (grace 0: it only sleeps) or the claim (agent-sandbox deletes its Sandbox and pod); not found is ok. */
	async delete(id: string, ctx: HostCall): Promise<Result<void>> {
		this.#pods.delete(id);
		const removed = await this.#api.call("DELETE", this.#path(this.#object === "pod" ? "pods" : "sandboxclaims", id), {
			query: this.#object === "pod" ? { gracePeriodSeconds: "0" } : { propagationPolicy: "Foreground" },
			timeoutMs: ctx.timeoutMs,
			accept: (status) => status === 404 || (status >= 200 && status < 300),
		});
		return removed.ok ? ok(undefined) : removed;
	}

	/** Replaces some adapter labels: the annotation read, merged, and written back under its resourceVersion (a 409 reads again). */
	async setLabels(id: string, labels: Record<string, string>, ctx: HostCall): Promise<Result<void>> {
		const kind = this.#object === "pod" ? "pods" : "sandboxclaims";
		for (let attempt = 1; ; attempt++) {
			const read = await this.#read<Pod | Claim>(kind, id, ctx);
			if (!read.ok) return read;
			if (read.value === undefined) return kubeFail("not_found", `the namespace ${this.#namespace} has no ${this.#object === "pod" ? "pod" : "SandboxClaim"} ${id}`);
			const merged = { ...labelsOf(read.value.metadata), ...labels };
			const patched = await this.#api.call("PATCH", this.#path(kind, id), {
				json: { metadata: { resourceVersion: read.value.metadata?.resourceVersion, annotations: { [LABELS_ANNOTATION]: JSON.stringify(merged) } } },
				contentType: "application/merge-patch+json",
				timeoutMs: ctx.timeoutMs,
				...(ctx.signal ? { signal: ctx.signal } : {}),
			});
			if (patched.ok) return ok(undefined);
			if (patched.error.code !== "exists" || attempt >= 3) return patched;
		}
	}

	/** The pod and container exec reaches, read running; cached for a claim's. */
	async #target(id: string, ctx: Pick<HostCall, "timeoutMs" | "signal">): Promise<Result<{ pod: string; container: string }>> {
		if (this.#object === "pod") return ok({ pod: id, container: CONTAINER });
		const known = this.#pods.get(id);
		if (known !== undefined) return ok(known);
		const found = await this.#observe(id, ctx);
		if (!found.ok) return found;
		const pod = found.value?.pod;
		if (pod?.metadata?.name === undefined || pod.status?.phase !== "Running") return kubeFail("not_found", `SandboxClaim ${id} has no running pod${found.value?.why ? `: ${found.value.why}` : ""}`);
		const container = this.#container ?? pod.spec?.containers?.[0]?.name;
		if (container === undefined) return vendorFail(KUBERNETES, `the pod of SandboxClaim ${id} has no container`);
		const target = { pod: pod.metadata.name, container };
		this.#pods.set(id, target);
		return ok(target);
	}

	/** argv in the pod's container, as its user (root), over the API server's exec WebSocket; see processOf. */
	async exec(id: string, argv: readonly string[], { stdin }: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>> {
		const target = await this.#target(id, ctx);
		if (!target.ok) return target;
		const query: Array<[string, string]> = [["container", target.value.container], ["stdout", "true"], ["stderr", "true"], ...(stdin ? ([["stdin", "true"]] as Array<[string, string]>) : []), ...argv.map((word) => ["command", word] as [string, string])];
		const opened = await this.#api.stream(`${this.#path("pods", target.value.pod)}/exec`, query, EXEC_PROTOCOLS, { timeoutMs: ctx.timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) });
		if (!opened.ok) {
			if (opened.error.code === "not_found") this.#pods.delete(id);
			if (opened.error.code === "denied") return failAs(opened.error, `${opened.error.message}: the provider's identity needs create on pods/exec in ${this.#namespace}`);
			return opened;
		}
		return ok(processOf(opened.value));
	}

	/**
	 * Bytes to path as root, through exec: `head -c <size>` reads exactly the bytes sent, so the upload needs no end of
	 * stdin (which v4 cannot send), and the file is moved into place only once it has them all.
	 */
	async upload(id: string, path: string, bytes: Uint8Array, ctx: HostCall): Promise<Result<void>> {
		const script = 'umask 077; head -c "$1" > "$2.part" && [ "$(wc -c < "$2.part")" -eq "$1" ] && mv -f "$2.part" "$2" || { rm -f "$2.part"; echo "the upload to $2 did not arrive whole" >&2; exit 1; }';
		const started = await this.exec(id, ["sh", "-c", script, "sh", String(bytes.length), path], { stdin: true }, ctx);
		if (!started.ok) return started;
		const running = started.value;
		const stderr: Uint8Array[] = [];
		const drained = (async () => {
			for await (const chunk of running.stderr) stderr.push(chunk);
		})().catch(() => {});
		const drainOut = (async () => {
			for await (const _ of running.stdout);
		})().catch(() => {});
		const bound = AbortSignal.timeout(ctx.timeoutMs);
		const timedOut = new Promise<"timeout">((done) => bound.addEventListener("abort", () => done("timeout"), { once: true }));
		try {
			const written = await Promise.race([running.write(bytes).then(() => "sent" as const), timedOut]);
			if (written === "timeout") return { ok: false, error: { code: "timeout", message: `the upload to ${path} did not finish within ${ctx.timeoutMs / 1000} s`, transient: true } };
			const code = await Promise.race([running.wait(), timedOut]);
			if (code === "timeout") return { ok: false, error: { code: "timeout", message: `the upload to ${path} did not finish within ${ctx.timeoutMs / 1000} s`, transient: true } };
			await Promise.all([drained, drainOut]);
			if (code !== 0) return vendorFail(KUBERNETES, `the upload to ${path} exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 300)}`);
			return ok(undefined);
		} catch (error) {
			return vendorFail(KUBERNETES, `the upload to ${path} failed: ${(error as Error).message}`);
		} finally {
			await running.kill();
		}
	}

	/** Settings' test: one page of the namespace's computers by the selector label, which makes nothing. */
	async testConnection(ctx: HostCall): Promise<Result<{ detail: string }>> {
		const listed = await this.#api.call("GET", this.#path(this.#object === "pod" ? "pods" : "sandboxclaims"), { query: { labelSelector: `${COMPUTER_LABEL}=1`, limit: String(PAGE) }, timeoutMs: ctx.timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) });
		if (!listed.ok) return countTested("Kubernetes", listed);
		const body = listed.value.body as { items?: unknown[]; metadata?: { continue?: unknown } } | undefined;
		const items = Array.isArray(body?.items) ? (body.items as Pod[]) : [];
		const count = items.filter((item) => !item.metadata?.deletionTimestamp).length;
		return countTested("Kubernetes", ok({ count, more: typeof body?.metadata?.continue === "string" && body.metadata.continue !== "" }));
	}
}

/** A JSON option given as text (a server's setting) or as the value; throws naming the option when it is not JSON of the shape. */
function jsonOption<T>(name: string, value: string | T | undefined, valid: (parsed: unknown) => boolean): T | undefined {
	if (value === undefined || value === "") return undefined;
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new Error(`options.${name} is not JSON`);
		}
	}
	if (!valid(parsed)) throw new Error(`options.${name} is not of its shape`);
	return parsed as T;
}

/** Computers that are Kubernetes pods, on the shared adapter. See the README's Kubernetes section. */
export class KubernetesProvider extends HostedProvider {
	constructor(options: KubernetesProviderOptions) {
		const { namespace, object, image, warmPool, runtimeClass, nodeSelector, tolerations, addCapabilities, container, arch = "amd64", transport, timeouts = {}, daemonPath, maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS, auth, apiUrl, caData, token, tokenFile, kubeconfig, kubeconfigFile, context, googleCredentials, tokenSource, env, readFile, googleFetch, ...rest } = options;
		if ((rest as { archilEgress?: unknown }).archilEgress !== undefined) throw new Error(`${KUBERNETES_NO_ARCHIL}, so it takes no archilEgress`);
		if (arch !== "amd64" && arch !== "arm64") throw new Error(`options.arch is amd64 or arm64, not ${String(arch)}`);
		const model: KubernetesObject = object ?? (warmPool ? "claim" : "pod");
		if (model !== "pod" && model !== "claim") throw new Error(`options.object is pod or claim, not ${JSON.stringify(object)}`);
		if (model === "claim" && warmPool !== undefined && !DNS_SUBDOMAIN.test(warmPool)) throw new Error(`options.warmPool is a SandboxWarmPool's name, not ${JSON.stringify(warmPool)}`);
		if (runtimeClass !== undefined && runtimeClass !== "" && !DNS_SUBDOMAIN.test(runtimeClass)) throw new Error(`options.runtimeClass is a RuntimeClass's name, not ${JSON.stringify(runtimeClass)}`);
		const selector = jsonOption<Record<string, string>>("nodeSelector", nodeSelector, (one) => typeof one === "object" && one !== null && !Array.isArray(one) && Object.values(one).every((value) => typeof value === "string"));
		const tolerated = jsonOption<object[]>("tolerations", tolerations, (one) => Array.isArray(one) && one.every((value) => typeof value === "object" && value !== null));
		const capabilities = (typeof addCapabilities === "string" ? addCapabilities.split(",") : (addCapabilities ?? [])).map((one) => one.trim().toUpperCase().replace(/^CAP_/, "")).filter((one) => one !== "");
		if (capabilities.some((one) => !/^[A-Z_]+$/.test(one))) throw new Error(`options.addCapabilities is a list of capability names such as SYS_ADMIN, not ${JSON.stringify(addCapabilities)}`);
		if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000) throw new Error(`maxLifetimeMs is a whole number of ms, a minute or more, not ${String(maxLifetimeMs)}`);
		const { requestMs = DEFAULT_REQUEST_MS, ...hostedTimeouts } = timeouts;
		let api = transport;
		let resolvedNamespace = namespace;
		if (api === undefined) {
			const resolved = resolveEndpoint({ ...(auth ? { auth } : {}), ...(apiUrl ? { apiUrl } : {}), ...(caData ? { caData } : {}), ...(token ? { token } : {}), ...(tokenFile ? { tokenFile } : {}), ...(kubeconfig ? { kubeconfig } : {}), ...(kubeconfigFile ? { kubeconfigFile } : {}), ...(context ? { context } : {}), ...(googleCredentials ? { googleCredentials } : {}), ...(tokenSource ? { tokenSource } : {}), ...(env ? { env } : {}), ...(readFile ? { readFile } : {}), ...(googleFetch ? { googleFetch } : {}) });
			api = kubeTransport(resolved.endpoint);
			resolvedNamespace ||= resolved.namespace;
		}
		const ns = resolvedNamespace || "default";
		if (!DNS_LABEL.test(ns)) throw new Error(`options.namespace is a namespace's name (lowercase letters, digits and -), not ${JSON.stringify(ns)}`);
		const host = new KubernetesHost({
			api,
			namespace: ns,
			object: model,
			...(image ? { image } : {}),
			...(warmPool ? { warmPool } : {}),
			...(runtimeClass ? { runtimeClass } : {}),
			...(selector ? { nodeSelector: selector } : {}),
			...(tolerated ? { tolerations: tolerated } : {}),
			...(container ? { container } : {}),
			...(capabilities.length > 0 ? { capabilities } : {}),
			arch,
			maxLifetimeMs,
			requestMs,
		});
		super(host, { ...rest, maxLifetimeMs, label: "Kubernetes", kind: "linux", timeouts: hostedTimeouts, daemonPath: daemonPath || fileURLToPath(new URL(`./computerd-linux-${arch}`, import.meta.url)) });
	}
}
