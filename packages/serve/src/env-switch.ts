// The server's on/off settings, which the CLI reads before the rest of the server loads (cli.ts): this module
// imports nothing.

/** The API-only profile (api-only.ts). */
export const API_ONLY_ENV = "AGENTRUN_API_ONLY";
/** The run-keys setting (run-keys.ts). */
export const RUN_KEYS_ENV = "AGENTRUN_RUN_KEYS";
/** The share host (share-host.ts), as --share-host. */
export const SHARE_HOST_ENV = "AGENTRUN_SHARE_HOST";

/** What each setting means on, and off where off needs saying: the words a refused value answers. */
const MEANS = {
  [API_ONLY_ENV]: ["serve the run API only", "the whole server"],
  [RUN_KEYS_ENV]: ["each run brings the tool keys this server does not hold"],
  [SHARE_HOST_ENV]: ["serve shares under /r/ alone", "the whole server"],
} as const satisfies Record<string, readonly [string, string?]>;

/** Whether `env` turns setting `name` on: `1` or `true` on; unset, empty, `0` or `false` off. Any other value is refused
 *  in words that say what each means (a TypeError), so a typo never leaves the console open on a server meant to be
 *  API-only. */
export function switchFrom(name: keyof typeof MEANS, env: NodeJS.ProcessEnv = process.env): boolean {
  const given = env[name]?.trim().toLowerCase() ?? "";
  if (given === "1" || given === "true") return true;
  if (given === "" || given === "0" || given === "false") return false;
  const [on, off] = MEANS[name] as readonly [string, string?];
  throw new TypeError(`${name} is 1 (${on}) or 0${off === undefined ? "" : ` (${off})`}, not ${JSON.stringify(env[name])}`);
}
