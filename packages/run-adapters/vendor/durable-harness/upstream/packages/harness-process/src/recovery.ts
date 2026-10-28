import { type EffectRecord, pendingSubmissions, type ReplayPolicy, type SessionState, type Submission } from 'harness-world';
import { type OpenTurn, openTurn } from './records.ts';

export { type OpenTurn, openTurn };

/**
 * The recovery note: what a process harness tells its model when it resumes
 * a turn a crash cut off. A CLI harness resumes its own session natively,
 * but it never knows what happened to the calls that were in flight (Claude
 * Code and OpenCode answer a dangling call "interrupted, outcome unknown";
 * Codex and Cursor need one injected), and a resumed session needs a new
 * user message to move. The note is that message, built from the log: the
 * calls since the turn began, each with what the log knows about it.
 */

export interface RecoveryCall {
  callId: string;
  name: string;
  input: unknown;
  replay: ReplayPolicy;
  /**
   * - `completed`: the result is recorded (`output`);
   * - `failed`: the tool failed and said so (`error`);
   * - `interrupted`: a `replay: 'never'` call whose outcome was lost: it may
   *   have taken effect;
   * - `retryable`: a `replay: 'safe'` call that was interrupted: safe to repeat;
   * - `running`: still open in the log (build the note after the kernel's
   *   recovery has resolved intents; a drive's own context always has).
   */
  status: 'completed' | 'failed' | 'interrupted' | 'retryable' | 'running';
  output?: string;
  error?: string;
}

export interface RecoveryOptions {
  /** Pending submissions to fold into the note. Default: every pending one. Pass `[]` to place them separately. */
  pending?: Submission[];
  /**
   * Quote the prompts placed in the interrupted turn. For a harness whose
   * native session may have lost them (the crash came before the record of
   * the message was in the log).
   */
  prompts?: boolean;
  /** How much of a tool's output, input or error to quote. Default 1500 characters. */
  clipChars?: number;
}

export interface RecoveryNote {
  /** The message to send the harness, as a user message. */
  text: string;
  calls: RecoveryCall[];
  /** The pending submissions the note carries: place these with it (`placeSubmissions`). */
  pending: Submission[];
  turn: OpenTurn;
}

/** The note for the open turn, or `undefined` if no turn is open. */
export function recoveryNote(state: SessionState, options: RecoveryOptions = {}): RecoveryNote | undefined {
  const turn = openTurn(state);
  if (!turn) return undefined;
  const max = options.clipChars ?? 1500;
  const calls = turn.calls.map((e) => recoveryCall(e, max));
  const pending = options.pending ?? pendingSubmissions(state);
  const lines: string[] = [
    '[Recovery] Your previous turn was interrupted: the process running it stopped, and this session was resumed from its durable log.',
  ];
  if (options.prompts) {
    const texts = turn.placed
      .map((id) => state.submissions.find((s) => s.id === id)?.text)
      .filter((t): t is string => !!t);
    if (texts.length) lines.push('', 'The user\'s message in that turn:', ...texts.map((t) => quote(clip(t, max))));
  }
  lines.push('');
  if (calls.length === 0) lines.push('No tool call had started in that turn.');
  else {
    lines.push('What the log records about the tool calls since that turn began:');
    for (const c of calls) lines.push(...describe(c));
  }
  lines.push('', 'Check the actual state before repeating anything that may have taken effect, then carry on with the task.');
  if (pending.length) {
    lines.push('', 'New messages since then:');
    for (const s of pending) lines.push(quote(s.text ?? ''));
  }
  return { text: lines.join('\n'), calls, pending, turn };
}

function recoveryCall(e: EffectRecord, max: number): RecoveryCall {
  const base = {
    callId: e.key.startsWith('tool:') ? e.key.slice(5) : e.key,
    name: e.name.slice('tool.'.length),
    input: e.input,
    replay: e.replay,
  };
  if (e.status === 'completed') return { ...base, status: 'completed', output: clip(text(e.output), max) };
  if (e.status === 'pending') return { ...base, status: 'retryable' };
  if (e.status === 'running') return { ...base, status: 'running' };
  if (e.error?.interrupted) return { ...base, status: e.replay === 'safe' ? 'retryable' : 'interrupted' };
  return { ...base, status: 'failed', error: clip(e.error?.message ?? 'failed', max) };
}

function describe(c: RecoveryCall): string[] {
  const head = `- ${c.name}(${clip(text(c.input), 300)}), call ${c.callId}:`;
  switch (c.status) {
    case 'completed':
      return [`${head} completed. Its result:`, ...indent(c.output ?? '')];
    case 'failed':
      return [`${head} failed: ${c.error}`];
    case 'interrupted':
      return [`${head} interrupted before it reported a result. It is not safe to repeat, and it may have taken effect: check before repeating it.`];
    case 'retryable':
      return [`${head} interrupted before it reported a result. It is safe to repeat.`];
    case 'running':
      return [`${head} interrupted, and it may still be running. It may have taken effect: check before repeating it.`];
  }
}

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v));
const quote = (t: string) => t.split('\n').map((l) => `> ${l}`).join('\n');
const indent = (t: string) => t.split('\n').map((l) => `    ${l}`);

function clip(t: string, max: number): string {
  return t.length <= max ? t : `${t.slice(0, max)}… [${t.length - max} more characters]`;
}

/**
 * The live event a harness sends as it resumes a turn a crash cut off,
 * before the model answers again: the model starts the step the crash
 * interrupted over, so what a reader saw of its reply is replaced.
 * `text` is the turn's text as the log kept it (the assistant text of its
 * finished steps, and the text before each tool call); a reader shows it in
 * place of what it showed of the turn so far (everything since the last
 * `idle`), and appends what streams after it. `parts` is the same text, one
 * entry per kept step, for a reader that shows tool calls between them: a
 * turn on screen with more text than `parts` has a cut-off reply last.
 */
export function restartEvent(turn: OpenTurn): { type: 'restart'; text: string; parts: string[] } {
  const parts = turn.entries.flatMap((r) => (r.data?.type === 'message' && r.data.role === 'assistant' && r.data.text ? [r.data.text] : []));
  return { type: 'restart', text: parts.join('\n\n'), parts };
}
