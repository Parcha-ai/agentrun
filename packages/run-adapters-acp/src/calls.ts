// How an ACP agent's calls get their ids. Written for AgentRun.
//  - A call of one of our tools reaches the adapter twice: as the agent's `tool_call` update (its own id, a title, the
//    input it reports) over ACP, and as the MCP call itself over HTTP or stdio, which names no id. The two are matched by
//    the arguments' canonical JSON, first in first out, as OpenCode's calls are matched to the model's: the call runs
//    under the agent's own id, which is the memo key a resumed session asks under again. Which tool an announcement
//    names is read from the field its recipe declares (AcpAnnounces: Goose's `_meta.goose.toolCall.toolName`, Cursor's
//    rawInput), never from its title: a call that field names as another tool is the agent's own and never takes an id.
//    One the field names nothing for is matched by its arguments alone.
//  - A permission request for one of the agent's own tools (a shell, an edit) is the host gate's call. Its id is made from
//    what a second request for the same call after a resume says the same: the open turn, the tool's title, kind and input,
//    and how many such requests came before it in the drive. Never from the agent's tool call id, which a new agent
//    session (no load) mints afresh.
import { createHash } from "node:crypto";

/** The MCP server's name, as the agent is given it. */
export const MCP_SERVER = "agentrun";

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON text of `value` with every object's keys sorted: two argument objects that say the same are the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The ACP tool kinds of a call with effects of its own (a shell, a file write, a delete, a move, a fetch): never one of
 *  our tools, whatever its title says. */
export const NATIVE_EFFECT_KINDS: ReadonlySet<string> = new Set(["execute", "edit", "delete", "move", "fetch"]);

/** The host tool a permission request's title names, by a name for our MCP server's tools (`agentrun__<tool>`) or by
 *  Cursor's own title for one (`agentrun-<tool>: <tool>`), when it is one of `tools` and its kind is not one with effects
 *  of its own. Read for Cursor's tie alone (quirks.permissionTie), and only beside the call's announcement: the title is
 *  the agent's text, so a request is tied only when it is for a call the recipe's announces field named as the same tool
 *  (CallIds.announced). Nothing else reads a title. */
export function ourTool(update: { title?: string | null; name?: string | null; kind?: string | null }, tools: ReadonlySet<string>): string | undefined {
  if (typeof update.kind === "string" && NATIVE_EFFECT_KINDS.has(update.kind)) return undefined;
  const candidates: string[] = [];
  for (const said of [update.name, update.title]) {
    if (typeof said !== "string") continue;
    const named = new RegExp(`^${MCP_SERVER}__(.+)$`).exec(said);
    if (named) candidates.push(named[1]!);
    const cursor = new RegExp(`^${MCP_SERVER}-[^:]*: (.+)$`).exec(said);
    if (cursor) candidates.push(cursor[1]!.trim());
  }
  return candidates.find((name) => tools.has(name));
}

/** Where in an agent's tool_call (or the update that names it later) a recipe finds which tool it calls, each a dotted
 *  path of field names into the update (`_meta.goose.toolCall.toolName`, `rawInput.toolName`).
 *  - `tool`: the tool's name. With `server`, our tool's own name; without, the name as the model calls it,
 *    `agentrun__<tool>` (our server's prefix, stripped).
 *  - `server`: the MCP server's name, which must be ours (`agentrun`).
 *  - `args`: the call's arguments (default `rawInput`). */
export interface AcpAnnounces {
  readonly tool: string;
  readonly server?: string;
  readonly args?: string;
}

/** A path an AcpAnnounces field may hold: field names joined by dots. */
export const ANNOUNCES_PATH = /^[A-Za-z_$][\w$-]*(\.[A-Za-z_$][\w$-]*)*$/;

/** The value at a dotted `path` in `value`, own fields only; undefined where any step is missing. */
function at(value: unknown, path: string): unknown {
  let here = value;
  for (const key of path.split(".")) {
    if (!isPlain(here) || !Object.hasOwn(here, key)) return undefined;
    here = here[key];
  }
  return here;
}

/** The tool of ours an agent's update names in the field its recipe declares (`announces`): its name; null when the
 *  field names a tool that is not ours (another server's, one without our prefix, or one of our server's that `tools`
 *  does not list); undefined when the recipe declares no field or the update does not carry it. A title is never read. */
export function announcedTool(update: unknown, announces: AcpAnnounces | undefined, tools: ReadonlySet<string>): string | null | undefined {
  if (!announces) return undefined;
  const said = at(update, announces.tool);
  if (typeof said !== "string" || said === "") return undefined;
  let tool = said;
  if (announces.server !== undefined) {
    if (at(update, announces.server) !== MCP_SERVER) return null;
  } else {
    if (!said.startsWith(`${MCP_SERVER}__`)) return null;
    tool = said.slice(`${MCP_SERVER}__`.length);
  }
  return tools.has(tool) ? tool : null;
}

/** The arguments an update reports for its call: at the recipe's `announces.args`, or its rawInput. */
function announcedArgs(update: { rawInput?: unknown }, announces: AcpAnnounces | undefined): unknown {
  return announces?.args !== undefined ? at(update, announces.args) : update.rawInput;
}

/** An agent's update about one of its calls, as the adapter reads it. */
export interface AcpCallUpdate {
  readonly toolCallId: string;
  readonly kind?: string | null;
  readonly rawInput?: unknown;
}

const hasEffects = (kind: unknown): boolean => typeof kind === "string" && NATIVE_EFFECT_KINDS.has(kind);

/** The agent's tool_call `update`, kept for the MCP call it may be: a call whose kind has effects of its own never is
 *  (a shell named as our tool never takes an MCP call's id); one the recipe's field names as another tool is the agent's
 *  own; one it names as ours is kept as that tool; one it names nothing for is matched by its arguments alone, except
 *  one with no arguments on a recipe whose field names calls, which waits for the update that names it. */
export function announceCall(calls: CallIds, update: AcpCallUpdate, announces: AcpAnnounces | undefined, tools: ReadonlySet<string>): void {
  if (hasEffects(update.kind)) return;
  const tool = announcedTool(update, announces, tools);
  if (tool === null) return;
  // Named by nothing and reporting no arguments, on a recipe that declares the field (Cursor's untitled `MCP: tool`,
  // rawInput {}, before its late update names it): {} would tie it to any call with no arguments, of any tool, so it
  // waits to be named (nameCall). On a recipe without the field nothing names it later: it is matched by {} at once.
  if (tool === undefined && announces && isPlain(update.rawInput) && Object.keys(update.rawInput).length === 0) return;
  calls.add(update.toolCallId, tool, tool === undefined ? update.rawInput : announcedArgs(update, announces));
}

/** A tool_call_update naming a call its tool_call left unnamed (Cursor's MCP calls: a tool_call titled "MCP: tool" with
 *  no input, then this update with rawInput {providerIdentifier, toolName, args}): kept as that tool, under the id its
 *  tool_call already counted, by the recipe's field. Held to both kinds, the tool_call's (`kindAtCall`) and the
 *  update's: a shell renamed by a later update is never ours. */
export function nameCall(calls: CallIds, update: AcpCallUpdate, kindAtCall: string | undefined, announces: AcpAnnounces | undefined, tools: ReadonlySet<string>): void {
  if (calls.announced(update.toolCallId) !== undefined) return;
  if (hasEffects(kindAtCall) || hasEffects(update.kind)) return;
  const tool = announcedTool(update, announces, tools);
  if (typeof tool !== "string") return;
  const args = announcedArgs(update, announces);
  calls.add(update.toolCallId, tool, isPlain(args) ? args : undefined);
}

/** The agent's announced calls, matched to the MCP calls of our tools that reach the server. */
export class CallIds {
  private readonly seen = new Map<string, string[]>();
  private readonly waiting = new Map<string, ((id: string) => void)[]>();
  private readonly used = new Set<string>();
  private readonly tools = new Map<string, string>();
  /** The key each announcement still waiting for its MCP call is kept under. */
  private readonly keyOf = new Map<string, string>();

  /** The agent announced call `id` with `input` (undefined: it reported none), its recipe's field naming `tool` of
   *  ours, or none (undefined). One with no tool is matched by its input alone, an object ({} included: announceCall
   *  holds one back where a later update will name the call); one with no input by its tool alone; one with neither is
   *  never matched. A tool named for an id already announced without one (a call the agent named in a later update)
   *  keys it again. */
  add(id: string, tool: string | undefined, input: unknown): void {
    if (this.used.has(id)) return;
    const reported = input !== undefined && input !== null;
    if (tool === undefined && !isPlain(input)) return;
    if (tool !== undefined && !this.tools.has(id)) this.tools.set(id, tool);
    // An announced call with input is matched only by that input (and its tool, where the field named one), so it never
    // takes an MCP call with other arguments that is waiting for its own announcement.
    const key = reported ? `${tool ?? ""}\0${canonical(isPlain(input) ? input : {})}` : `${tool}\0*`;
    const before = this.keyOf.get(id);
    if (before === key) return;
    if (before !== undefined) {
      const list = this.seen.get(before) ?? [];
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
    }
    const waiter = this.waiting.get(key)?.shift();
    if (waiter) {
      this.keyOf.delete(id);
      this.used.add(id);
      waiter(id);
      return;
    }
    const list = this.seen.get(key) ?? [];
    list.push(id);
    this.seen.set(key, list);
    this.keyOf.set(id, key);
  }

  /** Whether the agent announced `id` (matched or not). */
  has(id: string): boolean {
    return this.used.has(id) || this.keyOf.has(id);
  }

  /** The tool of ours the agent's tool_call `id` was announced as, or undefined when no tool_call named one. */
  announced(id: string): string | undefined {
    return this.tools.get(id);
  }

  /** The id of an MCP call of `tool` with `args`: the agent's announced one, waited for at most `ms`; undefined when none
   *  came by then. Of the announcements with the same arguments, the oldest named `tool` first, then the oldest named
   *  none; then the oldest of `tool` that reported no input. */
  async take(tool: string, args: Record<string, unknown>, signal: AbortSignal, ms: number): Promise<string | undefined> {
    const keys = [`${tool}\0${canonical(args)}`, `\0${canonical(args)}`, `${tool}\0*`];
    const ready = (from: readonly string[]) => {
      for (const key of from) {
        const id = this.seen.get(key)?.shift();
        if (id) {
          this.keyOf.delete(id);
          this.used.add(id);
          return id;
        }
      }
      return undefined;
    };
    // Once the wait is over, the oldest announced call named `tool` whose reported input differs from what reached MCP.
    // Never one named no tool: its arguments are all that ties it, and they differ.
    const loose = () => ready([...this.seen.keys()].filter((key) => key.startsWith(`${tool}\0`)));
    const now = ready(keys);
    if (now) return now;
    return new Promise<string | undefined>((resolve, reject) => {
      const lists = keys.map((key) => {
        const list = this.waiting.get(key) ?? [];
        this.waiting.set(key, list);
        return list;
      });
      const drop = () => {
        for (const list of lists) {
          const at = list.indexOf(done);
          if (at >= 0) list.splice(at, 1);
        }
      };
      const done = (id: string) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        drop();
        resolve(id);
      };
      const stop = () => {
        clearTimeout(timer);
        drop();
        reject(signal.reason instanceof Error ? signal.reason : new Error("the call was stopped"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        drop();
        resolve(loose());
      }, ms);
      signal.addEventListener("abort", stop, { once: true });
      for (const list of lists) list.push(done);
    });
  }
}

/** The gate's id for a permission request of the agent's own tool: the same for the same request after a resume. */
export function permissionCallId(turn: string, request: { title?: string | null; kind?: string | null; rawInput?: unknown }, nth: number): string {
  const digest = createHash("sha256").update(canonical({ turn, title: request.title ?? "", kind: request.kind ?? "", input: request.rawInput ?? null, nth })).digest("hex");
  return `acp-perm-${digest.slice(0, 24)}`;
}
