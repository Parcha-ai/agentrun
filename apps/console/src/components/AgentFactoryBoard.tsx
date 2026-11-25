import { ArrowUpRight, Factory, LayoutGrid, List, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import { Banner, Button, Chip, Field, pageTitleClass, pageToolbarClass, Picker, Segmented, Spinner, type ChipTone, type PickerOption, type SegmentedOption } from "@/components/ui";
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

/** How the sessions are laid out: one row each, or cards in a lane for each state. */
export type FactoryView = "list" | "cards";

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
  view: FactoryView;
  onView: (view: FactoryView) => void;
};

const LANES: { id: FactoryCard["lane"]; label: string; note: string; tone: ChipTone }[] = [
  { id: "waiting", label: "Waiting", note: "Queued or waiting for a prerequisite.", tone: "plain" },
  { id: "working", label: "Working", note: "Reported as executing.", tone: "active" },
  { id: "attention", label: "Needs you", note: "A decision or approval is needed.", tone: "warning" },
  { id: "unknown", label: "Unknown", note: "Current activity is unavailable.", tone: "muted" },
];

/** The two views as icons: each one's word is its name to a screen reader and what a pointer's hover says. */
const VIEWS: SegmentedOption<FactoryView>[] = [
  { value: "list", title: "List", label: <><List aria-hidden /><span className="sr-only">List</span></> },
  { value: "cards", title: "Cards", label: <><LayoutGrid aria-hidden /><span className="sr-only">Cards</span></> },
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
 *  complete fleet. The same sessions read as cards in a lane for each state, or as one row each in their loaded order.
 *  The page owns reads, pagination, lifecycle classification and the view its browser keeps. */
export function AgentFactoryBoard({ cards, review, loading, refreshing, error, updatedAt, hasMore, onLoadMore, onRefresh, view, onView }: AgentFactoryBoardProps) {
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
    // caps and, at the right, how its sessions are laid out and its action; then the content.
    <section className="flex min-h-full flex-col" aria-label="Agent Factory">
      <header className={cn(pageToolbarClass, "flex-wrap justify-between gap-2 px-5 md:px-6")}>
        <h1 className={pageTitleClass}><Factory className="size-4" aria-hidden />Agent Factory</h1>
        <div className="ml-auto flex items-center gap-2">
          <Segmented size="sm" name="factory-view" label="View" value={view} onChange={onView} options={VIEWS} />
          <Button size="icon" aria-label="Refresh Agent Factory" disabled={busy} aria-busy={busy} onClick={onRefresh}><RefreshCw className="size-4" aria-hidden /></Button>
        </div>
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
        </section>

        {hasMore && <Banner tone="info" title="Partial coverage">More sessions may be available. Counts and filters cover only the sessions loaded so far.</Banner>}

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-2">
            <Field label="Repository"><Picker label="Repository" small value={repository} onChange={setRepository} options={options.repositories} className="w-full sm:w-60" /></Field>
            <Field label="Control"><Picker label="Control" small value={control} onChange={setControl} options={options.controls} className="w-full sm:w-48" /></Field>
          </div>
          {/* What the filters leave, then the way out of them: one line, read on the button's own baseline. */}
          <div className="flex flex-wrap items-baseline gap-3">
            <div aria-live="polite">
              {filtered && <p aria-label="Matching sessions" className="font-mono text-small text-muted-foreground">{shown.length} of {cards.length} loaded active sessions match</p>}
            </div>
            {filtered && <Button size="sm" onClick={clearFilters}>Clear filters</Button>}
          </div>
        </div>

        {!cards.length && <Banner>{hasMore ? "No active sessions in the loaded results. Load more to check further results." : "No active sessions reported."}</Banner>}
        {filtered && !shown.length && !shownReview.length && <Banner>No loaded sessions match these filters.</Banner>}

        {view === "list" ? (shown.length > 0 ? <SessionTable label="Active agent sessions" cards={shown} /> : <p className="py-4 text-small text-muted-foreground">No matching sessions</p>)
        : <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 lg:grid-cols-4" aria-label="Active agent sessions">
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
        </div>}

        {review.length > 0 && <section aria-label="Ended runs needing attention" className="space-y-4 border-t pt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div><h2 className="text-lg font-semibold">Ended runs needing attention</h2><p className="mt-1 text-small text-muted-foreground">Excluded from active session totals.</p></div>
            <p className="font-mono text-small text-muted-foreground">{shownReview.length} of {review.length} loaded ended runs match</p>
          </div>
          {view === "list" ? shownReview.length > 0 && <SessionTable label="Ended runs" cards={shownReview} ended />
          : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {shownReview.map((card) => <SessionCard key={card.id} card={card} tone="warning" />)}
          </div>}
          {!shownReview.length && <p className="text-small text-muted-foreground">No ended runs match these filters.</p>}
        </section>}

        {hasMore && <Button onClick={onLoadMore} disabled={busy} aria-busy={loading}>{loading ? "Loading more" : "Load more"}</Button>}
        <footer className="flex flex-wrap justify-between gap-3 border-t pt-4 font-mono text-small text-muted-foreground">
          <p>{view === "list" ? "One row is one session." : "One card is one session."} Open a run for its supported controls.</p>
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
      {card.githubLinks.length > 0 ? <GithubLinks links={card.githubLinks} /> : <p className="break-words text-small text-muted-foreground">{card.repo ?? "Repository not reported"}</p>}
      <p className="flex flex-wrap gap-x-3 text-small text-muted-foreground">
        <span>{validTime(card.activityAt) ? <>Last activity <time dateTime={card.activityAt}>{when(card.activityAt)}</time></> : "Activity time not reported"}</span>
        <span className="break-words font-mono">{card.costLabel}</span>
      </p>
    </article>
  );
}

/** A session's GitHub links. The first is the repository itself, so its name is written once. */
function GithubLinks({ links }: { links: FactoryCard["githubLinks"] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {links.map((link) => <li key={link.url} className="min-w-0">
        <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-small underline underline-offset-2 hover:text-primary-text">
          <span className="min-w-0 break-all">{link.label}</span><ArrowUpRight className="size-3 shrink-0" aria-hidden /><span className="sr-only"> (opens in a new tab)</span>
        </a>
      </li>)}
    </ul>
  );
}

const CELL = "px-3 py-2.5 align-top";
/** The list's columns: each one's width, and the page width it shows from. Narrower than that, a row says the column
 *  under its session. The widths are fixed and the session takes the rest, so a long unbroken name wraps in its cell
 *  and never widens the table past its pane. */
const COLUMNS = {
  state: "w-28", session: "",
  control: "hidden w-28 lg:table-cell", repository: "hidden w-44 lg:table-cell",
  activity: "hidden w-36 xl:table-cell", cost: "hidden w-44 xl:table-cell",
} as const;
const HEADINGS: [keyof typeof COLUMNS, string][] = [["state", "State"], ["session", "Session"], ["control", "Control"], ["repository", "Repository"], ["activity", "Last activity"], ["cost", "Cost"]];

/** The sessions as a list: one row each, in the order they were loaded, so a child stays under the session that
 *  started it. A lane the cards say by their column is a word in the row; an ended run's state is its source's own. */
function SessionTable({ label, cards, ended = false }: { label: string; cards: FactoryCard[]; ended?: boolean }) {
  return (
    <div className="border bg-card">
      <table aria-label={label} className="w-full table-fixed border-collapse text-body">
        <thead className="hidden lg:table-header-group">
          <tr className="caps text-label text-muted-foreground">
            {HEADINGS.map(([column, name]) => <th key={column} scope="col" className={cn("border-b px-3 py-2.5 text-left font-normal", COLUMNS[column])}>{name}</th>)}
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => <SessionRow key={card.id} card={card} ended={ended} />)}
        </tbody>
      </table>
    </div>
  );
}

function SessionRow({ card, ended }: { card: FactoryCard; ended: boolean }) {
  const lane = LANES.find((each) => each.id === card.lane)!;
  const child = card.parentLabel !== undefined;
  const activity = validTime(card.activityAt) ? <time dateTime={card.activityAt}>{when(card.activityAt)}</time> : null;
  const repository = card.githubLinks.length > 0 ? <GithubLinks links={card.githubLinks} /> : card.repo;
  return (
    <tr className="border-b last:border-b-0" {...(child ? { "data-factory-child": "" } : {})}>
      <td className={cn(CELL, COLUMNS.state)}>
        {ended ? <Chip tone="warning" label title={card.stateLabel}>{card.stateLabel}</Chip> : <>
          <Chip tone={lane.tone} title={lane.note}>{lane.label}</Chip>
          {card.stateLabel.toLowerCase() !== lane.label.toLowerCase() && <span className="mt-1 block break-words text-small text-muted-foreground">{card.stateLabel}</span>}
        </>}
      </td>
      <td className={cn(CELL, COLUMNS.session, child && "pl-8")}>
        <a href={`#/runs/${encodeURIComponent(card.runId)}`} className="block break-words text-left hover:text-primary-text">
          <span className="line-clamp-1 font-semibold underline underline-offset-2" title={card.agentName}>{card.agentName}</span>
          <span className="line-clamp-2 lg:line-clamp-1" title={card.title}>{card.title}</span>
        </a>
        <p className="mt-1 break-words font-mono text-small text-muted-foreground">{card.sourceLabel} · <span title={card.id}>{card.ref}</span></p>
        {card.reason && <p className="mt-1 break-words">{card.reason}</p>}
        {card.parentLabel && <p className="mt-1 break-words text-small text-muted-foreground">Parent: {card.parentLabel}</p>}
        {/* Narrower than its columns, a row says them here. */}
        <p className="mt-1 flex flex-wrap gap-x-3 font-mono text-small text-muted-foreground xl:hidden">
          <span className="lg:hidden">{card.controlLabel}</span>
          <span>{card.costLabel}</span>
          <span>{activity ? <>Last activity {activity}</> : "Activity time not reported"}</span>
        </p>
        <div className="mt-1 break-words text-small text-muted-foreground lg:hidden">{repository ?? "Repository not reported"}</div>
      </td>
      <td className={cn(CELL, COLUMNS.control)}><Chip label title={card.controlLabel}>{card.controlLabel}</Chip></td>
      <td className={cn(CELL, COLUMNS.repository, "break-words text-small")}>{repository ?? <span className="text-muted-foreground">Not reported</span>}</td>
      <td className={cn(CELL, COLUMNS.activity, "break-words font-mono text-small text-muted-foreground")}>{activity ?? "Not reported"}</td>
      <td className={cn(CELL, COLUMNS.cost, "break-words font-mono text-small text-muted-foreground")}>{card.costLabel}</td>
    </tr>
  );
}
