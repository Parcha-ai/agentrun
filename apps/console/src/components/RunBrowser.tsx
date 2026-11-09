import { Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClientError } from "@/lib/client";
import { httpHref } from "@/lib/safeUrl";
import type { RunBrowser } from "@/lib/v2";

/** The run's browser, read from GET /v2/runs/{id}/browser and read again every `every` ms while the run is `going`: not
 *  over (completed, failed, cancelled), so a paused or waiting run is read on too. Null until the first answer, and while
 *  it is `off`. `off` is read from the server's keys now, but a going run's process holds the key it launched with and may
 *  still open a browser, so it is read on; a caller the route refuses (401, 403) is read no more. An ended run has
 *  nothing to watch: it is not read again, and a browser it showed reads as closed (none), whatever the last read said.
 *  A page opened on an ended run reads once, to know whether it had one. Any other failed read keeps the last answer, so
 *  a page being watched isn't torn down by one bad poll. Nothing about the answer is logged. */
export function useRunBrowser(read: (() => Promise<RunBrowser>) | undefined, going: boolean, every = 3000): RunBrowser | null {
  const [now, setNow] = useState<RunBrowser | null>(null);
  // A caller the route refuses (401, 403) is read no more, whatever the run does.
  const [refused, setRefused] = useState(false);
  // The newest reader, so a page that passes a new function each render doesn't restart the reads.
  const reader = useRef(read);
  reader.current = read;
  // Whether a read has answered on this page: an ended run is then read no more (an off it said included), and a browser
  // it showed reads as closed, until it goes again (a follow-up).
  const answered = useRef(false);
  const has = !!read;
  useEffect(() => {
    if (!has || refused) return;
    if (!going && answered.current) { setNow((prev) => (prev ? closed(prev) : prev)); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const once = async () => {
      try {
        const next = await reader.current!();
        if (!alive) return;
        answered.current = true;
        if (next.state === "off") setNow(null);
        // An ended run's browser is closed, whatever it last said.
        else if (!going) setNow(closed(next));
        // A same answer keeps the same object, so a live viewer's iframe is not touched by a poll.
        else setNow((prev) => (prev && prev.state === next.state && (prev.state !== "live" || (next.state === "live" && prev.viewer === next.viewer)) ? prev : next));
      } catch (e) {
        if (!alive) return;
        if (e instanceof ClientError && [401, 403].includes(e.status)) { setRefused(true); setNow(null); return; }
      }
      if (alive && going) timer = setTimeout(() => void once(), every);
    };
    void once();
    return () => { alive = false; clearTimeout(timer); };
  }, [has, going, every, refused]);
  return now;
}

/** A computer that closed with its run: `none`, of the same kind, the agent's. */
const closed = (from: RunBrowser): RunBrowser => (from.state === "off" ? from : { state: "none", kind: from.kind, hold: "agent" });

/** The Browser tab: the agent's live page, watched through the session's viewer, or that it waits for its first page.
 *  The viewer (a same-origin path, its token in the fragment) is the iframe's src and nothing else: never the address
 *  bar, the history, storage, a log or an error. A new session (a release, then a page again) is a new viewer: the
 *  iframe is made again for it. Taking over and handing back are the viewer's own (pi-browser live-view), not the console's. */
export function BrowserPanel({ runId, browser, opens, followUp }: {
  /** The run whose browser this is: only a viewer under its own path is framed. */
  runId: string;
  browser: RunBrowser;
  /** Whether the run can still open a browser: queued, working, waiting on its question with its process (and any
   *  session) held, or a paused workflow. Otherwise `none` is a browser that closed with the run, never one to wait for. */
  opens: boolean;
  /** Whether the ended run takes a follow-up: its turn runs in a new process, whose browser tool opens a new session if
   *  the agent uses it (serve's tools.ts, the live view handed over per session as the process opens one). */
  followUp: boolean;
}) {
  // Each viewer gets an iframe of its own (a new session is a new page); the key is a count, never the viewer itself.
  const session = useRef({ viewer: "", n: 0 });
  if (browser.state === "live" && browser.viewer !== session.current.viewer) session.current = { viewer: browser.viewer, n: session.current.n + 1 };
  const src = browser.state === "live" ? framedViewer(browser.viewer, runId) : undefined;
  return (
    <section aria-label="Browser" className="border">
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <Globe className="size-4 text-muted-foreground" aria-hidden />
        <span className="caps flex-1 text-[12px] font-semibold">{browser.state === "live" ? "Live" : "Browser"}</span>
      </header>
      {browser.state === "live" && src
        // The viewer's page (pi-browser live-view/viewer.ts) needs its own scripts, and its own origin: its WebSocket goes
        // to this server, which checks the session cookie and the Origin, and it clears the fragment from its own history.
        // Its address bar is a form (its own script reads it). Nothing else: no popups, no navigating the console.
        ? <iframe key={session.current.n} src={src} title="The run's browser" referrerPolicy="no-referrer" sandbox="allow-forms allow-scripts allow-same-origin" className="block aspect-[16/10] w-full bg-background" />
        : browser.state === "live"
        // A viewer that is not this run's own on this origin: said, never framed, and its value not shown.
        ? <p className="px-4 py-12 text-center font-mono text-[13px] text-muted-foreground">The live view can't be shown here.</p>
        : <p className="px-4 py-12 text-center font-mono text-[13px] text-muted-foreground">
            {opens ? "Waiting for the browser. The agent's page shows here once it opens one." : `The browser closed when the run ended.${followUp ? " A follow-up opens a new one if the agent needs it." : ""}`}
          </p>}
    </section>
  );
}

/** The served viewer as the iframe's src: resolved against this page's origin (it is a same-origin path, its token in the
 *  fragment), an http(s) URL (httpHref), on this origin, under this run's own live-view path. Anything else: undefined. */
export function framedViewer(viewer: string, runId: string): string | undefined {
  let resolved: string;
  try { resolved = new URL(viewer, location.origin).href; } catch { return undefined; }
  const href = httpHref(resolved);
  if (!href) return undefined;
  const url = new URL(href);
  return url.origin === location.origin && url.pathname.startsWith(`/v2/runs/${encodeURIComponent(runId)}/browser/live/`) ? href : undefined;
}
