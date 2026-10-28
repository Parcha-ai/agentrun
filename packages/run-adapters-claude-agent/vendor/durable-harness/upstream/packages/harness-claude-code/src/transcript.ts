import type { TranscriptEntry } from 'harness-world-process';

/**
 * The normalized transcript (harness-world-process's `transcript` stream) and
 * the live events, from the Agent SDK's messages.
 *
 * `query()` yields one `assistant` message per completed content block
 * (thinking, text, tool_use), `stream_event` deltas while a block streams
 * (with `includePartialMessages`), and one `result` per turn. This keeps the
 * text said since the last tool call, writes it with the call that follows it
 * (`{ role: 'assistant', text, toolCalls }`), and writes the rest and a `turn`
 * entry at the result. Text deltas go to the live stream. Subagent messages
 * (`parent_tool_use_id` set) are left out.
 *
 * Pure: the drive hands it SDK messages and gets entries back through `sink`,
 * so it is tested on recorded messages.
 */

export interface TranscriptSink {
  message(entry: TranscriptEntry): void;
  live(event: unknown): void;
}

/** The MCP server name the workspace tools are served under: the model sees `mcp__hands__<tool>`. */
export const MCP_SERVER = 'hands';
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

/** A tool's name without the MCP prefix. */
export const bareToolName = (name: string) => (name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name);

/** How a turn ended, from its `result` message. */
export interface TurnEnd {
  status: 'completed' | 'failed';
  error?: string;
  /** More turns follow without new input (`queued_turn_count`). */
  queued: number;
  /**
   * The `uuid`s of the user messages this turn consumed (`user_message_uuids`),
   * or `undefined` from a CLI that does not report them.
   */
  consumed?: string[];
  sessionId?: string;
}

type Block = { type?: string; text?: string; id?: string; name?: string };
// The SDK's message union, structurally (the SDK is a peer dependency).
type SdkMessage = { type: string; subtype?: string; parent_tool_use_id?: string | null; [k: string]: unknown };

export class TranscriptBuilder {
  private said = '';
  private readonly written = new Set<string>();
  private readonly waiters = new Map<string, (() => void)[]>();

  constructor(private readonly sink: TranscriptSink) {}

  /** One message from `query()`. Returns how the turn ended for a `result`. */
  observe(m: SdkMessage): TurnEnd | undefined {
    if (m.parent_tool_use_id) return undefined;
    if (m.type === 'stream_event') {
      const ev = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) this.sink.live({ type: 'text', delta: ev.delta.text });
      return undefined;
    }
    if (m.type === 'assistant') {
      const content = (m.message as { content?: unknown } | undefined)?.content;
      for (const block of Array.isArray(content) ? (content as Block[]) : []) {
        if (block.type === 'text' && block.text) this.said = this.said ? `${this.said}\n\n${block.text}` : block.text;
        else if (block.type === 'tool_use' && block.id) this.call(block.id, bareToolName(block.name ?? 'tool'));
      }
      return undefined;
    }
    if (m.type === 'result') {
      const isError = m.is_error === true || m.subtype !== 'success';
      const errors = Array.isArray(m.errors) ? (m.errors as unknown[]).map(String) : [];
      const error = isError ? (typeof m.result === 'string' && m.result) || errors.join('; ') || String(m.subtype) : undefined;
      const consumed = Array.isArray(m.user_message_uuids)
        ? (m.user_message_uuids as unknown[]).map(String)
        : typeof m.user_message_uuid === 'string'
          ? [m.user_message_uuid]
          : undefined;
      return {
        status: isError ? 'failed' : 'completed',
        ...(error ? { error } : {}),
        queued: typeof m.queued_turn_count === 'number' ? m.queued_turn_count : 0,
        ...(consumed ? { consumed } : {}),
        ...(typeof m.session_id === 'string' ? { sessionId: m.session_id } : {}),
      };
    }
    return undefined;
  }

  /**
   * Write the turn's last text and its end. Called at each `result`, or with
   * `interrupted` when the drive stops a turn it cannot finish.
   */
  endTurn(end: Pick<TurnEnd, 'status' | 'error'> | { status: 'interrupted'; error?: string }): void {
    if (this.said) this.sink.message({ type: 'message', role: 'assistant', text: this.said });
    this.said = '';
    this.sink.message({ type: 'turn', status: end.status, ...(end.error ? { error: end.error } : {}) });
  }

  /**
   * A tool call is about to run (its MCP handler was called). The message
   * that made it is written first: by `observe`, which normally sees the
   * `tool_use` block a moment before the handler runs (the CLI writes the
   * block before it calls the tool); after `waitMs`, by this.
   */
  async beforeCall(id: string, name: string, waitMs = 1000): Promise<void> {
    if (this.written.has(id)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, waitMs);
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), done]);
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
    this.call(id, name);
  }

  private call(id: string, name: string): void {
    if (this.written.has(id)) return;
    this.written.add(id);
    this.sink.message({ type: 'message', role: 'assistant', text: this.said, toolCalls: [{ id, name }] });
    this.said = '';
    for (const w of this.waiters.get(id) ?? []) w();
    this.waiters.delete(id);
  }
}
