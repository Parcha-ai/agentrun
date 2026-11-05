import { Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClientError } from "@/lib/client";
import type { RunBrowser } from "@/lib/v2";

/** The run's browser, read from GET /v2/runs/{id}/browser and read again every `every` ms while the run is live, and once
 *  more after it ends (a session is released at the end). Null until the first read, and for a run whose browser the
 *  console can't show, which is read no more: `off`, or a server with no such route (404) or that refuses this caller
 *  (401, 403). A failed read
 *  keeps the last answer, so a page being watched isn't torn down by one bad poll. Nothing about the answer is logged. */
export function useRunBrowser(read: (() => Promise<RunBrowser>) | undefined, live: boolean, every = 3000): RunBrowser | null {
  const [now, setNow] = useState<RunBrowser | null>(null);
  const [gone, setGone] = useState(false);
  // The newest reader, so a page that passes a new function each render doesn't restart the reads.
  const reader = useRef(read);
  reader.current = read;
  const has = !!read;
  useEffect(() => {
    if (!has || gone) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const once = async () => {
      try {
        const next = await reader.current!();
        if (!alive) return;
        // A run with no browser keeps none: no more reads for it.
        if (next.state === "off") { setGone(true); setNow(null); return; }
        // A same answer keeps the same object, so a live viewer's iframe is not touched by a poll.
        setNow((prev) => (prev && prev.state === next.state && (prev.state !== "live" || (next.state === "live" && prev.viewer === next.viewer)) ? prev : next));
      } catch (e) {
        if (!alive) return;
        if (e instanceof ClientError && [401, 403, 404].includes(e.status)) { setGone(true); setNow(null); return; }
      }
      if (alive && live) timer = setTimeout(() => void once(), every);
    };
    void once();
    return () => { alive = false; clearTimeout(timer); };
  }, [has, live, every, gone]);
  return now;
}

/** The Browser tab: the agent's live page, watched through the session's viewer, or that it waits for its first page.
 *  The viewer (a same-origin path, its token in the fragment) is the iframe's src and nothing else: never the address
 *  bar, the history, storage, a log or an error. A new session (a release, then a page again) is a new viewer: the
 *  iframe is made again for it. Take over and hand back, and what the agent waits on, are to come in their places here. */
export function BrowserPanel({ browser }: { browser: RunBrowser }) {
  // Each viewer gets an iframe of its own (a new session is a new page); the key is a count, never the viewer itself.
  const session = useRef({ viewer: "", n: 0 });
  if (browser.state === "live" && browser.viewer !== session.current.viewer) session.current = { viewer: browser.viewer, n: session.current.n + 1 };
  return (
    <section aria-label="Browser" className="border">
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <Globe className="size-4 text-muted-foreground" aria-hidden />
        <span className="caps flex-1 text-[12px] font-semibold">{browser.state === "live" ? "Live" : "Browser"}</span>
        {/* Take over and hand back go here. */}
        <div data-browser-actions className="flex items-center gap-2" />
      </header>
      {/* What the agent waits on in the browser ("Waiting for you: …") goes here. */}
      {browser.state === "live"
        ? <iframe key={session.current.n} src={browser.viewer} title="The run's browser" referrerPolicy="no-referrer" className="block aspect-[16/10] w-full bg-background" />
        : <p className="px-4 py-12 text-center font-mono text-[13px] text-muted-foreground">Waiting for the browser. The agent's page shows here once it opens one.</p>}
    </section>
  );
}
