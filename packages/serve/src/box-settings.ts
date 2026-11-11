// The hosts a run's computer may reach (AGENTRUN_BOX_ALLOW), as the server reads them at its start: a run's launch keeps
// them (box_allow) and its computer is made with them (workspace/computer-deps.ts). A setting that is not one throws,
// naming it: the start checks it, so no run meets one.

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
