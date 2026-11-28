import { ArrowUpRight, ChevronDown, Factory, LayoutGrid, List, RefreshCw } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Banner, Button, buttonVariants, Chip, Field, pageTitleClass, pageToolbarClass, Picker, Segmented, Spinner, type ChipTone, type PickerOption, type SegmentedOption } from "@/components/ui";
import { FACTORY_POLL_MS, type FactoryFilters, NO_FACTORY_FILTERS } from "@/lib/factory";
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
  controlLabel: FactoryControl;
  /** What a person does next for a session that waits on them: the word on the button that opens it. */
  action?: "Answer" | "Review";
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
  /** The filters, when the page keeps them in its address. Alone (a story, a test) the board holds its own. */
  filters?: FactoryFilters;
  onFilters?: (next: FactoryFilters) => void;
  /** Where a session opens: beside the board, in the page's panel. Without it, a session opens its run's own page. */
  sessionHref?: (runId: string) => string;
  /** The run whose session is open in the panel: its card and its row say so. */
  openSession?: string;
  /** The open session, drawn over the board's right side, or over all of it on a narrow page. The board keeps its
   *  place, its filters and its scroll under it. */
  panel?: ReactNode;
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
/** Whether this server holds a session and can act on it, or only hears of one something else runs. */
export type FactoryControl = "Managed" | "Observed";
const CONTROLS: readonly FactoryControl[] = ["Managed", "Observed"];
const controlValue = (control: FactoryControl) => `control:${control}`;
const validTime = (value: string | null): value is string => value !== null && Number.isFinite(Date.parse(value));
/** A time of day to the second: the board is read again every few seconds, and a minute would look stopped. */
const toTheSecond = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** Selection survives a refresh that removes its last matching run: an explicit zero match is more useful than a
 *  blank picker or silently widening the person's scope. Prefixes keep the filter sentinels apart from source words.
 *  A repository is offered once a loaded session names it. Both controls are always offered: they are the whole set,
 *  and a list that left out the one no loaded session has would hide that the other kind exists. */
function filterOptions(cards: FactoryCard[], repository: string): { repositories: PickerOption[]; controls: PickerOption[] } {
  const repos = new Set(cards.map((card) => card.repo).filter((repo): repo is string => repo !== null));
  if (repository.startsWith("repo:")) repos.add(repository.slice(5));
  return {
    repositories: [
      { value: "all", label: "All repositories" },
      ...[...repos].sort().map((repo) => ({ value: repoValue(repo), label: repo })),
      { value: "unreported", label: "Repository not reported" },
    ],
    controls: [{ value: "all", label: "All controls" }, ...CONTROLS.map((label) => ({ value: controlValue(label), label }))],
  };
}

/** The factory's read-only session board. Counts cover the supplied active cards; terminal runs needing review have
 *  their own section. A failed read preserves the prior snapshot, marked stale, and a partial list never claims a
 *  complete fleet. The same sessions read as cards in a lane for each state, or as one row each under a heading for
 *  each state.
 *  The page owns reads, pagination, lifecycle classification and the view its browser keeps. */
export function AgentFactoryBoard({ cards, review, loading, refreshing, error, updatedAt, hasMore, onLoadMore, onRefresh, view, onView, filters, onFilters, sessionHref, openSession, panel }: AgentFactoryBoardProps) {
  const id = useId();
  const [held, setHeld] = useState<FactoryFilters>(NO_FACTORY_FILTERS);
  const { repository, control } = filters ?? held;
  const setFilters = (next: FactoryFilters) => (onFilters ?? setHeld)(next);
  const setRepository = (value: string) => setFilters({ repository: value, control });
  const setControl = (value: string) => setFilters({ repository, control: value });
  // A session's links: the panel beside the board where the page has one, else the run's own page. A child's card
  // opens its parent's run (it has none of its own), so only the run's own card is the open one.
  const link: SessionLink = { href: (card) => sessionHref ? sessionHref(card.runId) : runHref(card.runId), own: sessionHref ? (card) => runHref(card.runId) : undefined, open: (card) => openSession === card.runId && card.id === card.runId };
  const busy = loading || refreshing;
  const hasSnapshot = updatedAt !== null || cards.length > 0 || review.length > 0;
  const available = hasSnapshot || (!loading && !error);
  const options = filterOptions([...cards, ...review], repository);
  const matches = (card: FactoryCard) => (repository === "all" || repoValue(card.repo) === repository) && (control === "all" || controlValue(card.controlLabel) === control);
  const shown = cards.filter(matches);
  const shownReview = review.filter(matches);
  const filtered = repository !== "all" || control !== "all";
  // The states a person folded in the list, each by its table: held while the page is open, so a refresh, a filter
  // that empties the list and a look at the cards all leave a folded state folded.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const fold = (key: string) => setFolded((held) => { const next = new Set(held); if (!next.delete(key)) next.add(key); return next; });
  const clearFilters = () => setFilters(NO_FACTORY_FILTERS);

  return (
    // The page's frame is Mission Control's and Runs': a bar with the place's icon and name in caps, then the content
    // in a pane of its own. The bar stays while the sessions scroll under it, so its bottom edge keeps meeting the
    // edge under the navigation's logo row. Its controls sit with the sessions they act on, at the end of the totals' row.
    <section className="flex h-full min-h-0 flex-col" aria-label="Agent Factory">
      <header className={cn(pageToolbarClass, "px-5 md:px-6")}>
        <h1 className={pageTitleClass}><Factory className="size-4" aria-hidden />Agent Factory</h1>
      </header>
      {/* The sessions, and over their right side the one that is open: the board keeps its place under the panel.
          Below xl the panel covers the whole board: there the board is hidden from the keyboard and a screen reader
          (invisible, so still laid out and still at its scroll), or Shift+Tab from the panel would land on a control
          nobody can see. Beside the panel, at xl, it stays in reach. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div data-factory-pane className={cn("min-h-0 flex-1 overflow-auto", !!panel && "max-xl:invisible")}>
      <div className="mx-auto w-full max-w-page-wide space-y-6 p-5 md:p-8">

      {error && <Banner tone="error" title={hasSnapshot ? "Could not refresh Agent Factory" : "Could not load Agent Factory"}
        actions={<Button size="xs" onClick={onRefresh} disabled={busy}>Try again</Button>}>
        <p className="break-words font-mono text-body">{error}</p>
        {hasSnapshot && <p className="mt-2">Showing last known sessions; counts may be stale.</p>}
      </Banner>}

      {!available && loading && <div role="status" className="flex items-center gap-3 py-8 text-body"><Spinner /> Loading agent sessions</div>}

      {available && <>
        {/* The loaded sessions counted once, on one row: each lane's own header counts the cards a filter leaves in it.
            The row ends with how the sessions are laid out, when they were last read, then Refresh: they keep the
            first line's right end, and in a narrow row the totals wrap beside them. A phone has no room for the time
            there: the page's last line says it at every width. */}
        <div className="flex items-start gap-x-8">
          <section aria-label="Loaded active session totals" className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-8 gap-y-2">
            <p className="font-mono text-body"><strong className="text-figure font-semibold">{cards.length}</strong> active sessions loaded</p>
            <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              {LANES.map((lane) => <div key={lane.id} className="flex items-baseline gap-2">
                <dt className="text-small text-muted-foreground">{lane.label}</dt>
                <dd className="order-first font-mono text-lg">{cards.filter((card) => card.lane === lane.id).length}</dd>
              </div>)}
            </dl>
          </section>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Segmented size="sm" name="factory-view" label="View" value={view} onChange={onView} options={VIEWS} />
            {validTime(updatedAt) && <p title={`Read again every ${FACTORY_POLL_MS / 1000} seconds, and when you come back to this tab`}
              className="hidden whitespace-nowrap font-mono text-small text-muted-foreground sm:block">Updated <time dateTime={updatedAt}>{toTheSecond(updatedAt)}</time>{error ? " · stale" : ""}</p>}
            <Button size="icon" aria-label="Refresh Agent Factory" disabled={busy} aria-busy={busy} onClick={onRefresh}><RefreshCw className="size-4" aria-hidden /></Button>
          </div>
        </div>

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

        {view === "list" ? (shown.length > 0 ? <SessionTable label="Active agent sessions" scope="active" groups={byLane(shown)} folded={folded} onFold={fold} link={link} /> : <p className="py-4 text-small text-muted-foreground">No matching sessions</p>)
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
                {laneCards.map((card) => <SessionCard key={card.id} card={card} tone={lane.tone} link={link} />)}
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
          {view === "list" ? shownReview.length > 0 && <SessionTable label="Ended runs" scope="ended" groups={byState(shownReview)} folded={folded} onFold={fold} link={link} />
          : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {shownReview.map((card) => <SessionCard key={card.id} card={card} tone="warning" link={link} />)}
          </div>}
          {!shownReview.length && <p className="text-small text-muted-foreground">No ended runs match these filters.</p>}
        </section>}

        {hasMore && <Button onClick={onLoadMore} disabled={busy} aria-busy={loading}>{loading ? "Loading more" : "Load more"}</Button>}
        <footer className="flex flex-wrap justify-between gap-3 border-t pt-4 font-mono text-small text-muted-foreground">
          <p>{view === "list" ? "One row is one session." : "One card is one session."} {sessionHref ? "Open one to see its latest activity and act on it." : "Open a run for its supported controls."}</p>
          <p>{validTime(updatedAt) ? <>Last successful refresh <time dateTime={updatedAt}>{when(updatedAt)}</time>{error ? " · stale" : ""}</> : "Refresh time not reported"}</p>
        </footer>
      </>}
      </div>
      </div>
      {panel}
      </div>
    </section>
  );
}

const runHref = (runId: string) => `#/runs/${encodeURIComponent(runId)}`;
/** Where a session's name leads, where its run's own page is when the name leads elsewhere, and whether it is the one open. */
type SessionLink = { href: (card: FactoryCard) => string; own?: (card: FactoryCard) => string; open: (card: FactoryCard) => boolean };
/** A session's identity ("run 9644d8ab"): a link to its run's own page where its name opens the panel instead. */
function SessionRef({ card, link }: { card: FactoryCard; link: SessionLink }) {
  return link.own ? <a href={link.own(card)} title={card.id} className="underline underline-offset-2 hover:text-foreground">{card.ref}</a> : <span title={card.id}>{card.ref}</span>;
}
/** The way in for a session that waits on a person, named for what they do there. */
function NextStep({ card, link }: { card: FactoryCard; link: SessionLink }) {
  return card.action ? <a data-factory-action href={link.href(card)} aria-label={`${card.action}: ${card.agentName}`} className={buttonVariants({ size: "xs" })}>{card.action}</a> : null;
}

/** One session: who works, on what, where it runs and which session it is, its state, then its repository and its
 *  last activity and cost. The whole run id is in the link and on the label's hover, never a line of its own. */
function SessionCard({ card, tone, link }: { card: FactoryCard; tone: ChipTone; link: SessionLink }) {
  const open = link.open(card);
  return (
    <article aria-current={open ? "true" : undefined} className={cn("min-w-0 space-y-2 border bg-card p-4", open && "border-border-strong")}>
      <h3 className="min-w-0">
        <a href={link.href(card)} className="group block break-words text-left hover:text-primary-text">
          {/* A child is named by the task its parent gave it, which can run long: two lines here, whole on hover.
              The name is its card's heading, bold, with no underline at rest: one under every card made the board busy.
              Under the pointer, or with the keyboard on the link, it is underlined as a list's names are elsewhere. */}
          <span className="line-clamp-2 text-prose font-semibold underline-offset-2 group-hover:underline group-focus-visible:underline" title={card.agentName}>{card.agentName}</span>
          <span className="mt-1 line-clamp-2 text-body font-normal" title={card.title}>{card.title}</span>
        </a>
      </h3>
      <p className="break-words font-mono text-small text-muted-foreground">{card.sourceLabel} · <SessionRef card={card} link={link} /></p>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Chip tone={tone} label title={card.stateLabel}>{card.stateLabel}</Chip>
        <Chip label title={card.controlLabel}>{card.controlLabel}</Chip>
      </div>
      {card.reason && <p className="break-words text-body">{card.reason}</p>}
      {card.action && <p><NextStep card={card} link={link} /></p>}
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
  session: "",
  control: "hidden w-28 lg:table-cell", repository: "hidden w-44 lg:table-cell",
  activity: "hidden w-36 xl:table-cell", cost: "hidden w-44 xl:table-cell",
} as const;
const HEADINGS: [keyof typeof COLUMNS, string][] = [["session", "Session"], ["control", "Control"], ["repository", "Repository"], ["activity", "Last activity"], ["cost", "Cost"]];

/** The rows of one state, under its heading. */
type Group = { id: string; label: string; note?: string; cards: FactoryCard[] };
/** The active sessions by state, in the lanes' order. A state with no session has no group: the totals count it. */
const byLane = (cards: FactoryCard[]): Group[] => LANES
  .map((lane) => ({ id: lane.id, label: lane.label, note: lane.note, cards: cards.filter((card) => card.lane === lane.id) }))
  .filter((group) => group.cards.length > 0);
/** Ended runs by the state their source gave them, in the order each state is first seen. */
function byState(cards: FactoryCard[]): Group[] {
  const groups = new Map<string, FactoryCard[]>();
  for (const card of cards) groups.set(card.stateLabel, [...(groups.get(card.stateLabel) ?? []), card]);
  return [...groups].map(([label, held]) => ({ id: label, label, cards: held }));
}

/** The sessions as a list: one row each, under a heading for each state that names it, counts its rows and says what
 *  it means, as a lane's header does. Inside a state the rows keep their loaded order, so a child stays under the
 *  session that started it where both are in that state. A heading folds its rows away and back: its whole band is the
 *  target, and its button says which way it stands to a keyboard and a screen reader. A folded state keeps its count. */
function SessionTable({ label, scope, groups, folded, onFold, link }: { label: string; scope: string; groups: Group[]; folded: ReadonlySet<string>; onFold: (key: string) => void; link: SessionLink }) {
  return (
    <table aria-label={label} className="w-full table-fixed border-collapse border bg-card text-body">
      <thead className="hidden lg:table-header-group">
        <tr className="caps border-b text-label text-muted-foreground">
          {HEADINGS.map(([column, name]) => <th key={column} scope="col" className={cn("px-3 py-2.5 text-left font-normal", COLUMNS[column])}>{name}</th>)}
        </tr>
      </thead>
      {groups.map((group) => {
        const key = `${scope}:${group.id}`, open = !folded.has(key);
        // The button's press reaches the row, so the row's one handler serves a pointer anywhere on the band and the keyboard.
        return <tbody key={group.id} data-factory-group={group.id}>
          <tr className="cursor-pointer border-b bg-muted/50 hover:bg-accent" onClick={() => onFold(key)}>
            <th scope="rowgroup" className="p-0 text-left font-normal">
              <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span data-factory-group-name className="caps text-small font-semibold">{group.label}</span>
                  <span data-factory-group-count className="font-mono text-small text-muted-foreground">{group.cards.length}</span>
                  {group.note && <span className="text-small text-muted-foreground">{group.note}</span>}
                </span>
              </button>
            </th>
            {/* The heading's band runs the row's whole width: an empty cell under each other column that shows. */}
            {(["control", "repository", "activity", "cost"] as const).map((column) => <td key={column} aria-hidden className={COLUMNS[column]} />)}
          </tr>
          {open && group.cards.map((card) => <SessionRow key={card.id} card={card} group={group} link={link} />)}
        </tbody>;
      })}
    </table>
  );
}

function SessionRow({ card, group, link }: { card: FactoryCard; group: Group; link: SessionLink }) {
  // A child whose parent is a row of this same state sits under it, set in; one whose parent is elsewhere is a row like
  // any other. Either way it names its parent.
  const nested = card.parentLabel !== undefined && group.cards.some((each) => each.id === card.runId && each.parentLabel === undefined);
  // The group says the state: the source's own word for it follows only when it says more ("Queued", "Input required").
  const said = card.stateLabel.toLowerCase() !== group.label.toLowerCase();
  const activity = validTime(card.activityAt) ? <time dateTime={card.activityAt}>{when(card.activityAt)}</time> : null;
  const repository = card.githubLinks.length > 0 ? <GithubLinks links={card.githubLinks} /> : card.repo;
  return (
    <tr className={cn("border-b", link.open(card) && "bg-accent")} aria-current={link.open(card) ? "true" : undefined} data-factory-row={card.id} {...(nested ? { "data-factory-child": "" } : {})}>
      <td className={cn(CELL, COLUMNS.session, nested && "pl-8")}>
        <a href={link.href(card)} className="group block break-words text-left hover:text-primary-text">
          <span className="line-clamp-1 font-semibold underline-offset-2 group-hover:underline group-focus-visible:underline" title={card.agentName}>{card.agentName}</span>
          <span className="line-clamp-2 lg:line-clamp-1" title={card.title}>{card.title}</span>
        </a>
        <p data-factory-meta className="mt-1 break-words font-mono text-small text-muted-foreground">{card.sourceLabel} · <SessionRef card={card} link={link} />{said && <> · {card.stateLabel}</>}</p>
        {card.reason && <p className="mt-1 break-words">{card.reason}</p>}
        {card.action && <p className="mt-2"><NextStep card={card} link={link} /></p>}
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
