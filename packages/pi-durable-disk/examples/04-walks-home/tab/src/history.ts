// What the model is shown of a conversation: pi's transcript turned into the plain user and assistant turns the small model was trained on. No system
// message, no tools, no tool results, and NEVER an earlier turn's thinking: the model was trained on one question at a time, each with its own thinking, and
// when it was shown its earlier thinking it talked about the earlier question and copied the earlier answer's wording (measured, README "history").
// Pure: it knows pi's message shapes only structurally, so the tab's Harness provider and the node tests both use it.
import type { ChatMsg } from './modelhost.ts';
import { REFUSAL } from './guard.ts';

export type HistoryMode = 'none' | 'last';

/** The parts of a pi message this reads (pi's `Message` fits it). */
export interface PiMessageLike { role: string; content?: unknown; rawStopReason?: string; stopReason?: string }

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c?.type === 'text' ? c.text ?? '' : '')).join('') : '';

/** The marker a held answer carries in the transcript (`rawStopReason`): the reader saw only the refusal line, and the model is never shown that turn. */
export const HELD = 'held_by_judge';

/** A turn the judge held: marked, or exactly the refusal line (a transcript written before the mark existed). */
export const isHeld = (m: PiMessageLike): boolean => m.role === 'assistant' && (m.rawStopReason === HELD || textOf(m.content).trim() === REFUSAL);

/**
 * The messages to send for the newest user message in `messages`. `none`: that message alone, every question answered fresh. `last`: the exchange before it
 * (a user message and the answer it got, the answer's TEXT only) and then that message. An exchange whose answer was held, failed, or came out empty is
 * skipped, so a refusal never reaches the model. Never any thinking, tool call, tool result or system message.
 */
export function chatMessages(messages: readonly PiMessageLike[], mode: HistoryMode): ChatMsg[] {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { at = i; break; }
  if (at < 0) return [];
  const current: ChatMsg = { role: 'user', content: textOf(messages[at].content) };
  if (mode === 'none') return [current];
  // the exchange just before: the nearest earlier user message that has a real answer after it (before the next user message)
  for (let i = at - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    let answer = '';
    for (let j = i + 1; j < at && messages[j].role !== 'user'; j++) {
      const m = messages[j];
      if (m.role === 'assistant' && !isHeld(m) && m.stopReason !== 'error' && m.stopReason !== 'aborted') answer = textOf(m.content).trim() || answer;
    }
    if (answer) return [{ role: 'user', content: textOf(messages[i].content) }, { role: 'assistant', content: answer }, current];
    break; // the exchange right before had no usable answer (held or failed): this question is answered fresh, never from an older exchange
  }
  return [current];
}
