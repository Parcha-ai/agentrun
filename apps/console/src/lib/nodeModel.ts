// The model a model node ran on, as the console says it: a learned workflow's node on its Timeline row, and a workflow
// run's node on its graph card and in its details. The server names the model the run's route sent the node to, and the
// tier the node asked for (`fast`, `strong`) when it named one; a call node has neither.

// A model on the server's ChatGPT plan (`chatgpt/<id>`) reads as modelLabel says it: "gpt-6.1-sol · on your ChatGPT plan".

import { modelLabel } from "./models";

/** What a node ran on, as the server sends it beside its state. */
export type RanOn = { model?: string; tier?: string };

/** The model as the server names it, or a plan model in the plan's words. No routing prefix is taken off here. */
const named = (model: string): string => modelLabel(model, null).text;

/** A node's kind with what it ran on: "extract · fast · gpt-6-luna", "extract · gpt-6-1-terra", or its kind alone. */
export const kindWithModel = (kind: string, ran?: RanOn): string => [kind, ran?.model ? ran.tier : undefined, ran?.model ? named(ran.model) : undefined].filter(Boolean).join(" · ");

/** The same, for a hover: "ran on gpt-6-luna (the fast tier)", "ran on gpt-6-1-terra"; nothing for a node with no model. */
export const ranOnWords = (ran?: RanOn): string => (ran?.model ? `ran on ${named(ran.model)}${ran.tier ? ` (the ${ran.tier} tier)` : ""}` : "");
