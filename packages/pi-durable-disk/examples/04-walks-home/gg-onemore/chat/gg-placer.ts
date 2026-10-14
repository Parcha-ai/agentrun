// `serve.ts --placer-module gg-onemore/chat/gg-placer.ts`: where the Golden Gate page's run should be, asked of TypeSafe Jev on
// the server for every user message and when each turn ends. The criteria say what each place can reach: the pipeline's tools
// and the edited model only from the Modal VM. The agent's current model (`agent_model`) is a typed fact of the question, so
// once it is the edited model Jev keeps the run where that model is. Jev is the only judge: no key, no server.
import { judgePlacer, type JudgeRunner, type Placer } from "../../../03-tab-to-cloud/placement.ts";
import { GG_MODEL } from "./gg-extra.ts";
import { STEERED_PROVIDER } from "../pi/use-model.ts";

const EDITED = `${STEERED_PROVIDER}/${GG_MODEL}`;

export const CRITERIA_GG: Readonly<Record<string, string>> = {
  tab: `Your user's browser tab: talking with the cloud model before the Golden Gate work starts. It cannot reach the GPU box: not the Golden Gate work, and not any message once agent_model is ${EDITED} (the edited model, which only the Modal VM reaches).`,
  "modal-vm": `The Modal VM next to the GPU box: the Golden Gate tools (the reading, running its own code on the GPU box, the control) and the edited model are reachable only from here. The Golden Gate work belongs here, and so does every message once agent_model is ${EDITED}.`,
};

export const LABELS_GG: Readonly<Record<string, string>> = { tab: "Browser", "modal-vm": "Modal VM" };

/** The question's facts: the agent's current model, when the server gives it with the query. */
export async function ggContext(_read: unknown, query?: { readonly model?: { readonly provider: string; readonly modelId: string } }): Promise<Record<string, unknown>> {
  return query?.model ? { agent_model: `${query.model.provider}/${query.model.modelId}` } : {};
}

export function buildGgPlacer(runJudge: JudgeRunner, model: "jev" | "scripted" = "jev"): Placer {
  return judgePlacer({ runJudge, criteria: CRITERIA_GG, labels: LABELS_GG, model, context: ggContext as never });
}

/** The server's placer: TypeSafe Jev decides every placement. No key, no server: there is no fallback judge. */
export default async function placer(options: { log: (event: string, data?: Record<string, unknown>) => void; args: Record<string, string> }): Promise<Placer> {
  if (options.args.client !== undefined && options.args.client !== "jev") throw new Error(`--placer-arg client=${options.args.client}: only jev decides where a run goes`);
  if (!process.env.TYPESAFE_API_KEY) throw new Error("the GG placer asks TypeSafe Jev and TYPESAFE_API_KEY is not in the server's environment: start the server under with-typesafe; there is no fallback judge");
  const { createJevRunner } = await import("@parcha/agentrun-jev");
  options.log("placer.ready", { client: "jev", page: "golden-gate" });
  return buildGgPlacer(createJevRunner({ timeoutMs: 20_000, maxAttempts: 2 }) as unknown as JudgeRunner, "jev");
}
