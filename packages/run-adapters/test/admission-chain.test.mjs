// A host's admission of a paid request (beforeRequest) and that request's start (request_start) are one step: no other
// admission lands between them, even for requests asked for at once (a side call beside the main one). serve's harness
// bridge (harness-app.ts) carries an admission to its start in one slot (admittedNext) and relies on exactly this.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelPortFor } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const WHY = "admit() must stay chained (runner.ts admitting.then): harness-app's single admittedNext slot is safe only because no admission can land between another's admission and its request_start";

test('two requests asked for at once (a side call and the main one): each request_start reads its own admission, never the other\'s', async () => {
  const log = [];
  // The host's one slot, as harness-app keeps it: set at admission, taken at the next start.
  let slot;
  const started = new Map();
  const port = await modelPortFor(await memorySessionStore().open('k'), {
    key: 'k',
    beforeRequest: async (request) => {
      log.push(`admit ${request.side ? 'side' : 'main'}`);
      // The host's check takes a while (a slow write, a sync): time for another admission to land, were it allowed to.
      await new Promise((resolve) => setTimeout(resolve, 30));
      slot = { side: request.side === true, boundUsd: request.side ? 0.01 : 0.5 };
      return { holdUsd: slot.boundUsd };
    },
    onEvent: async (event) => {
      if (event.type !== 'request_start') return;
      log.push(`start ${event.turn}`);
      started.set(event.turn, slot);
      slot = undefined;
      // Its mark is committed and synced before it leaves, as harness-app's is.
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  });
  // Both asked for before either is admitted.
  const side = port.models.beforeRequest({ model: 'small', side: true, inputTokensMax: 100 });
  const main = port.models.beforeRequest({ model: 'main', inputTokensMax: 100 });
  const [sideTicket, mainTicket] = await Promise.all([side, main]);
  assert.deepEqual(log, ['admit side', 'start 1', 'admit main', 'start 2'], `${WHY}: ${JSON.stringify(log)}`);
  assert.deepEqual(started.get(sideTicket.turn), { side: true, boundUsd: 0.01 }, `${WHY}: the side call's start read ${JSON.stringify(started.get(sideTicket.turn))}`);
  assert.deepEqual(started.get(mainTicket.turn), { side: false, boundUsd: 0.5 }, `${WHY}: the main request's start read ${JSON.stringify(started.get(mainTicket.turn))}`);
});
