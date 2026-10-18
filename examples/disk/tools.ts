// The disk demo's confined read: `read_lines` returns a window of a text file and says exactly which lines it returned, so a report can cite them (draft 49). pi's own `read` states no window and a result of it
// cannot back a line cite. The result is: content part 0 is exactly the file lines `from` to `to` (0-based positions between line breaks, `to` exclusive, each line with its own line break) and nothing else;
// part 1 states the receipt, so the agent can cite it; `details.lines` is `{ from, to, part: 0 }` and `details.receipt` is the same receipt, unique in the run. The window is capped by a line count and a byte budget well under pi-durable's output limit (2000 lines, 50 KB), so a stored
// result is never cut, and a longer file is read in windows (`from`). The file is read through the run's environment, so the disk's confinement decides what is reachable: this tool adds no path of its own.
import { createHash } from 'node:crypto';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';

/** The most lines and bytes one window returns, each well under the output limit. */
export const WINDOW_LINES = 200;
export const WINDOW_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export type Window = { from: number; to: number; text: string; total: number };

/** The window of `file` from line `from` (0-based): at most `lines` lines and `WINDOW_BYTES` bytes, whole lines only. Pure, so the contract is tested without a harness. */
export function windowOf(file: string, from: number, lines = WINDOW_LINES): Window {
  const parts = file.split('\n');
  // A file that ends with a line break has no last line after it.
  if (parts.at(-1) === '') parts.pop();
  const total = parts.length;
  if (!Number.isInteger(from) || from < 0 || from >= total) throw new Error(`from ${from} is not a line of this file (it has ${total} lines, numbered from 0)`);
  const last = file.endsWith('\n');
  const end = Math.min(total, from + Math.max(1, Math.min(lines, WINDOW_LINES)));
  let text = '';
  let to = from;
  for (; to < end; to++) {
    const line = parts[to]! + (to < total - 1 || last ? '\n' : '');
    if (Buffer.byteLength(text + line) > WINDOW_BYTES) break;
    text += line;
  }
  if (to === from) throw new Error(`line ${from} is longer than ${WINDOW_BYTES} bytes, which no window holds`);
  return { from, to, text, total };
}

export const readLines = defineTool({
  name: 'read_lines',
  description: `Read lines of a text file in your workspace. It returns the lines and says which it returned: lines from to to, numbered from 0, to not included, so line 5 of a file is from 4 to 5. At most ${WINDOW_LINES} lines come back; read a longer file with from. The receipt it shows after the lines is what a citation names.`,
  parameters: Type.Object({
    path: Type.String({ description: 'The file, relative to your workspace (for example invoices/INV-001.txt).' }),
    from: Type.Optional(Type.Number({ description: 'The first line to read, numbered from 0. Default 0.' })),
    lines: Type.Optional(Type.Number({ description: `How many lines at most. Default and most ${WINDOW_LINES}.` })),
  }),
  replay: 'safe',
  async execute(args, api, context) {
    const env = api.env;
    if (!env) throw new Error('No execution environment is configured');
    const info = await env.fileInfo(args.path, context);
    if (!info.ok) throw new Error(`cannot read ${args.path}: ${info.error.message}`);
    if (info.value.size > MAX_FILE_BYTES) throw new Error(`${args.path} is larger than ${MAX_FILE_BYTES} bytes`);
    const file = await env.readTextFile(args.path, context);
    if (!file.ok) throw new Error(`cannot read ${args.path}: ${file.error.message}`);
    const window = windowOf(file.value, args.from ?? 0, args.lines ?? WINDOW_LINES);
    // Unique in the run, and the same on a replay: the conversation and the call that made it, hashed. A later host's conversations are new ones in the same store, so its receipts never repeat an earlier host's.
    const receipt = `rl-${createHash('sha256').update(`${api.conversationId}:${api.callId}`).digest('hex').slice(0, 12)}`;
    const note = `receipt ${receipt}: ${args.path}, lines ${window.from} to ${window.to} of ${window.total}${window.to < window.total ? `; continue with from ${window.to}` : ''}`;
    return {
      content: [{ type: 'text', text: window.text }, { type: 'text', text: note }],
      details: { path: args.path, receipt, lines: { from: window.from, to: window.to, part: 0 }, total: window.total },
    };
  },
});

/** The extension the review installs: the one tool. */
export const DiskReview = defineExtension({ name: 'disk-review', tools: [readLines] });
