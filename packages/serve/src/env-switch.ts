// The server's on/off settings, which the CLI reads before the rest of the server loads (cli.ts): this module imports
// nothing.

/** The API-only profile (api-only.ts). */
export const API_ONLY_ENV = "AGENTRUN_API_ONLY";
/** The run-keys setting (run-keys.ts). */
export const RUN_KEYS_ENV = "AGENTRUN_RUN_KEYS";
/** Jev off for the web tools (web-run.ts jevWebOf): web_search's results go unranked, whatever key the server holds. */
export const WEB_JEV_OFF_ENV = "AGENTRUN_WEB_JEV_OFF";

/** What each setting means on, and off where off needs saying: the words a refused value answers. */
const MEANS = {
  [API_ONLY_ENV]: ["serve the run API only", "the whole server"],
  [RUN_KEYS_ENV]: ["each run brings the tool keys this server does not hold"],
  [WEB_JEV_OFF_ENV]: ["the web tools run without Jev", "Jev ranks web_search's results where the server holds a TypeSafe key"],
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

/** Whether Jev is off for the web tools under `env`: AGENTRUN_WEB_JEV_OFF on. The CLI refuses any other value at start;
 *  one met later (a runner's claim) reads as off, so a typo never turns Jev on. */
export function webJevOff(env: NodeJS.ProcessEnv): boolean {
  try {
    return switchFrom(WEB_JEV_OFF_ENV, env);
  } catch {
    return true;
  }
}
