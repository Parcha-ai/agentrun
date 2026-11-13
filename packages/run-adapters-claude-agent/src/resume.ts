// Claude Code's part of a resume, for a host-tool call its transcript left dangling (a `tool_use` with no `tool_result`):
// which calls those are, read from the transcript the drive is about to resume, and how one's result is written into
// it. The decision (run it, or leave it to the CLI's own repair) is the shared one, `resumeUnstartedCalls`: only a call
// with no effect of its own on the run's journal runs here, through the tool bridge (the host's gate first, then its
// intent, the call and its result), and only then is its result written here, before the CLI starts again. A call
// that has an effect is left as before: the CLI answers it "[Tool call interrupted]", and the recovery note says what
// the log knows of it.
import type { GateAnswer, GateCall } from '@parcha/agentrun-kernel';
import { askGate, type CallOutcome, type DanglingCall, resumeUnstartedCalls, type ToolBridge, unstartedCalls } from './host/process.js';
import type { DriveContext } from './host/kernel.js';
import { uuidFrom } from './ids.js';
import type { JournalSessionStore, TranscriptLine } from './store.js';
import { toolResultIds } from './store.js';
import { MCP_SERVER } from './transcript.js';

const BRIDGED = `mcp__${MCP_SERVER}__`;

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

const toolUses = (line: TranscriptLine): ToolUseBlock[] => {
  if (line.type !== 'assistant') return [];
  const content = (line.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content.filter((c): c is ToolUseBlock => c?.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string') : [];
};

/** A user line that is a prompt (the user's words, a recovery's), not a tool result the CLI wrote. */
const isPrompt = (line: TranscriptLine) => line.type === 'user' && line.isSidechain !== true && toolResultIds(line).length === 0;

/**
 * The host-tool calls the transcript's last turn left without a result, in the order the model made them: the
 * `tool_use` blocks after its last prompt that no `tool_result` answers. A call before that prompt is the CLI's to
 * have answered when it resumed then; it is never taken up here, turns later. Built-ins (no `mcp__hands__` prefix)
 * are the CLI's own.
 */
export function danglingCalls(lines: readonly TranscriptLine[]): DanglingCall[] {
  return danglingOf(lines, (name) => (name.startsWith(BRIDGED) ? name.slice(BRIDGED.length) : undefined));
}

/** The CLI's own WebSearch calls the transcript's last turn left without a result, as `danglingCalls` finds host-tool
 *  ones (tool: `WebSearch`). */
export function danglingSearches(lines: readonly TranscriptLine[]): DanglingCall[] {
  return danglingOf(lines, (name) => (name === WEB_SEARCH ? name : undefined));
}

/** The CLI's name for its own web search. */
export const WEB_SEARCH = 'WebSearch';

/** The answer a held WebSearch gets on the resume once the host's gate lets it run: the CLI ran nothing of it, and the
 *  model's next search with the same input runs on that answer (resumeDanglingSearches). */
export const SEARCH_RELEASED = 'Not searched yet: this search was held before it ran, and it may run now. Search again with the same query to run it.';

/**
 * Before the CLI resumes the transcript: each dangling WebSearch that never started (the host's gate held it: its run
 * parked on a person) is put to the gate again, under the id the model gave it. A deny answers it in the gate's words; an
 * allow answers it SEARCH_RELEASED, since the provider runs a search only inside the CLI's own model request, and the
 * call is returned, so its drive lets the model's next search with the same input run on that answer, once. A gate that
 * parks again rejects out of here; what it wrote is the same lines again on the next resume.
 */
export async function resumeDanglingSearches(ctx: DriveContext, store: JournalSessionStore, gate: (call: GateCall) => Promise<GateAnswer>): Promise<DanglingCall[]> {
  const held = unstartedCalls(ctx, danglingSearches(store.lines()));
  const released: DanglingCall[] = [];
  for (const call of held) {
    const refused = await askGate(gate, { callId: call.callId, tool: call.tool, args: (call.args ?? {}) as Record<string, unknown> }, ctx.signal);
    if (!refused) released.push(call);
    store.extend(resultLine(store.lines(), call, refused ? { text: refused.deny, isError: true } : { text: SEARCH_RELEASED, isError: true }));
  }
  if (held.length) await store.flush();
  return released;
}

/** The tool uses after the last prompt that no result answers, each named by `named` (undefined: not one of these). */
function danglingOf(lines: readonly TranscriptLine[], named: (name: string) => string | undefined): DanglingCall[] {
  let from = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isPrompt(lines[i]!)) {
      from = i + 1;
      break;
    }
  }
  const tail = lines.slice(from).filter((line) => line.isSidechain !== true);
  const answered = new Set(tail.flatMap((line) => toolResultIds(line)));
  return tail.flatMap(toolUses).flatMap((block) => {
    const tool = answered.has(block.id) ? undefined : named(block.name);
    return tool === undefined ? [] : [{ callId: block.id, tool, args: block.input ?? {} }];
  });
}

/**
 * The user line that answers `call` with its outcome, as Claude Code writes an MCP tool's result: after the
 * transcript's last line, with the session fields of the assistant line that made the call. Its `uuid` is the call's,
 * so writing it again (a crash before the CLI started) is the same line.
 */
export function resultLine(lines: readonly TranscriptLine[], call: DanglingCall, outcome: CallOutcome): TranscriptLine {
  const asked = lines.findLast((line) => toolUses(line).some((block) => block.id === call.callId));
  const parent = lines.findLast((line) => typeof line.uuid === 'string');
  const session: Record<string, unknown> = {};
  for (const field of ['sessionId', 'cwd', 'version', 'userType', 'gitBranch'] as const) if (asked?.[field] !== undefined) session[field] = asked[field];
  return {
    parentUuid: parent?.uuid ?? null,
    isSidechain: false,
    ...session,
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: call.callId, type: 'tool_result', content: [{ type: 'text', text: outcome.text }], ...(outcome.isError ? { is_error: true } : {}) }] },
    uuid: uuidFrom(`result:${call.callId}`),
    timestamp: new Date().toISOString(),
    ...(asked?.uuid ? { sourceToolAssistantUUID: asked.uuid } : {}),
  };
}

/**
 * Before the CLI resumes the transcript: each dangling host-tool call that never started runs through `bridge`, and its
 * result is written into the transcript and committed, so the CLI starts again past it. A gate that parks rejects out
 * of here with nothing written, and the call keeps the id the model gave it.
 */
export async function resumeDanglingCalls(ctx: DriveContext, bridge: ToolBridge, store: JournalSessionStore): Promise<void> {
  const dangling = danglingCalls(store.lines());
  if (dangling.length === 0) return;
  await resumeUnstartedCalls(ctx, bridge, dangling, async (call, outcome) => {
    store.extend(resultLine(store.lines(), call, outcome));
  });
  await store.flush();
}
