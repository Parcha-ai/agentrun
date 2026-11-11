// A box's settings as the server reads them at its start: a Docker box's limits (AGENTRUN_BOX_CPUS, _MEMORY, _PIDS), the
// hosts a box may reach (AGENTRUN_BOX_ALLOW) and what a server's Docker boxes reach from them, and, under `--faux` only,
// the tests' faux box provider. A setting that is not one throws, naming it: the start checks each, so no run meets one.
import { pathToFileURL } from "node:url";
import type { BoxProvider } from "@parcha/pi-transport";
import { type DockerNetwork, egressBlockedBy } from "./box-egress.js";
import { vmDocker } from "./box-egress-vm.js";

/** The settings that bound a Docker box; unset, their defaults: enough for a build, and safe on a laptop, where one run's
 *  runaway build or fork bomb would otherwise starve everything else. */
export const BOX_CPUS_ENV = "AGENTRUN_BOX_CPUS";
export const BOX_MEMORY_ENV = "AGENTRUN_BOX_MEMORY";
export const BOX_PIDS_ENV = "AGENTRUN_BOX_PIDS";
/** 2 CPUs' time: a CFS quota (pi-transport's Docker provider), which holds whatever CPU count Docker's VM has. */
export const DEFAULT_BOX_CPUS = 2;
/** 4 GiB, swap included (--memory-swap the same). */
export const DEFAULT_BOX_MEMORY = "4g";
/** Processes and threads at once. */
export const DEFAULT_BOX_PIDS = 1024;

/** A Docker box's limits, as pi-transport's Docker provider takes them. */
export type BoxLimits = { cpus: number; memory: string; pidsLimit: number };

/** The fewest CPUs a quota gives: the kernel's least quota is 1 ms of each 100 ms period. A quota is also a whole number of
 *  µs, so a count too large for one (or a long string of digits, which reads as Infinity) is refused too. */
const MIN_BOX_CPUS = 0.01;
const MIB = 1024 * 1024;
/** A size's units as Docker reads them, each 1024 of the one before. */
const SIZE_UNITS: Readonly<Record<string, number>> = { b: 1, k: 1024, m: MIB, g: 1024 * MIB };
/** The least memory Docker gives a container. */
const MIN_BOX_MEMORY = 6 * MIB;
/** The most processes a cgroup may be given (the kernel's PID_MAX_LIMIT); above it, every create fails. */
const MAX_BOX_PIDS = 4_194_304;

/** A Docker box's limits from `env`: each setting's value, or its default when unset or empty. A value that is not one, or
 *  that every create would fail on (less than a 1 ms quota, less memory than Docker gives, more processes than the kernel
 *  allows), throws, naming its setting: the start checks them (startServe), so no run meets one. */
export function boxLimitsOf(env: NodeJS.ProcessEnv): BoxLimits {
  const read = (name: string, what: string, takes: (value: string) => boolean): string | undefined => {
    const value = env[name];
    if (!value) return undefined;
    if (!takes(value)) throw new Error(`${name} is ${what}; it is ${JSON.stringify(value)}`);
    return value;
  };
  const cpus = read(BOX_CPUS_ENV, "a number of CPUs of at least 0.01, such as 2 or 1.5", (value) => /^\d+(\.\d+)?$/.test(value) && Number(value) >= MIN_BOX_CPUS && Number.isSafeInteger(Math.round(Number(value) * 100_000)));
  const memory = read(BOX_MEMORY_ENV, "a size of at least 6m with its unit (b, k, m or g), such as 512m or 4g", (value) => {
    const size = /^(\d+(?:\.\d+)?)([bkmg])$/i.exec(value);
    // Its bytes as Docker reads them, and pi-transport's Docker provider: the number times the unit, the fraction dropped.
    const bytes = size ? Math.floor(Number(size[1]) * SIZE_UNITS[size[2].toLowerCase()]) : 0;
    return Number.isSafeInteger(bytes) && bytes >= MIN_BOX_MEMORY;
  });
  const pids = read(BOX_PIDS_ENV, "a whole number from 1 to 4194304, such as 1024", (value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_BOX_PIDS);
  return { cpus: cpus === undefined ? DEFAULT_BOX_CPUS : Number(cpus), memory: memory ?? DEFAULT_BOX_MEMORY, pidsLimit: pids === undefined ? DEFAULT_BOX_PIDS : Number(pids) };
}

/** A Docker size (boxLimitsOf's memory) in MiB, the fraction dropped. */
export const memoryMbOf = (memory: string): number => {
  const size = /^(\d+(?:\.\d+)?)([bkmg])$/i.exec(memory);
  return size ? Math.floor((Number(size[1]) * SIZE_UNITS[size[2]!.toLowerCase()]!) / MIB) : 0;
};

/** The setting that names the hosts a box may reach: a comma list of hosts, each a name or `*.` and a name, which
 *  replaces the default list; `none` for no network at all. Unset or empty, the default. */
export const BOX_ALLOW_ENV = "AGENTRUN_BOX_ALLOW";
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
