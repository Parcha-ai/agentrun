import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Picker } from "@/components/ui/picker";
import { pageBodyClass, pageClass, pageTitleClass, pageToolbarClass } from "@/components/ui/toolbar";
import type { ToolOffer } from "@/lib/agentForm";
import { type Client, ClientError } from "@/lib/client";
import { keepersByRun } from "@/lib/idempotency";
import type { Places } from "@/lib/place";
import { type LaneChoice, laneKit, type LaneStart, laneStart, MAX_LANES, MIN_LANES, newRaceLabel, raceFilter } from "@/lib/race";
import { cn } from "@/lib/utils";
import type { Run } from "@/lib/v2";

/** A harness as capabilities list it: whether it runs here, and the models a person may pick for it. */
type RaceHarness = { id: string; available: boolean; default_model?: string | null; models?: string[] };
/** What became of a lane's start: its run; the server's refusal, in its words (nothing started, so the lane may change);
 *  or an answer that never came whole (it may have started, so the lane keeps the requests it sent, and Start sends them
 *  again: its agent's id names the agent already made, and its run's key the run, if the server made either). */
type Outcome = { run: Run } | { error: string } | { unsure: LaneStart };

/** The models a lane of `h` may run on: those capabilities offer for it, else its default model alone. A plan-billed
 *  harness (Cursor on its own sign-in) offers no list, only the model its agent picks (`cursor/default`). */
function choices(h: RaceHarness): string[] {
  if (h.models?.length) return h.models;
  return h.default_model ? [h.default_model] : [];
}

/** Lane `i`'s first pick: the harnesses that run here in turn, each on its default model (then its next ones). */
function firstPick(runnable: RaceHarness[], i: number): LaneChoice {
  const h = runnable[i % runnable.length];
  const models = choices(h);
  const start = Math.max(0, models.indexOf(h.default_model ?? ""));
  return { harness: h.id, model: models[(start + Math.floor(i / runnable.length)) % models.length] };
}

/** Whether `e` is the server saying no, nothing started: a 4xx with its error object, other than an idempotency answer
 *  (a start under this key it may still be making). A lost answer, a timeout or a 5xx may have started the run. */
const refused = (e: unknown): e is ClientError =>
  e instanceof ClientError && e.status >= 400 && e.status < 500 && e.code !== "http_error" && !e.code.startsWith("idempotency_");

/** Makes a lane's agent, or finds it made, and answers its first revision, the one the lane's run runs. Its id is already
 *  here only when an earlier send of this same lane made it (laneStart), so its version 1 is that send's definition,
 *  whatever an edit in the Agents list made current since. */
async function laneAgent(v2: Pick<Client, "createAgent" | "listRevisions">, agent: LaneStart["agent"]): Promise<string> {
  try {
    return (await v2.createAgent({ definition: agent })).revision;
  } catch (e) {
    if (!(e instanceof ClientError && e.code === "agent_exists")) throw e;
  }
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<Client["listRevisions"]>> = await v2.listRevisions(agent.id, cursor);
    const first = page.revisions.find((r) => r.version === 1);
    if (first) return first.revision;
    cursor = page.next_cursor;
  } while (cursor);
  throw new Error(`${agent.id} lists no first revision`);
}

/** A lane's pick as the form numbers it: its lane, harness, model and tools. */
const pickKey = (n: number, agent: Pick<LaneStart["agent"], "harness" | "model" | "tools">) => JSON.stringify([n, agent.harness, agent.model, agent.tools]);

/** #/races/new: one task and 2 to 4 lanes, each a harness and a model this server runs. Start makes each lane an agent
 *  and starts a run of it (lib/race.ts laneStart), each run under its own Idempotency-Key, all lanes at once; a lane the
 *  server refuses says why in its own place and the others start all the same. Once every lane has a run it opens the
 *  race (#/races/<label>). A second Start sends only the lanes left, each as it was sent, so no lane ever starts twice.
 *  `label`: the race's (a test's), else a new one (newRaceLabel). `tools` and `places`: capabilities' tool offers and
 *  places, which give each lane a new agent's tools and box (laneKit). */
export function RaceStart({ v2, harnesses, tools, places, go, label: given }: { v2: Pick<Client, "createAgent" | "listRevisions" | "startRun" | "archiveAgent">; harnesses: RaceHarness[]; tools: ToolOffer[]; places: Places | null; go: (to: string) => void; label?: string }) {
  const runnable = harnesses.filter((h) => h.available && choices(h).length > 0);
  const label = useRef(given ?? newRaceLabel()).current;
  const keys = useRef(keepersByRun()).current;
  // Each pick the form has sent (pickKey), numbered in turn: the same pick is the same agent.
  const picks = useRef(new Map<string, number>()).current;
  const counted = useRef(0);
  const pickOf = (key: string) => {
    if (!picks.has(key)) picks.set(key, ++counted.current);
    return picks.get(key)!;
  };
  // Each lane's agent made for a run that has not started (refused): archived when the lane is removed or picked again,
  // and its pick forgotten, so that pick sent again makes a new agent. Best effort: an agent the archive misses stays in
  // the Agents list, archivable there.
  const idle = useRef(new Map<number, { id: string; key: string }>()).current;
  const letGo = (i: number) => {
    const made = idle.get(i);
    if (!made) return;
    idle.delete(i);
    picks.delete(made.key);
    v2.archiveAgent(made.id).catch(() => {});
  };
  const [task, setTask] = useState("");
  const [cap, setCap] = useState("1");
  const seed = () => Array.from({ length: MIN_LANES }, (_, i) => firstPick(runnable, i));
  const [lanes, setLanes] = useState<LaneChoice[]>(() => (runnable.length ? seed() : []));
  // Capabilities read again may name a harness that runs where none did: the race gets the lanes it needs then.
  useEffect(() => { if (runnable.length && !lanes.length) setLanes(seed()); }, [runnable.length, lanes.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const [asked, setAsked] = useState(false);
  // A form left while its lanes start opens no race: the person went somewhere else meanwhile.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  if (runnable.length === 0) return (
    <div className={pageClass}>
      <div className={cn(pageToolbarClass, "px-5 md:px-8")}><h1 className={pageTitleClass}>New race</h1></div>
      <p role="status" data-page-body className={cn(pageBodyClass, "px-5 py-8 text-body text-muted-foreground md:px-8")}>No harness runs on this server yet, so there is nothing to race. Add a model key in Settings → Model keys.</p>
    </div>
  );

  const capUsd = Number(cap);
  const taskMissing = !task.trim();
  const capWrong = !(Number.isFinite(capUsd) && capUsd > 0);
  const startedAny = Object.values(outcomes).some((o) => "run" in o);
  const unsure = (i: number) => !!outcomes[i] && "unsure" in outcomes[i];
  // The task and cap every lane runs: fixed once a request leaves, so a lane started again runs what the others did.
  const fixed = startedAny || sending || lanes.some((_, i) => unsure(i));
  const left = lanes.map((_, i) => i).filter((i) => !(outcomes[i] && "run" in outcomes[i]));
  // A lane picked again after a refusal drops the refusal's words: they were about the pick it had.
  const pick = (i: number, lane: LaneChoice) => {
    letGo(i);
    setLanes((all) => all.map((l, j) => (j === i ? lane : l)));
    setOutcomes((all) => Object.fromEntries(Object.entries(all).filter(([j]) => Number(j) !== i)));
  };

  const fresh = (i: number) => {
    const kit = laneKit(lanes[i].harness, tools, places);
    return laneStart(label, i + 1, lanes[i], task.trim(), capUsd, kit, pickOf(pickKey(i + 1, { ...lanes[i], tools: kit.tools })));
  };
  const opened = (all: Record<number, Outcome>, count: number) => Array.from({ length: count }, (_, i) => all[i]).every((o) => o && "run" in o);
  // The last lane goes only while nothing of it may be running: never sent, or refused (a refusal started nothing). Then
  // the lanes left may all have runs, and the race opens.
  const last = outcomes[lanes.length - 1];
  const removable = !last || "error" in last;
  const remove = () => {
    const count = lanes.length - 1;
    letGo(count);
    const kept = Object.fromEntries(Object.entries(outcomes).filter(([j]) => Number(j) < count));
    setLanes((all) => all.slice(0, count));
    setOutcomes(kept);
    if (opened(kept, count)) go(`#/races/${encodeURIComponent(label)}`);
  };

  const start = async () => {
    setAsked(true);
    if (busy.current || taskMissing || capWrong || lanes.length < MIN_LANES) return;
    busy.current = true;
    setSending(true);
    const done = await Promise.all(left.map(async (i): Promise<[number, Outcome]> => {
      const was = outcomes[i];
      const sent = was && "unsure" in was ? was.unsure : fresh(i);
      try {
        const revision = await laneAgent(v2, sent.agent);
        idle.set(i, { id: sent.agent.id, key: pickKey(i + 1, sent.agent) });
        // Its first revision, by id: an edit made in the Agents list meanwhile never changes what this lane runs.
        const body = { ...sent.run, revision };
        const { run } = await v2.startRun(sent.agent.id, body, keys(String(i + 1)).keyFor(sent.agent.id, body));
        idle.delete(i);
        return [i, { run }];
      } catch (e) {
        return [i, refused(e) ? { error: e.message } : { unsure: sent }];
      }
    }));
    const next: Record<number, Outcome> = { ...outcomes, ...Object.fromEntries(done) };
    busy.current = false;
    setSending(false);
    setOutcomes(next);
    if (mounted.current && opened(next, lanes.length)) go(`#/races/${encodeURIComponent(label)}`);
  };

  return (
    <div className={pageClass}>
      <div className={cn(pageToolbarClass, "gap-3 px-5 md:px-8")}>
        <h1 className={pageTitleClass}>New race</h1>
        <span className="truncate font-mono text-small text-muted-foreground" title={raceFilter(label)}>{label}</span>
      </div>
      <div data-page-body className={pageBodyClass}>
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
            const offered = runnable.find((h) => h.id === lane.harness);
            const models = offered ? choices(offered) : [];
            return (
              <div key={i} data-race-lane={i + 1} className="flex flex-col gap-3 border bg-card p-4">
                <div className="flex items-center gap-2">
                  <span className="caps text-label text-muted-foreground">Lane {i + 1}</span>
                  {ran && <Chip tone="success" className="ml-auto">started</Chip>}
                </div>
                {ran && <a className="truncate font-mono text-small text-primary-text hover:underline" href={`#/runs/${encodeURIComponent(ran.run_id)}`}>{ran.run_id}</a>}
                <div data-lane-harness="" data-value={lane.harness}>
                  <Picker label={`Lane ${i + 1} harness`} value={lane.harness} disabled={!!ran || sending || unsure(i)} className="w-full"
                    options={runnable.map((h) => ({ value: h.id, label: h.id }))}
                    onChange={(id) => pick(i, firstPick(runnable.filter((h) => h.id === id), 0))} />
                </div>
                <div data-lane-model="" data-value={lane.model}>
                  <Picker label={`Lane ${i + 1} model`} value={lane.model} disabled={!!ran || sending || unsure(i)} className="w-full"
                    options={models.map((m) => ({ value: m, label: m }))}
                    onChange={(model) => pick(i, { ...lane, model })} />
                </div>
                {outcome && "error" in outcome && <p role="alert" className="font-mono text-small text-destructive-text">{outcome.error}</p>}
                {outcome && "unsure" in outcome && <p role="status" className="font-mono text-small text-warning-text">Not sure this lane started; Start again checks.</p>}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={sending || left.length === 0 || lanes.length < MIN_LANES}>{sending ? "Starting…" : startedAny ? "Start the lanes left" : "Start the race"}</Button>
          {lanes.length < MAX_LANES && !sending && <Button type="button" onClick={() => setLanes((all) => [...all, firstPick(runnable, all.length)])}>Add a lane</Button>}
          {lanes.length > MIN_LANES && !sending && removable && <Button type="button" variant="ghost" onClick={remove}>Remove lane {lanes.length}</Button>}
          {startedAny && <a className="font-mono text-small text-primary-text hover:underline" href={`#/races/${encodeURIComponent(label)}`}>Watch the race</a>}
        </div>
      </form>
      </div>
    </div>
  );
}
