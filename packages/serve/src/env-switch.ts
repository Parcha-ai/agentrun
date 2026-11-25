// The server's two on/off settings, and the API-only profile's MCP origins, which the CLI reads before the rest of the
// server loads (cli.ts): this module imports nothing.

/** The API-only profile (api-only.ts). */
export const API_ONLY_ENV = "AGENTRUN_API_ONLY";
/** The run-keys setting (run-keys.ts). */
export const RUN_KEYS_ENV = "AGENTRUN_RUN_KEYS";

/** What each setting means on, and off where off needs saying: the words a refused value answers. */
const MEANS = {
  [API_ONLY_ENV]: ["serve the run API only", "the whole server"],
  [RUN_KEYS_ENV]: ["each run brings the tool keys this server does not hold"],
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

/** The MCP origins an API-only server's token may save a per_run MCP server at: the serve README's API-only section. */
export const API_ONLY_MCP_ORIGINS_ENV = "AGENTRUN_API_ONLY_MCP_ORIGINS";

/** A URL hostname on this machine: localhost, ::1 (bracketed, as URL writes it) or 127.0.0.0/8. Defined here, since this
 *  module imports nothing; mcp-oauth.ts LOOPBACK is this one. */
export const LOOPBACK_HOST = /^(?:localhost|\[::1\]|127(?:[.]\d{1,3}){3})$/; // key-gate: loopback-rule the one loopback rule, for the API-only MCP origins and MCP sign-in

/** The origins `value` (API_ONLY_MCP_ORIGINS_ENV) names, each once, in its order: none when unset or blank. An entry
 *  that is not an http or https origin alone (a path, query, fragment, user or password, or no URL at all) is refused
 *  (a TypeError naming the entry by its place, never its text, which could hold a password), and so is a wildcard
 *  (`https://*.example.com`), which would otherwise be taken as a literal host and match nothing, and so is plain http
 *  to any host but a loopback one (LOOPBACK_HOST), whose traffic would cross the network in the clear. Empty entries
 *  are skipped. */
export function apiOnlyMcpOriginsFrom(value: string | undefined): string[] {
  const origins: string[] = [];
  (value ?? "").split(",").map((entry) => entry.trim()).forEach((entry, at) => {
    if (entry === "") return;
    if (entry.includes("*")) throw new TypeError(`${API_ONLY_MCP_ORIGINS_ENV} names each origin whole: entry ${at + 1} is a wildcard, and wildcards are not supported`);
    let url: URL | undefined;
    try {
      url = new URL(entry);
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.href !== `${url.origin}/`) {
      throw new TypeError(`${API_ONLY_MCP_ORIGINS_ENV} is a comma-separated list of MCP origins (http or https, scheme://host[:port], no path): entry ${at + 1} is not one`);
    }
    if (url.protocol === "http:" && !LOOPBACK_HOST.test(url.hostname)) {
      throw new TypeError(`${API_ONLY_MCP_ORIGINS_ENV} takes plain http only for this machine (127.0.0.0/8, ::1, localhost): entry ${at + 1} is plain http to a host off this machine; list it as https`);
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  });
  return origins;
}
