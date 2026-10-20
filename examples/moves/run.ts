// The supervisor's side of the example, with its hosts and its disk handed in: start the run on the local host, wait for it to ask
// for the move, hand it to the Modal host, then back. It holds no key. `main.ts` builds the live ones; the offline test builds
// stand-ins that run the same app through the CLI on a local directory.
import type { RunRecord } from "@parcha/pi-durable-disk";
import type { Where } from "./tools.ts";

/** One incarnation the supervisor started, with every id it will need to end it. */
export interface Started {
  readonly where: Where;
  /** An exact id of what was started (a systemd unit, a Modal sandbox), named in the cleanup ledger. */
  readonly id: string;
  /** What `stop` takes back. */
  readonly handle: unknown;
}

export interface MovesDeps {
  /** Start the run's next incarnation on `where`. `demand` starts a run that is paused. */
  startOn(where: Where, demand: boolean): Promise<Started>;
  /** The run's `run.json`, or null before there is one. */
  status(): Promise<RunRecord | null>;
  /** Stop one incarnation (drain it, then remove its unit or sandbox). */
  stop(started: Started): Promise<void>;
  /** A file the session wrote under the run's `work/`, read from the disk. */
  work(name: string): Promise<string>;
  /** Everything the run left: its tree, its token users, anything of its fleet still listed. Returns what it removed and what is left. */
  cleanup(): Promise<{ removed: string[]; left: string[] }>;
  /** One line of the take's own log (the recording). */
  say(line: string): void;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface MovesReport {
  readonly generations: { generation: number; where: Where; seconds: number; status: string; record: RunRecord }[];
  readonly threads: { n: number; metric: number | null; settings: string | null; gpu: string | null }[];
  readonly picked: number | null;
  readonly answer: string;
  readonly ledger: { started: string[]; left: string[] };
}

const WAIT_MS = 600_000;

async function waitFor<T>(deps: MovesDeps, what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = WAIT_MS): Promise<T> {
  for (const until = Date.now() + timeoutMs; ; await deps.sleep(1_000)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
  }
}

/** The three generations in order, then the cleanup. Throws with what went wrong; the cleanup runs either way. */
export async function moves(deps: MovesDeps): Promise<MovesReport> {
  const started: Started[] = [];
  const stopped = new Set<Started>();
  const stop = async (one: Started) => {
    if (stopped.has(one)) return;
    stopped.add(one);
    await deps.stop(one);
  };
  const generations: MovesReport["generations"] = [];
  const stages: { where: Where; expect: "paused" | "done"; to?: Where }[] = [
    { where: "local", expect: "paused", to: "modal" },
    { where: "modal", expect: "paused", to: "local" },
    { where: "local", expect: "done" },
  ];
  let problem: Error | undefined;
  let report: Omit<MovesReport, "ledger"> | undefined;
  try {
    for (const [i, stage] of stages.entries()) {
      const generation = i + 1;
      const t0 = Date.now();
      deps.say(`generation ${generation}: starting on ${stage.where === "modal" ? "the Modal VM" : "the local host"}`);
      const one = await deps.startOn(stage.where, generation > 1);
      started.push(one);
      const record = await waitFor(deps, `generation ${generation} to ${stage.expect === "done" ? "finish" : "ask to move"}`, async () => {
        const r = await deps.status();
        if (r?.status === "failed") throw new Error(`generation ${generation} failed: ${JSON.stringify(r.detail)}`);
        return r && r.generation === generation && r.status === stage.expect && typeof r.sealedSeq === "number" && r;
      });
      if (stage.to && (record.detail as { moveTo?: string } | null)?.moveTo !== stage.to) throw new Error(`generation ${generation} paused for ${JSON.stringify(record.detail)}, not a move to ${stage.to}`);
      generations.push({ generation, where: stage.where, seconds: Math.round((Date.now() - t0) / 100) / 10, status: record.status, record });
      deps.say(`generation ${generation}: ${record.status}${stage.to ? `, moving to ${stage.to === "modal" ? "the Modal VM" : "the local host"}` : ""} (${(Date.now() - t0) / 1000} s)`);
      // The incarnation has released; take its unit or sandbox away before the next one starts.
      await stop(one);
    }
    const threads = (JSON.parse(await deps.work("threads.json")) as { threads: MovesReport["threads"] }).threads;
    const finished = JSON.parse(await deps.work("report.json")) as { picked: number | null; answer: string };
    report = { generations, threads, picked: finished.picked, answer: finished.answer };
    for (const t of threads) deps.say(`thread ${t.n}: ${t.gpu ?? "(no GPU line)"}, metric ${t.metric}, settings ${t.settings}`);
    deps.say(`the session answered: ${finished.answer}`);
  } catch (error) {
    problem = error as Error;
  }
  for (const one of [...started].reverse()) await stop(one).catch(() => {});
  const cleaned = await deps.cleanup();
  if (cleaned.left.length) problem = new Error(`${problem ? `${problem.message}; ` : ""}left behind: ${cleaned.left.join(", ")}`);
  if (problem || !report) throw problem ?? new Error("no report");
  return { ...report, ledger: { started: started.map((s) => s.id), left: cleaned.left } };
}
