// The coding tools a run's process registers: pi's (ArchilCodingTools, `read` declared replay-safe) without `bash`. A
// run gets no shell on this machine, so this is the only coding-tools extension serve installs (app.ts, tools.ts) and
// the only one its host tools are taken from (host-tools.ts). The tools left are pi's own, with only their execute
// wrapped so a refusal names the path the call gave (asGivenRefusals), and the extension keeps everything else pi's
// carries (its name, so a conversation selects it as before).
//
// A run whose place is a box gets codingSource's instead: pi's own read, write, edit and bash, each call made on the
// box's environment (run-box.ts), so the shell exists only in the box. One source feeds pi's tool table (tools.ts,
// app.ts) and another harness's host tools (host-tools.ts).
//
// Where the box binds the run's work/ from this machine and the confinement holds directory handles (Docker on Linux),
// read, write and edit run on this machine instead, on the bind's source (bound-files.ts): a command in the box costs
// far more than a file read. bash always runs in the box, and every tool of any other box (or of any host that reaches
// directories by path) does too.
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type Extension, ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import { FileError } from "@earendil-works/pi-durable/env";
import { HOST_PHASE } from "@parcha/pi-durable-agent/timeline";
import { ArchilCodingTools } from "@parcha/pi-durable-disk";
import { boundFiles } from "./bound-files.js";
import { BOX_WORK, type Place } from "./place.js";
import { asGivenRefusals, refuseOutsideWorkspace } from "./workspace-paths.js";
import { writesHeld } from "./workspace.js";

// pi-durable-disk's types name the pi-durable it resolves, which a build at another pi version (the pi-floor legs) can
// hold apart from this package's own: the extension crosses that boundary as a value, typed on this side.
const pis = ArchilCodingTools as unknown as Extension;

/** pi's coding tools on the runner, without bash, each refusal of a path outside the workspace named by the path the
 *  call gave (`asGivenRefusals`): the model reads that refusal, and the run's timeline shows it. */
export const CodingTools: Extension = { ...pis, tools: asGivenRefusals((pis.tools ?? []).filter((tool) => tool.name !== "bash")) };

/** The tools a box runs: pi's, by name. */
export const BOXED_TOOLS: readonly string[] = ["read", "write", "edit", "bash"];

/** A run's coding tools and the extension a conversation selects for them. */
export type CodingSource = { readonly extension: Extension; readonly tools: readonly ToolRegistration[] };

/** The environment a boxed tool's call runs on: the run's box's (run-box.ts). `note` writes a row on the run's timeline
 *  while the box is being had (its image still coming). `hostWork`: the run's own work/ on this machine, the source the
 *  box binds at BOX_WORK; `bound`, whether the box's provider binds it there (Docker does). */
export type BoxedEnv = { env(context: Context, note?: (summary: string) => Promise<void>): Promise<unknown>; hostWork?: string; bound?(): Promise<boolean>; leftEnded?(context: Context): Promise<void> };

/** A failed call's error with what the file environment said, where pi's message gives only its code (edit's "Error
 *  code: permission_denied."), so the model reads why and what it can do. */
const withCause = (error: unknown): unknown => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return error instanceof Error && cause instanceof FileError && !error.message.includes(cause.message) ? new Error(`${error.message} ${cause.message}`, { cause }) : error;
};

/** A boxed file tool's path as the box names it, or undefined when it leaves the box's work dir (`~` and `file:`
 *  included). A path under the run's own host work dir (another harness's cwd can name one) is the same file at
 *  BOX_WORK, the bind renamed one for one; every other host path (the data root, another run) is never taken for a box
 *  path. */
export function boxPath(path: string, hostWork?: string): string | undefined {
  if (/^(~|file:)/.test(path)) return undefined;
  const named = hostWork && (path === hostWork || path.startsWith(`${hostWork}/`)) ? `${BOX_WORK}${path.slice(hostWork.length)}` : path;
  const at = posix.resolve(BOX_WORK, named);
  return at === BOX_WORK || at.startsWith(`${BOX_WORK}/`) ? named : undefined;
}

/** Whether a run's file tools write this machine's work/ (the runner's, or a box's that binds it, as codingSource's own
 *  rule reads it): the tool gate checks the reflect turn's carve-out there, and refuses it anywhere else (a remote box). */
export async function writesHere(place: Place, box?: BoxedEnv): Promise<boolean> {
  if (place.mode === "runner") return true;
  return Boolean(box?.hostWork && writesHeld() && (await box.bound?.()) === true);
}

/** A run's coding tools by its place: on the runner, CodingTools (no bash); in a box, pi's read, write, edit and bash,
 *  each with its arguments, output and replay as pi ships it and its environment the box's. A file tool's path stays in
 *  the box's work dir; bash's command is the box's own. */
export function codingSource(place: Place, box?: BoxedEnv): CodingSource {
  if (place.mode === "runner") return { extension: CodingTools, tools: CodingTools.tools ?? [] };
  if (!box) throw new Error("a run whose place is a box needs its box for its coding tools");
  const here = box.hostWork && writesHeld() ? boundFiles(box.hostWork) : undefined;
  const tools = asGivenRefusals((pis.tools ?? []).filter((tool) => BOXED_TOOLS.includes(tool.name)).map((tool): ToolRegistration => ({
    ...tool,
    execute: async (args, api, context) => {
      // A file tool's path in the box's words, or refused as the confined tools refuse (refuseOutsideWorkspace): named
      // by the path the call gave and no other, the box's work dir included.
      const path = (args as { path?: unknown } | null)?.path;
      const inBox = typeof path === "string" ? boxPath(path, box.hostWork) : undefined;
      if (typeof path === "string" && inBox === undefined) refuseOutsideWorkspace(path);
      const given = inBox === undefined ? args : { ...(args as object), path: inBox };
      // read, write and edit on this machine's work/, where the box binds it; no box is made for them. A box an earlier
      // process left has its left commands killed first, so none of them changes work/ under these tools.
      if (here && tool.name !== "bash" && (await box.bound?.()) === true) {
        await box.leftEnded?.(context);
        return tool.execute(given as typeof args, { ...api, env: here as typeof api.env }, context).catch((error: unknown) => Promise.reject(withCause(error)));
      }
      // A row the box's wait writes goes on the run's root, as a host's phase (pi-durable-agent's timeline shows it).
      const note = (summary: string) => api.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: HOST_PHASE, data: { summary } })), context);
      return tool.execute(given as typeof args, { ...api, env: (await box.env(context, note)) as typeof api.env }, context);
    },
  })));
  // The permission gate (allow, ask, deny) wraps this source: the one call it takes, whichever of the two lands second.
  return { extension: { ...pis, tools }, tools };
}
