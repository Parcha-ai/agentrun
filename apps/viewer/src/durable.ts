// What a durable line holds (RECORDING.md 3.1). Every read of a durable line's `data` is here, so a change in the
// export's shape is a change to this file.
import type { Json, Line } from './format.ts';

type Obj = { [key: string]: Json };
const isObj = (value: Json | undefined): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A document revision: the document kind, its family key (absent for a singleton), its whole value after the
 *  revision, and its stored version. */
export type DocLine = { doc: string; key?: string; value: Json; version?: number };
export const docOf = (line: Line): DocLine | undefined =>
  line.channel === 'durable' && isObj(line.data) && typeof line.data.doc === 'string' && 'value' in line.data ? (line.data as unknown as DocLine) : undefined;
/** A document's identity (RECORDING.md 3.1): `(doc, key, conv, task)`. A conversation-scoped document exists once per
 *  conversation, a task-scoped one once per task. */
export const docIdOf = (line: Line, doc: DocLine) => [doc.doc, doc.key ?? '', line.conv ?? '', line.task ?? ''].join('\u0001');

/** A pi conversation entry, as stored. */
export type Message = { role: string; content?: Json; toolCallId?: string; toolName?: string; isError?: boolean; usage?: Obj; details?: Obj; stopReason?: string };
export type Entry = { kind: string; id?: number; conversationId?: number; byTaskId?: number; model: Message[]; data?: Json };
export const entryOf = (line: Line): Entry | undefined =>
  line.channel === 'durable' && line.source === 'pi' && isObj(line.data) && Array.isArray(line.data.model) ? (line.data as unknown as Entry) : undefined;

/** A pi task record as a line (`pi.generation`, `pi.tool`); where the export places it is still open. */
export const taskOf = (line: Line): { kind: string; id?: number; state?: Obj } | undefined =>
  line.channel === 'durable' && line.source === 'pi' && isObj(line.data) && line.data.kind === line.kind && !Array.isArray(line.data.model)
    ? (line.data as unknown as { kind: string; id?: number; state?: Obj }) : undefined;

/** An effect as the journal holds it (`agentrun.effects`): admitted `unknown`, then `completed`. */
export type Effect = { name: string; argsHash: string; status: 'unknown' | 'completed'; intent?: { tool: string; argsHash: string }; calls?: Json };
/** The effect id, from the family key `<journal key>\u0000<effect id>`. */
export const effectIdOf = (key: string) => key.split('\u0000').at(-1) ?? key;
export const effectOf = (doc: DocLine): Effect | undefined =>
  doc.doc === 'agentrun.effects' && isObj(doc.value) && typeof doc.value.status === 'string' ? (doc.value as unknown as Effect) : undefined;

/** The outside calls the host reported for an effect (`calls`, each `{ outcome: 'applied' | 'failed' | 'unknown', ... }`,
 *  a list the driver replaces in each process), or undefined when it reported none. */
export const callsOf = (effect: Effect): Json[] | undefined => (Array.isArray(effect.calls) ? effect.calls : undefined);
export const applied = (call: Json) => isObj(call) && call.outcome === 'applied';

/** A conversation's `pi.live` generation (pi's ask in flight: `{ attempt, message? }`, the message being the committed
 *  partial), or undefined when none is open. */
export const liveGenerationOf = (doc: DocLine): { attempt?: Json; message?: Json } | undefined =>
  doc.doc === 'pi.live' && isObj(doc.value) && isObj(doc.value.generation) ? doc.value.generation : undefined;

/** The journal's own record (`agentrun.driver`): the generation of the process that holds it. */
export const generationOf = (doc: DocLine): number | undefined =>
  doc.doc === 'agentrun.driver' && isObj(doc.value) && typeof doc.value.generation === 'number' ? doc.value.generation : undefined;

/** A move of the run's store (`transport.moves`, RECORDING.md 3.2): `head`, the sequence the target's first new commit
 *  takes after any replay; a move's `seal.head`; a restore's `checkpoint.head`, and `replayed.to` when it replayed. */
export type Move = { kind: string; head?: number; seal?: number; checkpoint?: number; replayedTo?: number };
export const moveOf = (doc: DocLine): Move | undefined => {
  const value = doc.value;
  if (doc.doc !== 'transport.moves' || !isObj(value) || typeof value.kind !== 'string') return undefined;
  const num = (holder: Json | undefined, field: string) => (isObj(holder) && typeof holder[field] === 'number' ? { [field]: holder[field] as number } : {});
  const seal = num(value.seal, 'head').head;
  const checkpoint = num(value.checkpoint, 'head').head;
  const replayedTo = num(value.replayed, 'to').to;
  return { kind: value.kind, ...num(value, 'head'), ...(seal !== undefined ? { seal } : {}), ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(replayedTo !== undefined ? { replayedTo } : {}) };
};

/** A decision row (`agentrun.decisions`). */
export type DecisionRow = { decision_id?: string; run_key?: string; node?: string; error?: string; cost_usd?: number | null; rule?: Json };
export const decisionRowsOf = (doc: DocLine): DecisionRow[] | undefined =>
  doc.doc === 'agentrun.decisions' && isObj(doc.value) && Array.isArray(doc.value.receipts) ? (doc.value.receipts as unknown as DecisionRow[]) : undefined;

/** An agent's paid tool calls (`agentrun.receipts`): one per tool and argsHash. A family member is one; a singleton's
 *  value counts its entries. */
export const receiptCountOf = (doc: DocLine): number | undefined => {
  if (doc.doc !== 'agentrun.receipts') return undefined;
  if (doc.key !== undefined) return 1;
  const value = doc.value;
  return Array.isArray(value) ? value.length : isObj(value) ? Object.keys(value).length : 0;
};

/** A message's text parts, in order (a string content is one part); its image blocks' blobs; its tool calls. */
export const textPartsOf = (message: Message): string[] =>
  typeof message.content === 'string' ? [message.content]
    : Array.isArray(message.content) ? message.content.flatMap((block) => (isObj(block) && typeof block.text === 'string' ? [block.text] : [])) : [];
/** A message's text: its text parts, each set apart from the next by a blank line. */
export const textOf = (message: Message): string => textPartsOf(message).join('\n\n');
export const toolCallsOf = (message: Message): { id: string; name: string; arguments: Json }[] =>
  Array.isArray(message.content)
    ? message.content.flatMap((block) => (isObj(block) && block.type === 'toolCall' ? [{ id: String(block.id), name: String(block.name), arguments: block.arguments ?? null }] : []))
    : [];
export const imagesOf = (message: Message): string[] =>
  Array.isArray(message.content) ? message.content.flatMap((block) => (isObj(block) && block.type === 'image' && typeof block.blob === 'string' ? [block.blob] : [])) : [];

/** A browser session's charge in `browser.sessions`: its `spent.usd` once priced, else unknown (null). */
export const browserChargesOf = (doc: DocLine): { tag: string; usd: number | null }[] | undefined => {
  if (doc.doc !== 'browser.sessions' || !isObj(doc.value) || !Array.isArray(doc.value.sessions)) return undefined;
  return doc.value.sessions.flatMap((session) => {
    if (!isObj(session) || typeof session.tag !== 'string') return [];
    const spent = isObj(session.spent) ? session.spent : undefined;
    return [{ tag: session.tag, usd: spent?.state === 'priced' && typeof spent.usd === 'number' ? spent.usd : null }];
  });
};

/** A page action a `browser.sessions` revision journals (RECORDING.md section 6): pi-browser writes each replay-unsafe
 *  action as a session record's `pendingEffect` before it acts, and a later entry carries earlier ones as `prior`. Its key
 *  is its `tool` (absent means `run`) and `codeSha`, in its conversation; it REACHED THE PAGE when this revision shows it
 *  `finished` or with a `sent` row whose `held` is not `"denied"`. */
export type PageAction = { callId: string; tool: string; codeSha: string; reached: boolean };
export const pageActionsOf = (doc: DocLine): PageAction[] | undefined => {
  if (doc.doc !== 'browser.sessions' || !isObj(doc.value) || !Array.isArray(doc.value.sessions)) return undefined;
  const out: PageAction[] = [];
  const visit = (entry: Json | undefined): void => {
    if (Array.isArray(entry)) { entry.forEach(visit); return; }
    if (!isObj(entry)) return;
    // The entries a later one carries were dispatched before it: they come first.
    visit(entry.prior);
    if (typeof entry.callId === 'string' && typeof entry.codeSha === 'string') {
      const sent = Array.isArray(entry.sent) ? entry.sent : [];
      out.push({ callId: entry.callId, tool: typeof entry.tool === 'string' ? entry.tool : 'run', codeSha: entry.codeSha,
        reached: entry.finished === true || sent.some((row) => isObj(row) && row.held !== 'denied') });
    }
  };
  for (const session of doc.value.sessions) if (isObj(session)) visit(session.pendingEffect);
  return out;
};

/** The LookRecords a `vision.*` document files, each with its place in the document's list (the list only grows, and
 *  every revision carries all of it), its look key (`facts.key`), whether the eyes answered (`status` ok), whether the
 *  lead looked itself (`args.native`), whether it is an answer read back after a kill (`facts.kept`), and its price
 *  (`facts.cost_usd`, null when absent). A record with no key is not a look. */
export type LookFiling = { index: number; receipt: string | null; key: string; ok: boolean; native: boolean; kept: boolean; usd: number | null };
export const lookFilingsOf = (doc: DocLine): LookFiling[] | undefined => {
  if (!doc.doc.startsWith('vision.') || !isObj(doc.value) || !Array.isArray(doc.value.looks)) return undefined;
  return doc.value.looks.flatMap((filing, index) => {
    const record = isObj(filing) && isObj(filing.record) ? filing.record : undefined;
    const facts = record && isObj(record.facts) ? record.facts : undefined;
    const args = record && isObj(record.args) ? record.args : undefined;
    if (!record || !facts || typeof facts.key !== 'string') return [];
    return [{ index, receipt: isObj(filing) && typeof filing.receipt === 'string' ? filing.receipt : null, key: facts.key, ok: record.status === 'ok',
      native: args?.native === true, kept: facts.kept === true, usd: typeof facts.cost_usd === 'number' ? facts.cost_usd : null }];
  });
};
/** The look key a live `LookEvent` names (`record.facts.key`), and whether the lead looked itself (`args.native`). */
export const lookEventOf = (data: Json): { key: string; native: boolean } | undefined => {
  const record = isObj(data) && isObj(data.record) ? data.record : undefined;
  const facts = record && isObj(record.facts) ? record.facts : undefined;
  return typeof facts?.key === 'string' ? { key: facts.key, native: isObj(record?.args) && record.args.native === true } : undefined;
};

/** A message's priced usage, or null when it carries none. */
export const costOf = (message: Message): number | null => {
  const cost = isObj(message.usage) && isObj(message.usage.cost) ? message.usage.cost.total : undefined;
  return typeof cost === 'number' ? cost : null;
};

/** JSON with sorted keys: an identity for arguments, the same whatever order they were written in. */
export function stableJson(value: Json | undefined): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
