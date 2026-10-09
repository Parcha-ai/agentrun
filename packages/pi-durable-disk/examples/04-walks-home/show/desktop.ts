// The live view of a host's desktop (D4's route on the 03 server): the run's secret buys a short-lived ticket, the ticket
// names an MJPEG stream of the host's screen. The stage's SERVER holds the secret and does both calls; the page only ever
// sees a same-origin path (/desktop/<ticket>.mjpeg), so neither the secret nor the host's own access reaches it, and the
// picture arrives from the stage's own origin (it must, to load under the page's COEP).
import type { IncomingMessage, ServerResponse } from "node:http";

export type DesktopTarget = { origin: string; run: string; secret: string };
export type Ticket = { ok: true; url: string; ttlMs: number } | { ok: false; status: number };

/** The only path the proxy will forward: a ticket's stream, nothing else on the host. */
export const TICKET_PATH = /^\/desktop\/[A-Za-z0-9_-]{8,}\.mjpeg$/;

/** A run link (`http://host:port/run/ID#SECRET`) as a target. */
export function desktopTargetFromLink(link: string): DesktopTarget {
  const u = new URL(link.trim());
  return { origin: u.origin, run: decodeURIComponent(u.pathname.split("/").filter(Boolean).at(-1) ?? ""), secret: u.hash.slice(1) };
}

type FetchLike = typeof fetch;

/** Trade the run's secret for a ticket. A 404 is the host's way of saying there is no desktop (yet). */
export async function requestTicket(target: DesktopTarget, fetchFn: FetchLike = fetch): Promise<Ticket> {
  const res = await fetchFn(`${target.origin}/run/${encodeURIComponent(target.run)}/desktop-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${target.secret}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const body = (await res.json().catch(() => undefined)) as { url?: unknown; ttlMs?: unknown } | undefined;
  // What the host names must be a ticket's stream: anything else is not forwarded, whatever it claims.
  if (typeof body?.url !== "string" || !TICKET_PATH.test(body.url)) return { ok: false, status: 502 };
  return { ok: true, url: body.url, ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : 600_000 };
}

/** Stream a ticket's pictures to the page. No credential is sent: the ticket in the path is the credential. */
export async function proxyStream(target: DesktopTarget, path: string, req: IncomingMessage, res: ServerResponse, fetchFn: FetchLike = fetch): Promise<void> {
  if (!TICKET_PATH.test(path)) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "not a desktop ticket path" }));
    return;
  }
  const abort = new AbortController();
  // The page closed its picture: stop pulling frames from the host.
  req.on("close", () => abort.abort());
  let upstream: Response;
  try {
    upstream = await fetchFn(`${target.origin}${path}`, { signal: abort.signal });
  } catch {
    if (!res.headersSent) res.writeHead(502).end();
    return;
  }
  res.statusCode = upstream.status;
  const type = upstream.headers.get("content-type");
  if (type) res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  if (!upstream.body || upstream.status !== 200) return void res.end();
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once("drain", r));
    }
  } catch {
    // The host or the page went away mid-stream: the picture simply ends.
  } finally {
    res.end();
  }
}
