// Where `--to` points: an AgentRun's API base, as `agentrun deploy` (and the CLI's sign-in) takes it. `cloud` is the
// hosted AgentRun, its address one constant here that AGENTRUN_CLOUD_URL overrides (a staging install, a test).

/** The hosted AgentRun's API base: what `--to cloud` names. */
export const CLOUD_URL = "https://api.agentrun.ai/v2";

/** `--to`'s value as an API base: `cloud`, else an http or https URL with no user, password, query or fragment (a URL
 *  with no path gets /v2; a trailing slash is dropped). Anything else throws, naming --to; the URL itself is never echoed,
 *  as it may hold a password. */
export function toBase(given, env = process.env) {
  const raw = given === "cloud" ? env.AGENTRUN_CLOUD_URL || CLOUD_URL : given;
  const url = typeof raw === "string" && URL.canParse(raw) ? new URL(raw) : undefined;
  if (!url || !/^https?:$/.test(url.protocol) || /[?#]/.test(raw) || url.username || url.password) {
    throw new Error(`--to is cloud or an AgentRun's address: an http or https URL with no user, password, query or fragment${given === "cloud" ? " (AGENTRUN_CLOUD_URL is not one)" : ""}.`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path || "/v2"}`;
}
