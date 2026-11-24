import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ShareBundle, ShareLoad, ShareSource } from "./bundle";
import { ShareView } from "./ShareView";

/** Why a read of the bundle failed, said for a person, and what to do. None of it is the server's words or the run's:
 *  a page that failed shows nothing of the run. */
function refusal(status: number, runId: string): { title: string; why: string } {
  switch (status) {
    case 0: return { title: "Can't reach agentrun-serve.", why: "It may be restarting. Try again in a moment." };
    case 400: return { title: "The server refused the restore.", why: "A cut it names is not restorable, or is not in this run's bundle. Nothing was restored." };
    case 401: return { title: "This browser is not signed in to this server.", why: "Open the console at this address, sign in, then open this page again." };
    case 403: return { title: "This run is withheld.", why: "This server can't read back a sign-in the run was handed, so nothing of the run is exported." };
    case 404: return { title: `This server has no run ${runId}.`, why: "Check the run id in the address." };
    case 409: return { title: "This run hasn't ended.", why: "A run can be shared once it has ended. Open this page again then." };
    case 413: return { title: "This run is too large to share.", why: "Its bundle is over 8 MiB. Nothing of it is cut short, so it does not export." };
    default: return { title: "The export failed closed.", why: "Nothing of the run is shown, and nothing was sent. The server's log says why." };
  }
}

/** Why a share host's read of a share failed, for whoever opened its link. */
function hostedRefusal(status: number): { title: string; why: string } {
  switch (status) {
    case 0: return { title: "Can't reach this share host.", why: "Try again in a moment." };
    case 404: return { title: "There is no share at this address.", why: "Check the link you were given." };
    case 410: return { title: "This share was deleted.", why: "Its owner deleted it, and nothing of it is kept here." };
    default: return { title: "This share can't be shown.", why: "Try again in a moment." };
  }
}

/** A share host's public page of one share (/r/<id>): its stored bundle, read once, drawn by ShareView with no cuts panel
 *  and no publish command. A refusal shows nothing of the run. */
export function HostedSharePage({ source }: { source: ShareSource }) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<ShareLoad | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setLoad(null);
    source.load([], abort.signal).then(setLoad, (error: unknown) => {
      if ((error as Error)?.name !== "AbortError") setLoad({ ok: false, status: 0 });
    });
    return () => abort.abort();
  }, [source, attempt]);
  if (!load) return <main className="flex min-h-dvh items-center justify-center"><p className="font-mono text-body text-muted-foreground" role="status">Loading the share…</p></main>;
  if (load.ok) return <ShareView bundle={load.bundle} />;
  const { title, why } = hostedRefusal(load.status);
  return (
    <main className="flex min-h-dvh items-start justify-center px-5 py-16">
      <section className="flex max-w-xl gap-3 border bg-card px-5 py-4" role="alert">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive-text" aria-hidden />
        <div className="min-w-0">
          <p className="caps text-label text-muted-foreground">AgentRun · shared run</p>
          <p className="mt-2 text-prose font-semibold">{title}</p>
          <p className="mt-1 text-lead leading-relaxed">{why}</p>
          {load.status !== 404 && load.status !== 410 && (
            <div className="mt-3"><Button type="button" size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button></div>
          )}
        </div>
      </section>
    </main>
  );
}

/** The owner's share preview of one run: its export, drawn by ShareView; each restore switch exports it again with the
 *  ids switched on (the server keeps those cuts' values in place), so the page always shows the bundle the server made.
 *  Any refusal takes the run off the page: an earlier bundle is not the one that would ship. */
export function SharePage({ source, runId }: { source: ShareSource; runId: string }) {
  const [restore, setRestore] = useState<readonly string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [bundle, setBundle] = useState<ShareBundle | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const [pending, setPending] = useState(true);
  const current = useRef(0);
  useEffect(() => {
    const read = ++current.current;
    const abort = new AbortController();
    setPending(true);
    const settle = (load: ShareLoad) => {
      if (read !== current.current) return;
      setPending(false);
      if (load.ok) { setBundle(load.bundle); setFailed(null); }
      else { setBundle(null); setFailed(load.status); }
    };
    source.load(restore, abort.signal).then(settle, (error: unknown) => {
      if ((error as Error)?.name !== "AbortError") settle({ ok: false, status: 0 });
    });
    return () => abort.abort();
  }, [source, restore, attempt]);

  if (failed !== null) {
    const { title, why } = refusal(failed, runId);
    return (
      <main className="flex min-h-dvh items-start justify-center px-5 py-16">
        <section className="flex max-w-xl gap-3 border bg-card px-5 py-4" role="alert">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive-text" aria-hidden />
          <div className="min-w-0">
            <p className="caps text-label text-muted-foreground">AgentRun · share preview</p>
            <p className="mt-2 text-prose font-semibold">{title}</p>
            <p className="mt-1 text-lead leading-relaxed">{why}</p>
            <div className="mt-3 flex flex-wrap gap-3">
              {failed === 400
                ? <Button type="button" size="sm" onClick={() => setRestore([])}>Start again with every cut in place</Button>
                : <Button type="button" size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}
            </div>
          </div>
        </section>
      </main>
    );
  }
  if (!bundle) return <main className="flex min-h-dvh items-center justify-center"><p className="font-mono text-body text-muted-foreground" role="status">Exporting the run…</p></main>;
  const onToggle = (id: string, on: boolean) => setRestore((ids) => (on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id)));
  return <ShareView bundle={bundle} preview={{ runId, onToggle, pending }} />;
}
