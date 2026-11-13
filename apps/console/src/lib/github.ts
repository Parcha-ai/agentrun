// Connect GitHub (one GitHub App per server): the way back from GitHub, and the words the console says for it.

/** What the way back from GitHub says (#/settings/github?github=…): connected, or an error with its `reason`. Only
 *  `github` and `reason` are read from the address; undefined when it says neither. */
export type GitHubReturn = { ok: true } | { ok: false; reason?: string };
export function githubReturnOf(query: string | undefined): GitHubReturn | undefined {
  const q = new URLSearchParams(query ?? "");
  const how = q.get("github");
  if (how === "connected") return { ok: true };
  if (how === "error") { const reason = q.get("reason"); return reason ? { ok: false, reason } : { ok: false }; }
  return undefined;
}

/** The way back in words: per code the server names, and one line for any other, so its raw value is never shown. */
const RETURN_WORDS: Record<string, string> = {
  state_invalid: "That connection was started elsewhere or has expired. Start again.",
  conversion_failed: "GitHub didn't hand back the App. Try connecting again.",
  installation_unverified: "The App's install couldn't be confirmed. Install it again from GitHub.",
  already_connected: "Another GitHub App was connected while this one was being created. Delete the new App on GitHub.",
};
export const githubReturnWords = (r: GitHubReturn): string =>
  r.ok ? "Connected. The App is installed." : (r.reason && Object.hasOwn(RETURN_WORDS, r.reason) ? RETURN_WORDS[r.reason] : "The connection didn't finish. Try again.");

/** Whether `action` (the connect start's) is a place the console posts the App's manifest to: https on github.com. */
export function githubFormAction(action: string, href: (u: string) => string | undefined): string | undefined {
  const ok = href(action);
  if (!ok) return undefined;
  const url = new URL(ok);
  return url.protocol === "https:" && url.hostname === "github.com" ? ok : undefined;
}
