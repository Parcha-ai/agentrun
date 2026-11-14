// Kubernetes' descriptor: a sandbox that is a pod in one namespace of a cluster, a plain Pod or an agent-sandbox claim;
// no mount of the run's folder yet.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/**
 * Why a Kubernetes computer takes no Archil mount: check() refuses one in these words. Under gVisor root holds no
 * CAP_SYS_ADMIN, so the Archil client's FUSE mount must be made inside a user and mount namespace that the computer's
 * programs share, which the daemon does not make yet.
 */
export const KUBERNETES_NO_ARCHIL = "Archil mounts don't work on Kubernetes computers yet: under gVisor the FUSE mount needs a user and mount namespace the daemon does not make yet";

/** The image a computer starts from when its spec names "default": the provider's image option (pod) or warm pool (claim). */
export const KUBERNETES_DEFAULT_IMAGE = "default";

export const KUBERNETES = defineProvider({
	id: "kubernetes",
	label: "Kubernetes",
	// Every value is optional: auth in-cluster needs none. Each is a string a server's Settings or environment holds.
	keys: [
		{ name: "KUBERNETES_AUTH", option: "auth", required: false },
		{ name: "KUBERNETES_API_URL", option: "apiUrl", required: false },
		{ name: "KUBERNETES_CA_DATA", option: "caData", required: false },
		{ name: "KUBERNETES_TOKEN", option: "token", required: false },
		{ name: "KUBERNETES_TOKEN_FILE", option: "tokenFile", required: false },
		{ name: "KUBERNETES_KUBECONFIG", option: "kubeconfig", required: false },
		{ name: "KUBERNETES_CONTEXT", option: "context", required: false },
		{ name: "KUBERNETES_NAMESPACE", option: "namespace", required: false },
		{ name: "KUBERNETES_OBJECT", option: "object", required: false },
		{ name: "KUBERNETES_WARM_POOL", option: "warmPool", required: false },
		{ name: "KUBERNETES_RUNTIME_CLASS", option: "runtimeClass", required: false },
		{ name: "KUBERNETES_NODE_SELECTOR", option: "nodeSelector", required: false },
		{ name: "KUBERNETES_TOLERATIONS", option: "tolerations", required: false },
		{ name: "KUBERNETES_ADD_CAPABILITIES", option: "addCapabilities", required: false },
		{ name: "KUBERNETES_GOOGLE_CREDENTIALS", option: "googleCredentials", required: false },
	],
	// The cluster's nodes bill however its owner pays for them; agentrun meters nothing of it.
	metered: false,
	mounts: [],
	unmounted: { archil: KUBERNETES_NO_ARCHIL },
	// None: its programs run in a network of their own (isolation.ts OWN_NETWORK_ONLY).
	network: ["none"],
	capabilities: [SANDBOX],
	defaultImage: { sandbox: KUBERNETES_DEFAULT_IMAGE },
	// The operator's image (pod) or warm pool (claim) for every Kubernetes computer.
	imageEnv: "AGENTRUN_KUBERNETES_IMAGE",
	// The server's own: where it finds the cluster from inside a pod (in-cluster), and its Google credentials (gke-adc).
	hostEnv: ["KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT", "GOOGLE_APPLICATION_CREDENTIALS"],
	load: () => import("../kubernetes.js"),
});
