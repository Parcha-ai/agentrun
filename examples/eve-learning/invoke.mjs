import assert from 'node:assert/strict';
import { Client } from 'eve/client';

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
