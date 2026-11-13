import { RefreshCw, WifiOff } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import type { Connection, Link } from "@/lib/connection";

const ConnectionContext = createContext<Connection | null>(null);

/** Gives the pages under it the console's link to its server (the banner, a page that reads again on its return). */
export function ConnectionProvider({ connection, children }: { connection: Connection; children: ReactNode }) {
  return <ConnectionContext.Provider value={connection}>{children}</ConnectionContext.Provider>;
}

const ONLINE: Link = { state: "online" };
const never = () => () => {};
const online = () => ONLINE;

/** The link to the server, live; online where no connection is given (a component alone, in a test or a story). */
export function useLink(): Link {
  const c = useContext(ConnectionContext);
  // A page rendered to a string (a story's check) is online.
  return useSyncExternalStore(c ? c.subscribe : never, c ? c.link : online, online);
}

/** Calls `fn` each time the server is back after being away, so a page reads again what may have moved meanwhile. */
export function useResumed(fn: () => void) {
  const c = useContext(ConnectionContext);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => c?.onResume(() => latest.current()), [c]);
}

/** Seconds until the next probe, counted down while away. */
function useSecondsTo(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  return at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000));
}

/** The console's one word on its link, above every page: while the server can't be reached, "Reconnecting" with the
 *  next try and Retry now, over the page as it was; once back, "Resumed" for a few seconds (the server is back; the page's
 *  own reads say when they land). Nothing while online. */
export function ConnectionBanner() {
  const c = useContext(ConnectionContext);
  const link = useLink();
  const secs = useSecondsTo(link.state === "offline" ? link.retryAt : null);
  if (!c || link.state === "online") return null;
  if (link.state === "resumed") return (
    <Banner bar tone="success" icon={RefreshCw} data-connection="resumed"><span className="font-semibold">Resumed.</span> agentrun-serve is back.</Banner>
  );
  return (
    <Banner bar tone="warning" icon={WifiOff} data-connection="offline" actions={<Button type="button" onClick={c.retryNow} size="xs">Retry now</Button>}>
      <span className="font-semibold">Can't reach agentrun-serve at {location.host}.</span> Reconnecting… next try in {secs} s. The page shows what it had.
    </Banner>
  );
}

/** The whole page while the server can't be reached before the console knows who is signed in: never the password page
 *  (a password typed here would go nowhere), and it carries on by itself once the server answers. */
export function Unreached() {
  const c = useContext(ConnectionContext);
  const link = useLink();
  const secs = useSecondsTo(link.state === "offline" ? link.retryAt : null);
  return (
    <div data-connection="offline" role="status" className="mx-auto mt-[12vh] max-w-md border bg-card p-6">
      <WifiOff className="size-5 text-warning-text" aria-hidden />
      <p className="mt-3 text-base font-semibold">Can't reach agentrun-serve at {location.host}.</p>
      <p className="mt-2 text-lead leading-relaxed text-muted-foreground">Is it running? This page connects by itself as soon as the server answers.</p>
      <div className="mt-4 flex items-center gap-3">
        <Button type="button" onClick={c?.retryNow} size="sm">Retry now</Button>
        <span className="font-mono text-small text-muted-foreground">Next try in {secs} s</span>
      </div>
    </div>
  );
}
