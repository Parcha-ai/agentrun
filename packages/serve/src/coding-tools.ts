// The coding tools a run's process registers: pi's (ArchilCodingTools, `read` declared replay-safe) without `bash`. A
// run gets no shell on this machine, so this is the only coding-tools extension serve installs (app.ts, tools.ts) and
// the only one its host tools are taken from (host-tools.ts). The tools left are pi's own, with only their execute
// wrapped so a refusal names the path the call gave (asGivenRefusals), and the extension keeps everything else pi's
// carries (its name, so a conversation selects it as before).
//
// A run whose place is a box gets codingSource's instead: pi's own read, write, edit and bash, and the background tools
// (background.ts), each call made on the box's environment (run-box.ts), so the shell exists only in the box. One source feeds pi's tool table (tools.ts,
// app.ts) and another harness's host tools (host-tools.ts).
//
// Where the box binds the run's work/ from this machine and the confinement holds directory handles (Docker on Linux),
// read, write and edit run on this machine instead, on the bind's source (bound-files.ts): a command in the box costs
// far more than a file read. bash and the background tools always run in the box, and every tool of any other box (or of
// any host that reaches directories by path) does too.
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type Extension, ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import { type ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";
import { HOST_PHASE } from "@parcha/pi-durable-agent/timeline";
import { ArchilCodingTools } from "@parcha/pi-durable-disk";
import { BACKGROUND_TOOLS, backgroundTools, SHELL_TOOLS } from "./background.js";
import { boundFiles } from "./bound-files.js";
import { BOX_WORK, type Place } from "./place.js";
import { forModelBlocks } from "./result.js";
import { asGivenRefusals, refuseOutsideWorkspace } from "./workspace-paths.js";
import { writesHeld } from "./workspace.js";

// pi-durable-disk's types name the pi-durable it resolves, which a build at another pi version (the pi-floor legs) can
// hold apart from this package's own: the extension crosses that boundary as a value, typed on this side.
const pis = ArchilCodingTools as unknown as Extension;

/** pi's coding tools on the runner, without bash, each refusal of a path outside the workspace named by the path the
 *  call gave (`asGivenRefusals`): the model reads that refusal, and the run's timeline shows it. */
export const CodingTools: Extension = { ...pis, tools: asGivenRefusals((pis.tools ?? []).filter((tool) => tool.name !== "bash")) };

/** pi's tools a box runs, by name. */
const PI_BOXED: readonly string[] = ["read", "write", "edit", "bash"];
/** The tools that run a command in the box, never on this machine: bash, and the background tools (background.ts). */
export { SHELL_TOOLS };
/** The tools a box runs, by name: pi's four and the background tools. */
export const BOXED_TOOLS: readonly string[] = [...PI_BOXED, ...BACKGROUND_TOOLS];

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

/** bash's timeout, in seconds: the default when a call names none, and the most any call gets (Claude Code's own 120 s
 *  and 600 s). A command that needs longer is a background process (bash_background). */
export const BASH_DEFAULT_TIMEOUT_S = 120;
export const BASH_MAX_TIMEOUT_S = 600;
const BASH_TIMEOUT_WORDS = `Timeout in seconds: ${BASH_DEFAULT_TIMEOUT_S} s by default, at most ${BASH_MAX_TIMEOUT_S} s; for longer work use bash_background.`;
const BASH_TIMEOUT_SENTENCE = ` Each command is stopped after ${BASH_DEFAULT_TIMEOUT_S} s by default, at most ${BASH_MAX_TIMEOUT_S} s; for longer work use bash_background.`;
const capWords = (asked: number) => `bash runs a command for at most ${BASH_MAX_TIMEOUT_S} s: this one ran with ${BASH_MAX_TIMEOUT_S} s, not the ${asked} s asked. For longer work use bash_background.`;

/** pi's bash with its timeout said and kept: the description and the timeout's own words name the default and the
 *  ceiling, a call with none runs at the default, and one asking for more runs at the ceiling and says so (a diagnostic
 *  when it ends, its error when it times out). Its schema's shape is pi's; only words change. */
function boundedBash(tool: ToolRegistration): ToolRegistration {
  const parameters = tool.parameters as { properties?: Record<string, Record<string, unknown>> };
  const timeout = parameters.properties?.timeout;
  return {
    ...tool,
    description: `${tool.description}${BASH_TIMEOUT_SENTENCE}`,
    parameters: (timeout ? { ...parameters, properties: { ...parameters.properties, timeout: { ...timeout, description: BASH_TIMEOUT_WORDS } } } : parameters) as typeof tool.parameters,
    execute: async (args, api, context) => {
      const asked = (args as { timeout?: unknown } | null)?.timeout;
      const capped = typeof asked === "number" && asked > BASH_MAX_TIMEOUT_S;
      const timeoutS = typeof asked === "number" ? Math.min(asked, BASH_MAX_TIMEOUT_S) : BASH_DEFAULT_TIMEOUT_S;
      try {
        const result = await tool.execute({ ...(args as object), timeout: timeoutS } as typeof args, api, context);
        return capped ? { ...result, diagnostics: [...(result.diagnostics ?? []), { severity: "warn" as const, code: "timeout_capped", message: capWords(asked as number) }] } : result;
      } catch (error) {
        if (capped && error instanceof Error && /timed out/i.test(error.message)) throw new Error(`${error.message}. ${capWords(asked as number)}`, { cause: error });
        throw error;
      }
    },
  };
}

/** The image types read opens, by extension; the bytes must say the same (imageTypeOf). */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The largest image read hands the model, in bytes: 3.75 MiB, whose base64 is the 5 MiB the strictest platform a
 *  harness sends images to takes (the claude-agent adapter's CLAUDE_AGENT_MAX_IMAGE_BYTES, Amazon Bedrock's). */
export const READ_IMAGE_MAX_BYTES = 3_932_160;
/** The box's side of an image read: at most `$2` bytes of `$1`, as base64 (env.exec answers in text). A file over the
 *  bound never leaves the box whole: the server holds one byte past it at most, and refuses it. */
const READ_IMAGE_SCRIPT = '[ -f "$1" ] && [ -r "$1" ] || exit 6; head -c "$2" -- "$1" | base64';
/** At most `limit` bytes of the box's `path`, read in the box, or undefined when it can't be read there. */
async function boxBytes(env: ExecutionEnv, path: string, limit: number, context: Context): Promise<Uint8Array | undefined> {
  let out = "";
  const ran = await env.exec(["sh", "-c", READ_IMAGE_SCRIPT, "agentrun-read-image", path, String(limit)], {
    timeout: 30,
    onOutput: (text, _context, info) => {
      if (info.stream === "stdout") out += text;
    },
  }, context);
  if (!ran.ok || ran.value.exitCode !== 0) return undefined;
  return new Uint8Array(Buffer.from(out.replace(/\s+/g, ""), "base64"));
}
const READ_IMAGE_SENTENCE = " It also opens an image (png, jpg, gif, webp) at any path in the run's box, such as one rendered to /tmp, and returns it as an image; any other file only inside work/.";
/** The image type the bytes say they are, or undefined: the magic bytes of PNG, JPEG, GIF and WebP. */
function imageTypeOf(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}
/** A path read may open as an image anywhere in the box: an absolute box path (not `~`, not a URL) whose extension is an
 *  image's. */
const boxImagePath = (path: string): boolean => path.startsWith("/") && !path.startsWith("//") && IMAGE_EXTENSIONS[posix.extname(path).slice(1).toLowerCase()] !== undefined;

/** A run's coding tools by its place: on the runner, CodingTools (no bash); in a box, pi's read, write, edit and bash,
 *  each with its arguments, output and replay as pi ships it and its environment the box's, and the background tools
 *  (background.ts), each call a command in the box. A file tool's path stays in the box's work dir; bash's command is
 *  the box's own. */
export function codingSource(place: Place, box?: BoxedEnv): CodingSource {
  if (place.mode === "runner") return { extension: CodingTools, tools: CodingTools.tools ?? [] };
  if (!box) throw new Error("a run whose place is a box needs its box for its coding tools");
  const here = box.hostWork && writesHeld() ? boundFiles(box.hostWork) : undefined;
  const boxed = (pis.tools ?? []).filter((tool) => PI_BOXED.includes(tool.name)).map((tool) => (tool.name === "bash" ? boundedBash(tool) : tool.name === "read" ? { ...tool, description: `${tool.description}${READ_IMAGE_SENTENCE}` } : tool));
  const tools = asGivenRefusals([...boxed, ...backgroundTools()].map((tool): ToolRegistration => ({
    ...tool,
    execute: async (args, api, context) => {
      // A file tool's path in the box's words, or refused as the confined tools refuse (refuseOutsideWorkspace): named
      // by the path the call gave and no other, the box's work dir included.
      const path = (args as { path?: unknown } | null)?.path;
      const inBox = typeof path === "string" ? boxPath(path, box.hostWork) : undefined;
      // read opens an image anywhere in the box (a render in /tmp): read through the box itself, never on this machine,
      // and only when the bytes are an image's; anything else outside work/ is refused as before.
      if (tool.name === "read" && typeof path === "string" && inBox === undefined && boxImagePath(path)) {
        const note = (summary: string) => api.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: HOST_PHASE, data: { summary } })), context);
        const bytes = await boxBytes((await box.env(context, note)) as ExecutionEnv, path, READ_IMAGE_MAX_BYTES + 1, context);
        const mimeType = bytes ? imageTypeOf(bytes) : undefined;
        if (!bytes || !mimeType) refuseOutsideWorkspace(path);
        if (bytes.byteLength > READ_IMAGE_MAX_BYTES) throw new Error(`${path} is an image over read's ${READ_IMAGE_MAX_BYTES} bytes: scale it down first (for example with ffmpeg in bash).`);
        // A line naming it, then the image: an answer is never an empty text, on pi or on another harness (host-tools.ts).
        return forModelBlocks([{ type: "text", text: `${path}: ${mimeType}, ${bytes.byteLength} bytes` }, { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType }]);
      }
      if (typeof path === "string" && inBox === undefined) refuseOutsideWorkspace(path);
      const given = inBox === undefined ? args : { ...(args as object), path: inBox };
      // read, write and edit on this machine's work/, where the box binds it; no box is made for them. A box an earlier
      // process left has its left commands killed first, so none of them changes work/ under these tools.
      if (here && !SHELL_TOOLS.includes(tool.name) && (await box.bound?.()) === true) {
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
