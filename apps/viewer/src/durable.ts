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

/** A pi conversation entry, as stored. */
export type Message = { role: string; content?: Json; toolCallId?: string; toolName?: string; isError?: boolean; usage?: Obj; details?: Obj };
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

/** The outside calls the effect kept (`calls`, the host's records, which the driver replaces in each process), or
 *  undefined when it keeps none. */
export const callsOf = (effect: Effect): Json[] | undefined => (Array.isArray(effect.calls) ? effect.calls : undefined);

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

/** A message's text, its image blocks' blobs, and its tool calls. */
export const textOf = (message: Message): string =>
  typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.map((block) => (isObj(block) && typeof block.text === 'string' ? block.text : '')).join('') : '';
export const toolCallsOf = (message: Message): { id: string; name: string; arguments: Json }[] =>
  Array.isArray(message.content)
    ? message.content.flatMap((block) => (isObj(block) && block.type === 'toolCall' ? [{ id: String(block.id), name: String(block.name), arguments: block.arguments ?? null }] : []))
    : [];
export const imagesOf = (message: Message): string[] =>
  Array.isArray(message.content) ? message.content.flatMap((block) => (isObj(block) && block.type === 'image' && typeof block.blob === 'string' ? [block.blob] : [])) : [];

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
