// How an ACP agent's calls get their ids. Written for AgentRun.
//  - A call of one of our tools reaches the adapter twice: as the agent's `tool_call` update (its own id, a title, the
//    input it reports) over ACP, and as the MCP call itself over HTTP or stdio, which names no id. The two are matched by
//    the host tool's name and the arguments' canonical JSON, first in first out, as OpenCode's calls are matched to the
//    model's: the call runs under the agent's own id, which is the memo key a resumed session asks under again.
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

/** The host tool an ACP tool call names, by the agent's own name for our MCP server's tools (Goose `agentrun__<tool>`, or
 *  as Goose 1.59.2 titles it, `agentrun: <tool>` with the tool's underscores as spaces, and ` · <summary>` after it for a
 *  call whose arguments it summarizes, a path; Cursor `agentrun-<tool>: <tool>`),
 *  when it is one of `tools` and its kind is not one with effects of its own. The title is the agent's text, so this alone
 *  is never evidence that a call is ours: a permission request also needs the tool_call that announced it
 *  (CallIds.announced). */
export function ourTool(update: { title?: string | null; name?: string | null; kind?: string | null }, tools: ReadonlySet<string>): string | undefined {
  if (typeof update.kind === "string" && NATIVE_EFFECT_KINDS.has(update.kind)) return undefined;
  const candidates: string[] = [];
  for (const whole of [update.name, update.title]) {
    if (typeof whole !== "string") continue;
    // The name is what comes before Goose's summary (` · proof.txt`): the summary is the call's argument, never a name.
    const said = whole.split(" · ")[0]!;
    const goose = new RegExp(`^${MCP_SERVER}__(.+)$`).exec(said);
    if (goose) candidates.push(goose[1]!);
    const cursor = new RegExp(`^${MCP_SERVER}(-[^:]*)?: (.+)$`).exec(said);
    if (cursor) candidates.push(cursor[2]!.trim(), ...(cursor[1] ? [] : [cursor[2]!.replace(/ /g, "_")]));
  }
  return candidates.find((name) => tools.has(name));
}

/** The agent's announced calls of our tools, matched to the MCP calls that reach the server. */
export class CallIds {
  private readonly seen = new Map<string, string[]>();
  private readonly waiting = new Map<string, ((id: string) => void)[]>();
  private readonly used = new Set<string>();
  private readonly tools = new Map<string, string>();

  /** The agent announced call `id` of `tool` with `input` (undefined: it reported none). */
  add(id: string, tool: string, input: unknown): void {
    if (this.used.has(id)) return;
    if (!this.tools.has(id)) this.tools.set(id, tool);
    // An announced call with no input is matched by its tool alone; one with input only by its tool and that input, so
    // it never takes an MCP call of the same tool with other arguments that is waiting for its own announcement.
    const key = input === undefined || input === null ? `${tool}\0*` : `${tool}\0${canonical(isPlain(input) ? input : {})}`;
    const waiter = this.waiting.get(key)?.shift();
    if (waiter) {
      this.used.add(id);
      waiter(id);
      return;
    }
    const list = this.seen.get(key) ?? [];
    if (!list.includes(id)) list.push(id);
    this.seen.set(key, list);
  }

  /** Whether the agent announced `id` (matched or not). */
  has(id: string): boolean {
    return this.used.has(id) || [...this.seen.values()].some((ids) => ids.includes(id));
  }

  /** The tool of ours the agent's tool_call `id` was announced as, or undefined when no such tool_call came. */
  announced(id: string): string | undefined {
    return this.tools.get(id);
  }

  /** The id of an MCP call of `tool` with `args`: the agent's announced one, waited for at most `ms`; undefined when none
   *  came by then. */
  async take(tool: string, args: Record<string, unknown>, signal: AbortSignal, ms: number): Promise<string | undefined> {
    const keys = [`${tool}\0${canonical(args)}`, `${tool}\0*`];
    const ready = (from: readonly string[]) => {
      for (const key of from) {
        const id = this.seen.get(key)?.shift();
        if (id) {
          this.used.add(id);
          return id;
        }
      }
      return undefined;
    };
    // Once the wait is over, the oldest announced call of the tool whose reported input differs from what reached MCP.
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
