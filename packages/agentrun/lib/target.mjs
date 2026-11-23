// The AgentRun a command sends to (`--to`): an address, or `cloud`, the shortcut for AgentRun cloud. `agentrun login --to`
// and `agentrun deploy --to` name a target the same way.

/** AgentRun cloud's address, which `--to cloud` names unless AGENTRUN_CLOUD_URL names another. */
export const CLOUD_URL = "https://api.agentrun.ai";
/** AgentRun cloud's console, where cloud's device sign-in page is. */
export const CLOUD_CONSOLE = "https://console.agentrun.ai";

/** The API base a `--to` names, ending /v2: `cloud` is AGENTRUN_CLOUD_URL, else CLOUD_URL; an address whose path does
 *  not end /v2 gets it appended. The caller checks the result as every base URL is checked (cli.mjs baseOf), so a query,
 *  fragment, user or password is refused there. */
export function toUrl(given, env) {
  const url = (given === "cloud" ? env.AGENTRUN_CLOUD_URL || CLOUD_URL : given).replace(/\/+$/, "");
  return /\/v2$/.test(url) ? url : `${url}/v2`;
}
