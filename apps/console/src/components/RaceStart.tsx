import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Picker } from "@/components/ui/picker";
import { pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import { type Client, ClientError } from "@/lib/client";
import { keepersByRun } from "@/lib/idempotency";
import { type LaneChoice, laneStart, MAX_LANES, MIN_LANES, newRaceLabel, raceFilter } from "@/lib/race";
import { cn } from "@/lib/utils";
import type { Run } from "@/lib/v2";

/** A harness as capabilities list it: whether it runs here, and the models a person may pick for it. */
type RaceHarness = { id: string; available: boolean; default_model?: string | null; models?: string[] };
/** What became of a lane's start: its run, or the server's words for why not. */
type Outcome = { run: Run } | { error: string };

/** Lane `i`'s first pick: the harnesses that run here in turn, each on its default model (then its next ones). */
function firstPick(runnable: RaceHarness[], i: number): LaneChoice {
  const h = runnable[i % runnable.length];
  const models = h.models ?? [];
  const start = Math.max(0, models.indexOf(h.default_model ?? ""));
  return { harness: h.id, model: models[(start + Math.floor(i / runnable.length)) % models.length] };
}

const words = (e: unknown) => (e instanceof ClientError ? e.toApiError().message : e instanceof Error ? e.message : String(e));

/** #/races/new: one task and 2 to 4 lanes, each a harness and a model this server runs. Start sends one inline run per
 *  lane (lib/race.ts laneStart), each under its own Idempotency-Key, all at once; a lane the server refuses says why in
 *  its own place and the others start all the same. Once every lane has a run it opens the race (#/races/<label>). A
 *  second Start sends only the lanes left, each under the key its request had, so no lane ever starts twice. `label`: the
 *  race's (a test's), else a new one (newRaceLabel). */
export function RaceStart({ v2, harnesses, go, label: given }: { v2: Pick<Client, "startInlineRun">; harnesses: RaceHarness[]; go: (to: string) => void; label?: string }) {
  const runnable = harnesses.filter((h) => h.available && (h.models?.length ?? 0) > 0);
  const label = useRef(given ?? newRaceLabel()).current;
  const keys = useRef(keepersByRun()).current;
  const [task, setTask] = useState("");
  const [cap, setCap] = useState("1");
  const [lanes, setLanes] = useState<LaneChoice[]>(() => (runnable.length ? Array.from({ length: MIN_LANES }, (_, i) => firstPick(runnable, i)) : []));
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const [asked, setAsked] = useState(false);
  // A form left while its lanes start opens no race: the person went somewhere else meanwhile.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  if (runnable.length === 0) return (
    <div className="flex flex-col">
      <div className={cn(pageToolbarClass, "px-5 md:px-8")}><h1 className={pageTitleClass}>New race</h1></div>
      <p role="status" className="px-5 py-8 text-body text-muted-foreground md:px-8">No harness runs on this server yet, so there is nothing to race. Add a model key in Settings → Model keys.</p>
    </div>
  );

  const capUsd = Number(cap);
  const taskMissing = !task.trim();
  const capWrong = !(Number.isFinite(capUsd) && capUsd > 0);
  const startedAny = Object.values(outcomes).some((o) => "run" in o);
  // The task and cap every lane runs: fixed once a request leaves, so a lane started again runs what the others did.
  const fixed = startedAny || sending;
  const left = lanes.map((_, i) => i).filter((i) => !(outcomes[i] && "run" in outcomes[i]));
  // A lane picked again after a refusal drops the refusal's words: they were about the pick it had.
  const pick = (i: number, lane: LaneChoice) => {
    setLanes((all) => all.map((l, j) => (j === i ? lane : l)));
    setOutcomes((all) => Object.fromEntries(Object.entries(all).filter(([j]) => Number(j) !== i)));
  };

  const start = async () => {
    setAsked(true);
    if (busy.current || taskMissing || capWrong) return;
    busy.current = true;
    setSending(true);
    const done = await Promise.all(left.map(async (i): Promise<[number, Outcome]> => {
      const body = laneStart(label, i + 1, lanes[i], task.trim(), capUsd);
      try {
        return [i, { run: await v2.startInlineRun(body, keys(String(i + 1)).keyFor("race", body)) }];
      } catch (e) {
        return [i, { error: words(e) }];
      }
    }));
    const next: Record<number, Outcome> = { ...outcomes, ...Object.fromEntries(done) };
    busy.current = false;
    setSending(false);
    setOutcomes(next);
    if (mounted.current && lanes.every((_, i) => next[i] && "run" in next[i])) go(`#/races/${encodeURIComponent(label)}`);
  };

  return (
    <div className="flex flex-col">
      <div className={cn(pageToolbarClass, "gap-3 px-5 md:px-8")}>
        <h1 className={pageTitleClass}>New race</h1>
        <span className="truncate font-mono text-small text-muted-foreground" title={raceFilter(label)}>{label}</span>
      </div>
      <form className="flex max-w-5xl flex-col gap-6 p-5 md:p-8" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <p className="text-body text-muted-foreground">Each lane runs the same task on its own harness and model, as an agent and a run of its own, labeled <span className="font-mono text-foreground">{raceFilter(label)}</span>. The race page shows them side by side.</p>
        <Field label="Task" required error={asked && taskMissing ? "Say what every lane does: the task they all run." : undefined}>
          <Textarea rows={4} value={task} readOnly={fixed} onChange={(e) => setTask(e.target.value)} placeholder="Fix the failing test in the parser, and say what was wrong." />
        </Field>
        <Field label="Spend cap per lane (USD)" className="max-w-xs" error={asked && capWrong ? "A cap above $0 for each lane." : undefined}>
          <Input type="number" inputMode="decimal" min="0" step="0.01" value={cap} readOnly={fixed} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          {lanes.map((lane, i) => {
            const outcome = outcomes[i];
            const ran = outcome && "run" in outcome ? outcome.run : undefined;
            const models = runnable.find((h) => h.id === lane.harness)?.models ?? [];
            return (
              <div key={i} data-race-lane={i + 1} className="flex flex-col gap-3 border bg-card p-4">
                <div className="flex items-center gap-2">
                  <span className="caps text-label text-muted-foreground">Lane {i + 1}</span>
                  {ran && <Chip tone="success" className="ml-auto">started</Chip>}
                </div>
                {ran && <a className="truncate font-mono text-small text-primary-text hover:underline" href={`#/runs/${encodeURIComponent(ran.run_id)}`}>{ran.run_id}</a>}
                <div data-lane-harness="" data-value={lane.harness}>
                  <Picker label={`Lane ${i + 1} harness`} value={lane.harness} disabled={!!ran || sending} className="w-full"
                    options={runnable.map((h) => ({ value: h.id, label: h.id }))}
                    onChange={(id) => pick(i, firstPick(runnable.filter((h) => h.id === id), 0))} />
                </div>
                <div data-lane-model="" data-value={lane.model}>
                  <Picker label={`Lane ${i + 1} model`} value={lane.model} disabled={!!ran || sending} className="w-full"
                    options={models.map((m) => ({ value: m, label: m }))}
                    onChange={(model) => pick(i, { ...lane, model })} />
                </div>
                {outcome && "error" in outcome && <p role="alert" className="font-mono text-small text-destructive-text">{outcome.error}</p>}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={sending || left.length === 0}>{sending ? "Starting…" : startedAny ? "Start the lanes left" : "Start the race"}</Button>
          {lanes.length < MAX_LANES && !sending && <Button type="button" onClick={() => setLanes((all) => [...all, firstPick(runnable, all.length)])}>Add a lane</Button>}
          {lanes.length > MIN_LANES && !sending && !outcomes[lanes.length - 1] && <Button type="button" variant="ghost" onClick={() => setLanes((all) => all.slice(0, -1))}>Remove lane {lanes.length}</Button>}
          {startedAny && <a className="font-mono text-small text-primary-text hover:underline" href={`#/races/${encodeURIComponent(label)}`}>Watch the race</a>}
        </div>
      </form>
    </div>
  );
}
