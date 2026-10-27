// Review. Once a learning run's branch is proposed, the server curates it in the agent's queue (learning.ts), through a
// clone of its own, `<data>/agents/<id>/curator`: @parcha/pi-agent-learn's curate, with the checker on the tools this host
// binds, the injection screen and the judge. The agent's current revision decides how: `auto` merges what passes, and
// `approve` holds the plan in `<run id>.plan.json` until a person approves or refuses it. A server with no screen or no
// judge curates nothing, since curate would refuse the run for good: the branch waits, the run's state says why, and the
// start-time pass curates it once both are here. A merged branch is deleted while it is still at the commit proposed. The
// judge's cost is the agent's, on the run's learning state, never the run's own.
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HeldPlan, InjectionScreen, Judge, LandHeldResult } from "@parcha/pi-agent-learn";
import type { Repo } from "@parcha/pi-git-remote";
import type { Agents } from "./agents.js";
import { NODE_TOOLS } from "./app.js";
import { learningOf, learningRunsDir, openAgentRepo, readRunState, type RunState, withAgentRepo, writeRunState } from "./learning.js";

/** What a host gives review: the injection screen (the browser lane's page judge and its threshold) and, in tests, the
 *  judge. Without `judge`, the judge is Jev's, on the server's TYPESAFE_API_KEY. */
export type LearningOptions = { screen?: InjectionScreen; judge?: Judge };

export const NO_SCREEN = "no injection screen on this server";
export const NO_JUDGE = "no judge on this server";
/** The states review takes up: proposed, or waiting on something that may be here now. */
const REVIEWABLE = new Set<RunState["state"]>(["proposed", "no_screen", "no_judge", "off"]);
const PLAN = ".plan.json";

type ReviewOptions = LearningOptions & {
  data: string;
  agents: Pick<Agents, "get">;
  env: NodeJS.ProcessEnv;
  /** This server's secrets (runs.ts `serverSecrets`): no learning that holds one reaches main. */
  secrets: () => string[];
  log?: (event: string, fields: Record<string, string | number>) => void;
};

export class Review {
  private jev: Promise<Judge | undefined> | undefined;
  constructor(private readonly options: ReviewOptions) {}

  private curator = (agentId: string): Promise<Repo> => openAgentRepo(this.options.data, agentId, join(this.options.data, "agents", agentId, "curator"));
  private planFile = (agentId: string, runId: string) => join(learningRunsDir(this.options.data, agentId), `${runId}${PLAN}`);

  /** The judge: the host's, else Jev's when the server has TYPESAFE_API_KEY, else none. */
  private judge(): Promise<Judge | undefined> {
    if (this.options.judge) return Promise.resolve(this.options.judge);
    const key = this.options.env.TYPESAFE_API_KEY;
    if (!key || key.trim() === "") return Promise.resolve(undefined);
    this.jev ??= import("@parcha/agentrun-jev").then(({ createJevRunner }) => createJevRunner({ apiKey: key, provider: "typesafe" }) as unknown as Judge);
    return this.jev;
  }

  /** Reviews the run's proposal in the agent's queue, after any write queued before it. */
  run(agentId: string, runId: string): Promise<RunState | undefined> {
    return withAgentRepo(this.options.data, agentId, () => this.reviewNow(agentId, runId));
  }

  private async reviewNow(agentId: string, runId: string, from?: RunState): Promise<RunState | undefined> {
    const state = from ?? (await readRunState(this.options.data, agentId, runId));
    if (!state || !REVIEWABLE.has(state.state)) return state;
    const mode = learningOf(this.options.agents.get(agentId)?.revision);
    // Still waiting on the same thing: the state stands as it is, unwritten.
    const wait = async (next: RunState["state"], reason: string) => (state.state === next && state.reason === reason ? state : this.write(agentId, runId, { ...state, state: next, reason }));
    if (mode === "off") return wait("off", "learning is off for this agent");
    if (!this.options.screen) return wait("no_screen", NO_SCREEN);
    const judge = await this.judge();
    if (!judge) return wait("no_judge", NO_JUDGE);
    let spent = 0;
    const counted: Judge = async (params) => {
      const answer = await judge(params);
      const cost = (answer as { cost_usd?: unknown } | undefined)?.cost_usd;
      if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) spent += cost;
      return answer;
    };
    const { curate } = await import("@parcha/pi-agent-learn");
    const repo = await this.curator(agentId);
    const hold = mode === "approve";
    const report = await curate({ repo, judge: counted, screen: this.options.screen, tools: [...NODE_TOOLS], secrets: this.options.secrets(), only: [runId], hold });
    const usd = (state.review_usd ?? 0) + spent;
    const { reason: _reason, ...kept } = state;
    if (hold) {
      const planned = report.planned?.find((p) => p.run === runId);
      if (planned) {
        await this.writeWhole(this.planFile(agentId, runId), `${JSON.stringify(planned.plan)}\n`);
        return this.write(agentId, runId, { ...kept, state: "awaiting_approval", verdict: planned.report, review_usd: usd });
      }
    } else {
      const merged = report.runs.find((r) => r.run === runId);
      if (merged) {
        const { commit, ...verdict } = merged;
        const next = await this.write(agentId, runId, { ...kept, state: "merged", merge: commit, verdict, review_usd: usd, pruned: false });
        return this.prune(agentId, runId, next, repo);
      }
    }
    // Curated already (main names it), or nothing beyond main: nothing to merge.
    const skipped = report.skipped.find((s) => s.branch === `runs/${runId}`);
    return this.write(agentId, runId, { ...kept, state: skipped ? "empty" : "merged", review_usd: usd, ...(skipped ? { reason: skipped.reason } : {}), pruned: false });
  }

  /** Approves the run's held plan, as `principal`. */
  approve(agentId: string, runId: string, principal: string): Promise<LandHeldResult> {
    return this.decide(agentId, runId, principal, "approve");
  }

  /** Refuses the run's held plan, as `principal`, for `reason` (one line). */
  refuse(agentId: string, runId: string, principal: string, reason: string): Promise<LandHeldResult> {
    return this.decide(agentId, runId, principal, { refuse: reason });
  }

  private decide(agentId: string, runId: string, principal: string, decision: "approve" | { refuse: string }): Promise<LandHeldResult> {
    if (typeof principal !== "string" || principal.trim() === "") throw new Error("a decision names who made it");
    return withAgentRepo(this.options.data, agentId, async () => {
      const state = await readRunState(this.options.data, agentId, runId);
      if (state?.state !== "awaiting_approval") throw new Error(`the run ${runId} is not waiting for approval`);
      const plan = JSON.parse(await readFile(this.planFile(agentId, runId), "utf8")) as HeldPlan;
      const { landHeld } = await import("@parcha/pi-agent-learn");
      const repo = await this.curator(agentId);
      const result = await landHeld({ repo, plan, decision });
      const how = decision === "approve" ? "approve" : "refuse";
      this.options.log?.("learning_decided", { agent: agentId, run: runId, by: principal, decision: how, result: result.status });
      if (result.status === "stale") {
        // Main moved since the plan: plan it again, for a person to decide on what would land now.
        await this.reviewNow(agentId, runId, { ...state, state: "proposed" });
        return result;
      }
      await rm(this.planFile(agentId, runId), { force: true });
      const next = await this.write(agentId, runId, { ...state, state: "merged", ...(result.status === "landed" ? { merge: result.commit } : {}), decided_by: principal, decision: how, pruned: false });
      await this.prune(agentId, runId, next, repo);
      return result;
    });
  }

  /** Deletes the merged run's branch while it is at the commit proposed; one that moved since is kept. */
  private async prune(agentId: string, runId: string, state: RunState, repo?: Repo): Promise<RunState> {
    if (!state.sha) return this.write(agentId, runId, { ...state, pruned: true });
    try {
      await (repo ?? (await this.curator(agentId))).deleteBranch(`runs/${runId}`, state.sha);
      return this.write(agentId, runId, { ...state, pruned: true });
    } catch (error) {
      this.options.log?.("learning_branch_kept", { agent: agentId, run: runId, why: (error as Error).message.slice(0, 200) });
      return state;
    }
  }

  /** At start, after the proposals catch up: every run proposed or waiting is reviewed again, and every merged branch not
   *  yet deleted is deleted. A run awaiting approval is left for its person: nothing lands without one. */
  async startPass(): Promise<void> {
    const root = join(this.options.data, "agents");
    const agents = await readdir(root).catch(() => [] as string[]);
    const work: Promise<unknown>[] = [];
    for (const agentId of agents) {
      const files = await readdir(learningRunsDir(this.options.data, agentId)).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith(".json") || file.endsWith(PLAN)) continue;
        const runId = file.slice(0, -".json".length);
        const state = await readRunState(this.options.data, agentId, runId).catch(() => undefined);
        if (!state) continue;
        const done = REVIEWABLE.has(state.state)
          ? this.run(agentId, runId)
          : state.state === "merged" && state.pruned === false
            ? withAgentRepo(this.options.data, agentId, () => this.prune(agentId, runId, state))
            : undefined;
        if (done) work.push(done.catch((error: Error) => this.options.log?.("learning_review_failed", { agent: agentId, run: runId, why: error.message.slice(0, 200) })));
      }
    }
    await Promise.all(work);
  }

  private async write(agentId: string, runId: string, state: RunState): Promise<RunState> {
    await writeRunState(this.options.data, agentId, runId, state);
    return state;
  }

  /** Written whole: a reader sees the old file or the new one. */
  private async writeWhole(file: string, text: string): Promise<void> {
    await writeFile(`${file}.partial`, text, { mode: 0o600 });
    await rename(`${file}.partial`, file);
  }
}
