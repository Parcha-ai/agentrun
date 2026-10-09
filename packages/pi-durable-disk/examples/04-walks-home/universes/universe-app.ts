// The app each universe's instance runs (`pi-durable-disk run --app universe-app.mjs`, bundled by build.mjs): the demo's
// agent, told before the run resumes where it now runs and which reward its universe trains against (the env.switch
// notice of 03-tab-to-cloud), and a trainer that resumes from the run's last checkpoint in work/.
//   UNIVERSE_ID, UNIVERSE_OF, UNIVERSE_REWARD   which universe this is and what it optimizes
//   UNIVERSE_TOTAL_STEPS (default 120), UNIVERSE_STEP_MS (1000), UNIVERSE_CHECKPOINT_EVERY (5), UNIVERSE_SEED
//   DEMO_ENV_LABEL                              this machine, in the notice's and the stage's words
//   DEMO_SWITCH_ID, DEMO_SWITCH_FROM, DEMO_SWITCH_PLANNED   the move that brought the run here
//   DEMO_MODEL, DEMO_MODEL_URL                  the agent's model; no turn starts unless someone submits one
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AppContext, AppOptions } from "@parcha/pi-durable-disk";
import { agentModels, agentRegistry, rootAgent, SETTINGS } from "../../03-tab-to-cloud/agent.ts";
import { admitNotice } from "../../03-tab-to-cloud/environment.ts";
import { probeHost } from "../../03-tab-to-cloud/host-probe.ts";
import { startTrainer } from "./trainer.ts";

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

export default async function app(_where: AppContext): Promise<AppOptions> {
  const modelId = process.env.DEMO_MODEL ?? "none";
  const universe = process.env.UNIVERSE_ID ?? "u0";
  const of = process.env.UNIVERSE_OF ?? "1";
  const reward = process.env.UNIVERSE_REWARD ?? "forward speed";
  const label = process.env.DEMO_ENV_LABEL ?? "a cloud host";
  let trainer: ReturnType<typeof startTrainer> | undefined;
  // The drain (SIGTERM) releases the run; the trainer stops first, so no write of it is in flight under the release.
  process.once("SIGTERM", () => void trainer?.stop());
  return {
    registry: agentRegistry(async () => {}),
    models: agentModels({ baseUrl: process.env.DEMO_MODEL_URL ?? "http://127.0.0.1:9/v1", modelId }),
    settings: SETTINGS,
    root: { agent: rootAgent(modelId) },
    async beforeResume({ harness }) {
      const id = process.env.DEMO_SWITCH_ID;
      if (!id) return;
      const facts = { ...(await probeHost()), label, note: `You are universe ${universe} of ${of} forked from one run; your reward: ${reward}.` };
      const move = { id, from: process.env.DEMO_SWITCH_FROM ?? "another host", planned: process.env.DEMO_SWITCH_PLANNED !== "0" };
      await admitNotice(harness, rootAgent(modelId), facts, move, ctx);
      log("notice", { switchId: id, universe });
    },
    async onOpen(run) {
      log("open", { run: run.ref.id, generation: run.generation, universe });
      trainer = startTrainer({
        work: run.claim.work,
        total: num("UNIVERSE_TOTAL_STEPS", 120),
        stepMs: num("UNIVERSE_STEP_MS", 1_000),
        checkpointEvery: num("UNIVERSE_CHECKPOINT_EVERY", 5),
        seed: num("UNIVERSE_SEED", 1),
        generation: run.generation,
        host: label,
        barrier: () => run.claim.barrier(),
        log,
      });
      trainer.done.catch((error: unknown) => log("trainer.failed", { error: (error as Error).message }));
    },
  };
}
