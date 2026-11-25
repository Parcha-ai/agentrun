import { ArrowRight, ArrowUpRight, Check, Circle, FileCode, GitPullRequest, Github, RefreshCw, ScanSearch, Sparkles, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { ListSkeleton } from "@/components/Skeleton";
import { Banner, Button, buttonVariants, Checkbox, Chip, Dialog, Field, Input, Picker, Spinner, useToast } from "@/components/ui";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import { type Client, ClientError } from "@/lib/client";
import { githubFormAction, githubOrgOf } from "@/lib/github";
import { type Problem, problem } from "@/lib/problem";
import { httpHref } from "@/lib/safeUrl";
import { agentVariable, IMPACT, keepReturn, LANGUAGE, permissionLabel, readinessWords, repoHref, same, scanLine, scanning, suggestionsHash, TIER } from "@/lib/suggestions";
import { cn } from "@/lib/utils";
import type { Agent, GitHubRepository, ScannedRepository, Suggestion, SuggestionCreated, SuggestionDetail, SuggestionsList } from "@/lib/v2";
import { agentHarness, HarnessIcon } from "@/components/HarnessIcon";
import { harnessLabel } from "@/lib/agentForm";
import { when } from "@/lib/format";

/** How often the page reads the list again while a scan runs. */
const SCAN_POLL_MS = 3_000;
const link = "underline underline-offset-2 hover:text-foreground";

/** Suggested agents: connect a GitHub repository, scan it for places its app needs an agent, then create (a pull request
 *  that adds the agent, and the agent made here) or discard each suggestion. `repo`: the repository the address names,
 *  shown first and picked in the scan box. */
export function SuggestionsPage({ v2, repo, go }: { v2: Client; repo?: string; go: (hash: string) => void }) {
  const [list, setList] = useState<SuggestionsList | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  const [creating, setCreating] = useState<Suggestion | null>(null);
  // The last discard, said with an undo until the next decision.
  const [discarded, setDiscarded] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Each Refresh: the suggestions and the App's repositories read again (a repository added on GitHub shows up).
  const [round, setRound] = useState(0);
  const toast = useToast();

  // Each read is numbered by when it started, and sets the page unless a newer read has already answered: an older read
  // that answers last (a Refresh before a scan started) never puts back a list the newer one replaced, and polls slower
  // than their interval still show what each answers.
  const reads = useRef({ started: 0, shown: 0 });
  const read = useCallback(async () => {
    const mine = ++reads.current.started;
    try {
      const next = await v2.listSuggestions();
      if (mine > reads.current.shown) { reads.current.shown = mine; setList(next); setError(null); }
    } catch (e) { if (mine > reads.current.shown) setError(problem(e, "the suggested agents")); }
  }, [v2]);
  useEffect(() => { void read(); }, [read, tries]);
  // While a scan runs, its answer is read again until it ends.
  const running = list ? scanning(list.repositories) : false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void read(), SCAN_POLL_MS);
    return () => clearInterval(timer);
  }, [running, read]);

  const discard = async (s: Suggestion) => {
    setBusy(s.id);
    // Gone from the page at once; back if the server refuses.
    setList((l) => l && { ...l, suggestions: l.suggestions.filter((x) => x.id !== s.id) });
    try { await v2.discardSuggestion(s.id); setDiscarded(s); }
    catch (e) { toast({ tone: "error", title: `${s.title} was not discarded`, description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); void read(); }
  };
  const undo = async (s: Suggestion) => {
    setBusy(s.id);
    try { await v2.restoreSuggestion(s.id); setDiscarded(null); await read(); }
    catch (e) { toast({ tone: "error", title: `${s.title} was not brought back`, description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  };

  const body = error && !list ? <ProblemCard problem={error} onRetry={() => setTries((n) => n + 1)} className="" />
    : !list ? <ListSkeleton label="Loading the suggested agents" rows={3} />
    : !list.github.connected ? <ConnectGitHub v2={v2} />
    : (
      <div className="space-y-6">
        {!list.github.installations.length && <InstallApp url={list.github.install_url} onCheck={() => setTries((n) => n + 1)} />}
        {list.github.installations.length > 0 && <ScanBox v2={v2} repo={repo} round={round} scanned={list.repositories} onStarted={(r) => { go(suggestionsHash(r)); void read(); }} />}
        {discarded && (
          <div role="status" className="flex flex-wrap items-center gap-3 border bg-card px-4 py-2.5 text-body">
            <span className="min-w-0 flex-1">Discarded <span className="font-semibold">{discarded.title}</span>. Later scans of {discarded.repo} leave it out.</span>
            <Button size="xs" onClick={() => void undo(discarded)} disabled={busy === discarded.id}>Undo</Button>
            <Button size="icon" variant="ghost" aria-label="Dismiss" onClick={() => setDiscarded(null)}><X aria-hidden /></Button>
          </div>
        )}
        {[...list.repositories].sort((a, b) => (same(a.repo, repo) ? -1 : same(b.repo, repo) ? 1 : 0)).map((r) => (
          <RepositorySection key={r.repo} v2={v2} r={r} round={round} suggestions={list.suggestions.filter((s) => same(s.repo, r.repo))} busy={busy}
            onDiscard={(s) => void discard(s)} onCreate={(s) => { setDiscarded(null); setCreating(s); }} onScanned={() => void read()} />
        ))}
      </div>
    );

  return (
    <section className="flex min-h-full flex-col roomy:h-full roomy:min-h-0">
      <header className={cn(pageToolbarClass, "flex-wrap gap-2 px-5 md:px-6")}>
        <h1 className={pageTitleClass}><Sparkles className="size-4" aria-hidden />Suggested agents</h1>
        {list && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setRound((n) => n + 1); void read(); }} aria-label="Read the suggestions and repositories again"><RefreshCw aria-hidden />Refresh</Button>}
      </header>
      <div className="roomy:min-h-0 roomy:flex-1 roomy:overflow-auto"><div className="p-5 md:p-6">{body}</div></div>
      {creating && <CreateDialog v2={v2} suggestion={creating} onClose={() => setCreating(null)} onCreated={() => void read()} go={go} />}
    </section>
  );
}

/** Not connected yet: what this page does, what it asks of GitHub, and Connect GitHub (the App's manifest posted to
 *  GitHub, which sends the browser back to Settings → GitHub, and from there here). */
function ConnectGitHub({ v2 }: { v2: Client }) {
  const [org, setOrg] = useState("");
  const [write, setWrite] = useState(true);
  const [opening, setOpening] = useState<{ action: string; manifest: string } | null>(null);
  const [said, setSaid] = useState<{ text: string; openAt?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (opening) form.current?.submit(); }, [opening]);
  const connect = async () => {
    if (busy) return;
    // A pasted github.com address or @name is its login; anything else is said here, and nothing is sent.
    const typed = githubOrgOf(org);
    if (typed.problem) { setSaid({ text: typed.problem }); return; }
    setBusy(true); setSaid(null);
    try {
      const start = await v2.connectGitHub(typed.org, write ? "write" : undefined);
      const action = githubFormAction(start.action, httpHref);
      if (!action) { setSaid({ text: "GitHub's address didn't look right, so nothing was sent." }); setBusy(false); return; }
      keepReturn("#/suggestions");
      setOpening({ action, manifest: JSON.stringify(start.manifest) });
    } catch (e) {
      setBusy(false);
      const served = e instanceof ClientError && e.code === "github_wrong_origin" ? httpHref(String(e.details?.public_url ?? "")) : undefined;
      setSaid({ text: e instanceof Error ? e.message : String(e), ...(served ? { openAt: served } : {}) });
    }
  };
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section aria-labelledby="connect-title" className="border bg-card p-5">
        <h2 id="connect-title" className="text-xl font-semibold">Find where agents fit in your app</h2>
        <p className="mt-2 max-w-prose text-lead text-muted-foreground">
          Connect a GitHub repository. AgentRun reads its code on a read-only copy and suggests agents your app could call, each with the lines of code that show why. You decide each one: create it, and a pull request adds the agent to your repository; or discard it.
        </p>
        <ol className="mt-5 space-y-3 text-body">
          {[["Connect GitHub", "AgentRun makes a GitHub App that you own, and you install it on the repositories it may read."], ["Scan a repository", "An agent reads the default branch and answers up to five suggestions. It never runs your code."], ["Create or discard", "Create opens a pull request that only adds files: the agent's package and a small client. Discard hides it for good."]].map(([title, words], i) => (
            <li key={title} className="flex gap-3">
              <span className="caps flex size-6 shrink-0 items-center justify-center border text-label" aria-hidden>{i + 1}</span>
              <span><span className="font-semibold">{title}.</span> <span className="text-muted-foreground">{words}</span></span>
            </li>
          ))}
        </ol>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <Field label="Organization" optional note="The App is made under it; leave it empty for your own account." className="min-w-[240px] flex-1">
            <Input value={org} onChange={(e) => setOrg(e.target.value)} disabled={busy} placeholder="your-org or github.com/your-org" />
          </Field>
        </div>
        <Checkbox className="mt-4" checked={write} onChange={(e) => setWrite(e.target.checked)} disabled={busy}
          label="Let AgentRun open pull requests for the agents you create"
          note="Asks GitHub for Contents: Read and write. Without it you can still scan; Create will ask you to add it." />
        {said && (
          <p role="alert" className="mt-4 border border-destructive/50 px-4 py-3 text-body text-destructive-text">
            {said.openAt ? <>Open this server at <a href={said.openAt} className="break-all underline underline-offset-2">{said.openAt}</a> to connect GitHub.</> : said.text}
          </p>
        )}
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => void connect()} disabled={busy} aria-busy={busy || undefined}><Github aria-hidden />{opening ? "Opening GitHub…" : "Connect GitHub"}</Button>
        </div>
        {opening && (
          <form ref={form} method="post" action={opening.action} hidden>
            <input type="hidden" name="manifest" defaultValue={opening.manifest} />
          </form>
        )}
      </section>
      <Permissions write={write} />
    </div>
  );
}

/** What the GitHub App asks for, and why each. */
function Permissions({ write }: { write: boolean }) {
  const rows: [string, string, string][] = [
    ["Metadata", "Read-only", "List the repositories you install it on."],
    ["Contents", write ? "Read and write" : "Read-only", write ? "Read the code to scan it; push one new branch for each agent you create." : "Read the code to scan it."],
    ["Pull requests", "Read and write", "Open the pull request for each agent you create. Code review uses it too."],
    ["Issues", "Read-only", "Read issues the release-notes template links."],
  ];
  return (
    <aside aria-labelledby="permissions-title" className="border p-5">
      <h2 id="permissions-title" className="caps text-small font-semibold">What GitHub is asked for</h2>
      <dl className="mt-3 divide-y text-body">
        {rows.map(([name, level, why]) => (
          <div key={name} className="py-2.5">
            <dt className="flex flex-wrap items-center gap-2"><span className="font-semibold">{name}</span><Chip tone={level === "Read and write" ? "warning" : "muted"}>{level}</Chip></dt>
            <dd className="mt-1 text-muted-foreground">{why}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-small text-muted-foreground">Each scan reads with a token for that one repository, contents read-only, revoked after. Each create writes with a token for that one repository, revoked after. The agents never hold a GitHub token.</p>
    </aside>
  );
}

/** Connected, installed nowhere yet. */
function InstallApp({ url, onCheck }: { url: string | null; onCheck: () => void }) {
  const href = httpHref(url);
  return (
    <section aria-label="Install the GitHub App" className="border border-warning/50 bg-warning/5 p-4">
      <p className="caps text-label text-warning-text">One step left</p>
      <p className="mt-1 text-lead">Install the GitHub App on the accounts and repositories it may read. Pick only the repositories you want scanned.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {href && <a href={href} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "sm", variant: "primary" })}><Github aria-hidden />Install on GitHub<ArrowUpRight aria-hidden /></a>}
        <Button size="sm" onClick={onCheck}>Check again</Button>
      </div>
    </section>
  );
}

/** Pick a repository the App is installed on and scan it. Before any scan it is the page's first step, said whole; after,
 *  it offers only the repositories not scanned yet (each scanned one has its own Scan again), and says so when none is
 *  left. */
function ScanBox({ v2, repo, round = 0, scanned, onStarted }: { v2: Client; repo?: string; round?: number; scanned: readonly ScannedRepository[]; onStarted: (repo: string) => void }) {
  const [repos, setRepos] = useState<GitHubRepository[] | null>(null);
  // GitHub listed only part of what the App covers (past the limit, or an installation it did not list): a repository
  // can still be typed.
  const [partial, setPartial] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [picked, setPicked] = useState(repo ?? "");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    v2.githubRepositories().then((r) => { if (live) { setRepos(r.repositories); setPartial(r.truncated === true || (r.unread ?? []).length > 0); setListError(null); } }, (e) => { if (live) setListError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [v2, round]);
  const first = !scanned.length;
  const left = (repos ?? []).filter((r) => !scanned.some((s) => same(s.repo, r.full_name)));
  // The pick stays one of the repositories offered: the address's, else the first not scanned.
  const choice = left.some((r) => r.full_name === picked) ? picked : left[0]?.full_name ?? "";
  // A typed name counts only while its field is shown: a Refresh that lists the whole App hides it, and the pick stands.
  const typing = !left.length || partial;
  const target = (typing ? typed.trim() : "") || (left.length ? choice : "");
  const scan = async () => {
    if (!target) return;
    setBusy(true); setSaid(null);
    try { const started = await v2.scanRepository(target); onStarted(started.repo); }
    catch (e) { setSaid(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  // Scanned all the App covers: one line, no form.
  if (!first && repos && !listError && !partial && !left.length) {
    return <p className="text-small text-muted-foreground">Every repository the GitHub App is installed on is scanned. To scan another, add it to the App's installation on GitHub, then refresh.</p>;
  }
  const typedField = (label: string, note: string) => (
    <Field label={label} note={note} className="min-w-[260px] flex-1">
      <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="owner/name" />
    </Field>
  );
  const control = repos === null && !listError
    ? <p className="flex min-h-control-md items-center gap-2 text-body text-muted-foreground"><Spinner />Reading the repositories the App is installed on…</p>
    : left.length
      ? <>
          <div className="min-w-[260px] flex-1"><Picker label="Repository" value={choice} onChange={setPicked} options={left.map((r) => ({ value: r.full_name, label: r.full_name, ...(r.private ? { tag: "private" } : {}) }))} /></div>
          {partial && typedField("Or type one", "GitHub listed only some of the App's repositories. A name typed here is scanned instead.")}
        </>
      : typedField("Repository", listError ? `The App's repositories could not be listed (${listError}). Type one it is installed on.` : partial ? "GitHub listed only some of the App's repositories: type one it is installed on." : "The App covers no repository yet: add one to its installation on GitHub, or type a public one.");
  const button = <Button variant={first ? "primary" : "outline"} size="md" onClick={() => void scan()} disabled={!target || busy} aria-busy={busy || undefined}><ScanSearch aria-hidden />{busy ? "Starting…" : "Scan repository"}</Button>;
  if (!first) {
    return (
      <section aria-label="Scan another repository" className="flex flex-wrap items-end gap-2">
        <span className="caps w-full text-small font-semibold text-muted-foreground">Scan another repository</span>
        {control}{button}
        {said && <p role="alert" className="w-full text-body text-destructive-text">{said}</p>}
      </section>
    );
  }
  return (
    <section aria-labelledby="scan-title" className="border bg-card p-5">
      <h2 id="scan-title" className="text-xl font-semibold">Scan a repository</h2>
      <p className="mt-2 max-w-prose text-lead text-muted-foreground">An agent reads the default branch on a read-only copy: the README, the layout, then the code where people or brittle rules judge text by hand. It suggests up to five agents your app could call, each with the lines that show why.</p>
      <div className="mt-4 flex flex-wrap items-end gap-2">{control}{button}</div>
      {said && <p role="alert" className="mt-2 text-body text-destructive-text">{said}</p>}
      <ul className="mt-4 grid gap-2 text-small text-muted-foreground md:grid-cols-3">
        <li className="border px-3 py-2"><span className="font-semibold text-foreground">Read-only.</span> A token for that one repository, contents read, revoked after. Your code never runs.</li>
        <li className="border px-3 py-2"><span className="font-semibold text-foreground">A few minutes.</span> One run of the agent-scout template, capped at $3. You can watch it.</li>
        <li className="border px-3 py-2"><span className="font-semibold text-foreground">Nothing is written.</span> Only Create writes: one new branch and a pull request, for the suggestion you pick.</li>
      </ul>
    </section>
  );
}

/** One scanned repository: its scan, its open suggestions and the ones created. */
function RepositorySection({ v2, r, suggestions, busy, onDiscard, onCreate, onScanned, round = 0 }: { v2: Client; r: ScannedRepository; suggestions: Suggestion[]; busy: string | null; onDiscard: (s: Suggestion) => void; onCreate: (s: Suggestion) => void; onScanned: () => void; round?: number }) {
  const open = suggestions.filter((s) => s.status === "open");
  const created = suggestions.filter((s) => s.status === "created");
  const [rescanning, setRescanning] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const rescan = async () => {
    setRescanning(true); setSaid(null);
    try { await v2.scanRepository(r.repo); onScanned(); } catch (e) { setSaid(e instanceof Error ? e.message : String(e)); } finally { setRescanning(false); }
  };
  const headingId = `repo-${r.repo.replace(/[^A-Za-z0-9]/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-2">
        <h2 id={headingId} className="flex min-w-0 items-center gap-2 text-lg font-semibold">
          <Github className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <a href={repoHref(r.repo)} target="_blank" rel="noopener noreferrer" className="min-w-0 break-all font-mono underline-offset-2 hover:underline">{r.repo}</a>
        </h2>
        <span className="font-mono text-small text-muted-foreground">{scanLine(r)}</span>
        {r.scan.commit && <span className="font-mono text-small text-muted-foreground">at {r.scan.commit.slice(0, 7)}</span>}
        <span className="ml-auto flex items-center gap-2">
          <a href={`#/runs/${encodeURIComponent(r.scan.run_id)}`} className={cn("text-small text-muted-foreground", link)}>{r.scan.status === "running" ? "Watch the scan" : "The scan's run"}</a>
          {r.scan.status !== "running" && <Button size="sm" onClick={() => void rescan()} disabled={rescanning}><RefreshCw aria-hidden />{rescanning ? "Starting…" : "Scan again"}</Button>}
        </span>
      </div>
      {said && <p role="alert" className="text-body text-destructive-text">{said}</p>}
      {r.scan.app && <p className="text-lead text-muted-foreground">{r.scan.app}</p>}
      {r.scan.status === "running" && (
        <p role="status" className="flex items-center gap-2 border px-4 py-6 text-body text-muted-foreground"><Spinner />Reading {r.repo}: its README, its layout, then the code where language is judged by hand. This page updates by itself.</p>
      )}
      {(r.scan.status === "failed" || r.scan.status === "cancelled") && (
        <Banner tone="error" title={r.scan.status === "failed" ? "The scan failed" : "The scan was cancelled"} actions={<Button size="xs" onClick={() => void rescan()} disabled={rescanning}>Scan again</Button>}>
          {r.scan.error && <p className="font-mono">{r.scan.error}</p>}
        </Banner>
      )}
      {r.scan.dropped.length > 0 && (
        <details className="text-small text-muted-foreground">
          <summary className="cursor-pointer">{r.scan.dropped.length} {r.scan.dropped.length === 1 ? "suggestion was" : "suggestions were"} left out because {r.scan.dropped.length === 1 ? "it" : "they"} did not check</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono">{r.scan.dropped.map((d) => <li key={d}>{d}</li>)}</ul>
        </details>
      )}
      {r.scan.status === "completed" && !open.length && !created.length && (
        <p className="border px-4 py-8 text-center text-body text-muted-foreground">No open suggestion for {r.repo}. {r.counts.discarded ? `${r.counts.discarded} discarded. ` : ""}Scan again after the code changes.</p>
      )}
      {open.length > 0 && (
        <ul aria-label={`Suggestions for ${r.repo}`} className="grid gap-3 xl:grid-cols-2">
          {/* min-w-0: a grid item is as wide as its widest line of code otherwise, and the page would scroll sideways. */}
          {open.map((s) => <li key={s.id} className="min-w-0"><SuggestionCard s={s} busy={busy === s.id} onDiscard={() => onDiscard(s)} onCreate={() => onCreate(s)} /></li>)}
        </ul>
      )}
      {created.length > 0 && <CreatedSection v2={v2} repo={r.repo} created={created} onRetry={onCreate} round={round} />}
    </section>
  );
}

/** One open suggestion: what it does, why here (with the lines), what it takes and answers, where it is called, and its
 *  two actions. */
function SuggestionCard({ s, busy, onDiscard, onCreate }: { s: Suggestion; busy: boolean; onDiscard: () => void; onCreate: () => void }) {
  const impact = IMPACT[s.impact];
  const site = httpHref(s.integration.call_site.url);
  return (
    <article aria-label={s.title} className="flex h-full min-w-0 flex-col border bg-card px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 break-words text-prose font-semibold">{s.title}</h3>
        <Chip tone={impact.tone}>{impact.label}</Chip>
      </div>
      <p className="mt-1.5 text-lead">{s.summary}</p>
      <p className="mt-3 text-body text-muted-foreground"><span className="font-semibold text-foreground">Why here. </span>{s.why}</p>
      <ul aria-label="Evidence" className="mt-3 space-y-2">
        {s.evidence.map((e) => {
          const href = httpHref(e.url);
          return (
            <li key={`${e.path}:${e.line}`}>
              {href ? <a href={href} target="_blank" rel="noopener noreferrer" className={cn("font-mono text-small text-muted-foreground", link)}>{e.path}:{e.line}</a> : <span className="font-mono text-small text-muted-foreground">{e.path}:{e.line}</span>}
              <pre tabIndex={0} role="region" aria-label={`${e.path} line ${e.line}`} className="mt-1 overflow-x-auto bg-muted px-3 py-1.5 font-mono text-small"><code>{e.quote}</code></pre>
            </li>
          );
        })}
      </ul>
      <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-small sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="caps text-label text-muted-foreground">Takes</dt>
        <dd className="break-words font-mono">{s.agent.inputs.map((f) => `${f.name}${f.required ? "" : "?"}`).join(", ")}</dd>
        <dt className="caps text-label text-muted-foreground">Answers</dt>
        <dd className="break-words font-mono">{s.agent.output.map((f) => f.name).join(", ")}</dd>
        <dt className="caps text-label text-muted-foreground">Runs on</dt>
        <dd>{TIER[s.agent.tier]}{s.agent.tools.length ? `, with ${s.agent.tools.join(" and ")}` : ", no tools"}</dd>
        <dt className="caps text-label text-muted-foreground">Called from</dt>
        <dd className="min-w-0">
          {site ? <a href={site} target="_blank" rel="noopener noreferrer" className={cn("break-all font-mono", link)}>{s.integration.call_site.path}:{s.integration.call_site.line}</a> : <span className="break-all font-mono">{s.integration.call_site.path}:{s.integration.call_site.line}</span>}
          <span className="block text-muted-foreground">{s.integration.call_site.note}</span>
        </dd>
      </dl>
      <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-4">
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy} aria-label={`Discard ${s.title}`}>Discard</Button>
        <Button size="sm" variant="primary" onClick={onCreate} disabled={busy} aria-label={`Create ${s.title}`}><GitPullRequest aria-hidden />Create agent</Button>
      </div>
    </article>
  );
}

/** The agents created from a repository's suggestions, each read here for its harness and its runs: `undefined` while
 *  it is read, `null` once it is gone (deleted), `"unread"` when the read failed. */
type CreatedAgent = Agent | null | "unread" | undefined;
function useCreatedAgents(v2: Pick<Client, "getAgent">, ids: string[], round: number): Record<string, CreatedAgent> {
  const [agents, setAgents] = useState<Record<string, CreatedAgent>>({});
  const key = ids.join(" ");
  useEffect(() => {
    let live = true;
    for (const id of ids) {
      v2.getAgent(id).then(({ agent }) => { if (live) setAgents((a) => ({ ...a, [id]: agent })); },
        (e) => { if (live) setAgents((a) => ({ ...a, [id]: e instanceof ClientError && e.status === 404 ? null : "unread" })); });
    }
    return () => { live = false; };
  }, [v2, key, round]); // eslint-disable-line react-hooks/exhaustive-deps
  return agents;
}

/** What a repository's suggestions became: one card per created agent, how far along it is (created, its pull request,
 *  its first call), and the one thing to do next. */
function CreatedSection({ v2, repo, created, onRetry, round }: { v2: Pick<Client, "getAgent">; repo: string; created: Suggestion[]; onRetry: (s: Suggestion) => void; round: number }) {
  // Read again on each Refresh (`round`): a first call made since shows, and a read that failed is tried again.
  const agents = useCreatedAgents(v2, created.flatMap((s) => s.created ? [s.created.agent_id] : []), round);
  const runs = created.reduce((n, s) => { const a = s.created && agents[s.created.agent_id]; return n + (a && typeof a === "object" ? a.runs.count : 0); }, 0);
  const headingId = `created-${repo.replace(/[^A-Za-z0-9]/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3 pt-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={headingId} className="caps flex items-center gap-2 text-small font-semibold text-success-text"><Check className="size-4" aria-hidden />Created<span className="font-normal text-muted-foreground">{created.length}</span></h3>
        <p className="text-small text-muted-foreground">{created.length === 1 ? "One agent" : `${created.length} agents`} from {repo}{runs ? `, ${runs} ${runs === 1 ? "run" : "runs"} so far` : ""}. A pull request changes none of your code: your app calls its agent once you wire in the client it adds.</p>
      </div>
      <ul aria-label={`Created from ${repo}`} className="grid gap-3 xl:grid-cols-2">
        {created.map((s) => <li key={s.id} className="min-w-0"><CreatedCard s={s} agent={s.created ? agents[s.created.agent_id] : undefined} onRetry={() => onRetry(s)} /></li>)}
      </ul>
    </section>
  );
}

type StepTone = "done" | "waiting" | "problem";
const STEP: Record<StepTone, { edge: string; icon: typeof Check; iconClass: string }> = {
  done: { edge: "border-success/60", icon: Check, iconClass: "text-success-text" },
  waiting: { edge: "border-border-strong", icon: Circle, iconClass: "text-muted-foreground" },
  problem: { edge: "border-warning/60", icon: TriangleAlert, iconClass: "text-warning-text" },
};
function Step({ tone, label, children }: { tone: StepTone; label: string; children: ReactNode }) {
  const { edge, icon: Icon, iconClass } = STEP[tone];
  return (
    <li data-step={label} data-tone={tone} className={cn("min-w-0 border-t pt-2", edge)}>
      <p className="caps flex items-center gap-1.5 text-label text-muted-foreground"><Icon className={cn("size-3.5 shrink-0", iconClass)} aria-hidden />{label}<span className="sr-only">: {tone === "done" ? "done" : tone === "problem" ? "needs you" : "not yet"}</span></p>
      <div className="mt-1 min-w-0 break-words text-small">{children}</div>
    </li>
  );
}

/** One created agent: when it was made, what it takes and answers, how far along it is, and what to do next. */
function CreatedCard({ s, agent, onRetry }: { s: Suggestion; agent: CreatedAgent; onRetry: () => void }) {
  const made = s.created;
  const pull = made?.pull_request;
  const pullHref = httpHref(pull?.url);
  const agentHref = made ? `#/agents/${encodeURIComponent(made.agent_id)}` : undefined;
  const site = s.integration.call_site;
  const siteHref = httpHref(site.url);
  const here = agent && typeof agent === "object" ? agent : undefined;
  const impact = IMPACT[s.impact];
  return (
    <article aria-label={s.title} data-created={s.key} className="flex h-full min-w-0 flex-col border border-success/40 bg-card">
      <p className="caps flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-success/30 bg-success/10 px-5 py-1.5 text-label text-success-text">
        <Check className="size-3.5 shrink-0" aria-hidden />Created{s.decided_at ? ` ${when(s.decided_at)}` : ""}
        {made && <span className="ml-auto font-mono normal-case tracking-normal text-muted-foreground">{made.branch ?? made.agent_id}</span>}
      </p>
      <div className="flex flex-1 flex-col px-5 py-4">
        <div className="flex items-start gap-2">
          <span data-agent-icon className="flex h-7 shrink-0 items-center">{here ? <HarnessIcon harness={agentHarness(here)} label={harnessLabel(here.definition.harness ?? "pi")} /> : <span className="size-5" aria-hidden />}</span>
          <h4 className="min-w-0 flex-1 break-words text-prose font-semibold">{s.title}</h4>
          <Chip tone={impact.tone}>{impact.label}</Chip>
        </div>
        <p className="mt-1.5 text-lead text-muted-foreground">{s.summary}</p>
        {/* What it does, as a flow: what the app sends, the agent, what it answers. */}
        <div aria-label="What it takes and answers" className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-small">
          <span className="flex flex-wrap items-center gap-1">{s.agent.inputs.map((f) => <code key={f.name} className="bg-muted px-1.5 py-0.5">{f.name}{f.required ? "" : "?"}</code>)}</span>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-label="into" />
          <span className="border border-border-strong px-2 py-0.5 font-semibold">{here?.definition.name ?? s.agent.name}</span>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-label="which answers" />
          <span className="flex flex-wrap items-center gap-1">{s.agent.output.map((f) => <code key={f.name} className="bg-muted px-1.5 py-0.5">{f.name}</code>)}</span>
        </div>
        <ol aria-label="How far along it is" className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]">
          <Step tone="done" label="Agent">{agentHref && agent !== null ? <a href={agentHref} className={link}>{here?.definition.name ?? s.agent.name}</a> : <span className="text-muted-foreground">Removed from this server</span>}</Step>
          {pull ? <Step tone="done" label="Pull request">{pullHref ? <a href={pullHref} target="_blank" rel="noopener noreferrer" className={cn("inline-flex items-center gap-1 font-mono", link)}><GitPullRequest className="size-3.5" aria-hidden />#{pull.number}<ArrowUpRight className="size-3.5" aria-hidden /></a> : <span className="font-mono">#{pull.number}</span>}</Step>
            : <Step tone="problem" label="Pull request"><span className="text-warning-text">{made?.pull_error ?? "Not opened yet."}</span></Step>}
          {here && here.runs.count > 0
            ? <Step tone="done" label="Called">{here.runs.count} {here.runs.count === 1 ? "run" : "runs"}{here.runs.live ? <span className="text-primary-text"> · {here.runs.live} live</span> : null}</Step>
            : <Step tone="waiting" label="First call"><span className="text-muted-foreground">{agent === "unread" ? "Its runs couldn't be read." : <>{pull ? "Wire its client in at " : "From "}{/* Wraps whole, onto its own line where it must; the step breaks only a path too long for a line. */}{siteHref ? <a href={siteHref} target="_blank" rel="noopener noreferrer" className={cn("font-mono", link)}>{site.path}:{site.line}</a> : <span className="font-mono">{site.path}:{site.line}</span>}{pull ? `, and set the variables #${pull.number} lists` : ""}</>}</span></Step>}
        </ol>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
        {agentHref && agent !== null && <a href={agentHref} className={buttonVariants({ size: "sm" })} aria-label={`Open ${s.title}'s agent`}>Open the agent</a>}
        {pull && pullHref ? <a href={pullHref} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "sm", variant: "primary" })}><GitPullRequest aria-hidden />Review #{pull.number}<ArrowUpRight aria-hidden /></a>
          : !pull && <Button size="sm" variant="primary" onClick={onRetry}><GitPullRequest aria-hidden />Open the pull request</Button>}
      </div>
    </article>
  );
}

/** Create: the agent's name, the files the pull request adds (each readable whole), where to call it, and whether GitHub
 *  lets this server open it now; then the result, with the pull request and what the app sets to call the agent. */
function CreateDialog({ v2, suggestion, onClose, onCreated, go }: { v2: Client; suggestion: Suggestion; onClose: () => void; onCreated: () => void; go: (hash: string) => void }) {
  const [detail, setDetail] = useState<SuggestionDetail | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [name, setName] = useState(suggestion.agent.name);
  // The name the preview was rendered with: the typed one once it stops changing and checks, so the files shown are the
  // files Create pushes.
  const [shown, setShown] = useState(suggestion.agent.name);
  useEffect(() => {
    const typed = name.trim();
    if (typed.length < 3 || typed.length > 60 || typed === shown) return;
    const later = setTimeout(() => setShown(typed), 500);
    return () => clearTimeout(later);
  }, [name, shown]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ title: string; text: string } | null>(null);
  const [done, setDone] = useState<SuggestionCreated | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    try { setDetail(await v2.getSuggestion(suggestion.id, shown !== suggestion.agent.name ? shown : undefined)); setReadError(null); }
    catch (e) { setReadError(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  }, [v2, suggestion.id, suggestion.agent.name, shown]);
  useEffect(() => { void check(); }, [check]);
  const nameOk = name.trim().length >= 3 && name.trim().length <= 60;
  const retry = suggestion.status === "created";
  // Ready once the preview shows the name typed: Create never pushes files other than the ones on screen.
  const ready = Boolean(detail?.github.ready) && !detail?.problems.length && nameOk && shown === name.trim() && !checking;
  const create = async () => {
    setBusy(true); setSaid(null);
    try {
      const made = await v2.createSuggestedAgent(suggestion.id, name.trim() !== suggestion.agent.name ? name.trim() : undefined);
      setDone(made); onCreated();
    } catch (e) {
      const code = e instanceof ClientError ? e.code : "";
      setSaid({ title: code === "github_permission_missing" ? "GitHub needs one more permission" : code === "github_file_exists" ? "The repository already has these files" : code === "agent_not_runnable" ? "The agent can't run on this server yet" : "Nothing was created", text: e instanceof Error ? e.message : String(e) });
      if (code === "github_permission_missing" || code === "github_not_installed") void check();
      if (code === "github_failed" && e instanceof ClientError && e.details?.agent_id) onCreated();
    } finally { setBusy(false); }
  };

  if (done) {
    const pull = done.created?.pull_request;
    const href = httpHref(pull?.url);
    return (
      <Dialog open onClose={onClose} size="lg" title={<span className="flex items-center gap-2"><Check className="size-5 text-success-text" aria-hidden />{done.title}: created</span>}
        description={`The agent is made on this server, and ${pull ? `pull request #${pull.number}` : "its pull request"} adds it to ${done.repo}.`}
        footer={<>
          <Button size="sm" onClick={() => { onClose(); go(`#/agents/${encodeURIComponent(done.created!.agent_id)}`); }}>Open the agent</Button>
          {href && <a href={href} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "sm", variant: "primary" })}><GitPullRequest aria-hidden />Open pull request #{pull!.number}<ArrowUpRight aria-hidden /></a>}
        </>}>
        <div className="space-y-4">
          <p className="text-lead">Review the pull request, then wire the client in at <span className="font-mono">{done.integration.call_site.path}:{done.integration.call_site.line}</span>. {done.integration.call_site.note}</p>
          <div>
            <h3 className="caps mb-1.5 text-small font-semibold">Set in your app's environment</h3>
            <dl className="divide-y border font-mono text-small">
              {[["AGENTRUN_BASE_URL", `${location.origin}/v2`], ["AGENTRUN_API_KEY", "an API key of this server: keep it in your secrets"], [agentVariable(done.key), done.created!.agent_id]].map(([k, v]) => (
                <div key={k} className="flex flex-wrap gap-x-3 px-3 py-1.5"><dt className="font-semibold">{k}</dt><dd className="min-w-0 break-all text-muted-foreground">{v}</dd></div>
              ))}
            </dl>
          </div>
          {done.warnings.length > 0 && <Banner tone="warning" title="The agent was made with warnings"><ul className="list-disc pl-5">{done.warnings.map((w, i) => <li key={i}>{String((w as { message?: unknown }).message ?? JSON.stringify(w))}</li>)}</ul></Banner>}
        </div>
      </Dialog>
    );
  }

  const g = detail?.github;
  const words = g ? readinessWords(g, suggestion.repo) : null;
  return (
    <Dialog open onClose={busy ? () => {} : onClose} size="lg" title={`Create ${suggestion.title}`}
      description={retry ? `The agent is made already; this opens its pull request on ${suggestion.repo}.` : `A pull request adds the agent to ${suggestion.repo}, and the agent is made on this server from the same files.`}
      footer={<>
        <Button size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={() => void create()} disabled={!ready || busy} aria-busy={busy || undefined}><GitPullRequest aria-hidden />{busy ? "Creating…" : retry ? "Open pull request" : "Create and open pull request"}</Button>
      </>}>
      <div className="space-y-5">
        {!retry && (
          <Field label="Agent name" error={nameOk ? undefined : "3 to 60 characters."}>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={60} />
          </Field>
        )}
        <section aria-label="GitHub">
          {!detail && !readError && <p className="flex items-center gap-2 text-body text-muted-foreground"><Spinner />Checking what GitHub lets this server do on {suggestion.repo}…</p>}
          {readError && <Banner tone="error" title="The suggestion could not be read" actions={<Button size="xs" onClick={() => void check()}>Try again</Button>}><p className="font-mono">{readError}</p></Banner>}
          {g && words && (g.ready
            ? <p role="status" className="flex items-start gap-2 border border-success/50 bg-success/5 px-4 py-3 text-body"><Check className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden /><span><span className="font-semibold">{words.title}.</span> {words.body}</span></p>
            : (
              <div className="border border-warning/50 bg-warning/5 p-4">
                <p className="caps text-label text-warning-text">{words.title}</p>
                <p className="mt-1 text-body">{words.body}</p>
                {g.reason === "permission_missing" && (
                  <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-body">
                    <li>On the App's permissions page, set {g.missing.map(permissionLabel).join(" and ")}, then save. {httpHref(g.permissions_url) && <a href={httpHref(g.permissions_url)} target="_blank" rel="noopener noreferrer" className={link}>Open the App's permissions</a>}</li>
                    <li>Accept the new permission on the installation. {httpHref(g.installation_url) && <a href={httpHref(g.installation_url)} target="_blank" rel="noopener noreferrer" className={link}>Open the installation</a>}</li>
                    <li>Come back and check again.</li>
                  </ol>
                )}
                {g.reason === "not_installed" && httpHref(g.install_url) && <p className="mt-2 text-body"><a href={httpHref(g.install_url)} target="_blank" rel="noopener noreferrer" className={link}>Add {suggestion.repo} to the installation</a></p>}
                {g.reason === "not_connected" && <p className="mt-2 text-body"><a href="#/settings/github" className={link}>Open Settings → GitHub</a></p>}
                <Button size="xs" className="mt-3" onClick={() => void check()} disabled={checking}>{checking ? "Checking…" : "Check again"}</Button>
              </div>
            ))}
          {detail && detail.problems.length > 0 && <Banner tone="error" title="This suggestion doesn't make a package that checks"><ul className="list-disc pl-5 font-mono">{detail.problems.map((p) => <li key={p}>{p}</li>)}</ul><p className="mt-1">Scan again for a new one.</p></Banner>}
        </section>
        {said && <Banner tone="error" title={said.title}><p>{said.text}</p></Banner>}
        {detail && (
          <section aria-labelledby="files-title">
            <h3 id="files-title" className="caps mb-1.5 text-small font-semibold">What the pull request adds</h3>
            <p className="mb-2 text-small text-muted-foreground">On a new branch <span className="font-mono">agentrun/{suggestion.key}</span>. It changes none of your files: you wire the client in yourself.</p>
            <ul className="divide-y border">
              {detail.files.map((f) => (
                <li key={f.path}>
                  <details>
                    <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 font-mono text-small hover:bg-accent"><FileCode className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span className="min-w-0 break-all">{f.path}</span><span className="ml-auto shrink-0 text-muted-foreground">{f.content.split("\n").length} lines</span></summary>
                    <pre tabIndex={0} role="region" aria-label={f.path} className="max-h-80 overflow-auto border-t bg-muted px-3 py-2 font-mono text-small"><code>{f.content}</code></pre>
                  </details>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-small text-muted-foreground">The client is {LANGUAGE[detail.integration.language]} with no dependency. Call it from <span className="font-mono">{detail.integration.call_site.path}:{detail.integration.call_site.line}</span>: {detail.integration.call_site.note}</p>
          </section>
        )}
        {busy && <p role="status" className="flex items-center gap-2 text-body text-muted-foreground"><Spinner />Pushing the branch, making the agent, opening the pull request…</p>}
      </div>
    </Dialog>
  );
}
