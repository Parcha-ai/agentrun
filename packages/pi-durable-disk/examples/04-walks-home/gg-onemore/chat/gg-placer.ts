// `serve.ts --placer-module gg-onemore/chat/gg-placer.ts`: where a chat page's run should be (the Golden Gate page's or the
// any-topic page's), asked of TypeSafe Jev on the server for every user message and when each turn ends. The criteria say
// what each place can reach: the GPU box's tools and the edited model only from the Modal VM. The agent's current model (`agent_model`) is a typed fact of the question, so
// once it is the edited model Jev keeps the run where that model is. Jev is the only judge: no key, no server.
import { judgePlacer, type JudgeRunner, type Placer } from "../../../03-tab-to-cloud/placement.ts";
import { GG_MODEL } from "./gg-extra.ts";
import { STEERED_PROVIDER } from "../pi/use-model.ts";

const EDITED = `${STEERED_PROVIDER}/${GG_MODEL}`;

// The criteria must put both pages' requests ("make yourself obsessed with cats", a saved recipe, the Golden Gate) and every
// line to the edited model on the VM: check a change with real Jev on such messages.
export const CRITERIA_GG: Readonly<Record<string, string>> = {
  tab: `Your user's browser tab, only while agent_model is the cloud model and the message needs no model work: small talk and questions the cloud model answers. It cannot reach the GPU box: no model work happens here (no Golden Gate, no obsession with a topic, no recipe), and once agent_model is ${EDITED} no message can be answered here at all.`,
  "modal-vm": `The Modal VM next to the GPU box with Qwen3.5-27B. Once agent_model is ${EDITED} (the edited model, reachable only from here), every message belongs here, whatever it says. Model work also happens only here: recreating Golden Gate Claude, making yourself or the model obsessed with any topic your user names (cats, a landmark, a food, a product, anything), switching yourself to a saved recipe, running code on the GPU box.`,
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
  options.log("placer.ready", { client: "jev" });
  return buildGgPlacer(createJevRunner({ timeoutMs: 20_000, maxAttempts: 2 }) as unknown as JudgeRunner, "jev");
}
