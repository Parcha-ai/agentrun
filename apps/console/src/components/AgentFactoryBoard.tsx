import { ArrowUpRight, Factory, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import { Banner, Button, Chip, Field, pageTitleClass, pageToolbarClass, Picker, Spinner, type ChipTone, type PickerOption } from "@/components/ui";
import { when } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A projection of a reported run. The board neither guesses a role from task text nor grants controls to its source.
 *  GitHub URLs are validated by the projection before they reach this presentational component. */
export type FactoryCard = {
  id: string;
  runId: string;
  /** What a person reads for the session's identity ("run 9644d8ab", "child 24"); `id` stays whole for the key. */
  ref: string;
  agentName: string;
  title: string;
  lane: "waiting" | "working" | "attention" | "unknown";
  stateLabel: string;
  sourceLabel: string;
  controlLabel: string;
  repo: string | null;
  githubLinks: { label: string; url: string }[];
  activityAt: string | null;
  reason: string | null;
  parentLabel?: string;
  costLabel: string;
};

export type AgentFactoryBoardProps = {
  cards: FactoryCard[];
  review: FactoryCard[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  updatedAt: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onRefresh: () => void;
};

const LANES: { id: FactoryCard["lane"]; label: string; note: string; tone: ChipTone }[] = [
  { id: "waiting", label: "Waiting", note: "Queued or waiting for a prerequisite.", tone: "plain" },
  { id: "working", label: "Working", note: "Reported as executing.", tone: "active" },
  { id: "attention", label: "Needs you", note: "A decision or approval is needed.", tone: "warning" },
  { id: "unknown", label: "Unknown", note: "Current activity is unavailable.", tone: "muted" },
];

const repoValue = (repo: string | null) => repo === null ? "unreported" : `repo:${repo}`;
const controlValue = (control: string) => `control:${control}`;
const validTime = (value: string | null): value is string => value !== null && Number.isFinite(Date.parse(value));

/** Selection survives a refresh that removes its last matching run: an explicit zero match is more useful than a
 *  blank picker or silently widening the person's scope. Prefixes keep the filter sentinels apart from source words. */
function filterOptions(cards: FactoryCard[], repository: string, control: string): { repositories: PickerOption[]; controls: PickerOption[] } {
  const repos = new Set(cards.map((card) => card.repo).filter((repo): repo is string => repo !== null));
  const controls = new Set(cards.map((card) => card.controlLabel));
  if (repository.startsWith("repo:")) repos.add(repository.slice(5));
  if (control.startsWith("control:")) controls.add(control.slice(8));
  return {
    repositories: [
      { value: "all", label: "All repositories" },
      ...[...repos].sort().map((repo) => ({ value: repoValue(repo), label: repo })),
      { value: "unreported", label: "Repository not reported" },
    ],
    controls: [{ value: "all", label: "All controls" }, ...[...controls].sort().map((label) => ({ value: controlValue(label), label }))],
  };
}

/** The factory's read-only session board. Counts cover the supplied active cards; terminal runs needing review have
 *  their own section. A failed read preserves the prior snapshot, marked stale, and a partial list never claims a
 *  complete fleet. The page owns reads, pagination and lifecycle classification. */
export function AgentFactoryBoard({ cards, review, loading, refreshing, error, updatedAt, hasMore, onLoadMore, onRefresh }: AgentFactoryBoardProps) {
  const id = useId();
  const [repository, setRepository] = useState("all");
  const [control, setControl] = useState("all");
  const busy = loading || refreshing;
  const hasSnapshot = updatedAt !== null || cards.length > 0 || review.length > 0;
  const available = hasSnapshot || (!loading && !error);
  const options = filterOptions([...cards, ...review], repository, control);
  const matches = (card: FactoryCard) => (repository === "all" || repoValue(card.repo) === repository) && (control === "all" || controlValue(card.controlLabel) === control);
  const shown = cards.filter(matches);
  const shownReview = review.filter(matches);
  const filtered = repository !== "all" || control !== "all";
  const clearFilters = () => { setRepository("all"); setControl("all"); };

  return (
    // The page's frame is every list page's (Mission Control, Runs, Triggers): a bar with the place's icon and name in
    // caps and its action at the right, then the content.
    <section className="flex min-h-full flex-col" aria-label="Agent Factory">
      <header className={cn(pageToolbarClass, "flex-wrap justify-between gap-2 px-5 md:px-6")}>
        <h1 className={pageTitleClass}><Factory className="size-4" aria-hidden />Agent Factory</h1>
        <Button className="ml-auto" size="icon" aria-label="Refresh Agent Factory" disabled={busy} aria-busy={busy} onClick={onRefresh}><RefreshCw className="size-4" aria-hidden /></Button>
      </header>
      <div className="mx-auto w-full max-w-page-wide space-y-6 p-5 md:p-8">

      {error && <Banner tone="error" title={hasSnapshot ? "Could not refresh Agent Factory" : "Could not load Agent Factory"}
        actions={<Button size="xs" onClick={onRefresh} disabled={busy}>Try again</Button>}>
        <p className="break-words font-mono text-body">{error}</p>
        {hasSnapshot && <p className="mt-2">Showing last known sessions; counts may be stale.</p>}
      </Banner>}

      {!available && loading && <div role="status" className="flex items-center gap-3 py-8 text-body"><Spinner /> Loading agent sessions</div>}

      {available && <>
        {/* The loaded sessions counted once, on one row: each lane's own header counts the cards a filter leaves in it.
            While a filter narrows the cards, how many of them match is said at the row's end, on the same baseline. */}
        <section aria-label="Loaded active session totals" className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-b pb-4">
          <p className="font-mono text-body"><strong className="text-figure font-semibold">{cards.length}</strong> active sessions loaded</p>
          <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            {LANES.map((lane) => <div key={lane.id} className="flex items-baseline gap-2">
              <dt className="text-small text-muted-foreground">{lane.label}</dt>
              <dd className="order-first font-mono text-lg">{cards.filter((card) => card.lane === lane.id).length}</dd>
            </div>)}
          </dl>
          <div className="ml-auto" aria-live="polite">
            {filtered && <p aria-label="Matching sessions" className="font-mono text-small text-muted-foreground">{shown.length} of {cards.length} loaded active sessions match</p>}
          </div>
        </section>

        {hasMore && <Banner tone="info" title="Partial coverage">More sessions may be available. Counts and filters cover only the sessions loaded so far.</Banner>}

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-2">
            <Field label="Repository"><Picker label="Repository" small value={repository} onChange={setRepository} options={options.repositories} className="w-full sm:w-60" /></Field>
            <Field label="Control"><Picker label="Control" small value={control} onChange={setControl} options={options.controls} className="w-full sm:w-48" /></Field>
          </div>
          {filtered && <Button size="sm" onClick={clearFilters}>Clear filters</Button>}
        </div>

        {!cards.length && <Banner>{hasMore ? "No active sessions in the loaded results. Load more to check further results." : "No active sessions reported."}</Banner>}
        {filtered && !shown.length && !shownReview.length && <Banner>No loaded sessions match these filters.</Banner>}

        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 lg:grid-cols-4" aria-label="Active agent sessions">
          {LANES.map((lane) => {
            const laneCards = shown.filter((card) => card.lane === lane.id);
            return <section key={lane.id} data-factory-lane={lane.id} aria-labelledby={`${id}-${lane.id}`} className="min-w-0 bg-muted/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 id={`${id}-${lane.id}`} className="caps text-small font-semibold">{lane.label}</h2>
                <span className="font-mono text-small text-muted-foreground">{laneCards.length}</span>
              </div>
              <p className="mb-4 mt-2 text-small text-muted-foreground">{lane.note}</p>
              <div className="space-y-3">
                {laneCards.map((card) => <SessionCard key={card.id} card={card} tone={lane.tone} />)}
                {!laneCards.length && <p className="py-4 text-small text-muted-foreground">No matching sessions</p>}
              </div>
            </section>;
          })}
        </div>

        {review.length > 0 && <section aria-label="Ended runs needing attention" className="space-y-4 border-t pt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div><h2 className="text-lg font-semibold">Ended runs needing attention</h2><p className="mt-1 text-small text-muted-foreground">Excluded from active session totals.</p></div>
            <p className="font-mono text-small text-muted-foreground">{shownReview.length} of {review.length} loaded ended runs match</p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {shownReview.map((card) => <SessionCard key={card.id} card={card} tone="warning" />)}
          </div>
          {!shownReview.length && <p className="text-small text-muted-foreground">No ended runs match these filters.</p>}
        </section>}

        {hasMore && <Button onClick={onLoadMore} disabled={busy} aria-busy={loading}>{loading ? "Loading more" : "Load more"}</Button>}
        <footer className="flex flex-wrap justify-between gap-3 border-t pt-4 font-mono text-small text-muted-foreground">
          <p>One card is one session. Open a run for its supported controls.</p>
          <p>{validTime(updatedAt) ? <>Last successful refresh <time dateTime={updatedAt}>{when(updatedAt)}</time>{error ? " · stale" : ""}</> : "Refresh time not reported"}</p>
        </footer>
      </>}
      </div>
    </section>
  );
}

/** One session: who works, on what, where it runs and which session it is, its state, then its repository and its
 *  last activity and cost. The whole run id is in the link and on the label's hover, never a line of its own. */
function SessionCard({ card, tone }: { card: FactoryCard; tone: ChipTone }) {
  return (
    <article className="min-w-0 space-y-2 border bg-card p-4">
      <h3 className="min-w-0">
        <a href={`#/runs/${encodeURIComponent(card.runId)}`} className="block break-words text-left hover:text-primary-text">
          {/* A child is named by the task its parent gave it, which can run long: two lines here, whole on hover. */}
          <span className="line-clamp-2 text-prose font-semibold underline underline-offset-2" title={card.agentName}>{card.agentName}</span>
          <span className="mt-1 line-clamp-2 text-body font-normal" title={card.title}>{card.title}</span>
        </a>
      </h3>
      <p className="break-words font-mono text-small text-muted-foreground">{card.sourceLabel} · <span title={card.id}>{card.ref}</span></p>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Chip tone={tone} label title={card.stateLabel}>{card.stateLabel}</Chip>
        <Chip label title={card.controlLabel}>{card.controlLabel}</Chip>
      </div>
      {card.reason && <p className="break-words text-body">{card.reason}</p>}
      {card.parentLabel && <p className="break-words text-small text-muted-foreground">Parent: {card.parentLabel}</p>}
      {/* The first link is the repository itself, so its name is written once. */}
      {card.githubLinks.length > 0 ? <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {card.githubLinks.map((link) => <li key={link.url} className="min-w-0">
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-small underline underline-offset-2 hover:text-primary-text">
            <span className="min-w-0 break-all">{link.label}</span><ArrowUpRight className="size-3 shrink-0" aria-hidden /><span className="sr-only"> (opens in a new tab)</span>
          </a>
        </li>)}
      </ul> : <p className="break-words text-small text-muted-foreground">{card.repo ?? "Repository not reported"}</p>}
      <p className="flex flex-wrap gap-x-3 text-small text-muted-foreground">
        <span>{validTime(card.activityAt) ? <>Last activity <time dateTime={card.activityAt}>{when(card.activityAt)}</time></> : "Activity time not reported"}</span>
        <span className="break-words font-mono">{card.costLabel}</span>
      </p>
    </article>
  );
}
