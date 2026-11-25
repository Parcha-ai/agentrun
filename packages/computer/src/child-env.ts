// The environment a child this package starts holds: the names that child reads, of the environment its host passes
// (the provider's `env` option), and nothing else, so a key the host holds never reaches a child that has no use for it.
// The package itself reads no environment: with no `env`, a child starts with none. The lists of names are
// descriptors/env-names.ts', where the descriptors' hostEnv reads them too.
import { CHROME_ENV_NAMES, DOCKER_ENV_NAMES } from "./descriptors/env-names.js";

export { BASE_ENV_NAMES, CHROME_ENV_NAMES, DOCKER_ENV_NAMES } from "./descriptors/env-names.js";

/** The environment variables a host passes, by name; a name with no value is unset. */
export type HostEnv = Readonly<Record<string, string | undefined>>;

/** `env`'s values of `names` that are set, and nothing else: a child's whole environment. */
export function childEnv(env: HostEnv, names: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of names) {
		const value = env[name];
		if (typeof value === "string") out[name] = value;
	}
	return out;
}

/** A docker CLI child's environment: DOCKER_ENV_NAMES of `env`. */
export const dockerEnv = (env: HostEnv = {}): Record<string, string> => childEnv(env, DOCKER_ENV_NAMES);
/** A Chrome child's (and the local browser's supervisor's) environment: CHROME_ENV_NAMES of `env`. */
export const chromeEnv = (env: HostEnv = {}): Record<string, string> => childEnv(env, CHROME_ENV_NAMES);
