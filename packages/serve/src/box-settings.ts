// A box's settings as the server reads them at its start: the hosts a box may reach (AGENTRUN_BOX_ALLOW) and what a
// server's Docker boxes reach from them, and, under `--faux` only, the tests' faux box provider. A setting that is not one
// throws, naming it: the start checks each, so no run meets one. A Docker computer's size (AGENTRUN_BOX_CPUS, _MEMORY,
// _PIDS) is workspace/computer-deps.ts dockerLimitsOf.
import { pathToFileURL } from "node:url";
import type { BoxProvider } from "@parcha/pi-transport";
import { type DockerNetwork, egressBlockedBy } from "./box-egress.js";
import { vmDocker } from "./box-egress-vm.js";

/** The setting that names the hosts a box may reach: a comma list of hosts, each a name or `*.` and a name, which
 *  replaces the default list; `none` for no network at all. Unset or empty, the default. */
export const BOX_ALLOW_ENV = "AGENTRUN_BOX_ALLOW";
/** Whether the operator set the setting (a list of their own, or none), not left it to the default: a browser is held to
 *  the operator's list, never to the default, which is a sandbox's package-install list and no browsing policy. */
export const boxAllowSetIn = (env: NodeJS.ProcessEnv): boolean => (env[BOX_ALLOW_ENV] ?? "").trim() !== "";
/** The hosts a box reaches when the setting names none: the package registries pip and npm (and yarn) install from, and
 *  GitHub for a clone or an archive. */
export const DEFAULT_BOX_ALLOW: readonly string[] = Object.freeze(["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "registry.yarnpkg.com", "github.com", "codeload.github.com"]);
/** The most hosts the list may hold: Daytona's own limit on a sandbox's domain list. */
export const MAX_BOX_ALLOW = 100;
/** A host name, or `*.` and one: letters, digits and hyphens in dotted labels, the last one starting with a letter, so no
 *  IP address is one. */
const ALLOW_HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The hosts a box may reach, from `env`'s AGENTRUN_BOX_ALLOW: its list, lower-cased, each host once; the default list when
 *  unset or empty; `none` for no network. `*`, an IP address, a CIDR, a port, a URL, or more than 100 hosts throws, saying
 *  what the setting takes: the start checks it (startServe), so no run meets one. */
export function boxAllowOf(env: NodeJS.ProcessEnv): readonly string[] | "none" {
  const value = (env[BOX_ALLOW_ENV] ?? "").trim();
  if (!value) return DEFAULT_BOX_ALLOW;
  if (value.toLowerCase() === "none") return "none";
  const hosts = [...new Set(value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean))];
  const takes = "a comma list of host names (such as pypi.org or *.pythonhosted.org), or none for no network";
  const bad = hosts.find((host) => !ALLOW_HOST.test(host));
  if (bad !== undefined) throw new Error(`${BOX_ALLOW_ENV} is ${takes}: ${JSON.stringify(bad)} is not a host name${bad === "*" ? " (a box never reaches every host)" : ""}`);
  if (hosts.length === 0) throw new Error(`${BOX_ALLOW_ENV} is ${takes}; it is ${JSON.stringify(value)}`);
  if (hosts.length > MAX_BOX_ALLOW) throw new Error(`${BOX_ALLOW_ENV} names ${hosts.length} hosts; it takes at most ${MAX_BOX_ALLOW}`);
  return Object.freeze(hosts);
}

/** What a server's Docker boxes reach, resolved once at its start: the setting's list (boxAllowOf) where egressBlockedBy
 *  (box-egress.ts) finds the daemon is this Linux machine's own, else none with the reason; `none` from the setting, with
 *  it as the reason. */
export async function boxNetworkOf(env: NodeJS.ProcessEnv, options: Parameters<typeof egressBlockedBy>[1] = {}): Promise<DockerNetwork> {
  const allow = boxAllowOf(env);
  if (allow === "none") return { allow: "none", reason: `${BOX_ALLOW_ENV} is none` };
  const blocked = await egressBlockedBy(env, options);
  if (!blocked) return { allow };
  // On a Mac only: a Docker that docker info names as a VM runtime this server knows gets the proxy container
  // (box-egress-vm.ts); any other stays none, saying why.
  if ((options.platform ?? process.platform) !== "darwin") return { allow: "none", reason: blocked };
  const vm = await vmDocker(env, { ...(options.platform ? { platform: options.platform } : {}), ...(options.kernel ? { kernel: options.kernel } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  return "runtime" in vm ? { allow, vm: vm.runtime } : { allow: "none", reason: vm.reason };
}

/** Under `--faux` only: a module whose default export, given the data root, is the provider the tests' faux box comes
 *  from in place of Docker. */
export const FAUX_BOX_ENV = "AGENTRUN_SERVE_FAUX_BOX";

/** The tests' faux box provider, from its module. */
export const fauxBoxes = async (module: string, root: string): Promise<BoxProvider> =>
  ((await import(pathToFileURL(module).href)) as { default: (root: string) => BoxProvider }).default(root);
