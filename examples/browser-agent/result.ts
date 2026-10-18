// The result as the recording keeps it: a cited record whose one row is the agent's answer. The agent's evidence (every
// page it read, by its receipt) is in the recording's browser lines; the answer cites none of it by itself.
import type { DemoOptions } from '@parcha/agentrun-reference';

export const result: NonNullable<DemoOptions['result']> = (record) => {
  const { answer } = record as { answer: string };
  return { json: { format: 'agentrun.cited/1', title: answer, rows: [{ label: 'Answer', value: answer, cites: [] }] }, title: answer };
};
