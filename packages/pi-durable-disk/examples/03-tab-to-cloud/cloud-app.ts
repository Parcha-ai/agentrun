// The same agent as the tab's, as the app module a host runs (`pi-durable-disk run --app cloud-app.ts`): its tools on
// the claimed mount (the package's environment), its writing tools followed by the claim's barrier, its model calls
// to DEMO_MODEL_URL. Opening the run resumes whatever the tab left unfinished.
//   DEMO_MODEL_URL  an OpenAI-compatible endpoint (`.../v1`) reachable from this host, or
//   DEMO_LINK_PORT and DEMO_LINK_TOKEN (or DEMO_LINK_TOKEN_FILE), DEMO_LINK_HOST (default 127.0.0.1): listen for the
//                   demo server's link instead, send model calls through it and stream events over it (cloud-link.ts)
//   DEMO_MODEL      the model id
//   DEMO_EVENTS_LOG optional: a file this instance appends one JSON line to when it opens and after each commit it made
//                   (its generation, the commit's sequence, the time), the evidence that no write of it lands after a
//                   takeover
import { appendFileSync, readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AppContext, AppOptions, DurableRun } from "@parcha/pi-durable-disk";
import { agentModels, agentRegistry, rootAgent, SETTINGS } from "./agent.ts";
import { startCloudLink, type CloudLink } from "./cloud-link.ts";

export default async function app(_where: AppContext): Promise<AppOptions> {
  const modelId = process.env.DEMO_MODEL;
  if (!modelId) throw new Error("DEMO_MODEL names the model");
  let baseUrl = process.env.DEMO_MODEL_URL;
  let link: CloudLink | undefined;
  const linkToken = process.env.DEMO_LINK_TOKEN ?? (process.env.DEMO_LINK_TOKEN_FILE ? readFileSync(process.env.DEMO_LINK_TOKEN_FILE, "utf8").trim() : undefined);
  if (process.env.DEMO_LINK_PORT && linkToken) {
    link = await startCloudLink({ port: Number(process.env.DEMO_LINK_PORT), host: process.env.DEMO_LINK_HOST ?? "127.0.0.1", token: linkToken });
    baseUrl = link.baseUrl;
  }
  if (!baseUrl) throw new Error("DEMO_MODEL_URL (or DEMO_LINK_PORT and DEMO_LINK_TOKEN_FILE) names how this host reaches a model");
  let run: DurableRun | undefined;
  const durable = async () => {
    if (!run) throw new Error("the run is not open");
    await run.claim.barrier();
  };
  return {
    registry: agentRegistry(durable),
    models: agentModels({ baseUrl, modelId }),
    settings: SETTINGS,
    root: { agent: rootAgent(modelId) },
    async onOpen(opened) {
      run = opened;
      const events = process.env.DEMO_EVENTS_LOG;
      const note = (event: string, extra: Record<string, unknown> = {}) => {
        if (events) appendFileSync(events, `${JSON.stringify({ at: new Date().toISOString(), event, run: opened.ref.id, generation: opened.generation, pid: process.pid, ...extra })}\n`);
      };
      note("open");
      opened.harness.subscribeCommits((publication) => note("commit", { seq: publication.seq }));
      const root = await opened.harness.root(ctx, { agent: rootAgent(modelId) });
      link?.attach(opened.harness, root.id);
    },
  };
}
