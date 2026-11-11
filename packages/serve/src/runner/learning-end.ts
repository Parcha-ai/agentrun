// The end-of-run step of a run that learns, on the runner: the reflect hook (reflect-hook.ts createReflectHook) over the
// run's store, driven by the learning start its launch records (run-launch.ts learningStartOf), which the server decided
// once at the run's start. A spec builder gives the adapter loop `endOfRun: learningEndOfRun(launch, deps)`. Each of the
// hook's reads is the server's own rule, over the store in place of the run's directory:
//   - whether it looks back (learning-run.ts reflectSkip): its cap and its spend so far, read as its view reads them;
//   - its prompt's facts: how many notes its seed held (launch seedNotes), the tools a workflow draft may name
//     (learning-run.ts draftTools), and the learned skill whose job it asks for as a workflow draft (draftForOf);
//   - what the person said in the run and a trigger's input (heard.ts Hearing over its entries, the end-of-run turn's
//     own left out), as learning-run.ts turnOf reads them;
//   - the checks: propose.ts proposeRun against the seed it started from, the server's one rule, which keeps the
//     proposal the hook stores beside the run's end (learning_proposals);
//   - what the run must never learn (learning-run.ts refused, the server's serverSecrets as far as the runner reads
//     them): every secret the server keeps sealed (store-secrets.ts storeSecrets: the store's planes, and the API token,
//     session secret and outbound webhook secret beside it), the runner's secrets, the keys its claim handed it, and
//     the sign-in pointers its row says it was handed, read back from the store (handed-values.ts handedValuesOf). A run
//     whose pointers can't be read back learns nothing (the hook drops it, saying why), never over a shorter list. A
//     runner's run has no door token: its loop runs in the runner's process.
// A proposal queues the learning run (learning_run), which the runner's dispatch runs on the learning loop
// (harness-loops.ts: harness "learning"), to grade and merge it. A run whose seed could not be read keeps that drop.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Hearing } from "../heard.js";
import { type LearningFolder, readSnapshot } from "../learn/folder.js";
import { DRAFT_AFTER_RUNS } from "../learn/reflect.js";
import { SKILL_NAME } from "../learn/skills.js";
import { handedValuesOf } from "../handed-values.js";
import { MIN_SECRET } from "../learn/secrets.js";
import { PROPOSAL } from "../learning.js";
import { reflects, type Reflect } from "../reflect-range.js";
import { said, STOPPED } from "../learning-words.js";
import { proposeRun } from "../propose.js";
import { learningStartOf, readLaunchBody, type RunLaunch, seedFailed } from "../run-launch.js";
import { costOf, type SignInReader } from "../run-view.js";
import type { Store } from "../store/store.js";
import { runEntries, runReflect, runTimeline } from "../store-reads/journal.js";
import type { EndOfRunTurn } from "./loop-contract.js";
import { type Checked, createReflectHook, type ReflectTurn } from "./reflect-hook.js";
import { runnerSecrets } from "./redact.js";

/** What the step reads: the run's store, the data directory (the server's tool settings a draft's tools are read with),
 *  the agent's learning folder (where the run's place keeps it), the runner's environment (the host's secrets a
 *  proposal is refused for; the grade model it names), and what the run was handed (its claim's keys, its sign-in's
 *  pointers through `signIns`), which it never learns. */
export interface LearningEndDeps {
  readonly store: Store;
  readonly data: string;
  /** Agent `agentId`'s learning folder, where the run's place keeps it: learningWorkspace({ mode: "local", agentId, data })
   *  in Mode 1, { mode: "archil", agentId, archil } in Mode 2. Opened for each check, and ended after it. */
  readonly learningFolder: (agentId: string) => LearningFolder;
  readonly env?: NodeJS.ProcessEnv;
  /** The agent's sign-ins, opened (sign-ins-store.ts signInReads over the store and the seal key): the pointers the run's
   *  row says it was handed are read back through them and never learned. Absent, a run marked as handed one learns
   *  nothing (its pointers can't be read back). */
  readonly signIns?: SignInReader;
  /** The secret values the run's claim handed it (claim-secrets.ts: its tool and model keys), never learned. */
  readonly handed?: readonly string[];
  /** Every secret the server keeps sealed, read once at the run's end (store-secrets.ts storeSecrets over the store, the
   *  seal key and the data directory), never learned. A throw is a list that can't be read: the run learns nothing. */
  readonly stored?: () => Promise<readonly string[]>;
}

/** The end-of-run step for a run launched with `launch`: undefined when its launch records no learning start (a run that
 *  does not learn is asked nothing and keeps nothing), else the reflect hook over the run's store. */
export function learningEndOfRun(launch: RunLaunch, deps: LearningEndDeps): EndOfRunTurn | undefined {
  const start = learningStartOf(launch);
  if (!start) return undefined;
  const env = deps.env ?? process.env;
  // The grade model the server named at the run's start (its learning start's), none: the agent's own grades it.
  const gradeModel = start.gradeModel;
  const capUsd = launch.maxCostUsd;
  const hookFor = (runId: string) => createReflectHook({
    // reflectSkip's facts: a run its cap stopped has no room left, and one whose spend is unknown under a cap cannot be
    // kept within it. A person's stop comes to the hook as its `cut`.
    facts: async (runId) => {
      const costUsd = costOf(await runTimeline(deps.store, runId, BACKGROUND_CONTEXT, { settled: false }));
      return { learns: true, costUsd, ...(capUsd !== undefined ? { capUsd, capReached: costUsd !== null && costUsd >= capUsd } : {}) };
    },
    // A draft asked for or not never stops the turn: a count that can't be read asks for none.
    promptFacts: async (runId, agentId) => {
      const { tools } = await draftTools(deps, runId);
      const draftFor = await draftForOf(deps, agentId, runId, start.skills ?? []).catch(() => []);
      // With a draft asked for, what each tool its call nodes may run takes and gives, in the server's own words.
      const described = draftFor.length ? await describedOf(tools) : [];
      return { active: start.seedNotes ?? start.given.length, tools, draftFor, described };
    },
    asked: async (runId) => {
      const [entries, reflect] = await Promise.all([runEntries(deps.store, runId, BACKGROUND_CONTEXT), runReflect(deps.store, runId, BACKGROUND_CONTEXT)]);
      const hearing = new Hearing();
      for (const entry of entries) hearing.note(entry);
      const heard = [...hearing.heard].filter(([id]) => !reflects(reflect as Reflect | undefined, id)).sort(([a], [b]) => a - b).map(([, one]) => one);
      const triggered = heard.flatMap(({ text, source }) => (source === undefined ? [] : [{ source, text }]));
      return { asked: heard.filter((one) => one.source === undefined).map(({ text }) => text), ...(triggered.length ? { triggered } : {}) };
    },
    // learning-run.ts refused(run): the runner's secrets, what the claim handed the run, every secret the server keeps
    // sealed, and the sign-in pointers it was handed (each at least MIN_SECRET long, as every cut takes them);
    // `unreadable` when those can't be read back, or the server's secrets can't be read (never a check over a shorter list).
    refuse: async (runId) => {
      const pointers = await handedValuesOf(deps, deps.store, runId);
      if (pointers === "unreadable") return "unreadable";
      let stored: readonly string[];
      try {
        stored = deps.stored ? await deps.stored() : [];
      } catch {
        return "unreadable";
      }
      return runnerSecrets(env, [...(deps.handed ?? []), ...stored, ...pointers.refs.filter((ref) => ref.length >= MIN_SECRET)]);
    },
    check: async ({ runId, agentId, turn, outcome, refuse }) => {
      if (start.seed === null) throw new Error("the run's learning start names no commit of main to propose against");
      return checkedOf(deps, { runId, agentId, seed: start.seed, turn, outcome, refuse });
    },
    // The learning run's id, one per run: a replayed end queues the same one (the store adds it once).
    newRunId: () => `${runId}-learning`,
    ...(gradeModel ? { gradeModel } : {}),
  });
  return async (input) => {
    // No seed, no end-of-run turn (seedFailed): a run that started from no commit of main has nothing to propose against,
    // so it is never asked to look back (no model request). Why, as its start recorded it: a folder that could not be
    // read, or a start that could not be made from it; a start that records none names no reason.
    if (seedFailed(start)) {
      const failed = start.seedFailed;
      const why = failed === "unreadable" ? STOPPED.unreadable : failed === "not_copied" ? STOPPED.notCopied : STOPPED.noSeed;
      return { also: [{ table: "learning_proposals", row: { turn: null, proposal: { state: "dropped", reason: "seed_failed", detail: said.stopped(why) } } }] };
    }
    return hookFor(input.runId)(input);
  };
}

/** What each of `tools` takes and gives a workflow's call node, in the server's own words for it (tools.ts ToolEntry's
 *  summary): the draft ask's `describe`. */
async function describedOf(tools: readonly string[]): Promise<{ name: string; does: string }[]> {
  const { toolOf } = await import("../tools.js");
  return tools.flatMap((name) => {
    const does = toolOf(name)?.summary;
    return does ? [{ name, does }] : [];
  });
}

/** How many of an agent's latest runs draftForOf reads at most: a skill offered to fewer than DRAFT_AFTER_RUNS of them is
 *  no repeated job. */
export const DRAFT_SCAN_RUNS = 200;

/** The learned skill whose job the end-of-run turn asks for as a workflow draft: of the skills run `runId` was offered
 *  (its launch's learning start), the first in the seed's order (the one changed last first) offered to DRAFT_AFTER_RUNS
 *  or more runs of agent `agentId` started before it (each run's launch says what it was offered; its latest
 *  DRAFT_SCAN_RUNS runs are read newest first, those after `runId` in that order counted, only until every skill has its
 *  count), with no learned workflow of its name on the agent's main, active or waiting for
 *  its owner's OK (the folder's snapshot). One at most: a turn keeps one workflow draft. None when no skill qualifies, or
 *  when the folder can't be read: a read that fails asks for nothing, never a draft that may be there already. */
export async function draftForOf(deps: Pick<LearningEndDeps, "store" | "learningFolder">, agentId: string, runId: string, offered: readonly string[]): Promise<string[]> {
  // Only a skill's name reaches the prompt (reflectPrompt refuses anything else).
  const served = new Map(offered.filter((name) => SKILL_NAME.test(name)).map((name) => [name, 0]));
  if (!served.size) return [];
  // The list is newest first: only the runs after the ending one in it started before it, and count. A run started
  // later (a long job's newer runs) never does, and an ending run past the latest DRAFT_SCAN_RUNS + 1 counts none.
  let earlier = false;
  for (const run of await deps.store.runs.list({ agentId, limit: DRAFT_SCAN_RUNS + 1 })) {
    if (run.id === runId) {
      earlier = true;
      continue;
    }
    if (!earlier || run.agentId !== agentId) continue;
    const row = await deps.store.runs.launch(run.id).catch(() => undefined);
    const launch = row ? readLaunchBody(row.body) : undefined;
    for (const name of (launch && learningStartOf(launch)?.skills) ?? []) if (served.has(name)) served.set(name, served.get(name)! + 1);
    // Enough runs read once every skill has served its count.
    if ([...served.values()].every((count) => count >= DRAFT_AFTER_RUNS)) break;
  }
  const due = [...served].filter(([, count]) => count >= DRAFT_AFTER_RUNS);
  if (!due.length) return [];
  let drafted: Set<string>;
  const folder = deps.learningFolder(agentId);
  try {
    const snapshot = await readSnapshot(folder.workspace);
    drafted = new Set((snapshot?.workflows ?? []).filter(({ status }) => status === "active" || status === "pending").map(({ name }) => name));
  } catch {
    return [];
  } finally {
    await folder.end().catch(() => undefined);
  }
  const open = due.find(([name]) => !drafted.has(name));
  return open ? [open[0]] : [];
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
    const folder = deps.learningFolder(input.agentId);
    let proposed;
    try {
      proposed = await proposeRun({ folder: folder.workspace, runDir, seed: input.seed, turn, refuse: input.refuse, outcome: input.outcome, tools, ...(Object.keys(gated).length ? { gated } : {}) });
    } finally {
      await folder.end();
    }
    if (proposed.state !== "proposed") return proposed as Checked;
    const proposal: unknown = JSON.parse(await readFile(join(runDir, PROPOSAL), "utf8"));
    return { ...proposed, proposal };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}
