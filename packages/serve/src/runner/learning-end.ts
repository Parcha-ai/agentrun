// The end-of-run step of a run that learns, on the runner: the reflect hook (reflect-hook.ts createReflectHook) over the
// run's store, driven by the learning start its launch records (run-launch.ts learningStartOf), which the server decided
// once at the run's start. A spec builder gives the adapter loop `endOfRun: learningEndOfRun(launch, deps)`. Each of the
// hook's reads is the server's own rule, over the store in place of the run's directory:
//   - whether it looks back (learning-run.ts reflectSkip): its cap and its spend so far, read as its view reads them;
//   - its prompt's facts: how many notes its seed held (launch seedNotes) and the tools a workflow draft may name
//     (learning-run.ts draftTools);
//   - what the person said in the run and a trigger's input (heard.ts Hearing over its entries, the end-of-run turn's
//     own left out), as learning-run.ts turnOf reads them;
//   - the checks: propose.ts proposeRun against the seed it started from, the server's one rule, which keeps the
//     proposal the hook stores beside the run's end (learning_proposals).
// A proposal queues the learning run (learning_run), which the runner's dispatch runs on the learning loop
// (harness-loops.ts: harness "learning"), to grade and merge it. A run whose seed could not be read keeps that drop.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Hearing } from "../heard.js";
import { gradeModelOf, PROPOSAL } from "../learning.js";
import { reflects, type Reflect } from "../learning-run.js";
import { said, STOPPED } from "../learning-words.js";
import { proposeRun } from "../propose.js";
import { learningStartOf, type RunLaunch } from "../run-launch.js";
import { costOf } from "../run-view.js";
import { hostSecrets } from "../secrets.js";
import type { Store } from "../store/store.js";
import { runEntries, runReflect, runTimeline } from "../store-reads/journal.js";
import type { EndOfRunTurn } from "./loop-contract.js";
import { type Checked, createReflectHook, type ReflectTurn } from "./reflect-hook.js";

/** What the step reads: the run's store, the data directory its agents' learning folders are in (the learning loop's
 *  `data`), and the runner's environment (the host's secrets a proposal is refused for; the grade model it names). */
export interface LearningEndDeps {
  readonly store: Store;
  readonly data: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The grade model the server names (learning.ts gradeModelOf); none, from `env` as the server reads it. */
  readonly gradeModel?: string;
}

/** The end-of-run step for a run launched with `launch`: undefined when its launch records no learning start (a run that
 *  does not learn is asked nothing and keeps nothing), else the reflect hook over the run's store. */
export function learningEndOfRun(launch: RunLaunch, deps: LearningEndDeps): EndOfRunTurn | undefined {
  const start = learningStartOf(launch);
  if (!start) return undefined;
  const env = deps.env ?? process.env;
  const gradeModel = deps.gradeModel ?? gradeModelOf(env);
  const capUsd = launch.maxCostUsd;
  const hookFor = (runId: string) => createReflectHook({
    // reflectSkip's facts: a run its cap stopped has no room left, and one whose spend is unknown under a cap cannot be
    // kept within it. A person's stop comes to the hook as its `cut`.
    facts: async (runId) => {
      const costUsd = costOf(await runTimeline(deps.store, runId, BACKGROUND_CONTEXT, { settled: false }));
      return { learns: true, costUsd, ...(capUsd !== undefined ? { capUsd, capReached: costUsd !== null && costUsd >= capUsd } : {}) };
    },
    promptFacts: async (runId) => ({ active: start.seedNotes ?? start.given.length, tools: (await draftTools(deps, runId)).tools }),
    asked: async (runId) => {
      const [entries, reflect] = await Promise.all([runEntries(deps.store, runId, BACKGROUND_CONTEXT), runReflect(deps.store, runId, BACKGROUND_CONTEXT)]);
      const hearing = new Hearing();
      for (const entry of entries) hearing.note(entry);
      const heard = [...hearing.heard].filter(([id]) => !reflects(reflect as Reflect | undefined, id)).sort(([a], [b]) => a - b).map(([, one]) => one);
      const triggered = heard.flatMap(({ text, source }) => (source === undefined ? [] : [{ source, text }]));
      return { asked: heard.filter((one) => one.source === undefined).map(({ text }) => text), ...(triggered.length ? { triggered } : {}) };
    },
    check: async ({ runId, agentId, turn, outcome }) => {
      if (start.seed === null) throw new Error("the run's learning start names no commit of main to propose against");
      return checkedOf(deps, { runId, agentId, seed: start.seed, turn, outcome, refuse: hostSecrets(env) });
    },
    // The learning run's id, one per run: a replayed end queues the same one (the store adds it once).
    newRunId: () => `${runId}-learning`,
    ...(gradeModel ? { gradeModel } : {}),
  });
  return async (input) => {
    // A seed that could not be read (no seedNotes, no commit): the server dropped its learning at the start, and the run
    // was never asked to look back.
    if (start.seed === null && start.seedNotes === undefined) {
      return { also: [{ table: "learning_proposals", row: { turn: null, proposal: { state: "dropped", reason: "seed_failed", detail: said.stopped(STOPPED.notCopied) } } }] };
    }
    return hookFor(input.runId)(input);
  };
}

/** The tools a workflow draft may name (learning-run.ts draftTools): the revision's own, as its run's gate reads them
 *  with the server's settings (from the store) and the agent's; none for a workflow revision. */
async function draftTools(deps: LearningEndDeps, runId: string): Promise<{ tools: string[]; gated: Record<string, string> }> {
  const run = await deps.store.runs.get(runId);
  const revision = run ? await deps.store.agents.revision(run.revisionId) : undefined;
  if (revision?.kind !== "agentic") return { tools: [], gated: {} };
  const body = revision.body as { tools?: string[]; toolSettings?: unknown; approvals?: string };
  const [{ learnedDraftTools }, { permissionFrom }, { loadToolSettings }] = await Promise.all([import("../tools.js"), import("../tool-gate.js"), import("../tool-plane.js")]);
  // The server's settings from the one store, as the run's gate reads them: a stored row that does not read carries
  // SETTINGS_UNREAD, which permissionFrom honours (no ask is lifted over a deny the row may hold).
  const server = (await loadToolSettings(deps.store)).settings;
  const agent = (body.toolSettings ?? {}) as never;
  const approvals = body.approvals === "never" ? "never" : "ask";
  const { tools, gated } = learnedDraftTools(body.tools ?? [], (name) => permissionFrom(name, server as never, agent, approvals).permission, undefined, (name) => permissionFrom(name, server as never, agent, approvals).from);
  return { tools, gated };
}

/** proposeRun's checks over the turn, against seed `seed`, in a directory of the step's own: the proposal it keeps there
 *  is read back for the hook to store with the run's end, and the directory is removed. */
async function checkedOf(deps: LearningEndDeps, input: { runId: string; agentId: string; seed: string; turn: ReflectTurn; outcome: "completed" | "failed"; refuse: readonly string[] }): Promise<Checked> {
  const runDir = await mkdtemp(join(tmpdir(), "agentrun-learning-end-"));
  try {
    const { tools, gated } = await draftTools(deps, input.runId);
    const turn = { answer: input.turn.answer, asked: [...input.turn.asked], ...(input.turn.triggered?.length ? { triggered: input.turn.triggered.map((one) => ({ ...one })) } : {}) };
    const proposed = await proposeRun({ data: deps.data, agentId: input.agentId, runDir, seed: input.seed, turn, refuse: input.refuse, outcome: input.outcome, tools, ...(Object.keys(gated).length ? { gated } : {}) });
    if (proposed.state !== "proposed") return proposed as Checked;
    const proposal: unknown = JSON.parse(await readFile(join(runDir, PROPOSAL), "utf8"));
    return { ...proposed, proposal };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}
