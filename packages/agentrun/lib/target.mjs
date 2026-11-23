// The AgentRun a command sends to (`--to`): an address, or `cloud`, the shortcut for AgentRun cloud. `agentrun login --to`
// and `agentrun deploy --to` name a target the same way.

/** AgentRun cloud's address, which `--to cloud` names unless AGENTRUN_CLOUD_URL names another. */
export const CLOUD_URL = "https://api.agentrun.ai";
/** AgentRun cloud's console, where cloud's device sign-in page is. */
export const CLOUD_CONSOLE = "https://console.agentrun.ai";

/** The API base of a server's address, the one rule every command takes it by: the address without its trailing
 *  slashes, with /v2 added when its path holds no v2 segment, so `https://host/prefix` is `https://host/prefix/v2` and
 *  `https://host/v2/` is `https://host/v2`. Only the path's end changes: the string is never re-serialized, so the
 *  origin is the given one, byte for byte. The caller checks the address first (cli.mjs baseOf). */
export function apiBase(given) {
  const url = given.replace(/\/+$/, "");
  const path = URL.canParse(url) ? new URL(url).pathname : "";
  return path.split("/").includes("v2") ? url : `${url}/v2`;
}

/** The API base a `--to` names: `cloud` is AGENTRUN_CLOUD_URL, else CLOUD_URL; any other address is taken as every
 *  command takes one (apiBase). The caller checks the result as every base URL is checked (cli.mjs baseOf), so a query,
 *  fragment, user or password is refused there. */
export function toUrl(given, env) {
  return apiBase(given === "cloud" ? env.AGENTRUN_CLOUD_URL || CLOUD_URL : given);
}
