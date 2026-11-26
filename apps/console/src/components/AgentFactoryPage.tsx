import { useEffect, useMemo, useState } from "react";
import { AgentFactoryBoard, type FactoryView } from "./AgentFactoryBoard";
import { useResumed } from "./Connection";
import type { Client } from "@/lib/client";
import { problemOf } from "@/lib/client";
import { FACTORY_PAGE_BATCH, FACTORY_POLL_MS, factoryCards, readFactoryScope, reconcileFactoryRuns, savedFactoryView, saveFactoryView } from "@/lib/factory";
import type { FactoryRun } from "@/lib/v2";

type ScopeRead = { runs: FactoryRun[]; hasMore: boolean };
type Snapshot = { active: ScopeRead; review: ScopeRead; updatedAt: string | null };
const EMPTY: ScopeRead = { runs: [], hasMore: false };

/** Polls bounded, keyset-paged projections. It keeps the last successful board on failure and never lets an older
 * request replace a new read, even when changing clients or leaving the page while a request is in flight. */
export function AgentFactoryPage({ v2, agentName }: { v2: Pick<Client, "listFactoryRuns">; agentName: (id: string) => string }) {
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
  return <AgentFactoryBoard cards={cards} review={review} loading={reading && snapshot.updatedAt === null && !cards.length && !review.length}
    refreshing={reading} error={error} updatedAt={snapshot.updatedAt} hasMore={snapshot.active.hasMore || snapshot.review.hasMore}
    onLoadMore={() => setPages((n) => n + FACTORY_PAGE_BATCH)} onRefresh={() => setRefresh((n) => n + 1)}
    view={view} onView={(next) => { saveFactoryView(next); setView(next); }} />;
}
