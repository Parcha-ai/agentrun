// CORS for the stage's feed. The stage page is static files served on the agent's tab's origin (the 03 server's /show/), cross-origin isolated; its feed is this server, on another origin, so
// its fetches and event stream need CORS. This server takes commands, so only the ONE origin named in SHOW_ALLOW_ORIGIN gets it, by exact match, never a wildcard, never with credentials.
export function corsHeaders(allow: string | undefined, origin: string | undefined): Record<string, string> {
  if (allow === undefined || allow === "") return {};
  let allowed: string;
  try {
    allowed = new URL(allow).origin;
  } catch {
    return {};
  }
  if (allowed === "null") return {};
  if (origin !== allowed) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": allowed,
    Vary: "Origin",
    // The page resumes the event stream after the snapshot's last event id, read from this header.
    "Access-Control-Expose-Headers": "x-last-event-id",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, last-event-id",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}
