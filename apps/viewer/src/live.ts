// What a live line from inside a run says (RECORDING.md section 5). Live lines show what is in flight; a count from them
// is "observed", never proven.
import type { Line } from './format.ts';

/** A model's ask: pi's live assistant `message_start` (a resumed generation emits no `turn_start`). */
export const isAsk = (line: Line) => {
  const data = line.data as { role?: unknown; message?: { role?: unknown } } | null;
  return line.channel === 'live' && line.source === 'pi' && line.kind === 'message_start' && (data?.message?.role ?? data?.role) === 'assistant';
};
