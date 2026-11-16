// Kubernetes for the conformance CLI: `--provider kubernetes [--image <image or warm pool>]`. The provider reads no
// environment: this module reads the run's settings from its own COMPUTER_KUBERNETES_* names (never KUBECONFIG, which
// may point at another cluster on the host that runs the suite) and passes each to create() as its option. The
// kubeconfig is the file COMPUTER_KUBERNETES_KUBECONFIG names (create() reads it), as JSON (kubectl config view --raw --minify
// --flatten -o json writes one). The live sweep (sweep.ts, --provider kubernetes) reads the same names through createHost.
import { KUBERNETES_DEFAULT_IMAGE } from "../descriptors/kubernetes.js";
import type { MachineHost } from "../host.js";
import { create, type KubernetesProvider, type KubernetesProviderOptions } from "../kubernetes.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";

/** The environment this module reads, by name, each for the option its comment names. */
export const KUBERNETES_ENV = {
	/** auth: kubeconfig, in-cluster, token or gke-adc; default as create() picks. */
	auth: "COMPUTER_KUBERNETES_AUTH",
	/** kubeconfig: a file holding the kubeconfig as JSON. */
	kubeconfig: "COMPUTER_KUBERNETES_KUBECONFIG",
	/** context: the kubeconfig's context; default its current one. */
	context: "COMPUTER_KUBERNETES_CONTEXT",
	/** apiUrl: the API server's https URL (token, gke-adc). */
	url: "COMPUTER_KUBERNETES_API_URL",
	/** caData: the API server's CA, PEM or base64 of PEM. */
	ca: "COMPUTER_KUBERNETES_CA_DATA",
	/** tokenFile: a file holding a bearer token (auth token). */
	tokenFile: "COMPUTER_KUBERNETES_TOKEN_FILE",
	/** googleCredentials: the Google credentials file (auth gke-adc). */
	google: "COMPUTER_KUBERNETES_GOOGLE_CREDENTIALS",
	/** namespace; default the context's, else default. */
	namespace: "COMPUTER_KUBERNETES_NAMESPACE",
	/** object: pod (default) or claim. */
	object: "COMPUTER_KUBERNETES_OBJECT",
	/** image: the pod model's image every computer of the run starts from. */
	image: "COMPUTER_KUBERNETES_IMAGE",
	/** warmPool: the claim model's SandboxWarmPool. */
	warmPool: "COMPUTER_KUBERNETES_WARM_POOL",
	/** runtimeClass: the pod model's RuntimeClass (gvisor). */
	runtimeClass: "COMPUTER_KUBERNETES_RUNTIME_CLASS",
	/** addCapabilities: extra container capabilities, comma-separated (SYS_ADMIN on a runc node that refuses user namespaces). */
	capabilities: "COMPUTER_KUBERNETES_ADD_CAPABILITIES",
	/** daemonPath; default this package's dist/computerd-linux-<arch>. */
	daemon: "COMPUTER_KUBERNETES_DAEMON",
	/** arch: amd64 (default) or arm64. */
	arch: "COMPUTER_KUBERNETES_ARCH",
} as const;

export const ENV = KUBERNETES_ENV;

/** The provider's options this module reads from env, each only when its name is set; create() checks them. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): KubernetesProviderOptions {
	const named = (name: string) => (env[name] ? (env[name] as string) : undefined);
	const kubeconfigFile = named(KUBERNETES_ENV.kubeconfig);
	const url = named(KUBERNETES_ENV.url);
	if (kubeconfigFile === undefined && url === undefined && named(KUBERNETES_ENV.auth) !== "in-cluster") {
		throw new Error(`set ${KUBERNETES_ENV.kubeconfig} to a kubeconfig file (JSON: kubectl config view --raw --minify --flatten -o json), or ${KUBERNETES_ENV.url} with ${KUBERNETES_ENV.auth} token or gke-adc: the conformance module reads these and never KUBECONFIG`);
	}
	const pick = <K extends keyof KubernetesProviderOptions>(key: K, name: string) => (named(name) ? { [key]: named(name) } : {});
	return {
		...pick("auth", KUBERNETES_ENV.auth),
		...(kubeconfigFile ? { kubeconfigFile } : {}),
		...pick("context", KUBERNETES_ENV.context),
		...pick("apiUrl", KUBERNETES_ENV.url),
		...pick("caData", KUBERNETES_ENV.ca),
		...pick("tokenFile", KUBERNETES_ENV.tokenFile),
		...pick("googleCredentials", KUBERNETES_ENV.google),
		...pick("namespace", KUBERNETES_ENV.namespace),
		...pick("object", KUBERNETES_ENV.object),
		...pick("image", KUBERNETES_ENV.image),
		...pick("warmPool", KUBERNETES_ENV.warmPool),
		...pick("runtimeClass", KUBERNETES_ENV.runtimeClass),
		...pick("addCapabilities", KUBERNETES_ENV.capabilities),
		...pick("daemonPath", KUBERNETES_ENV.daemon),
		...pick("arch", KUBERNETES_ENV.arch),
	} as KubernetesProviderOptions;
}

export const conformanceNotes: string[] = [
	"kubernetes: lifetime janitor. A computer's deadline is its label (in the agentrun.labels annotation) and init's own; the pod's activeDeadlineSeconds (or a claim's shutdownTime) ends it at the most a computer may live, as a backstop.",
];

export interface KubernetesModuleOptions {
	env?: Record<string, string | undefined>;
	transport?: KubernetesProviderOptions["transport"];
	timeouts?: KubernetesProviderOptions["timeouts"];
	onNote?: KubernetesProviderOptions["onNote"];
}

function optionsOf({ env = process.env, transport, timeouts, onNote }: KubernetesModuleOptions): KubernetesProviderOptions {
	return { ...settingsFromEnv(env), ...(transport ? { transport } : {}), ...(timeouts ? { timeouts } : {}), ...(onNote ? { onNote } : {}) };
}

/** The image every computer of the run starts from: "default", the provider's image or warm pool. */
export function conformanceImage(): string {
	return KUBERNETES_DEFAULT_IMAGE;
}

export function createProvider(options: KubernetesModuleOptions = {}): KubernetesProvider {
	return create(optionsOf(options));
}

export async function createHost(options: Pick<KubernetesModuleOptions, "env" | "transport"> = {}): Promise<MachineHost> {
	return create(optionsOf(options)).host;
}

/** The same provider with a daemon that reports another version, built with Go for the drift case. */
export async function createDriftedProvider(options: KubernetesModuleOptions = {}): Promise<KubernetesProvider> {
	const settings = optionsOf(options);
	create(settings);
	return create({ ...settings, daemonPath: await buildDriftDaemon(settings.arch ?? "amd64", DRIFT_VERSION) });
}
