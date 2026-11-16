import assert from 'node:assert/strict';
import { Client } from 'eve/client';
import { emptySessionView, foldEvents, turns, calls, reply } from 'eve/events';

/** Re-read one completed native session without sending any message or running the model again. */
export async function readReport(sessionId, { expectedTask, baseUrl = process.env.EVE_BASE_URL ?? 'http://127.0.0.1:2000', bearer = process.env.EVE_BEARER_TOKEN } = {}) {
  assert.ok(typeof sessionId === 'string' && sessionId.length > 0 && typeof expectedTask === 'string', 'Reading a saved session requires its id and exact expected task.');
  const client = new Client({ baseUrl, ...(bearer ? { auth: { bearer } } : {}) });
  const records = [], seen = new Map();
  let bytes = 0, expectedLine = 0, previousLine = -1, previousIndex = -1;
  for await (const event of client.sessions.attach(sessionId).stream({ follow: false, startIndex: 0, reconnect: false, signal: AbortSignal.timeout(30_000) })) {
    const encoded = JSON.stringify(event);
    bytes += Buffer.byteLength(encoded);
    assert.ok(bytes <= 4_000_000 && records.length < 10_000, 'The saved session exceeds the bounded proof history.');
    const { line, index } = event.meta.position, key = `${line}:${index}`;
    assert.ok(Number.isSafeInteger(line) && line >= 0 && Number.isSafeInteger(index) && index >= 0, 'The saved session has invalid source positions.');
    if (seen.has(key)) { assert.equal(seen.get(key), encoded, 'The saved session contains conflicting facts.'); continue; }
    seen.set(key, encoded);
    assert.ok(line === previousLine ? index === previousIndex + 1 : line === expectedLine && index === 0, 'The saved session has missing history.');
    if (line !== previousLine) assert.notEqual(records.at(-1)?.meta.endOfLine, false, 'The saved session contains a partial earlier commit.');
    records.push(event);
    previousLine = line; previousIndex = index;
    expectedLine = event.meta.endOfLine === false ? line : Math.max(line + 1, event.meta.next ?? line + 1);
  }
  assert.notEqual(records.at(-1)?.meta.endOfLine, false, 'The saved session still has an incomplete commit; do not send a replacement task.');
  const starts = records.filter(event => event.type === 'turn.started');
  assert.equal(starts.length, 1, 'The comparison must have exactly one fresh native turn.');
  assert.equal(starts[0].data.follows, null, 'The saved turn continued prior conversation history.');
  const turnId = starts[0].data.turnId;
  const sessionStarts = records.filter(event => event.type === 'session.started');
  assert.equal(sessionStarts.length, 1, 'The native session start is missing or duplicated.');
  assert.ok(!sessionStarts[0].data.parent && !sessionStarts[0].data.predecessor, 'The saved session is inherited from another session.');
  const input = records.filter(event => event.type === 'delivery.consumed');
  assert.equal(input.length, 1, 'The saved session includes additional input or steering.');
  assert.equal(input[0].data.turnId, turnId, 'The saved input belongs to another turn.');
  assert.ok(!input[0].data.history?.length, 'The saved input imported earlier conversation history.');
  assert.deepEqual(input[0].data.parts, [{ kind: 'text', text: expectedTask }], 'The saved native task does not match this proof stage.');
  const view = foldEvents(emptySessionView(), records), nativeTurns = turns(view);
  assert.equal(nativeTurns.length, 1, 'The native session contains unexpected turns.');
  assert.equal(nativeTurns[0].status, 'settled', 'The saved native task is unfinished; inspect it instead of sending a replacement.');
  assert.equal(nativeTurns[0].outcome, 'completed', 'The saved native task did not complete successfully.');
  const selected = reply(view, turnId);
  assert.ok(selected.length && selected.every(part => part.kind === 'text' && !part.valueRef && !part.interrupted && typeof part.value === 'string'), 'The saved native answer is unavailable.');
  const toolCalls = calls(view, { turnId }).filter(call => call.kind === 'tool' && call.name === 'release_status').map(call => {
    assert.ok(records.some(event => event.type === 'call.started' && event.data.callId === call.callId), 'The original callback has no recorded start.');
    const value = call.output;
    return { callId: call.callId, name: call.name, outcome: call.outcome,
      ...(value && typeof value === 'object' && !call.outputRef ? { release: Object.fromEntries(
        ['service', 'version', 'tests', 'ready', 'observation'].filter(key => key in value).map(key => [key, value[key]])) } : {}) };
  });
  assert.ok(toolCalls.some(call => call.outcome === 'completed'), 'The original release_status callback did not finish.');
  return { sessionId, turnId, deliveryId: input[0].data.deliveryId, answer: selected.map(part => part.value).join('\n'), toolCalls };
}

/** One fresh native eve session. Reading its delivery again never sends the paid task again. */
export async function report(task, { baseUrl = process.env.EVE_BASE_URL ?? 'http://127.0.0.1:2000', bearer = process.env.EVE_BEARER_TOKEN, onStarted } = {}) {
  const client = new Client({ baseUrl, ...(bearer ? { auth: { bearer } } : {}) });
  await client.health();
  const signal = AbortSignal.timeout(180_000);
  const { session, delivery } = await client.sessions.create({ message: task, signal });
  await onStarted?.({ sessionId: session.id, deliveryId: delivery.deliveryId });
  const calls = new Map();
  let turnId;
  for await (const event of delivery.stream({ signal })) {
    if (event.type === 'delivery.consumed' && event.data.deliveryId === delivery.deliveryId) turnId = event.data.turnId;
    if (event.type === 'call.requested' && event.data.capability.name === 'release_status') {
      calls.set(event.data.callId, { callId: event.data.callId, name: 'release_status' });
    }
    if (event.type === 'call.settled' && calls.has(event.data.callId)) {
      const call = calls.get(event.data.callId);
      call.outcome = event.data.outcome;
      // This example's only output is the fictional fixture, never generic tool payloads.
      const value = event.data.output;
      if (value && typeof value === 'object') call.release = Object.fromEntries(
        ['service', 'version', 'tests', 'ready', 'observation'].filter(key => key in value).map(key => [key, value[key]]));
    }
  }
  const result = await delivery.result({ signal });
  assert.equal(result.status, 'completed', 'The native eve turn did not complete. Inspect that session before retrying.');
  assert.ok([...calls.values()].some(call => call.outcome === 'completed'), 'The existing release_status callback did not finish.');
  return { sessionId: session.id, turnId, answer: result.reply, toolCalls: [...calls.values()] };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.includes('--live')) throw new Error('This invokes a real model. Configure eve and run with --live.');
  const task = args.filter(arg => arg !== '--live').join(' ') || 'Read release status for demo-api and report its service, version, test result and readiness.';
  console.log(JSON.stringify(await report(task), null, 2));
}
