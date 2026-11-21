import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { serve } from './support.mjs';
import { transcriptOf } from '../dist/import.js';

const DAY = 86_400_000;
const today = () => Date.parse(new Date().toISOString().slice(0, 10));
const date = ms => new Date(ms).toISOString().slice(0, 10);
const hash = value => createHash('sha256').update(value).digest('hex');
const counts = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, requests: 1, unmetered: 0 });
const usage = (input, output, extra = {}) => ({ model: 'native-model', input_tokens: input, output_tokens: output, ...extra });

async function run(s, id, metrics, agent = 'managed', body = { instructions: 'Task.' }, launch) {
  if (!await s.store.agents.get(agent)) await s.store.agents.create({ id: agent, name: agent }, { id: `rev-${agent}`, kind: 'agentic', body });
  await s.store.runs.create({ id, agentId: agent, revisionId: `rev-${agent}` }, launch);
  const claim = await s.store.claim(id, 'test-runner', { leaseMs: 60_000 });
  await s.store.runs.update(claim, { state: 'ended', outcome: 'completed', endedAt: Date.now(), metrics });
  return claim;
}
async function cliWindow(s, id, input, output, { session = 'native-session', turn = id, agent = 'profile', reflection = 0, nativeReflection = false } = {}) {
  const cli = { runtime: 'codex-cli', connection_id: 'connection', connection_generation: 'generation', session_id: session,
    turn_id: turn, instructions: 'Task.', policy_complete: true, ...(nativeReflection ? { native_grading: { runtime: 'codex' } } : {}) };
  const claim = await run(s, id, { ...counts(input + reflection, output), cli_runtime: cli.runtime, cli_session_id: session }, agent,
    { instructions: 'Task.', cli_learning: { runtime: 'codex', connection_id: cli.connection_id } }, { body: { cli_learning: cli } });
  await s.store.settings.putIfAbsent(`sdk-run:${id}`, { completion: { status: 'completed', session_id: session, evidence_complete: true,
    usage: { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null } } });
  return claim;
}
async function observed(s, id, days, { native, connection, harness = 'codex', connector = id, received = Date.now() } = {}) {
  await s.store.settings.putIfAbsent(`observation.connector.${connector}`, { id: connector, sessions: {
    [id]: { id, harness, received_at: new Date(received).toISOString(), usage_by_day: days,
      ...(native ? { learning_association: { readiness: 'ready', native_session_hash: hash(native), connection_id: connection, generation: 'historic' } } : {}),
    },
  } });
}
const read = async (s, query = '') => { const result = await s.api('GET', '/stats' + query); assert.equal(result.status, 200); return result.body.analytics; };

test('one dashboard token total includes managed runs and connected sessions even without cache breakdown', async t => {
  const s = await serve(t, { runner: false });
  await run(s, 'managed-run', counts(100, 20, 50, 0));
  await observed(s, 'os_external', { [date(today())]: { model: usage(300, 40) } });
  const a = await read(s, '?from=' + new Date(today()).toISOString());
  assert.equal(a.usage?.tokens, 510, '170 managed + 340 externally reported tokens share the main total');
  assert.equal(a.usage.input, null, 'unknown source cache split is not guessed');
  assert.equal(a.usage.output, 60);
  assert.equal(a.usage.known_runs, 1);
  assert.equal(a.usage.observed_sessions, 1);
  assert.deepEqual(a.usage.by_day, [{ day: date(today()), tokens: 510 }]);
  assert.equal(a.totals.runs, 1, 'source sessions do not invent completed runs');
});

test('overlapping source, CLI, SDK, native and imported views form a lower bound without blind addition', async t => {
  const s = await serve(t, { runner: false });
  await run(s, 'cli-window', { ...counts(10, 2), cli_session_id: 'native-session', cli_runtime: 'codex-cli' }, 'profile');
  await run(s, 'native-window', { ...counts(20, 3), native_session_id: 'native-session', native_runtime: 'codex' }, 'native');
  await run(s, 'sdk-window', { ...counts(20, 3), sdk_session_id: 'native-session', sdk_runtime: 'codex-sdk' }, 'sdk');
  await run(s, 'other', counts(5, 2));
  for (const [id, input, output] of [['cli-window', 10, 2], ['sdk-window', 20, 3]]) await s.store.settings.putIfAbsent(`sdk-run:${id}`,
    { completion: { usage: { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null } } });
  await s.store.importRun({ id: 'imported-root', agentId: 'profile', revisionId: 'rev-profile', importedFrom: { source: 'codex', session: 'native-session' },
    launch: { body: {} }, metrics: counts(500, 50), startedAt: Date.now(), endedAt: Date.now(), transcript: [] });
  await s.store.settings.putIfAbsent('cli-learning-connection:connection', { agent_id: 'profile', active: false });
  await observed(s, 'os_source', { [date(today())]: { model: usage(1000, 80, { cache_read_tokens: 700, cache_write_tokens: 0 }) } }, { native: 'native-session', connection: 'connection' });
  const a = await read(s);
  assert.equal(a.usage?.tokens, 1087, 'session source is counted once, not added to its three recorded run views');
  assert.equal(a.usage.known_runs, 1);
  assert.equal(a.usage.unknown_runs, 4, 'neither same-session identity nor a larger day bucket proves complete overlap');
  assert.equal(a.usage.observed_sessions, 1);
  assert.equal(a.totals.runs, 5);
  assert.equal((await read(s, '?agent=profile')).usage.tokens, 1080, 'historical verified association survives revocation');
  assert.equal((await read(s, '?agent=os_source')).usage.tokens, 1080);
  assert.equal((await read(s, '?agent=managed')).usage.tokens, 7);
});

test('unbound session selection and date bounds never include another session or its lifetime total', async t => {
  const s = await serve(t, { runner: false });
  await observed(s, 'os_one', {
    [date(today() - 2 * DAY)]: { model: usage(900, 90) },
    [date(today())]: { model: usage(30, 3) },
  });
  await observed(s, 'os_two', { [date(today())]: { model: usage(70, 7) } });
  const query = '?agent=os_one&from=' + new Date(today()).toISOString();
  assert.equal((await read(s, query)).usage?.tokens, 33);
  const partial = (await read(s, '?agent=os_one&from=' + new Date(today() + 1).toISOString())).usage;
  assert.equal(partial.tokens, null, 'a daily bucket cannot be split at a millisecond boundary');
  assert.equal(partial.partial_days, 1);
  assert.equal(partial.unknown_sessions, 1);
  assert.equal((await read(s, '?agent=os_missing')).usage.tokens, 0);
});

test('multiple attested collectors use one session authority and unbound identities are not guessed', async t => {
  const s = await serve(t, { runner: false });
  await observed(s, 'os_old', { [date(today() - DAY)]: { model: usage(10, 1) }, [date(today())]: { model: usage(50, 5) } }, { native: 'shared', connection: 'old' });
  await observed(s, 'os_new', { [date(today())]: { model: usage(80, 8) } }, { native: 'shared', connection: 'new' });
  await observed(s, 'os_unbound', { [date(today())]: { model: usage(20, 2) } });
  const u = (await read(s)).usage;
  assert.equal(u?.tokens, 121, 'disjoint day11 + today authority88 + unrelated22, never same-day55+88');
  assert.equal(u.observed_sessions, 2);
  assert.equal(u.unknown_sessions, 1, 'same-day collector copies have no request identities proving their union');
});

test('retention, missing reports and unchanged managed-only totals stay explicit', async t => {
  const s = await serve(t, { runner: false });
  await run(s, 'known', counts(5, 1));
  await run(s, 'unknown', { input: null, output: null, cacheRead: null, cacheWrite: null });
  const before = await read(s);
  assert.equal(before.usage?.tokens, before.totals.tokens);
  assert.equal(before.usage.unknown_runs, 1);
  await observed(s, 'os_empty', {});
  await observed(s, 'os_expired', { [date(today() - 100 * DAY)]: { model: usage(9000, 900) } });
  const u = (await read(s)).usage;
  assert.equal(u.tokens, 6);
  assert.equal(u.retention_limited, true);
  assert.equal(u.unknown_sessions, 2);
  assert.equal((await read(s, '?from=' + new Date(today() - 120 * DAY).toISOString() + '&to=' + new Date(today() - 100 * DAY).toISOString())).usage.retention_limited, true);
});

test('late CLI delivery does not prove disjoint source dates and profile archive keeps source usage', async t => {
  const s = await serve(t, { runner: false });
  await cliWindow(s, 'window', 10, 2);
  await s.store.settings.putIfAbsent('cli-learning-connection:connection', { agent_id: 'profile' });
  await observed(s, 'os_source', { [date(today() - DAY)]: { model: usage(50, 5) } }, { native: 'native-session', connection: 'connection' });
  const current = (await read(s, '?from=' + new Date(today()).toISOString())).usage;
  assert.equal(current.tokens, 12, 'yesterday source data does not overlap or erase today complete run');
  assert.equal(current.unknown_sessions, 1);
  const acrossDays = (await read(s, '?from=' + new Date(today() - 6 * DAY).toISOString())).usage;
  assert.equal(acrossDays.tokens, 55, 'today server receipt may describe yesterday offline native prompt; 55 +12 is not proven');
  assert.equal(acrossDays.unknown_runs, 1);
  await s.store.agents.archive('profile', true);
  assert.equal((await read(s)).usage.tokens, 55, 'archiving a learning profile does not disconnect its observed source');
});

test('source replacement preserves separately booked SDK reflection and makes unknown remainder explicit', async t => {
  const s = await serve(t, { runner: false });
  await run(s, 'sdk', { ...counts(110, 15, 10), sdk_runtime: 'codex-sdk', sdk_session_id: 'session' });
  await s.store.settings.putIfAbsent('sdk-run:sdk', { completion: { usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 10, cache_write_tokens: 0, cost_usd: null } } });
  await observed(s, 'os_source', { [date(today())]: { model: usage(300, 20) } }, { native: 'session', connection: 'connection' });
  let u = (await read(s)).usage;
  assert.equal(u.tokens, 335, '320 source +15 separately booked reflection');
  assert.equal(u.known_runs, 1);
  assert.equal(u.unknown_runs, 1, 'source-day aggregates do not prove coverage of the SDK task');
  await run(s, 'unknown-reflection', { ...counts(2, 1), sdk_runtime: 'codex-sdk', sdk_session_id: 'session' });
  u = (await read(s)).usage;
  assert.equal(u.tokens, 335);
  assert.equal(u.unknown_runs, 2, 'without immutable source counters the second remainder cannot be established');
});

for (const [name, input, output, received] of [
  ['stale partial observation', 20, 3, () => today()],
  ['fresh partial observation', 20, 3, () => Date.now() + 1],
  ['explicit zero observation', 0, 0, () => Date.now() + 1],
]) test(`${name} cannot erase a larger completed prompt window`, async t => {
  const s = await serve(t, { runner: false });
  await cliWindow(s, 'complete-window', 100, 20);
  await observed(s, 'os_partial', { [date(today())]: { model: usage(input, output, { cache_read_tokens: 0, cache_write_tokens: 0 }) } },
    { native: 'native-session', connection: 'connection', received: received() });
  const u = (await read(s)).usage;
  assert.equal(u.tokens, 120, 'the union is at least the known 120-token window, without guessing that 23 more are disjoint');
  assert.equal(u.input, 100);
  assert.equal(u.output, 20, 'the chosen total retains its own whole breakdown');
  assert.equal(u.known_runs, 1);
  assert.equal(u.unknown_runs, 1, 'the source/window union remains explicitly incomplete');
  assert.equal(u.observed_sessions, 1);
  assert.deepEqual(u.by_day, [{ day: date(today()), tokens: 120 }]);
});

test('distinct immutable prompt identities sum, repeated captures and generic session views do not', async t => {
  const s = await serve(t, { runner: false });
  await cliWindow(s, 'first-capture', 100, 20, { turn: 'first' });
  await cliWindow(s, 'first-copy', 100, 20, { turn: 'first', agent: 'another-profile' });
  await cliWindow(s, 'second-capture', 200, 30, { turn: 'second' });
  await run(s, 'generic-sdk', { ...counts(290, 50), sdk_session_id: 'native-session', sdk_runtime: 'codex-sdk' });
  await observed(s, 'os_partial', { [date(today())]: { model: usage(20, 3) } }, { native: 'native-session', connection: 'connection' });
  const u = (await read(s)).usage;
  assert.equal(u.tokens, 350, '120 +230 from distinct prompt IDs, not their duplicate or a 340-token generic session view');
  assert.equal(u.input, 300);
  assert.equal(u.output, 50);
  assert.equal(u.known_runs, 2);
  assert.equal(u.unknown_runs, 4);
});

test('generic SDK timestamps do not prove disjointness from an older source day', async t => {
  const s = await serve(t, { runner: false });
  await run(s, 'sdk-aggregate', { ...counts(100, 20), sdk_session_id: 'native-session', sdk_runtime: 'codex-sdk' });
  await observed(s, 'os_source', { [date(today() - DAY)]: { model: usage(50, 5) } }, { native: 'native-session', connection: 'connection' });
  const u = (await read(s)).usage;
  assert.equal(u.tokens, 120, 'a generic aggregate lacks native prompt identity; 120 +55 could count the same requests twice');
  assert.equal(u.unknown_runs, 1);
});

test('a smaller source delta preserves the captured task and its separate reflection exactly once', async t => {
  const s = await serve(t, { runner: false });
  await cliWindow(s, 'reflected-window', 100, 20, { reflection: 15 });
  await observed(s, 'os_partial', { [date(today())]: { model: usage(20, 3) } }, { native: 'native-session', connection: 'connection' });
  const u = (await read(s)).usage;
  assert.equal(u.tokens, 135, '120 known task +15 reflection, not 23 source +15 reflection or 135 +15');
  assert.equal(u.known_runs, 1);
  assert.equal(u.unknown_runs, 1);
});

async function importedTree(s, { journal = 'complete', children = 20 } = {}) {
  await s.store.agents.create({ id: 'history', name: 'History' }, { id: 'rev-history', kind: 'agentic', body: { instructions: 'Task.' } });
  const session = (id, input, output) => ({ source: 'codex', id, model: 'native-model', state: 'completed', users: 1, activeMs: 0, copies: 0,
    turns: [{ role: 'assistant', text: 'Done.', at: new Date().toISOString(), calls: [], usage: { input, output, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 }] });
  const { batches } = transcriptOf(session('root-session', 80, 20), value => value, children ? [session('child-session', children, 0)] : []);
  await s.store.importRun({ id: 'imported-tree', agentId: 'history', revisionId: 'rev-history', importedFrom: { source: 'codex', session: 'root-session' },
    launch: { body: {} }, metrics: counts(80 + children + (journal === 'inconsistent' ? 10 : 0), 20), startedAt: Date.now(), endedAt: Date.now(),
    transcript: journal === 'missing' ? [] : batches });
}

test('an imported subtree and an observed child count once while independent managed work remains additive', async t => {
  const s = await serve(t, { runner: false });
  await importedTree(s);
  await run(s, 'independent', counts(5, 2));
  assert.equal((await read(s)).usage.tokens, 127, 'standalone imported history keeps its exact 120-token aggregate');
  await observed(s, 'os_child', { [date(today())]: { model: usage(20, 0, { cache_read_tokens: 0, cache_write_tokens: 0 }) } },
    { native: 'child-session', connection: 'connection' });
  const u = (await read(s)).usage;
  assert.equal(u.tokens, 127, '100 proven root +20 observed child +7 independent, not 120 +20 +7');
  assert.equal(u.input, 105);
  assert.equal(u.output, 22);
  assert.equal(u.known_runs, 2);
  assert.equal(u.unknown_runs, 1, 'child identities are absent, so overlap coverage remains incomplete');
});

for (const journal of ['missing', 'inconsistent']) test(`${journal} import journal uses an aggregate alternative without counting a possible child twice`, async t => {
  const s = await serve(t, { runner: false });
  await importedTree(s, { journal });
  await run(s, 'independent', counts(5, 2));
  await observed(s, 'os_child', { [date(today())]: { model: usage(20, 0) } }, { native: 'child-session', connection: 'connection' });
  const u = (await read(s)).usage;
  assert.equal(u.tokens, journal === 'missing' ? 127 : 137);
  assert.equal(u.input, journal === 'missing' ? 105 : 115, 'the complete selected aggregate supplies its own breakdown');
  assert.equal(u.output, 22);
  assert.equal(u.unknown_runs, 1);
});

test('verified root-only import usage remains additive with a different native identity', async t => {
  const s = await serve(t, { runner: false });
  await importedTree(s, { children: 0 });
  await observed(s, 'os_other', { [date(today())]: { model: usage(30, 0) } }, { native: 'different-session', connection: 'connection' });
  const u = (await read(s)).usage;
  assert.equal(u.tokens, 130, 'the complete journal proves there is no opaque child remainder to overlap the other session');
  assert.equal(u.unknown_runs, 0);
});

test('purging a recorded run keeps its numeric usage in the unified total', async t => {
  const s = await serve(t, { runner: false });
  const claim = await run(s, 'gone', counts(100, 20));
  await s.store.release(claim);
  await run(s, 'kept', counts(5, 1));
  const before = (await read(s)).usage;
  assert.equal(before.tokens, 126);
  assert.equal((await s.api('DELETE', '/runs/gone')).status, 204);
  assert.deepEqual((await read(s)).usage, before, 'purge removes private evidence, not already recorded numeric counters');
});

test('purged native counters remain a conservative alternative after their private identity is erased', async t => {
  const s = await serve(t, { runner: false });
  const claim = await cliWindow(s, 'gone-native', 100, 20);
  await s.store.release(claim);
  await observed(s, 'os_source', { [date(today())]: { model: usage(20, 3) } }, { native: 'native-session', connection: 'connection' });
  assert.equal((await read(s)).usage.tokens, 120);
  assert.equal((await s.api('DELETE', '/runs/gone-native')).status, 204);
  let a = await read(s);
  assert.equal(a.usage.tokens, 120, '120 anonymous native counters and23 observed tokens are alternatives, not143');
  assert.equal(a.totals.tokens, 120, 'the original recorded counters remain exact');
  assert.equal(a.usage.unknown_runs, 1);
  const tombstone = await s.store.runs.get('gone-native');
  assert.equal(tombstone.metrics.cli_session_id, undefined);
  await assert.rejects(s.store.runs.launch('gone-native'));
  await s.store.agents.purge('profile');
  a = await read(s);
  assert.equal(a.usage.tokens, 120, 'erasing the revision runtime cannot turn anonymous usage into an additive managed run');
  assert.equal(a.usage.unknown_runs, 1);
});

test('historical native reflection is not added again when another observed session can contain it', async t => {
  const s = await serve(t, { runner: false });
  await cliWindow(s, 'legacy-reflected', 100, 20, { reflection: 15, nativeReflection: true });
  await observed(s, 'os_task', { [date(today())]: { model: usage(300, 20, { cache_read_tokens: 0, cache_write_tokens: 0 }) } },
    { native: 'native-session', connection: 'connection' });
  await observed(s, 'os_reflection', { [date(today())]: { model: usage(15, 0, { cache_read_tokens: 0, cache_write_tokens: 0 }) } },
    { native: 'reflection-session', connection: 'connection' });
  const u = (await read(s)).usage;
  assert.equal(u.tokens, 335, '320 observed task +15 observed reflection, never +15 from the legacy completion remainder again');
  assert.equal(u.input, 315);
  assert.equal(u.output, 20);
  assert.equal(u.unknown_runs, 1, 'the historical reflector did not retain its native session identity');
});
