// How an ACP agent's calls get their ids. Written for AgentRun.
//  - A call of one of our tools reaches the adapter twice: as the agent's `tool_call` update (its own id, a title, the
//    input it reports) over ACP, and as the MCP call itself over HTTP or stdio, which names no id. The two are matched by
//    the arguments' canonical JSON, first in first out, as OpenCode's calls are matched to the model's: the call runs
//    under the agent's own id, which is the memo key a resumed session asks under again. Which tool an announcement
//    names is read from the field its recipe declares (AcpAnnounces: Goose's `_meta.goose.toolCall.toolName`, Cursor's
//    rawInput, agy's `name` after its `mcp_agentrun_` prefix, with agy's toolSummary left out of the arguments as an
//    extra), never from its title: a call that field names as another tool is the agent's own and never takes an id.
//    One the field names nothing for is matched by its arguments alone.
//  - A permission request for one of the agent's own tools (a shell, an edit) is the host gate's call. Its id is made from
//    what a second request for the same call after a resume says the same: the open turn, the tool's title, kind and input,
//    and how many such requests came before it in the drive. Never from the agent's tool call id, which a new agent
//    session (no load) mints afresh.
import { createHash, randomBytes } from "node:crypto";

/** The MCP server's name, as the agent is given it (under agy's recipe, the start of it: mcpServerName). */
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

/** The host tool a permission request's title or name gives, by a name for our MCP server's tools (`agentrun__<tool>`),
 *  Cursor's own title for one (`agentrun-<tool>: <tool>`), or agy's (Antigravity's) name and title for one
 *  (`mcp_agentrun_<tool>`, titled `Run mcp_agentrun_<tool>`, the whole text), when it is one of `tools` and its kind is
 *  not one with effects of its own. Read for the title tie alone (quirks.permissionTie: Cursor's and agy's), and only
 *  beside the call's announcement: the title is the agent's text, so a request is tied only when it is for a call the
 *  recipe's announces field named as the same tool (CallIds.announced). Nothing else reads a title. `server` is the name
 *  our MCP server was given to the agent under at this start (mcpServerName): agy's name and title carry it. */
export function ourTool(update: { title?: string | null; name?: string | null; kind?: string | null }, tools: ReadonlySet<string>, server: string = MCP_SERVER): string | undefined {
  if (typeof update.kind === "string" && NATIVE_EFFECT_KINDS.has(update.kind)) return undefined;
  const candidates: string[] = [];
  for (const said of [update.name, update.title]) {
    if (typeof said !== "string") continue;
    const named = new RegExp(`^${server}__(.+)$`).exec(said);
    if (named) candidates.push(named[1]!);
    const cursor = new RegExp(`^${server}-[^:]*: (.+)$`).exec(said);
    if (cursor) candidates.push(cursor[1]!.trim());
    // agy's (Antigravity's): `mcp_<server>_<tool>`, titled `Run mcp_<server>_<tool>`, the whole text (agy 1.5.14 writes
    // no summary after either).
    const agy = new RegExp(`^(?:Run )?mcp_${server}_(.+)$`).exec(said);
    if (agy) candidates.push(agy[1]!);
  }
  return candidates.find((name) => tools.has(name));
}

/** Whether a recipe's announces names our server by a prefix that joins it to a tool's name with one `_` or `-` (agy's
 *  `mcp_agentrun_`): a join another server's own name may hold, so a server `agentrun_look` with a tool `up`
 *  (`mcp_agentrun_look_up`) would spell our `look_up`. Not Goose's default `agentrun__`, nor a recipe that reads the
 *  server from a field of its own (Cursor's). */
export function joinsByOne(announces: AcpAnnounces | undefined): boolean {
  return announces !== undefined && announces.server === undefined && announces.prefix !== undefined && new RegExp(`${MCP_SERVER}[_-]$`).test(announces.prefix);
}

/** The name our MCP server is given to the agent under at one start: under a recipe whose prefix joins by one character
 *  (joinsByOne), `agentrun` and 8 random hex digits, no `_` or `-`, which no server set up before the start can spell
 *  (8, not more: each of our tools is named with it, under the agent's cap, TOOL_NAME_CAP); under any other, `agentrun`. */
export function mcpServerName(announces: AcpAnnounces | undefined): string {
  return joinsByOne(announces) ? `${MCP_SERVER}${randomBytes(4).toString("hex")}` : MCP_SERVER;
}

/** The most characters a tool's name may hold where the agent names it (agy's, as the model APIs' tool names: 64). */
export const TOOL_NAME_CAP = 64;

/** Of `tools`, those whose name as the agent names them at this start (`announces` as announcesAt reads them: its prefix
 *  and the tool's name) is longer than TOOL_NAME_CAP. Only a prefix is counted; a recipe that reads the tool's name
 *  from a field of its own with the server beside it (Cursor's) names none. */
export function namesTooLong(announces: AcpAnnounces | undefined, tools: Iterable<string>): string[] {
  if (announces?.prefix === undefined || announces.server !== undefined) return [];
  const prefix = announces.prefix;
  return [...tools].filter((tool) => prefix.length + tool.length > TOOL_NAME_CAP);
}

/** The recipe's `announces` as one start reads them, our MCP server given to the agent as `server` (mcpServerName): its
 *  prefix names that server (`mcp_agentrun_` reads `mcp_<server>_`). ANNOUNCES_PREFIX ends a prefix at our server's
 *  name, so the last `agentrun` in it is that name. */
export function announcesAt(announces: AcpAnnounces | undefined, server: string): AcpAnnounces | undefined {
  if (!announces || announces.prefix === undefined || server === MCP_SERVER) return announces;
  const at = announces.prefix.lastIndexOf(MCP_SERVER);
  return at < 0 ? announces : { ...announces, prefix: `${announces.prefix.slice(0, at)}${server}${announces.prefix.slice(at + MCP_SERVER.length)}` };
}

/** Whether an input schema may name an argument `name`: in its `properties`, or in those of a schema it composes (allOf,
 *  anyOf, oneOf, at any depth), or behind a `$ref` to its own `$defs` or `definitions`. A `$ref` it cannot read (another
 *  document's, or a def it lacks) may, so it counts; a `$ref` that comes back to itself adds nothing. */
export function declaresProperty(schema: unknown, name: string): boolean {
  if (!isPlain(schema)) return false;
  const root = schema;
  const seen = new Set<unknown>();
  const walk = (node: unknown): boolean => {
    if (!isPlain(node) || seen.has(node)) return false;
    seen.add(node);
    if (isPlain(node.properties) && Object.hasOwn(node.properties, name)) return true;
    if (typeof node.$ref === "string") {
      const local = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(node.$ref);
      const defs = local ? root[local[1]!] : undefined;
      const target = local && isPlain(defs) && Object.hasOwn(defs, local[2]!) ? defs[local[2]!] : undefined;
      if (target === undefined) return true;
      if (walk(target)) return true;
    }
    return (["allOf", "anyOf", "oneOf"] as const).some((key) => Array.isArray(node[key]) && (node[key] as unknown[]).some(walk));
  };
  return walk(schema);
}

/** Where in an agent's tool_call (or the update that names it later) a recipe finds which tool it calls, each a dotted
 *  path of field names into the update (`_meta.goose.toolCall.toolName`, `rawInput.toolName`, `name`).
 *  - `tool`: the tool's name. With `server`, our tool's own name; without, the name as the model calls it, our server's
 *    prefix and the tool's (`prefix`, stripped).
 *  - `server`: the MCP server's name, which must be ours (`agentrun`).
 *  - `prefix`: without `server`, what comes before our tool's name in `tool` (default `agentrun__`; agy's
 *    `mcp_agentrun_`). It names our server (ANNOUNCES_PREFIX), so a name without it is never ours. One that joins our
 *    server's name to the tool's with one `_` or `-` gives the server a name of each start's own (mcpServerName), which
 *    the prefix then reads (announcesAt).
 *  - `args`: the call's arguments (default `rawInput`).
 *  - `extras`: fields the agent writes beside the call's arguments that the MCP call never carries (agy's
 *    `toolSummary`, its model's line about the call), left out before the arguments are matched when they hold text,
 *    except one the tool's own input schema declares (declaresProperty), which is then the call's own argument. */
export interface AcpAnnounces {
  readonly tool: string;
  readonly server?: string;
  readonly prefix?: string;
  readonly args?: string;
  readonly extras?: readonly string[];
}

/** The prefix a recipe's announces.prefix may be: our server's name, with at most one word and a `_` or `-` before it,
 *  and one or two `_` or `-` after it (`agentrun__`, `mcp_agentrun_`). */
export const ANNOUNCES_PREFIX = new RegExp(`^(?:[A-Za-z0-9]+[_-])?${MCP_SERVER}[_-]{1,2}$`);

/** A field name announces.extras may list. */
export const ANNOUNCES_EXTRA = /^[A-Za-z_$][\w$-]*$/;

/** A path an AcpAnnounces field may hold: field names joined by dots, never starting at the update's title,
 *  toolCallId, kind, status, rawOutput, content, locations or sessionUpdate: a path through the title would let the
 *  agent's text name a call again, one through rawOutput or content a tool's output. */
export const ANNOUNCES_PATH = /^(?!(?:title|toolCallId|kind|status|rawOutput|content|locations|sessionUpdate)(?:\.|$))[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/;

/** The value at a dotted `path` in `value`, own fields only; undefined where any step is missing. */
function at(value: unknown, path: string): unknown {
  let here = value;
  for (const key of path.split(".")) {
    if (!isPlain(here) || !Object.hasOwn(here, key)) return undefined;
    here = here[key];
  }
  return here;
}

/** The most of the word at a recipe's announces.tool a debug line quotes. */
export const ANNOUNCED_FIELD_CHARS = 200;

/** The word at the recipe's announces.tool in `update`, clipped to ANNOUNCED_FIELD_CHARS: what the agent said it calls.
 *  It may sit inside the call's input (Cursor's rawInput.toolName): the debug line (harness.ts) quotes it only for a call
 *  of ours. Null when the recipe declares no field or it holds no string. */
export function announcedField(update: unknown, announces: AcpAnnounces | undefined): string | null {
  const said = announces ? at(update, announces.tool) : undefined;
  return typeof said === "string" ? said.slice(0, ANNOUNCED_FIELD_CHARS) : null;
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
    const prefix = announces.prefix ?? `${MCP_SERVER}__`;
    if (!said.startsWith(prefix)) return null;
    tool = said.slice(prefix.length);
  }
  return tools.has(tool) ? tool : null;
}

/** The arguments an update reports for its call: at the recipe's `announces.args`, or its rawInput, without the
 *  recipe's `extras` that hold text (agy's toolSummary), but for those the tool's schema declares (`kept`). */
function announcedArgs(update: { rawInput?: unknown }, announces: AcpAnnounces | undefined, kept?: ReadonlySet<string>): unknown {
  const args = announces?.args !== undefined ? at(update, announces.args) : update.rawInput;
  const extras = (announces?.extras ?? []).filter((name) => !kept?.has(name));
  if (!isPlain(args) || !extras.some((name) => typeof args[name] === "string")) return args;
  return Object.fromEntries(Object.entries(args).filter(([name, value]) => !(extras.includes(name) && typeof value === "string")));
}

/** Add announced call `update` of `tool` to `calls` by its arguments (announcedArgs). Where the tool's schema declares
 *  one of the extras (`kept`), the agent may have added its own (agy's toolSummary beside a call that sent none, the
 *  field being optional) or passed the call's: which, only the MCP call's arguments say. So it is kept under both forms,
 *  with that extra and without, and the first MCP call either form matches takes it (CallIds.add `also`). */
function addAnnounced(calls: CallIds, update: AcpCallUpdate, announces: AcpAnnounces | undefined, tool: string, kept: ReadonlySet<string> | undefined): void {
  const args = announcedArgs(update, announces, kept);
  const bare = kept?.size ? announcedArgs(update, announces) : args;
  calls.add(update.toolCallId, tool, args, bare === args ? undefined : bare);
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
 *  one with no arguments on a recipe whose field names calls, which waits for the update that names it. On a recipe
 *  without the field, one reporting no input at all is kept as a call that names nothing (CallIds.add). `declared`: for
 *  each tool, the recipe's extras its input schema declares (declaresProperty), matched with and without (addAnnounced). */
export function announceCall(calls: CallIds, update: AcpCallUpdate, announces: AcpAnnounces | undefined, tools: ReadonlySet<string>, declared?: ReadonlyMap<string, ReadonlySet<string>>): void {
  if (hasEffects(update.kind)) return;
  const tool = announcedTool(update, announces, tools);
  if (tool === null) return;
  // Named by nothing and reporting no arguments, on a recipe that declares the field (Cursor's untitled `MCP: tool`,
  // rawInput {}, before its late update names it): {} would tie it to any call with no arguments, of any tool, so it
  // is held for the update that names it (nameCall), and only that. On a recipe without the field nothing names it
  // later: it is matched by {} at once, and one with no input at all as a call that names nothing.
  const raw = update.rawInput;
  if (tool === undefined && announces && (raw === undefined || raw === null || (isPlain(raw) && Object.keys(raw).length === 0))) return calls.hold(update.toolCallId);
  // Named by nothing, on a recipe that names its calls, with input that is no argument object: its field never named
  // it, so it is the agent's own.
  if (tool === undefined && announces && !isPlain(raw)) return;
  if (tool === undefined) calls.add(update.toolCallId, undefined, update.rawInput);
  else addAnnounced(calls, update, announces, tool, declared?.get(tool));
}

/** A tool_call_update naming a call its tool_call left unnamed with no input (Cursor's MCP calls: a tool_call titled
 *  "MCP: tool" with rawInput {}, then this update with rawInput {providerIdentifier, toolName, args}): kept as that
 *  tool, under the id its tool_call already counted, by the recipe's field. Only a call announceCall held for its name
 *  (CallIds.held): one whose tool_call reported input, or named a tool, is never named later, so a native read whose
 *  update echoes the model's arguments stays the agent's own. The tool_call's kind was checked before it was held;
 *  the update's is checked here: a shell renamed by a later update is never ours. */
export function nameCall(calls: CallIds, update: AcpCallUpdate, announces: AcpAnnounces | undefined, tools: ReadonlySet<string>, declared?: ReadonlyMap<string, ReadonlySet<string>>): void {
  if (!calls.held(update.toolCallId) || hasEffects(update.kind)) return;
  const tool = announcedTool(update, announces, tools);
  if (typeof tool !== "string") return;
  addAnnounced(calls, update, announces, tool, declared?.get(tool));
}

/** The key of an announcement that names no tool and reports no input (CallIds.add). */
const NOTHING = "\0*";

/** take's word for a call torn between announcements its arguments match only without an extra. */
const TORN = Symbol("torn");

/** The agent's announced calls, matched to the MCP calls of our tools that reach the server. */
export class CallIds {
  private readonly seen = new Map<string, string[]>();
  private readonly waiting = new Map<string, ((id: string) => void)[]>();
  private readonly used = new Set<string>();
  private readonly tools = new Map<string, string>();
  /** The keys each announcement still waiting for its MCP call is kept under: one, or two where its arguments may be
   *  read with or without an extra (add's `also`). */
  private readonly keyOf = new Map<string, readonly string[]>();
  /** The calls announced naming no tool and reporting no input, held for the update that names them (hold). */
  private readonly unnamed = new Set<string>();

  /** The agent announced call `id` naming no tool and reporting no input, on a recipe whose field names calls: held for
   *  the later update that names it (nameCall), and matched to nothing until then. */
  hold(id: string): void {
    if (!this.used.has(id) && !this.tools.has(id)) this.unnamed.add(id);
  }

  /** Whether `id` is held for its name (hold) and no update has named it yet. */
  held(id: string): boolean {
    return this.unnamed.has(id);
  }

  /** The agent announced call `id` with `input`, its recipe's field naming `tool` of ours, or none (undefined). Input
   *  that is not an object (none reported, or a value that is not an argument object) is no input. One with no tool is
   *  matched by its input alone, an object ({} included: announceCall holds one back where a later update will name
   *  the call); one with no input by its tool alone. One with neither (only on a recipe without announces: announceCall
   *  never keeps one elsewhere) is the last an MCP call takes, of any tool, when nothing else matches it: nothing names
   *  it and nothing ties it, and its MCP call would otherwise run under an id of the adapter's, counted a second time
   *  against a plan's limit and memoized under a key a resume never asks again. Until its call ends (settle). A tool
   *  named for an id already announced without one (a call the agent named in a later update) keys it again. `also`:
   *  the same call's arguments read another way (addAnnounced: without an extra its tool's schema declares), under
   *  which it is kept too; the first MCP call either matches takes it, and it is gone from both. */
  add(id: string, tool: string | undefined, input: unknown, also?: unknown): void {
    if (this.used.has(id)) return;
    if (tool !== undefined) this.unnamed.delete(id);
    if (tool !== undefined && !this.tools.has(id)) this.tools.set(id, tool);
    // An announced call with input is matched only by that input (and its tool, where the field named one), so it never
    // takes an MCP call with other arguments that is waiting for its own announcement.
    const keyFor = (args: unknown) => (isPlain(args) ? `${tool ?? ""}\0${canonical(args)}` : `${tool ?? ""}\0*`);
    const keys = [...new Set([keyFor(input), ...(also === undefined ? [] : [keyFor(also)])])];
    const before = this.keyOf.get(id);
    if (before && before.length === keys.length && before.every((key, i) => key === keys[i])) return;
    this.unlist(id);
    for (const key of keys) {
      const waiter = this.waiting.get(key)?.shift();
      if (waiter) {
        this.used.add(id);
        waiter(id);
        return;
      }
    }
    for (const key of keys) {
      const list = this.seen.get(key) ?? [];
      list.push(id);
      this.seen.set(key, list);
    }
    this.keyOf.set(id, keys);
  }

  /** `id` out of every list it is kept in (keyOf), waiting for its MCP call no more. */
  private unlist(id: string): void {
    for (const key of this.keyOf.get(id) ?? []) {
      const list = this.seen.get(key) ?? [];
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
    }
    this.keyOf.delete(id);
  }

  /** The agent's call `id` ended (completed or failed) with no MCP call having taken it: an announcement that names
   *  nothing and reports nothing is dropped, so a call of the agent's own never takes a later MCP call's id. */
  settle(id: string): void {
    if (this.keyOf.get(id)?.[0] !== NOTHING) return;
    this.unlist(id);
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
   *  none; then the oldest of `tool` that reported no input. Then, already there or once the wait is over, never woken
   *  by one coming in during it (which may be the agent's own while this call's own announcement is on its way), the
   *  oldest that named nothing and reported nothing. Where the arguments match two or more announcements only read
   *  without an extra (addAnnounced), the call waits while one of them may yet be another call's whole arguments. */
  async take(tool: string, args: Record<string, unknown>, signal: AbortSignal, ms: number): Promise<string | undefined> {
    const keys = [`${tool}\0${canonical(args)}`, `\0${canonical(args)}`, `${tool}\0*`];
    const key = keys[0]!;
    // Under the first of `from` that keeps one: an announcement whose own arguments are these (its first key, the form
    // with the extra) first, then the oldest. But two or more kept under this call's own key only read without an extra
    // (addAnnounced) are torn: which of them sent none, only their own MCP calls say, and another's may be on its way
    // with the extra, needing its own. So while there are more of them than calls waiting on them (`waiting`, this one
    // among them), the call waits; once there are not, each takes the oldest.
    const pick = (from: readonly string[], waiting: number): string | undefined | typeof TORN => {
      for (const at of from) {
        const list = this.seen.get(at);
        if (!list?.length) continue;
        const id = list.find((each) => this.keyOf.get(each)?.[0] === at) ?? (at === key && list.length > 1 && list.length > waiting ? TORN : list[0]!);
        if (id === TORN) return TORN;
        this.unlist(id);
        this.used.add(id);
        this.wake();
        return id;
      }
      return undefined;
    };
    // Once the wait is over, the oldest announced call named `tool` whose reported input differs from what reached MCP.
    // Never one named no tool with other arguments: its arguments are all that ties it, and they differ. Then the oldest
    // that named nothing and reported nothing.
    const loose = () => pick([...[...this.seen.keys()].filter((at) => at.startsWith(`${tool}\0`)), NOTHING], Infinity) as string | undefined;
    // Calls already torn on this key go first, in the order they came, unless this one's arguments are an announcement's own.
    const queued = this.torn.get(key) ?? 0;
    const now = queued && !this.seen.get(key)?.some((id) => this.keyOf.get(id)?.[0] === key) ? TORN : pick([...keys, NOTHING], 1);
    if (typeof now === "string") return now;
    const torn = now === TORN;
    return new Promise<string | undefined>((resolve, reject) => {
      const lists = keys.map((at) => {
        const list = this.waiting.get(at) ?? [];
        this.waiting.set(at, list);
        return list;
      });
      const retry = () => {
        const id = pick(keys, this.torn.get(key) ?? 0);
        if (typeof id === "string") done(id);
      };
      const leave = () => {
        for (const list of lists) {
          const at = list.indexOf(done);
          if (at >= 0) list.splice(at, 1);
        }
        if (!this.retries.delete(retry)) return;
        const left = (this.torn.get(key) ?? 1) - 1;
        if (left > 0) this.torn.set(key, left);
        else this.torn.delete(key);
      };
      const done = (id: string) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        leave();
        resolve(id);
      };
      const stop = () => {
        clearTimeout(timer);
        leave();
        reject(signal.reason instanceof Error ? signal.reason : new Error("the call was stopped"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        leave();
        resolve((torn ? (pick(keys, Infinity) as string | undefined) : undefined) ?? loose());
      }, ms);
      signal.addEventListener("abort", stop, { once: true });
      for (const list of lists) list.push(done);
      if (torn) {
        this.torn.set(key, (this.torn.get(key) ?? 0) + 1);
        this.retries.add(retry);
        this.wake();
      }
    });
  }

  /** The MCP calls torn between announcements (take): how many wait under each key, and each one's retry. */
  private readonly torn = new Map<string, number>();
  private readonly retries = new Set<() => void>();
  private waking = false;

  /** Each torn call tries again, once the current one is through: an announcement was taken, or another call is torn. */
  private wake(): void {
    if (this.waking || this.retries.size === 0) return;
    this.waking = true;
    queueMicrotask(() => {
      this.waking = false;
      for (const retry of [...this.retries]) retry();
    });
  }
}

/** The gate's id for a permission request of the agent's own tool: the same for the same request after a resume. */
export function permissionCallId(turn: string, request: { title?: string | null; kind?: string | null; rawInput?: unknown }, nth: number): string {
  const digest = createHash("sha256").update(canonical({ turn, title: request.title ?? "", kind: request.kind ?? "", input: request.rawInput ?? null, nth })).digest("hex");
  return `acp-perm-${digest.slice(0, 24)}`;
}
