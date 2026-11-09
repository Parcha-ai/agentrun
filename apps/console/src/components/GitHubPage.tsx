import { Github } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Client, ClientError } from "@/lib/client";
import { githubFormAction, type GitHubReturn, githubReturnWords } from "@/lib/github";
import { httpHref } from "@/lib/safeUrl";
import { cn } from "@/lib/utils";
import type { GitHubConnection, GitHubDisconnected } from "@/lib/v2";

/** A disconnect's note, its trailing URL a link through httpHref ("Delete the App itself on GitHub: <URL>"); the whole
 *  note as plain text when that part is no http(s) URL. */
function Note({ note }: { note: string }) {
  const at = note.lastIndexOf(": ");
  const tail = at >= 0 ? note.slice(at + 2).trim() : "";
  const href = tail ? httpHref(tail) : undefined;
  if (!href) return <>{note}</>;
  return <>{note.slice(0, at + 2)}<a href={href} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">{tail}</a></>;
}

/** Settings → GitHub: this server's one GitHub App (GET /v2/integrations/github: `{connected: false}` when none).
 *  Connect starts one: the server answers where the browser posts the App's manifest (`action`, on github.com, carrying
 *  ?state=), and the page posts it there, once. Connected, it shows the App and the accounts it is installed on, and
 *  Disconnect deletes it here (every GitHub trigger turns off) and says what to delete on GitHub. `returned`: what the
 *  way back from GitHub said (#/settings/github?github=…), said once in words and taken off the address. */
export function GitHubPage({ v2, returned }: { v2: Client; returned?: GitHubReturn }) {
  // undefined until read; null: not connected.
  const [connection, setConnection] = useState<GitHubConnection | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  // The form to GitHub, once the start is in: the browser leaves with it.
  const [opening, setOpening] = useState<{ action: string; manifest: string } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // A wrong-origin refusal's public URL, as the server serves it (details.public_url): never read from the words.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [disconnected, setDisconnected] = useState<GitHubDisconnected | null>(null);
  // One start per click run: a second click before the first answers sends nothing.
  const starting = useRef(false);
  const form = useRef<HTMLFormElement>(null);

  const read = useCallback(async () => {
    // Always a 200: `connected` says whether there is an App, never a 404.
    try { const status = await v2.githubConnection(); setConnection(status.connected ? status : null); setLoadError(null); }
    catch (e) { setLoadError(e instanceof Error ? e.message : String(e)); }
  }, [v2]);
  useEffect(() => { void read(); }, [read]);
  // The way back from GitHub is said here once; the address keeps no query.
  useEffect(() => { if (returned) history.replaceState(null, "", `${location.pathname}${location.search}#/settings/github`); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (opening) form.current?.submit(); }, [opening]);

  const connect = async () => {
    if (starting.current) return;
    starting.current = true;
    setBusy(true); setSaid(null); setOpenAt(null); setDisconnected(null);
    try {
      const start = await v2.connectGitHub(org.trim() || undefined);
      const action = githubFormAction(start.action, httpHref);
      if (!action) { setSaid("GitHub's address didn't look right, so nothing was sent."); starting.current = false; setBusy(false); return; }
      // The manifest alone: `action` carries the state.
      setOpening({ action, manifest: JSON.stringify(start.manifest) });
    } catch (e) {
      starting.current = false; setBusy(false);
      setSaid(e instanceof Error ? e.message : String(e));
      // Started on another host than the public URL: link the one the server serves, through httpHref.
      if (e instanceof ClientError && e.code === "github_wrong_origin") {
        const served = e.details?.public_url;
        setOpenAt((typeof served === "string" && httpHref(served)) || null);
      }
      // Already connected: show the App this server has.
      if (e instanceof ClientError && e.code === "github_already_connected") void read();
    }
  };

  const disconnect = async () => {
    setConfirming(false); setBusy(true); setSaid(null); setOpenAt(null);
    try { setDisconnected(await v2.disconnectGitHub()); setConnection(null); }
    catch (e) {
      // Not connected (any more; another tab may have disconnected it): the status read again says so, no error.
      if (e instanceof ClientError && (e.status === 404 || e.code === "github_not_connected")) await read();
      else setSaid(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const appHref = connection ? httpHref(`https://github.com/apps/${encodeURIComponent(connection.slug)}`) : undefined;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <div>
          <p className="caps text-[11px] text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">GitHub</h1>
          <p className="mt-2 text-[14px] text-muted-foreground">One GitHub App for this server: its templates and triggers reach GitHub through it.</p>
        </div>
        {returned && (
          <p aria-label="From GitHub" role="status" className={cn("border p-4 text-[14px]", returned.ok ? "border-success/50 bg-success/5" : "border-warning/50 bg-warning/5 text-warning-text")}>{githubReturnWords(returned)}</p>
        )}
        {(said || openAt) && (
          <div role="alert" className="border border-destructive/50 px-4 py-3 text-[14px] text-destructive-text">
            {/* A wrong-origin refusal is one line, the linked one: the server's words say the same thing unlinked. */}
            {openAt ? <p>Open this server at <a href={openAt} className="break-all underline underline-offset-2">{openAt}</a> to connect GitHub.</p> : <p>{said}</p>}
          </div>
        )}
        {disconnected && (
          <section aria-label="Disconnected" className="border p-4 text-[14px]">
            <p><Note note={disconnected.note} /></p>
            <p className="mt-1 text-muted-foreground">{disconnected.triggers_off ? `${disconnected.triggers_off} GitHub ${disconnected.triggers_off === 1 ? "trigger" : "triggers"} turned off.` : "No GitHub trigger was on."}</p>
          </section>
        )}
        {loadError && (
          <div role="alert" className="border p-4">
            <p className="font-mono text-[13px] text-destructive-text">GitHub's connection could not be read: {loadError}</p>
            <button type="button" onClick={() => void read()} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>
          </div>
        )}
        {connection === undefined && !loadError && <p className="font-mono text-[13px] text-muted-foreground">Loading...</p>}
        {connection === null && (
          <section aria-label="Connect GitHub" className="border bg-card p-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[13px]">
                <span className="text-muted-foreground">Organization (optional): the App is made under it</span>
                <input name="org" value={org} onChange={(e) => setOrg(e.target.value)} disabled={busy} placeholder="your-org" className="h-9 border bg-background px-3 font-mono text-[13px]" />
              </label>
              <Button type="button" variant="solid" onClick={() => void connect()} disabled={busy}><Github aria-hidden />{opening ? "Opening GitHub…" : "Connect GitHub"}</Button>
            </div>
            <p className="mt-3 text-[13px] text-muted-foreground">GitHub asks you to create the App, then to install it on the accounts it may use. You come back here after.</p>
          </section>
        )}
        {connection && (
          <section aria-label="GitHub App" className="border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <Github className="size-4 text-muted-foreground" aria-hidden />
              {appHref ? <a href={appHref} target="_blank" rel="noopener noreferrer" className="font-mono underline underline-offset-2">{connection.slug}</a> : <span className="font-mono">{connection.slug}</span>}
              <span className="font-mono text-[12px] text-muted-foreground">App {connection.app_id}</span>
            </div>
            {connection.installations.length
              ? <ul aria-label="Installations" className="mt-3 space-y-1 font-mono text-[13px]">{connection.installations.map((i) => <li key={i.id}>{i.account}</li>)}</ul>
              : <p className="mt-3 text-[13px] text-muted-foreground">Not installed on any account yet.</p>}
            {!confirming
              ? <Button type="button" variant="outline" className="mt-4" disabled={busy} onClick={() => setConfirming(true)}>Disconnect</Button>
              : (
                <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]" role="alertdialog" aria-label="Disconnect GitHub?">
                  <span>Disconnect GitHub? Every GitHub trigger turns off.</span>
                  <Button type="button" variant="destructive" disabled={busy} onClick={() => void disconnect()}>Disconnect GitHub</Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
                </div>
              )}
          </section>
        )}
        {opening && (
          <form data-github-manifest ref={form} method="post" action={opening.action} hidden>
            <input type="hidden" name="manifest" defaultValue={opening.manifest} />
          </form>
        )}
      </div>
    </div>
  );
}
