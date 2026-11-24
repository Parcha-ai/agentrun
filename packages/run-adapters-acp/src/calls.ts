// How an ACP agent's calls get their ids. Written for AgentRun.
//  - A call of one of our tools reaches the adapter twice: as the agent's `tool_call` update (its own id, a title, the
//    input it reports) over ACP, and as the MCP call itself over HTTP or stdio, which names no id. The two are matched by
//    the arguments' canonical JSON, first in first out, as OpenCode's calls are matched to the model's: the call runs
//    under the agent's own id, which is the memo key a resumed session asks under again. The title is the agent's text
//    in a form each release may change, so it only breaks a tie between announcements with the same arguments.
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

/** The host tool an ACP tool call names, by a name for our MCP server's tools (`agentrun__<tool>`, as Goose names them)
 *  or by Cursor's own title for one (`agentrun-<tool>: <tool>`), when it is one of `tools` and its kind is not one with
 *  effects of its own. No other title form is read: Goose 1.59.2's (`agentrun: <tool>`, with ` · <summary>` after it)
 *  ties nothing, since Goose asks nothing for our tools (its recipe's allowFile) and its calls are matched by their
 *  arguments (CallIds). Cursor's form stays for Cursor's tie alone (quirks.permissionTie). The title is the agent's text,
 *  so this alone is never evidence that a call is ours: a permission request also needs the tool_call that announced it
 *  (CallIds.announced) and a recipe that declares the tie. */
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

/** The tool of ours an agent's update names in its rawInput, as Cursor 2026.11.13 names an MCP call it announced
 *  untitled: `{providerIdentifier: "agentrun", toolName, args}`. A field, read as it is; undefined when it names another
 *  server, no tool of `tools`, or the update's kind has effects of its own. */
export function rawInputTool(update: { rawInput?: unknown; kind?: string | null }, tools: ReadonlySet<string>): { tool: string; args: unknown } | undefined {
  if (typeof update.kind === "string" && NATIVE_EFFECT_KINDS.has(update.kind)) return undefined;
  const raw = update.rawInput;
  if (!isPlain(raw) || raw.providerIdentifier !== MCP_SERVER || typeof raw.toolName !== "string" || !tools.has(raw.toolName)) return undefined;
  return { tool: raw.toolName, args: raw.args };
}

/** The agent's announced calls, matched to the MCP calls of our tools that reach the server. */
export class CallIds {
  private readonly seen = new Map<string, string[]>();
  private readonly waiting = new Map<string, ((id: string) => void)[]>();
  private readonly used = new Set<string>();
  private readonly tools = new Map<string, string>();
  /** The key each announcement still waiting for its MCP call is kept under. */
  private readonly keyOf = new Map<string, string>();

  /** The agent announced call `id` with `input` (undefined: it reported none), its title naming `tool` of ours, or none
   *  (undefined: a title in no form ourTool reads). One with no tool is matched by its input alone, an object; one with
   *  no input by its tool alone; one with neither is never matched. A tool named for an id already announced without one (a
   *  call the agent named in a later update) keys it again. */
  add(id: string, tool: string | undefined, input: unknown): void {
    if (this.used.has(id)) return;
    const reported = input !== undefined && input !== null;
    if (tool === undefined && !isPlain(input)) return;
    if (tool !== undefined && !this.tools.has(id)) this.tools.set(id, tool);
    // An announced call with input is matched only by that input (and its tool, where the title named one), so it never
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
   *  came by then. Of the announcements with the same arguments, the oldest whose title named `tool` first, then the
   *  oldest whose title named none; then the oldest of `tool` that reported no input. */
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
    // Once the wait is over, the oldest announced call the title named `tool` whose reported input differs from what
    // reached MCP. Never one the title named no tool for: its arguments are all that ties it, and they differ.
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
