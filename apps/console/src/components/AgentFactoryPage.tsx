import { useEffect, useMemo, useRef, useState } from "react";
import { AgentFactoryBoard, type FactoryView } from "./AgentFactoryBoard";
import { useResumed } from "./Connection";
import { FactorySession } from "./FactorySession";
import type { Client } from "@/lib/client";
import { problemOf } from "@/lib/client";
import { FACTORY_PAGE_BATCH, FACTORY_POLL_MS, factoryCards, factoryHash, type FactoryFilters, type FactoryPlace, NO_FACTORY_FILTERS, readFactoryScope, reconcileFactoryRuns, savedFactoryView, saveFactoryView } from "@/lib/factory";
import { runLabel } from "@/lib/format";
import type { MessageCaps } from "@/lib/liveRun";
import type { FactoryRun } from "@/lib/v2";

type ScopeRead = { runs: FactoryRun[]; hasMore: boolean };
type Snapshot = { active: ScopeRead; review: ScopeRead; updatedAt: string | null };
const EMPTY: ScopeRead = { runs: [], hasMore: false };

/** Polls bounded, keyset-paged projections. It keeps the last successful board on failure and never lets an older
 * request replace a new read, even when changing clients or leaving the page while a request is in flight. */
export function AgentFactoryPage({ v2, agentName, caps = null, place = NO_FACTORY_FILTERS, go = (hash) => { location.hash = hash; } }: {
  v2: Client; agentName: (id: string) => string;
  /** What this server lets a person send a run: the open session's message box follows it, as a run's page does. */
  caps?: MessageCaps | null;
  /** The filters and the open session the address names (#/factory?session=…&repo=…&control=…). */
  place?: FactoryPlace;
  go?: (hash: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ active: EMPTY, review: EMPTY, updatedAt: null });
  const [pages, setPages] = useState(FACTORY_PAGE_BATCH);
  const [refresh, setRefresh] = useState(0);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // List or cards: the pick this browser kept, and kept again as it changes.
  const [view, setView] = useState<FactoryView>(() => savedFactoryView());
  useResumed(() => setRefresh((n) => n + 1));
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setReading(true);
    void Promise.allSettled([
      readFactoryScope(v2, "active", pages, controller.signal),
      readFactoryScope(v2, "review", pages, controller.signal),
    ]).then(([active, review]) => {
      if (!alive) return;
      const problems = [active, review].flatMap((read, i) => read.status === "rejected" ? [`${i === 0 ? "Active sessions" : "Review attention"}: ${problemOf(read.reason)}`] : []);
      // Absence in one successful scope cannot remove a session while the other scope failed: it may have moved
      // there. Keep the whole last-known board until both reads complete, explicitly marked stale below.
      if (active.status === "fulfilled" && review.status === "fulfilled") try {
        const a = active.value, r = review.value;
        const reconciled = reconcileFactoryRuns(a.runs, r.runs);
        const next = {
          active: { ...a, runs: reconciled.active }, review: { ...r, runs: reconciled.review },
          updatedAt: new Date().toISOString(),
        };
        setSnapshot(next);
      } catch (e) { problems.push(problemOf(e)); }
      setError(problems.length ? problems.join(" · ") : null);
      setReading(false);
      timer = setTimeout(() => setRefresh((n) => n + 1), FACTORY_POLL_MS);
    });
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [v2, pages, refresh]);
  const cards = useMemo(() => factoryCards(snapshot.active.runs, agentName), [snapshot.active.runs, agentName]);
  const review = useMemo(() => factoryCards(snapshot.review.runs, agentName, true), [snapshot.review.runs, agentName]);
  // The address holds the filters and the open session, so a reload, a link and the way back from a run's own page all
  // open the same board.
  const filters: FactoryFilters = { repository: place.repository, control: place.control };
  const sessionHref = (runId: string) => factoryHash({ ...filters, session: runId });
  const session = place.session;
  const held = session === undefined ? undefined : [...snapshot.active.runs, ...snapshot.review.runs].find((run) => run.run_id === session);
  // Closing the panel gives the keyboard back to the session's own link on the board, where it came from.
  const opened = useRef(session);
  useEffect(() => {
    const before = opened.current;
    opened.current = session;
    if (before === undefined || session !== undefined) return;
    const href = factoryHash({ repository: place.repository, control: place.control, session: before });
    const link = [...document.querySelectorAll<HTMLAnchorElement>("[data-factory-pane] a")].find((a) => a.getAttribute("href") === href);
    // Its card may have left the board while the panel was open (an answered run that ended): the keyboard then goes to
    // the board's view switch, which is always there, never to the page's body.
    (link ?? document.querySelector<HTMLInputElement>('[data-factory-pane] input[name="factory-view"]:checked'))?.focus();
  }, [session, place.repository, place.control]);
  return <AgentFactoryBoard cards={cards} review={review} loading={reading && snapshot.updatedAt === null && !cards.length && !review.length}
    refreshing={reading} error={error} updatedAt={snapshot.updatedAt} hasMore={snapshot.active.hasMore || snapshot.review.hasMore}
    onLoadMore={() => setPages((n) => n + FACTORY_PAGE_BATCH)} onRefresh={() => setRefresh((n) => n + 1)}
    view={view} onView={(next) => { saveFactoryView(next); setView(next); }}
    filters={filters} onFilters={(next) => go(factoryHash({ ...next, session }))} sessionHref={sessionHref} openSession={session}
    panel={session === undefined ? null : <FactorySession v2={v2} runId={session} caps={caps} agentName={agentName}
      label={held ? `${agentName(held.agent_id) || held.agent_id} · run ${runLabel(held.run_id)}` : `Run ${runLabel(session)}`}
      onClose={() => go(factoryHash(filters))} onChanged={() => setRefresh((n) => n + 1)} />} />;
}
