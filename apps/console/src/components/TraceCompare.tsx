import { useEffect, useMemo, useState } from "react";
import { ProblemCard } from "@/components/Problem";
import { RunSkeleton } from "@/components/Skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import type { Client } from "@/lib/client";
import { runTitle } from "@/lib/format";
import { problem } from "@/lib/problem";
import { duration, usd } from "@/lib/trace";
import { compareFigures, compareModels, compareTools, differenceWords, MIN_COMPARED, partial, type Side, sideOf } from "@/lib/traceCompare";
import { cn } from "@/lib/utils";

const TH = "caps whitespace-nowrap px-3 py-2 text-right text-label font-normal text-muted-foreground first:text-left";
const TD = "whitespace-nowrap px-3 py-2 text-right font-mono";
const ROW_HEAD = "px-3 py-2 text-left text-body font-normal";

/** Two to four runs' Dev tools figures side by side (lib/traceCompare.ts): a column a run, in the order the address names
 *  them, and with two runs what the second is against the first. Each run and its trace are read once, when the page
 *  opens: a run still going is compared as it stood then, and the page says so. Read-only: a run's name links to its
 *  own page, whose Dev tools tab has every call. */
export function TraceCompare({ v2, ids, now: fixed }: { v2: Pick<Client, "getRun" | "runTrace">; ids: readonly string[]; now?: number }) {
  const [sides, setSides] = useState<Side[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reads, setReads] = useState(0);
  const key = ids.join(",");
  useEffect(() => {
    if (ids.length < MIN_COMPARED) return;
    let alive = true;
    setSides(null);
    setError(null);
    Promise.all(ids.map(async (id) => { const [run, trace] = await Promise.all([v2.getRun(id), v2.runTrace(id)]); return sideOf(run, trace, fixed ?? Date.now()); }))
      .then((read) => { if (alive) setSides(read); }, (failed) => { if (alive) setError(failed); });
    return () => { alive = false; };
  }, [key, reads]); // eslint-disable-line react-hooks/exhaustive-deps
  const figures = useMemo(() => (sides ? compareFigures(sides) : []), [sides]);
  const tools = useMemo(() => (sides ? compareTools(sides) : []), [sides]);
  const models = useMemo(() => (sides ? compareModels(sides) : []), [sides]);

  const bar = (
    <div className={cn(pageToolbarClass, "gap-3 px-5 md:px-8")}>
      <h1 className={pageTitleClass}>Compare runs</h1>
      {ids.length >= MIN_COMPARED && <span className="caps ml-auto text-label text-muted-foreground">{ids.length} runs</span>}
    </div>
  );
  if (ids.length < MIN_COMPARED) {
    return <div className="flex flex-col">{bar}<p role="status" className="px-5 py-8 text-body text-muted-foreground md:px-8">This address names {ids.length === 1 ? "one run" : "no run"}. A comparison takes two to four: open a run's Dev tools tab and choose Compare, or open a race.</p></div>;
  }
  if (error) return <div className="flex flex-col">{bar}<ProblemCard className="m-5 md:m-8" problem={problem(error, "the runs to compare")} onRetry={() => setReads((n) => n + 1)} /></div>;
  if (!sides) return <RunSkeleton />;

  const pair = sides.length === 2;
  const going = sides.filter((side) => !side.run.ended_at).length;
  /** How the page names a run: by its place. */
  const nameOf = (i: number) => (pair ? (i === 0 ? "The first run" : "The second run") : `Run ${i + 1}`);
  const NOT_SAID = <><span aria-hidden>–</span><span className="sr-only">Not said</span></>;
  /** A run's column heading: where it stands in the comparison, its title (a link to its page) and how it ended. */
  const heads = sides.map((side, i) => (
    <th key={side.run.run_id} scope="col" className={cn(TH, "min-w-40 max-w-64 align-bottom")}>
      <span className="block text-muted-foreground">{pair ? (i === 0 ? "First" : "Second") : `Run ${i + 1}`}</span>
      <a href={`#/runs/${encodeURIComponent(side.run.run_id)}`} className="mt-1 block truncate font-mono text-small font-semibold normal-case tracking-normal text-foreground underline underline-offset-2" title={runTitle(side.run)}>{runTitle(side.run)}</a>
      <span className="mt-1 flex justify-end normal-case tracking-normal"><StatusBadge run={side.run} /></span>
    </th>
  ));
  const scroll = (label: string) => ({ className: "overflow-x-auto border bg-card", tabIndex: 0, role: "region", "aria-label": label }) as const;
  return (
    <div className="flex flex-col">
      {bar}
      <div className="space-y-6 p-5 md:p-8">
        {/* A trace is a run's first 2,000 requests and calls: a longer run's figures are of that part, and are said so. */}
        {sides.map((side, i) => partial(side) && (
          <p key={side.run.run_id} role="status" data-partial className="text-body text-muted-foreground">{nameOf(i)}'s trace holds its first {side.trace.spans.length.toLocaleString("en-US")} requests and calls; {side.trace.dropped.toLocaleString("en-US")} later ones are not counted. Its figures from the trace are at least what is shown, and no difference is said of them. Its cost is the run's own, not summed from the trace.</p>
        ))}
        {going > 0 && <p role="status" className="text-body text-muted-foreground">{going === 1 ? "One of these runs is" : `${going} of these runs are`} still going: {going === 1 ? "its" : "their"} figures are as they stood when this page opened. Open the page again for newer ones.</p>}
        <section aria-label="The runs in figures">
          <h2 className="caps mb-2 text-small font-semibold">The runs in figures</h2>
          <div {...scroll("The runs' figures, side by side")}>
            <table className="w-full text-small">
              <thead><tr className="border-b"><th scope="col" className={TH}>Figure</th>{heads}{pair && <th scope="col" className={cn(TH, "align-bottom")}>Second against first</th>}</tr></thead>
              <tbody>
                {figures.map((row) => {
                  const said = pair ? differenceWords(row) : null;
                  return (
                    <tr key={row.label} className="border-b last:border-b-0">
                      <th scope="row" className={ROW_HEAD}>{row.label}</th>
                      {row.cells.map((cell, i) => <td key={i} className={TD}>{cell.value === null ? <><span aria-hidden>–</span><span className="sr-only">Not known</span></> : cell.words}</td>)}
                      {pair && <td className={cn(TD, said === "Same" && "text-muted-foreground")} data-difference>{said ?? NOT_SAID}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 max-w-prose text-small text-muted-foreground">Each figure is the one the run's own Dev tools tab shows. A difference is the second run's figure less the first's; its percent is of the first's. None is said of a figure that is not known, or not exact: "at least" is a sum over a part of the run, or a cost that leaves out a charge with no price; "at most" is a cost that counts a cut request at what was held for it.</p>
        </section>

        {tools.length > 0 && (
          <section aria-label="By tool">
            <h2 className="caps mb-2 text-small font-semibold">By tool</h2>
            <div {...scroll("Each tool's calls and time, by run")}>
              <table className="w-full text-small">
                <thead><tr className="border-b"><th scope="col" className={TH}>Tool</th>{sides.map((side, i) => <th key={side.run.run_id} scope="col" className={TH}>{pair ? (i === 0 ? "First" : "Second") : `Run ${i + 1}`}: calls · time</th>)}</tr></thead>
                <tbody>
                  {tools.map((tool) => (
                    <tr key={tool.name} className="border-b last:border-b-0">
                      <th scope="row" className={cn(ROW_HEAD, "font-mono text-small")}>{tool.name}</th>
                      {tool.calls.map((calls, i) => (
                        <td key={i} className={cn(TD, calls === 0 && "text-muted-foreground")}>{calls === 0 ? (partial(sides[i]!) ? "None in the part read" : "Not called") : `${partial(sides[i]!) ? "at least " : ""}${calls.toLocaleString("en-US")}${tool.failed[i] ? ` (${tool.failed[i]} failed)` : ""} · ${duration(tool.ms[i]!)}`}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {models.length > 0 && (
          <section aria-label="By model">
            <h2 className="caps mb-2 text-small font-semibold">By model</h2>
            <div {...scroll("Each model's requests, tokens and cost, by run")}>
              <table className="w-full text-small">
                <thead><tr className="border-b"><th scope="col" className={TH}>Model</th>{sides.map((side, i) => <th key={side.run.run_id} scope="col" className={TH}>{pair ? (i === 0 ? "First" : "Second") : `Run ${i + 1}`}: requests · tokens · cost</th>)}</tr></thead>
                <tbody>
                  {models.map((model) => (
                    <tr key={model.name} className="border-b last:border-b-0">
                      <th scope="row" className={cn(ROW_HEAD, "font-mono text-small")}>{model.name}</th>
                      {model.requests.map((requests, i) => (
                        <td key={i} className={cn(TD, !requests && "text-muted-foreground")}>{requests === null ? "Not recorded" : requests === 0 ? (partial(sides[i]!) ? "None in the part read" : "Not used") : `${partial(sides[i]!) ? "at least " : ""}${requests.toLocaleString("en-US")} · ${model.tokens[i]!.toLocaleString("en-US")} · ${model.usd[i] === null ? "cost unknown" : usd(model.usd[i]!)}`}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
