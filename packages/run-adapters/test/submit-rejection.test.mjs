// submit's rejection as the model reads it: a review that rejects a candidate without words still rejects it, and the
// model reads that the review gave no reason. A review's words, however long, reach the model through the host's one
// bound on a result (HOST_RESULT_MAX_CHARS, the tool bridge's), not a cut of submit's own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as kernel from '@parcha/agentrun-kernel';
import { fauxAdapter, memorySessionStore } from '@parcha/agentrun-kernel/testing';

const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false };

/** What submit answers the session for a first candidate the review answers with `verdict`, and the node's result; a
 *  second candidate is accepted, so the node ends. */
async function rejectedBy(verdict) {
  let submit;
  let rejected;
  const probe = { name: 'probe', description: 'Submit a draft.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => { rejected = await submit.call({ value: { answer: 'draft' } }, { callId: 'p', signal: new AbortController().signal }); return { text: 'ok' }; } };
  const adapter = fauxAdapter({ script: (spec) => { submit = spec.tools.find((tool) => tool.name === kernel.SUBMIT_TOOL); return [{ call: 'probe' }, { submit: { answer: 'final' } }]; } });
  const runNode = kernel.createHarnessRunner(adapter, { store: memorySessionStore(), tools: [probe] });
  const review = async (candidate) => (candidate.answer === 'final' ? { accepted: true } : verdict);
  const result = await runNode({ kind: 'agent', label: 'review', system: [], user: 'Go.', schema: SCHEMA, tools: ['probe'], review });
  return { result, rejected };
}

test('a review that rejects without words still rejects the candidate, and the model reads that it gave no reason', async () => {
  for (const verdict of [{ accepted: false }, { accepted: false, message: null }, { accepted: false, message: '' }, { accepted: false, message: '  \n ' }]) {
    const { result, rejected } = await rejectedBy(verdict);
    assert.deepEqual(result, { answer: 'final' }, `never the rejected candidate: ${JSON.stringify(verdict)}`);
    assert.deepEqual([rejected?.isError, rejected?.text], [true, 'Rejected: the review rejected it without saying why. Correct the result and call submit again.'], JSON.stringify(verdict));
  }
  const { rejected } = await rejectedBy({ accepted: false, message: 'Cite a source' });
  assert.equal(rejected.text, 'Rejected: Cite a source. Correct the result and call submit again.', "a review's words as it gave them");
});
