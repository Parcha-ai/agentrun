// How the Kubernetes host reaches a cluster's API, from its options alone (it reads no environment: a server passes the
// variables its descriptor names as options.env). Four ways, by options.auth:
// - kubeconfig: a kubeconfig's context (its server, CA, and a token, token file or client certificate). The kubeconfig is
//   JSON: `kubectl config view --raw --minify --flatten -o json` writes one. An exec plugin is refused in words.
// - in-cluster: the pod's service account, as Kubernetes mounts it (its token read again before each call, since the
//   kubelet rotates it), and the API at KUBERNETES_SERVICE_HOST and _PORT.
// - token: an API URL and a bearer token, given, or read from a file before each call (a token a sidecar rotates).
// - gke-adc: an API URL (GKE's endpoint, or its DNS endpoint) and a Google access token from Application Default
//   Credentials (./google-adc.ts), a credentials file: a server outside the cluster that holds a Google identity, a
//   federated one included.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type GoogleAdcOptions, googleAdc } from "./google-adc.js";
import type { KubeEndpoint, KubeTls, TokenSource } from "./kubernetes-api.js";
import { fail, ok } from "./result.js";

export type KubernetesAuth = "kubeconfig" | "in-cluster" | "token" | "gke-adc";
export const KUBERNETES_AUTHS: readonly KubernetesAuth[] = ["kubeconfig", "in-cluster", "token", "gke-adc"];

/** Where Kubernetes mounts a pod's service account. */
export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** The options that say how the API is reached. */
export interface KubernetesConnectOptions {
	/** Default: kubeconfig when one is given, else token when a token or token file is, else in-cluster. */
	auth?: KubernetesAuth;
	/** The API server (https). Required for token and gke-adc; overrides the kubeconfig's or the in-cluster one. */
	apiUrl?: string;
	/** The API server's CA, PEM or base64 of PEM. Absent: the kubeconfig's, the service account's, else the system's CAs. */
	caData?: string;
	/** A bearer token (auth token). */
	token?: string;
	/** A file whose content is the bearer token, read again before each call (auth token). */
	tokenFile?: string;
	/** A kubeconfig, as JSON text (auth kubeconfig). */
	kubeconfig?: string;
	/** A file holding the kubeconfig as JSON, read once here (auth kubeconfig), in place of kubeconfig. */
	kubeconfigFile?: string;
	/** The kubeconfig's context; default its current-context. */
	context?: string;
	/** The Google credentials file (auth gke-adc); default env.GOOGLE_APPLICATION_CREDENTIALS. One of the two is required. */
	googleCredentials?: string;
	/** For a library caller: the bearer token of every call, in place of auth's own. */
	tokenSource?: TokenSource;
	/** The server's own variables the descriptor names (hostEnv), as serve passes them. */
	env?: Readonly<Record<string, string | undefined>>;
	/** For tests: what reads a file. */
	readFile?: (path: string) => string;
	/** For tests: Google's token calls. */
	googleFetch?: GoogleAdcOptions["fetch"];
}

/** The endpoint, and the namespace the kubeconfig's context or the service account names (when it names one). */
export interface ResolvedEndpoint {
	endpoint: KubeEndpoint;
	namespace?: string;
	/** How it was reached, in words for a test of the settings: "kubeconfig context kind-test", "in-cluster", ... */
	via: string;
}

interface KubeconfigJson {
	"current-context"?: string;
	contexts?: Array<{ name?: string; context?: { cluster?: string; user?: string; namespace?: string } }>;
	clusters?: Array<{ name?: string; cluster?: { server?: string; "certificate-authority-data"?: string; "certificate-authority"?: string; "insecure-skip-tls-verify"?: boolean } }>;
	users?: Array<{ name?: string; user?: { token?: string; tokenFile?: string; "client-certificate-data"?: string; "client-key-data"?: string; "client-certificate"?: string; "client-key"?: string; exec?: unknown; "auth-provider"?: unknown; username?: string } }>;
}

/** PEM text from PEM or from base64 of PEM. */
export function pemOf(value: string): string {
	const text = value.trim();
	if (text.startsWith("-----BEGIN")) return text;
	const decoded = Buffer.from(text, "base64").toString("utf8").trim();
	if (!decoded.startsWith("-----BEGIN")) throw new Error("it is neither PEM nor base64 of PEM");
	return decoded;
}

/** A token source that reads a file before each call: the kubelet, or a sidecar, rotates it in place. */
function fileToken(path: string, what: string): TokenSource {
	return async () => {
		try {
			const token = (await readFile(path, "utf8")).trim();
			return token === "" ? fail("denied", `${what} ${path} is empty`) : ok({ token });
		} catch (cause) {
			return fail("denied", `${what} ${path} could not be read: ${(cause as NodeJS.ErrnoException).code ?? (cause as Error).message}`);
		}
	};
}

const staticToken = (token: string): TokenSource => async () => ok({ token });

/**
 * The endpoint the options name, checked: throws in words naming the option to fix, never echoing a token or a key.
 * Reads the files it names (a kubeconfig's CA or client certificate, the service account's CA) once, here.
 */
export function resolveEndpoint(options: KubernetesConnectOptions): ResolvedEndpoint {
	const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const env = options.env ?? {};
	if (options.kubeconfig === undefined && options.kubeconfigFile) {
		try {
			options = { ...options, kubeconfig: read(options.kubeconfigFile) };
		} catch (cause) {
			throw new Error(`options.kubeconfigFile ${options.kubeconfigFile} could not be read: ${(cause as NodeJS.ErrnoException).code ?? (cause as Error).message}`);
		}
	}
	const auth = options.auth ?? (options.kubeconfig ? "kubeconfig" : options.token || options.tokenFile ? "token" : "in-cluster");
	if (!KUBERNETES_AUTHS.includes(auth)) throw new Error(`options.auth is one of ${KUBERNETES_AUTHS.join(", ")}, not ${JSON.stringify(auth)}`);
	const ca = (value: string | undefined, what: string): string | undefined => {
		if (value === undefined || value.trim() === "") return undefined;
		try {
			return pemOf(value);
		} catch (error) {
			throw new Error(`${what}: ${(error as Error).message}`);
		}
	};
	const given = ca(options.caData, "options.caData, the API server's CA");
	const apiUrl = options.apiUrl?.trim() || undefined;

	if (auth === "kubeconfig") {
		if (!options.kubeconfig) throw new Error("auth kubeconfig needs options.kubeconfig, the kubeconfig as JSON: kubectl config view --raw --minify --flatten -o json writes one");
		let config: KubeconfigJson;
		try {
			config = JSON.parse(options.kubeconfig) as KubeconfigJson;
		} catch {
			throw new Error("options.kubeconfig is not JSON: a YAML kubeconfig is not read here; kubectl config view --raw --minify --flatten -o json writes one as JSON");
		}
		const contextName = options.context || config["current-context"];
		const context = config.contexts?.find((one) => one.name === contextName)?.context;
		if (context === undefined) throw new Error(`the kubeconfig has no context ${JSON.stringify(contextName)}: set options.context to one of ${(config.contexts ?? []).map((one) => one.name).join(", ") || "none"}`);
		const cluster = config.clusters?.find((one) => one.name === context.cluster)?.cluster;
		const user = config.users?.find((one) => one.name === context.user)?.user ?? {};
		if (cluster?.server === undefined) throw new Error(`the kubeconfig's cluster ${JSON.stringify(context.cluster)} names no server`);
		if (cluster["insecure-skip-tls-verify"] === true) throw new Error("the kubeconfig's cluster skips TLS verification, which this provider never does: give its CA (certificate-authority-data)");
		if (user.exec !== undefined || user["auth-provider"] !== undefined) throw new Error("the kubeconfig's user runs an exec plugin or an auth provider, which this provider does not run: for GKE use auth gke-adc; else give a user with a token, a token file or a client certificate");
		const fileOrData = (data: string | undefined, file: string | undefined, what: string): string | undefined => {
			if (data) return ca(data, `the kubeconfig's ${what}`);
			if (file) {
				try {
					return read(file);
				} catch (cause) {
					throw new Error(`the kubeconfig's ${what} file ${file} could not be read: ${(cause as NodeJS.ErrnoException).code ?? (cause as Error).message}`);
				}
			}
			return undefined;
		};
		const tls: KubeTls = {};
		const clusterCa = given ?? fileOrData(cluster["certificate-authority-data"], cluster["certificate-authority"], "certificate-authority");
		if (clusterCa) tls.ca = clusterCa;
		const cert = fileOrData(user["client-certificate-data"], user["client-certificate"], "client-certificate");
		const key = fileOrData(user["client-key-data"], user["client-key"], "client-key");
		if ((cert === undefined) !== (key === undefined)) throw new Error("the kubeconfig's user has a client certificate without its key, or a key without its certificate");
		if (cert && key) {
			tls.cert = cert;
			tls.key = key;
		}
		const token = options.tokenSource ?? (user.token ? staticToken(user.token) : user.tokenFile ? fileToken(user.tokenFile, "the kubeconfig's tokenFile") : undefined);
		if (token === undefined && tls.cert === undefined) throw new Error(`the kubeconfig's user ${JSON.stringify(context.user)} has no token, token file or client certificate`);
		return { endpoint: { server: apiUrl ?? cluster.server, tls, ...(token ? { token } : {}) }, ...(context.namespace ? { namespace: context.namespace } : {}), via: `kubeconfig context ${contextName}` };
	}

	if (auth === "in-cluster") {
		const host = env.KUBERNETES_SERVICE_HOST;
		const port = env.KUBERNETES_SERVICE_PORT ?? "443";
		if (apiUrl === undefined && !host) throw new Error("auth in-cluster needs the server to run in a pod (KUBERNETES_SERVICE_HOST is unset): outside a cluster use kubeconfig, token or gke-adc");
		let serviceCa: string | undefined;
		try {
			serviceCa = read(`${SERVICE_ACCOUNT_DIR}/ca.crt`);
		} catch {
			serviceCa = undefined;
		}
		let namespace: string | undefined;
		try {
			namespace = read(`${SERVICE_ACCOUNT_DIR}/namespace`).trim() || undefined;
		} catch {
			namespace = undefined;
		}
		const ipv6 = host?.includes(":") ? `[${host}]` : host;
		const tlsCa = given ?? serviceCa;
		return { endpoint: { server: apiUrl ?? `https://${ipv6}:${port}`, tls: tlsCa ? { ca: tlsCa } : {}, token: options.tokenSource ?? fileToken(`${SERVICE_ACCOUNT_DIR}/token`, "the service account token") }, ...(namespace ? { namespace } : {}), via: "in-cluster service account" };
	}

	if (apiUrl === undefined) throw new Error(`auth ${auth} needs options.apiUrl, the Kubernetes API server's https URL`);
	if (auth === "token") {
		const token = options.tokenSource ?? (options.token ? staticToken(options.token) : options.tokenFile ? fileToken(options.tokenFile, "options.tokenFile") : undefined);
		if (token === undefined) throw new Error("auth token needs options.token, a bearer token, or options.tokenFile, a file holding one");
		return { endpoint: { server: apiUrl, tls: given ? { ca: given } : {}, token }, via: options.token ? "a bearer token" : options.tokenFile ? "a bearer token file" : "the caller's token source" };
	}
	// gke-adc
	const credentialsFile = options.googleCredentials || env.GOOGLE_APPLICATION_CREDENTIALS || undefined;
	if (options.tokenSource === undefined && credentialsFile === undefined) throw new Error("auth gke-adc needs a Google credentials file: set GOOGLE_APPLICATION_CREDENTIALS, or options.googleCredentials (KUBERNETES_GOOGLE_CREDENTIALS); the metadata server is not asked");
	const token = options.tokenSource ?? googleAdc({ ...(credentialsFile ? { credentialsFile } : {}), ...(options.googleFetch ? { fetch: options.googleFetch } : {}) });
	return { endpoint: { server: apiUrl, tls: given ? { ca: given } : {}, token }, via: options.tokenSource ? "the caller's token source" : "Google ADC from a credentials file" };
}
