// Claude Code's part of a resume, for a host-tool call its transcript left dangling (a `tool_use` with no `tool_result`):
// which calls those are, read from the transcript the drive is about to resume, and how one's result is written into
// it. The decision (run it, or leave it to the CLI's own repair) is the shared one, `resumeUnstartedCalls`: only a call
// with no effect of its own on the run's journal runs here, through the tool bridge (the host's gate first, then its
// intent, the call and its result), and only then is its result written here, before the CLI starts again. A call
// that has an effect is left as before: the CLI answers it "[Tool call interrupted]", and the recovery note says what
// the log knows of it.
import { type CallOutcome, type DanglingCall, resumeUnstartedCalls, type ToolBridge } from './host/process.js';
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
  let from = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isPrompt(lines[i]!)) {
      from = i + 1;
      break;
    }
  }
  const tail = lines.slice(from).filter((line) => line.isSidechain !== true);
  const answered = new Set(tail.flatMap((line) => toolResultIds(line)));
  return tail
    .flatMap(toolUses)
    .filter((block) => block.name.startsWith(BRIDGED) && !answered.has(block.id))
    .map((block) => ({ callId: block.id, tool: block.name.slice(BRIDGED.length), args: block.input ?? {} }));
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
