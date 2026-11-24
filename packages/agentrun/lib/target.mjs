// The AgentRun a command sends to (`--to`): an address, or `cloud`, the shortcut for AgentRun cloud. `agentrun login --to`
// and `agentrun deploy --to` name a target the same way.

/** AgentRun cloud's address, which `--to cloud` names unless AGENTRUN_CLOUD_URL names another. */
export const CLOUD_URL = "https://api.agentrun.ai";
/** AgentRun cloud's console, where cloud's device sign-in page is. */
export const CLOUD_CONSOLE = "https://console.agentrun.ai";

/** The API base of a server's address, the one rule every command takes it by: the address without its trailing
 *  slashes, with /v2 added when its path holds no v2 segment, so `https://host/prefix` is `https://host/prefix/v2` and
 *  `https://host/v2/` is `https://host/v2`. Only the path's end changes: the string is never re-serialized, so the
 *  origin is the given one, byte for byte. The caller checks the address first (checkedBase). */
export function apiBase(given) {
  const url = given.replace(/\/+$/, "");
  const path = URL.canParse(url) ? new URL(url).pathname : "";
  return path.split("/").includes("v2") ? url : `${url}/v2`;
}

/** The API base (apiBase) of an address a token may be sent to: http or https, with no query, fragment, user or
 *  password, which would carry the token elsewhere or swallow the path appended to it. Undefined for any other; the
 *  caller refuses it without echoing it, as it may hold a password. */
export function checkedBase(given) {
  const url = typeof given === "string" && URL.canParse(given) ? new URL(given) : undefined;
  if (!url || !/^https?:$/.test(url.protocol) || /[?#]/.test(given) || url.username || url.password) return undefined;
  return apiBase(given);
}

/** The API base a `--to` names: `cloud` is AGENTRUN_CLOUD_URL, else CLOUD_URL; any other address is taken as every
 *  command takes one (apiBase). The caller checks the result as every base URL is checked (checkedBase), so a query,
 *  fragment, user or password is refused there. */
export function toUrl(given, env) {
  return apiBase(given === "cloud" ? env.AGENTRUN_CLOUD_URL || CLOUD_URL : given);
}
