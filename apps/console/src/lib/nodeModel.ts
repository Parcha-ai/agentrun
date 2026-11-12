// The model a model node ran on, as the console says it: a learned workflow's node on its Timeline row, and a workflow
// run's node on its graph card and in its details. The server names the model the run's route sent the node to, and the
// tier the node asked for (`fast`, `strong`) when it named one; a call node has neither.

/** What a node ran on, as the server sends it beside its state. */
export type RanOn = { model?: string; tier?: string };

/** A node's kind with what it ran on: "extract · fast · gpt-5-mini", "extract · gpt-5-4-mini", or its kind alone. */
export const kindWithModel = (kind: string, ran?: RanOn): string => [kind, ran?.model ? ran.tier : undefined, ran?.model].filter(Boolean).join(" · ");

/** The same, for a hover: "ran on gpt-5-mini (the fast tier)", "ran on gpt-5-4-mini"; nothing for a node with no model. */
export const ranOnWords = (ran?: RanOn): string => (ran?.model ? `ran on ${ran.model}${ran.tier ? ` (the ${ran.tier} tier)` : ""}` : "");
