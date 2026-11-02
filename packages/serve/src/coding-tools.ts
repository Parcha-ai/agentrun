// The coding tools a run's process registers: pi's (ArchilCodingTools, `read` declared replay-safe) without `bash`. A
// run gets no shell on this machine, so this is the only coding-tools extension serve installs (app.ts, tools.ts) and
// the only one its host tools are taken from (host-tools.ts). The tools left are pi's own objects, and the extension
// keeps everything else pi's carries (its name, so a conversation selects it as before).
//
// A run whose place is a box gets codingSource's instead: pi's own read, write, edit and bash, each call made on the
// box's environment (run-box.ts), so the shell exists only in the box. One source feeds pi's tool table (tools.ts,
// app.ts) and another harness's host tools (host-tools.ts).
import type { Context } from "@earendil-works/chord";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { ArchilCodingTools } from "@parcha/pi-durable-disk";
import type { Place } from "./place.js";

// pi-durable-disk's types name the pi-durable it resolves, which a build at another pi version (the pi-floor legs) can
// hold apart from this package's own: the extension crosses that boundary as a value, typed on this side.
const pis = ArchilCodingTools as unknown as Extension;

export const CodingTools: Extension = { ...pis, tools: (pis.tools ?? []).filter((tool) => tool.name !== "bash") };

/** The tools a box runs: pi's, by name. */
export const BOXED_TOOLS: readonly string[] = ["read", "write", "edit", "bash"];

/** A run's coding tools and the extension a conversation selects for them. */
export type CodingSource = { readonly extension: Extension; readonly tools: readonly ToolRegistration[] };

/** The environment a boxed tool's call runs on: the run's box's (run-box.ts). */
export type BoxedEnv = { env(context: Context): Promise<unknown> };

/** A run's coding tools by its place: on the runner, CodingTools (no bash); in a box, pi's read, write, edit and bash,
 *  each with its arguments, output and replay as pi ships it and its environment the box's. */
export function codingSource(place: Place, box?: BoxedEnv): CodingSource {
  if (place.mode === "runner") return { extension: CodingTools, tools: CodingTools.tools ?? [] };
  if (!box) throw new Error("a run whose place is a box needs its box for its coding tools");
  const tools = (pis.tools ?? []).filter((tool) => BOXED_TOOLS.includes(tool.name)).map((tool): ToolRegistration => ({
    ...tool,
    execute: async (args, api, context) => tool.execute(args, { ...api, env: (await box.env(context)) as typeof api.env }, context),
  }));
  // The permission gate (allow, ask, deny) wraps this source: the one call it takes, whichever of the two lands second.
  return { extension: { ...pis, tools }, tools };
}
