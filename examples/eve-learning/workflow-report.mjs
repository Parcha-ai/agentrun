import assert from 'node:assert/strict';
import { Client } from 'eve/client';
import { calls, emptySessionView, foldEvents, reply, turns } from 'eve/events';

/** Re-read real finite source history; never replay a native task to recover a proof. */
export async function readWorkflowReport(sessionId, { expectedTask, baseUrl = process.env.EVE_BASE_URL,
  bearer = process.env.EVE_BEARER_TOKEN } = {}) {
  assert.ok(sessionId && typeof expectedTask === 'string' && baseUrl, 'The saved session, expected task and Eve URL are required.');
  const client = new Client({ baseUrl, ...(bearer ? { auth: { bearer } } : {}) });
  const records = [], seen = new Map();
  let bytes = 0, line = -1, index = -1, expectedLine = 0;
  for await (const event of client.sessions.attach(sessionId).stream({ follow: false, startIndex: 0,
    reconnect: false, signal: AbortSignal.timeout(30_000) })) {
    const encoded = JSON.stringify(event), position = event.meta.position, key = `${position.line}:${position.index}`;
    bytes += Buffer.byteLength(encoded);
    assert.ok(bytes <= 4_000_000 && records.length < 10_000, 'The proof session exceeds bounded history.');
    if (seen.has(key)) { assert.equal(seen.get(key), encoded, 'Conflicting native history.'); continue; }
    assert.ok(position.line === line ? position.index === index + 1 : position.line === expectedLine && position.index === 0, 'Native history has gaps.');
    if (position.line !== line) assert.notEqual(records.at(-1)?.meta.endOfLine, false, 'An earlier native commit is partial.');
    records.push(event); seen.set(key, encoded); line = position.line; index = position.index;
    expectedLine = event.meta.endOfLine === false ? line : Math.max(line + 1, event.meta.next ?? line + 1);
  }
  assert.notEqual(records.at(-1)?.meta.endOfLine, false, 'Native history is still partial; inspect the saved session.');
  const starts = records.filter(event => event.type === 'turn.started');
  assert.equal(starts.length, 1, 'The workflow comparison requires one fresh native turn.');
  assert.equal(starts[0].data.follows, null, 'The workflow comparison inherited conversation context.');
  const session = records.filter(event => event.type === 'session.started');
  assert.equal(session.length, 1); assert.ok(!session[0].data.parent && !session[0].data.predecessor, 'The session inherited another agent’s context.');
  const input = records.filter(event => event.type === 'delivery.consumed');
  assert.equal(input.length, 1, 'The proof includes additional input or steering.');
  assert.ok(!input[0].data.history?.length);
  assert.deepEqual(input[0].data.parts, [{ kind: 'text', text: expectedTask }], 'The saved task changed.');
  const turnId = starts[0].data.turnId;
  assert.equal(input[0].data.turnId, turnId);
  const view = foldEvents(emptySessionView(), records), turn = turns(view);
  assert.equal(turn.length, 1); assert.equal(turn[0].status, 'settled'); assert.equal(turn[0].outcome, 'completed');
  const parts = reply(view, turnId);
  assert.ok(parts.length && parts.every(part => part.kind === 'text' && !part.valueRef && !part.interrupted && typeof part.value === 'string'), 'The original answer is unavailable.');
  const toolCalls = calls(view, { turnId }).filter(call => call.kind === 'tool').map(call => {
    const row = { callId: call.callId, name: call.name, outcome: call.outcome };
    assert.ok(records.some(event => event.type === 'call.started' && event.data.callId === call.callId), 'A source tool call has no recorded start.');
    if (call.name === 'agentrun__learned_workflow') {
      const trace = !call.outputRef && call.output?.agentrun;
      assert.ok(trace && trace.version === 1 && trace.callId === call.callId && trace.sessionId === sessionId && trace.turnId === turnId,
        'The workflow result has no bound execution trace.');
      // Persist metadata only. Never retain the private signature or any capability from a native envelope.
      row.workflow = { name: trace.name, revision: trace.revision, runId: trace.runId, complete: trace.complete,
        events: (trace.events ?? []).filter(event => event.type === 'tool').map(event => ({
          id: event.id, name: event.name, status: event.status,
          ...(event.parent_tool_use_id ? { parent_tool_use_id: event.parent_tool_use_id } : {}),
        })) };
    }
    return row;
  });
  return { sessionId, turnId, answer: parts.map(part => part.value).join('\n'), toolCalls };
}

export async function workflowReport(task, { baseUrl = process.env.EVE_BASE_URL, bearer = process.env.EVE_BEARER_TOKEN, onStarted } = {}) {
  assert.ok(baseUrl, 'Set EVE_BASE_URL to the existing workflow example.');
  const client = new Client({ baseUrl, ...(bearer ? { auth: { bearer } } : {}) });
  await client.health();
  const signal = AbortSignal.timeout(180_000);
  const { session, delivery } = await client.sessions.create({ message: task, signal });
  await onStarted?.({ sessionId: session.id, deliveryId: delivery.deliveryId });
  for await (const _event of delivery.stream({ signal })) { /* Consume without logging raw native events. */ }
  const result = await delivery.result({ signal });
  assert.equal(result.status, 'completed', 'The original Eve task failed; do not resend it automatically.');
  return readWorkflowReport(session.id, { expectedTask: task, baseUrl, bearer });
}
