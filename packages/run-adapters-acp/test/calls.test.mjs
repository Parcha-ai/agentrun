// How an MCP call of ours gets the agent's own tool call id (src/calls.ts): matched to the tool_call that announced it by
// the tool and the arguments, never to another call's announcement. Which tool of ours an announcement names is read from
// the recipe's `announces` field (announcedTool), never from a title. And which titles name our tool for Cursor's tie
// (ourTool).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as calls from '../dist/calls.js';

const { CallIds, declaresProperty, ourTool } = calls;
const TOOLS = new Set(['look_up', 'check_echo', 'lookup', 'write']);
/** goose.json's and cursor.json's announces fields. */
const GOOSE = Object.freeze({ tool: '_meta.goose.toolCall.toolName' });
const CURSOR = Object.freeze({ tool: 'rawInput.toolName', server: 'rawInput.providerIdentifier', args: 'rawInput.args' });
/** The Antigravity example recipe's (agy 1.5.14): its `name` field, our server's prefix as agy writes it, and its own
 *  toolSummary beside the arguments. */
const AGY = Object.freeze({ tool: 'name', prefix: 'mcp_agentrun_', extras: Object.freeze(['toolSummary']) });
/** A tool_call as Goose 1.59.2 sends it: titled for people, named in `_meta.goose.toolCall`, whose shape is copied from
 *  goose-acp's goose_tool_call_meta (conversion.rs:65-91 at v1.59.2): `toolName` is the name the model called
 *  (`agentrun__look_up`), `extensionName` the part before `__`, left out when the name has none. Only the first
 *  tool_call carries it; its permission request and later updates do not. */
const gooseCall = (toolCallId, toolName, rawInput, kind = 'other') => ({
  toolCallId,
  title: toolName.replace(/__/, ': ').replace(/_/g, ' '),
  kind,
  rawInput,
  _meta: { goose: { toolCall: { toolName, ...(toolName.includes('__') ? { extensionName: toolName.split('__')[0] } : {}) } } },
});

test("ourTool reads a name, `agentrun__<tool>`, and Cursor's own title, `agentrun-<tool>: <tool>`; nothing else", () => {
  assert.equal(ourTool({ title: 'agentrun__look_up' }, TOOLS), 'look_up');
  assert.equal(ourTool({ name: 'agentrun__check_echo' }, TOOLS), 'check_echo');
  assert.equal(ourTool({ title: 'agentrun-look_up: look_up' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'agentrun-lookup: lookup', kind: 'other' }, TOOLS), 'lookup');
});

test("ourTool no longer reads Goose 1.59.2's titles (`agentrun: <tool with spaces>`, ` · <summary>`): those calls are matched by their arguments, and Goose asks nothing for them", () => {
  // Before: each of these was read as our tool, and its permission request answered allow_once on the title.
  for (const title of ['agentrun: look up', 'agentrun: check echo', 'agentrun: lookup', 'agentrun: look up · proof.txt', 'agentrun: check echo · a · b', 'agentrun__look_up · proof.txt']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS), undefined, title);
  }
});

test("ourTool ties agy 1.5.14's name for our tool, `mcp_agentrun_<tool>`, and its title `Run mcp_agentrun_<tool>`, and nothing like them", () => {
  assert.equal(ourTool({ name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind: 'other' }, TOOLS), 'look_up');
  assert.equal(ourTool({ title: 'Run mcp_agentrun_check_echo', kind: 'other' }, TOOLS), 'check_echo');
  assert.equal(ourTool({ name: 'mcp_agentrun_lookup' }, TOOLS), 'lookup');
  for (const title of ['Run mcp_github_look_up', 'mcp_agentrunx_look_up', 'Run mcp_agentrun_look_up now', 'run mcp_agentrun_look_up', 'Run  mcp_agentrun_look_up', 'Run mcp_agentrun_drop_tables', 'xmcp_agentrun_look_up', 'Run mcp_agentrun_', 'Run mcp_agentrun_look_up · x']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS), undefined, title);
    assert.equal(ourTool({ name: title, kind: 'other' }, TOOLS), undefined, `name ${title}`);
  }
  assert.equal(ourTool({ name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind: 'execute' }, TOOLS), undefined, 'a kind with effects of its own');
});

test("a recipe whose prefix joins our server to the tool with one _ or - (agy's) gives the server a name of each start's own, ar and 6 hex digits, as long as agentrun; any other recipe, agentrun", () => {
  const { mcpServerName, joinsByOne } = calls;
  const a = mcpServerName(AGY);
  const b = mcpServerName(AGY);
  assert.match(a, /^ar[0-9a-f]{6}$/, 'no _ or -, so mcp_<server>_<tool> splits at its first _ after mcp_');
  assert.equal(a.length, 'agentrun'.length, "so a tool's name fits agy's cap as it did under agentrun");
  assert.notEqual(a, b, 'a fresh name at each start');
  assert.match(mcpServerName({ tool: 'name', prefix: 'agentrun-' }), /^ar[0-9a-f]{6}$/, 'a - joins by one too');
  for (const announces of [undefined, GOOSE, CURSOR, { tool: 'name', prefix: 'agentrun__' }, { tool: 'name', prefix: 'mcp_agentrun__' }]) {
    assert.equal(joinsByOne(announces), false, JSON.stringify(announces));
    assert.equal(mcpServerName(announces), 'agentrun', JSON.stringify(announces));
  }
});

test("agy caps a tool's name at 64 characters: under a start's own server name (mcp_ar<6 hex>_, 13 characters, as mcp_agentrun_) a tool of ours fits up to 51; namesTooLong names those that do not, and only for a recipe whose prefix names our tool", () => {
  const { announcesAt, namesTooLong, TOOL_NAME_CAP } = calls;
  assert.equal(TOOL_NAME_CAP, 64);
  const at = announcesAt(AGY, 'ar0123ab');
  assert.equal(at.prefix, 'mcp_ar0123ab_');
  const fits = 'a'.repeat(51);
  const over = 'b'.repeat(52);
  assert.deepEqual(namesTooLong(at, ['look_up', fits, over]), [over]);
  assert.deepEqual(namesTooLong(at, ['look_up', fits]), []);
  for (const announces of [undefined, GOOSE, CURSOR]) assert.deepEqual(namesTooLong(announces, [over, 'c'.repeat(80)]), [], JSON.stringify(announces));
});

test("agy joins server and tool with one _: under a start's own server name only that name's calls are ours, so another server's tool that spells one of ours is the agent's own", async () => {
  const { announcesAt, announcedTool, announceCall } = calls;
  const server = 'agentrun0123abcd';
  const at = announcesAt(AGY, server);
  assert.deepEqual(at, { ...AGY, prefix: `mcp_${server}_` });
  assert.equal(announcesAt(AGY, 'agentrun'), AGY, 'the name agentrun reads the recipe as written');
  assert.equal(announcesAt(GOOSE, server), GOOSE, 'no prefix, nothing to read');
  assert.deepEqual(announcesAt({ tool: 'name', prefix: 'agentrun_agentrun_' }, server), { tool: 'name', prefix: `agentrun_${server}_` }, 'the last agentrun is the server');
  const agy = (toolCallId, name, rawInput) => ({ toolCallId, name, title: `Run ${name}`, kind: 'other', rawInput });
  assert.equal(announcedTool(agy('c', `mcp_${server}_look_up`, {}), at, TOOLS), 'look_up');
  // A server named agentrun_look with a tool up: agy names its call mcp_agentrun_look_up, our look_up's name under agentrun.
  for (const name of ['mcp_agentrun_look_up', `mcp_${server}x_look_up`, `mcp_agentrun_${server}_look_up`, `mcp_${server.slice(0, -1)}_look_up`]) {
    assert.equal(announcedTool(agy('c', name, {}), at, TOOLS), null, name);
  }
  const ids = new calls.CallIds();
  announceCall(ids, agy('spoof', 'mcp_agentrun_look_up', { q: 'x', toolSummary: 'Look x up' }), at, TOOLS);
  assert.equal(ids.has('spoof'), false, "another server's call never takes an id of ours");
  announceCall(ids, agy('ours', `mcp_${server}_look_up`, { q: 'x', toolSummary: 'Look x up' }), at, TOOLS);
  assert.equal(await ids.take('look_up', { q: 'x' }, new AbortController().signal, 50), 'ours');
  // The title tie reads the same name: Run mcp_<server>_<tool>, and not agentrun's.
  assert.equal(ourTool({ name: `mcp_${server}_look_up`, title: `Run mcp_${server}_look_up`, kind: 'other' }, TOOLS, server), 'look_up');
  for (const said of ['mcp_agentrun_look_up', 'Run mcp_agentrun_look_up', `Run mcp_${server}x_look_up`]) assert.equal(ourTool({ title: said, kind: 'other' }, TOOLS, server), undefined, said);
});

test("an extra our tool's input schema declares is its argument, never agy's own line: kept, so two calls in flight keep their own ids", async () => {
  const { announceCall } = calls;
  const agy = (toolCallId, rawInput) => ({ toolCallId, name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind: 'other', rawInput });
  const signal = new AbortController().signal;
  const declared = new Map([['look_up', new Set(['toolSummary'])]]);
  const ids = new calls.CallIds();
  announceCall(ids, agy('call_a', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  announceCall(ids, agy('call_b', { q: 'x', toolSummary: 'b' }), AGY, TOOLS, declared);
  assert.equal(await ids.take('look_up', { q: 'x', toolSummary: 'b' }, signal, 50), 'call_b', 'its own call, never the oldest of the tool');
  assert.equal(await ids.take('look_up', { q: 'x', toolSummary: 'a' }, signal, 50), 'call_a');
  // The control: without the declaration the summary is agy's, left out, and both calls read { q: 'x' }: the oldest goes first.
  const plain = new calls.CallIds();
  announceCall(plain, agy('call_a', { q: 'x', toolSummary: 'a' }), AGY, TOOLS);
  announceCall(plain, agy('call_b', { q: 'x', toolSummary: 'b' }), AGY, TOOLS);
  assert.equal(await plain.take('look_up', { q: 'x', toolSummary: 'b' }, signal, 50), 'call_a', 'the control: the ids swap');
  // The field optional and left out, agy adds a summary of its own: the call is kept without it too, so its MCP call,
  // which carries none, takes its id after a short hold (ANNOUNCE_GRACE_MS), never the wait's fallback; and once taken
  // it is gone from both forms.
  const hurry = (taking) => Promise.race([taking, new Promise((resolve) => setTimeout(() => resolve('waited'), 2_000).unref())]);
  const omitted = new calls.CallIds();
  announceCall(omitted, agy('call_d', { q: 'd', toolSummary: 'Look d up' }), AGY, TOOLS, declared);
  announceCall(omitted, agy('call_e', { q: 'e', toolSummary: 'Look e up' }), AGY, TOOLS, declared);
  assert.equal(await hurry(omitted.take('look_up', { q: 'e' }, signal, 60_000)), 'call_e', 'its own id, after the hold');
  assert.equal(await hurry(omitted.take('look_up', { q: 'd', toolSummary: 'Look d up' }, signal, 60_000)), 'call_d', 'the other, by the form with it');
  for (const args of [{ q: 'd' }, { q: 'e', toolSummary: 'Look e up' }]) assert.equal(await omitted.take('look_up', args, signal, 50), undefined, `taken once, under either form: ${JSON.stringify(args)}`);
  // An MCP call already waiting when the announcement comes is woken by either form.
  const early = new calls.CallIds();
  const waiting = early.take('look_up', { q: 'f' }, signal, 60_000);
  announceCall(early, agy('call_f', { q: 'f', toolSummary: 'Look f up' }), AGY, TOOLS, declared);
  assert.equal(await hurry(waiting), 'call_f');
  // Two calls in flight with the same arguments but for the extra, each announced with its own: one sent it (A's MCP
  // call carries toolSummary 'a'), one left it out, agy adding its own (B's carries none). B's MCP call reaching MCP
  // first matches both without the extra, so it waits rather than take A's id, which A's own call is about to need:
  // A's takes A by its whole arguments, and B's the one left. Before, B's took A (the oldest), and A's took B after the wait.
  const pair = new calls.CallIds();
  announceCall(pair, agy('call_a', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  announceCall(pair, agy('call_b', { q: 'x', toolSummary: 'generated b' }), AGY, TOOLS, declared);
  const bFirst = pair.take('look_up', { q: 'x' }, signal, 60_000);
  const aNext = pair.take('look_up', { q: 'x', toolSummary: 'a' }, signal, 60_000);
  assert.deepEqual(await hurry(Promise.all([bFirst, aNext])), ['call_b', 'call_a'], 'each its own id, well before the wait');
  // Both left it out: each MCP call carries { q: 'x' }. Two calls waiting for two such announcements leave none for a
  // whole-argument call, so past the hold they take them oldest first, never after the wait.
  const both = new calls.CallIds();
  announceCall(both, agy('call_a', { q: 'x', toolSummary: 'Look x up' }), AGY, TOOLS, declared);
  announceCall(both, agy('call_b', { q: 'x', toolSummary: 'Look x up again' }), AGY, TOOLS, declared);
  const first = both.take('look_up', { q: 'x' }, signal, 60_000);
  const second = both.take('look_up', { q: 'x' }, signal, 60_000);
  assert.deepEqual(await hurry(Promise.all([first, second])), ['call_a', 'call_b'], 'oldest first, after the hold');
  // Only one there and no other call: taken after the hold, while its own announcement could still have come.
  const lone = new calls.CallIds();
  announceCall(lone, agy('call_a', { q: 'x', toolSummary: 'Look x up' }), AGY, TOOLS, declared);
  assert.equal(await hurry(lone.take('look_up', { q: 'x' }, signal, 60_000)), 'call_a');
  // B's MCP call reaching MCP before B's own announcement: A, announced with the extra it sent, is the only one there, and
  // B's call matches it only without the extra. It holds a short while for its own; B's comes, then A's MCP call takes A by
  // its whole arguments, and B's the one left. Before, B's took A at once, and A's took B after the wait.
  const ahead = new calls.CallIds();
  announceCall(ahead, agy('call_a', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  const bAhead = ahead.take('look_up', { q: 'x' }, signal, 60_000);
  announceCall(ahead, agy('call_b', { q: 'x', toolSummary: 'generated b' }), AGY, TOOLS, declared);
  const aAfter = ahead.take('look_up', { q: 'x', toolSummary: 'a' }, signal, 60_000);
  assert.deepEqual(await hurry(Promise.all([bAhead, aAfter])), ['call_b', 'call_a'], 'its own, though it came first');
  // The same with B's MCP call already waiting when A's announcement comes: it is not handed A for matching it without
  // the extra. Before, add handed it A at once.
  const handed = new calls.CallIds();
  const bWaiting = handed.take('look_up', { q: 'x' }, signal, 60_000);
  announceCall(handed, agy('call_a', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  announceCall(handed, agy('call_b', { q: 'x', toolSummary: 'generated b' }), AGY, TOOLS, declared);
  const aLater = handed.take('look_up', { q: 'x', toolSummary: 'a' }, signal, 60_000);
  assert.deepEqual(await hurry(Promise.all([bWaiting, aLater])), ['call_b', 'call_a'], 'not handed the other');
  // An announcement whose call ended with no MCP call (denied before it ran) is kept as ended (settle), and a live one
  // comes first: the next MCP call matching it and another only without the extra takes the other, never waiting out the wait.
  const stale = new calls.CallIds();
  announceCall(stale, agy('call_s', { q: 'x', toolSummary: 'Look x up' }), AGY, TOOLS, declared);
  stale.settle('call_s');
  announceCall(stale, agy('call_a', { q: 'x', toolSummary: 'Look x up again' }), AGY, TOOLS, declared);
  assert.equal(await hurry(stale.take('look_up', { q: 'x' }, signal, 60_000)), 'call_a', 'the live one, not the ended one');
  // Its call ended with no MCP call yet (a cancel can report it failed while the MCP call is on its way): the
  // announcement no longer holds a later call matching it and another only without the extra (above), but a late MCP
  // call of its own still takes it, rather than wait out the wait for nothing.
  const late = new calls.CallIds();
  announceCall(late, agy('call_a', { q: 'x', toolSummary: 'Look x up' }), AGY, TOOLS, declared);
  late.settle('call_a');
  assert.equal(await hurry(late.take('look_up', { q: 'x' }, signal, 60_000)), 'call_a', 'its own, though its call ended');
  // A denied or cancelled call the model tries again with the same whole arguments: the retry's MCP call takes the
  // retry's id, never the ended one's, whether the retry's announcement comes before its MCP call or after it. Before,
  // the ended one was the oldest exact match, taken at once in both orders.
  const retried = new calls.CallIds();
  announceCall(retried, agy('call_s', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  retried.settle('call_s');
  announceCall(retried, agy('call_r', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  assert.equal(await hurry(retried.take('look_up', { q: 'x', toolSummary: 'a' }, signal, 60_000)), 'call_r', 'announced first: the live one');
  const ahead2 = new calls.CallIds();
  announceCall(ahead2, agy('call_s', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  ahead2.settle('call_s');
  const rEarly = ahead2.take('look_up', { q: 'x', toolSummary: 'a' }, signal, 60_000);
  announceCall(ahead2, agy('call_r', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  assert.equal(await hurry(rEarly), 'call_r', 'its MCP call first: it holds for its own');
  // Two ended and none live: a late MCP call takes the oldest after the hold, never waiting out the wait.
  const gone = new calls.CallIds(20);
  announceCall(gone, agy('call_s', { q: 'x', toolSummary: 'Look x up' }), AGY, TOOLS, declared);
  announceCall(gone, agy('call_t', { q: 'x', toolSummary: 'Look x up again' }), AGY, TOOLS, declared);
  gone.settle('call_s');
  gone.settle('call_t');
  assert.equal(await hurry(gone.take('look_up', { q: 'x' }, signal, 60_000)), 'call_s', 'the oldest, after the hold');
  // An announcement keyed again, to its whole arguments alone, wakes a call already past its hold: here it leaves that
  // call the one other announcement it matches, which it then takes, never after the wait.
  const rekeyed = new calls.CallIds(20);
  announceCall(rekeyed, agy('call_a', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  announceCall(rekeyed, agy('call_b', { q: 'x', toolSummary: 'generated b' }), AGY, TOOLS, declared);
  const past = rekeyed.take('look_up', { q: 'x' }, signal, 60_000);
  await new Promise((resolve) => setTimeout(resolve, 60));
  rekeyed.add('call_a', 'look_up', { q: 'x', toolSummary: 'a' });
  assert.equal(await hurry(past), 'call_b', 'woken by the change');
  // Another tool's declaration keeps nothing for this one.
  const other = new calls.CallIds();
  announceCall(other, agy('call_c', { q: 'c', toolSummary: 'Look c up' }), AGY, TOOLS, new Map([['check_echo', new Set(['toolSummary'])]]));
  assert.equal(await other.take('look_up', { q: 'c' }, signal, 50), 'call_c');
});

test("two calls of a tool with the same other arguments, one passing a declared extra and one leaving it out for agy to fill: neither takes the other's id, whichever MCP call comes first", async () => {
  const { announceCall } = calls;
  const agy = (toolCallId, rawInput) => ({ toolCallId, name: 'mcp_agentrun_look_up', title: 'Run mcp_agentrun_look_up', kind: 'other', rawInput });
  const signal = new AbortController().signal;
  const declared = new Map([['look_up', new Set(['toolSummary'])]]);
  const hurry = (taking) => Promise.race([taking, new Promise((resolve) => setTimeout(() => resolve('waited'), 2_000).unref())]);
  // call_a's model passed toolSummary 'a'; call_b's left it out and agy announced one of its own. call_b's MCP call,
  // with none, comes first: { q: 'x' } matches both only without the extra, so it waits until call_a's MCP call takes
  // call_a by its full form, and then takes call_b.
  const ids = new calls.CallIds();
  announceCall(ids, agy('call_a', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  announceCall(ids, agy('call_b', { q: 'x', toolSummary: 'generated b' }), AGY, TOOLS, declared);
  const b = ids.take('look_up', { q: 'x' }, signal, 60_000);
  const a = ids.take('look_up', { q: 'x', toolSummary: 'a' }, signal, 60_000);
  assert.deepEqual(await hurry(Promise.all([b, a])), ['call_b', 'call_a'], 'each its own id, the one without the extra first');
  // call_a's MCP call first: its own by its full form, and call_b's is then the one left.
  const other = new calls.CallIds();
  announceCall(other, agy('call_a', { q: 'x', toolSummary: 'a' }), AGY, TOOLS, declared);
  announceCall(other, agy('call_b', { q: 'x', toolSummary: 'generated b' }), AGY, TOOLS, declared);
  assert.equal(await hurry(other.take('look_up', { q: 'x', toolSummary: 'a' }, signal, 60_000)), 'call_a');
  assert.equal(await hurry(other.take('look_up', { q: 'x' }, signal, 60_000)), 'call_b');
  // One announced with exactly the MCP call's arguments is taken at once, before one that matches only without the extra.
  const exact = new calls.CallIds();
  announceCall(exact, agy('call_c', { q: 'x', toolSummary: 'generated c' }), AGY, TOOLS, declared);
  announceCall(exact, agy('call_d', { q: 'x' }), AGY, TOOLS, declared);
  assert.equal(await hurry(exact.take('look_up', { q: 'x' }, signal, 60_000)), 'call_d');
  // Still two that match only so when the wait ends: the oldest, as before.
  const both = new calls.CallIds();
  announceCall(both, agy('call_e', { q: 'x', toolSummary: 'generated e' }), AGY, TOOLS, declared);
  announceCall(both, agy('call_f', { q: 'x', toolSummary: 'generated f' }), AGY, TOOLS, declared);
  assert.equal(await both.take('look_up', { q: 'x' }, signal, 50), 'call_e');
  assert.equal(await hurry(both.take('look_up', { q: 'x' }, signal, 60_000)), 'call_f', 'one left: at once');
});

test("a schema declares an argument at its top, in allOf, anyOf or oneOf at any depth, or behind a $ref to its own $defs; a $ref it cannot read may", () => {
  const summary = { toolSummary: { type: 'string' } };
  for (const schema of [
    { type: 'object', properties: summary },
    { type: 'object', allOf: [{ properties: { q: {} } }, { properties: summary }] },
    { type: 'object', anyOf: [{ properties: { q: {} } }, { properties: summary }] },
    { type: 'object', oneOf: [{ allOf: [{ properties: summary }] }] },
    { type: 'object', $ref: '#/$defs/args', $defs: { args: { properties: summary } } },
    { type: 'object', allOf: [{ $ref: '#/definitions/args' }], definitions: { args: { allOf: [{ properties: summary }] } } },
    { type: 'object', allOf: [{ $ref: 'https://example.com/args.json' }] },
    { type: 'object', $ref: '#/$defs/missing', $defs: {} },
  ]) assert.equal(declaresProperty(schema, 'toolSummary'), true, JSON.stringify(schema));
  for (const schema of [
    { type: 'object', properties: { q: {} } },
    { type: 'object', allOf: [{ properties: { q: {} } }], anyOf: [{ properties: { r: {} } }] },
    { type: 'object', $ref: '#/$defs/args', $defs: { args: { properties: { q: {} } } } },
    { type: 'object', properties: { nested: { type: 'object', properties: summary } } },
    { type: 'object', $ref: '#/$defs/a', $defs: { a: { $ref: '#/$defs/a' } } },
    {}, null, undefined, 'object',
  ]) assert.equal(declaresProperty(schema, 'toolSummary'), false, JSON.stringify(schema));
  assert.equal(declaresProperty({ properties: { note: {} } }, 'note'), true, 'any name an extra may be');
  assert.equal(declaresProperty({ properties: { note: {} } }, 'toolSummary'), false);
});

test("an agy call is named by its recipe's field (`name`, prefix `mcp_agentrun_`) and matched without agy's own toolSummary; any other recipe's input is as reported", async () => {
  // #3755's case (announcedInput, by agy's name) on the announces field: the recipe says which fields are agy's own.
  const { announcedTool, announceCall } = calls;
  const agy = (toolCallId, name, rawInput, kind = 'other') => ({ toolCallId, name, title: `Run ${name}`, kind, rawInput });
  assert.equal(announcedTool(agy('c', 'mcp_agentrun_look_up', {}), AGY, TOOLS), 'look_up');
  for (const name of ['mcp_github_look_up', 'mcp_agentrunx_look_up', 'agentrun__look_up', 'mcp_agentrun_drop_tables', 'xmcp_agentrun_look_up']) assert.equal(announcedTool(agy('c', name, {}), AGY, TOOLS), null, name);
  assert.equal(announcedTool({ toolCallId: 'c', title: 'Run mcp_agentrun_look_up', rawInput: {} }, AGY, TOOLS), undefined, 'the title names nothing');
  // Two calls of one tool in flight: each MCP call takes its own by its arguments, agy's toolSummary left out. (One whose
  // arguments match no call falls back to the oldest call of its tool once the wait is over: take's loose match.)
  const signal = new AbortController().signal;
  const ids = new calls.CallIds();
  announceCall(ids, agy('call_a', 'mcp_agentrun_look_up', { q: 'a', toolSummary: 'Look a up' }), AGY, TOOLS);
  announceCall(ids, agy('call_b', 'mcp_agentrun_look_up', { q: 'b', toolSummary: 'Look b up' }), AGY, TOOLS);
  assert.equal(await ids.take('look_up', { q: 'b' }, signal, 50), 'call_b', "its own call, never the oldest of the tool");
  assert.equal(await ids.take('look_up', { q: 'a' }, signal, 50), 'call_a');
  // Without extras the summary is an argument, so neither matches and the first MCP call takes the oldest: the wrong id.
  const plain = new calls.CallIds();
  const noExtras = Object.freeze({ tool: 'name', prefix: 'mcp_agentrun_' });
  announceCall(plain, agy('call_a', 'mcp_agentrun_look_up', { q: 'a', toolSummary: 'Look a up' }), noExtras, TOOLS);
  announceCall(plain, agy('call_b', 'mcp_agentrun_look_up', { q: 'b', toolSummary: 'Look b up' }), noExtras, TOOLS);
  assert.equal(await plain.take('look_up', { q: 'b' }, signal, 50), 'call_a', 'the control: without extras the ids swap');
  // An extra that holds no text is an argument, and a recipe without extras (Goose's) keeps every field.
  announceCall(ids, agy('call_c', 'mcp_agentrun_look_up', { q: 'c', toolSummary: 3 }), AGY, TOOLS);
  announceCall(ids, agy('call_d', 'mcp_agentrun_look_up', { q: 'd', toolSummary: 3 }), AGY, TOOLS);
  assert.equal(await ids.take('look_up', { q: 'd', toolSummary: 3 }, signal, 50), 'call_d');
  announceCall(ids, gooseCall('call_e', 'agentrun__look_up', { q: 'e', toolSummary: 'kept' }), GOOSE, TOOLS);
  announceCall(ids, gooseCall('call_f', 'agentrun__look_up', { q: 'f', toolSummary: 'kept' }), GOOSE, TOOLS);
  assert.equal(await ids.take('look_up', { q: 'f', toolSummary: 'kept' }, signal, 50), 'call_f');
  announceCall(ids, agy('call_x', 'mcp_agentrun_look_up', { q: 'x', toolSummary: 'Look' }, 'execute'), AGY, TOOLS);
  assert.equal(ids.has('call_x'), false, 'a kind with effects of its own is never ours');
});

test("ourTool leaves another server's tool named like ours, and a call with effects of its own, as the agent's own", () => {
  for (const title of ['github: look up', 'agentrun-github: look up', 'agentrun github: look up', 'Agentrun: look up', 'agentrun: Look Up', 'agentrun: look  up', 'agentrun: look up now', 'xagentrun: look up', 'agentrun: look_up_', 'agentrun:look up', 'agentrun: look up now · x', 'agentrun: look up·x', ' · agentrun: look up', 'github: look up · proof.txt', 'agentrun-look_up: look up']) {
    assert.equal(ourTool({ title, kind: 'other' }, TOOLS), undefined, title);
  }
  for (const kind of ['execute', 'edit', 'delete', 'move', 'fetch']) {
    assert.equal(ourTool({ title: 'agentrun__look_up', kind }, TOOLS), undefined, kind);
    assert.equal(ourTool({ title: 'agentrun-look_up: look_up', kind }, TOOLS), undefined, `${kind}, Cursor's form`);
  }
  assert.equal(ourTool({ title: 'agentrun__drop_tables', kind: 'other' }, TOOLS), undefined, 'a tool that is not ours, under our server name');
});

test('two parallel calls whose announcements come in reverse order each get their own id', async () => {
  const ids = new CallIds();
  const signal = new AbortController().signal;
  // The MCP call with args a reaches the server before either announcement.
  const a = ids.take('lookup', { q: 'a' }, signal, 2_000);
  ids.add('call_b', 'lookup', { q: 'b' });
  ids.add('call_a', 'lookup', { q: 'a' });
  const b = ids.take('lookup', { q: 'b' }, signal, 2_000);
  assert.deepEqual(await Promise.all([a, b]), ['call_a', 'call_b']);
});

test('an announcement with no input still matches a waiting call of its tool', async () => {
  const ids = new CallIds();
  const waiting = ids.take('lookup', { q: 'a' }, new AbortController().signal, 2_000);
  ids.add('call_0', 'lookup', undefined);
  assert.equal(await waiting, 'call_0');
});

test('an announcement whose title names no tool of ours is matched by the arguments alone; a title that names the tool only breaks a tie between announcements with the same arguments', async () => {
  const ids = new CallIds();
  const signal = new AbortController().signal;
  // Before: an announcement the title did not tie was dropped, so the MCP call ran under no id of the agent's.
  ids.add('call_0', undefined, { path: 'proof.txt', content: 'x' });
  assert.equal(await ids.take('write', { content: 'x', path: 'proof.txt' }, signal, 50), 'call_0', 'the same arguments, in any key order');
  assert.equal(ids.announced('call_0'), undefined, 'it names no tool: a permission request is never tied to it');
  // Two announcements with the same arguments: the one whose title named the tool is taken first, then the other.
  ids.add('call_1', undefined, { q: 'a' });
  ids.add('call_2', 'lookup', { q: 'a' });
  assert.equal(await ids.take('lookup', { q: 'a' }, signal, 50), 'call_2', 'the title breaks the tie');
  assert.equal(await ids.take('lookup', { q: 'a' }, signal, 50), 'call_1');
  // An MCP call that reached the server first waits for it.
  const waiting = ids.take('write', { path: 'b' }, signal, 2_000);
  ids.add('call_3', undefined, { path: 'b' });
  assert.equal(await waiting, 'call_3');
  // Other arguments never take it. An announcement with no input and no tool (only on a recipe without announces) is
  // the last resort: nothing names or ties it, and it is taken rather than leave the call an id of the adapter's.
  ids.add('call_4', undefined, { path: 'c' });
  ids.add('call_5', undefined, undefined);
  assert.equal(await ids.take('write', { path: 'd' }, signal, 50), 'call_5');
  assert.equal(await ids.take('write', { path: 'd' }, signal, 50), undefined);
  assert.equal(ids.has('call_4'), true, 'still announced, still waiting for its own call');
});

test("an agent's own call announced with the same arguments as ours never takes our MCP call's id: each is named by the recipe's field (Goose's _meta toolName)", async () => {
  // Before (a known limit of this PR, skipped): both announcements were matched by their arguments alone, so Goose's own
  // load_skill, announced first, took our MCP call's id, and the resume memo keyed our call under it.
  assert.equal(typeof calls.announceCall, 'function', "calls.ts reads the recipe's announces field (announceCall)");
  const ids = new CallIds();
  const signal = new AbortController().signal;
  calls.announceCall(ids, gooseCall('call_skill', 'skills__load_skill', { name: 'notes' }), GOOSE, TOOLS);
  calls.announceCall(ids, gooseCall('call_ours', 'agentrun__look_up', { name: 'notes' }), GOOSE, TOOLS);
  assert.equal(await ids.take('look_up', { name: 'notes' }, signal, 50), 'call_ours');
  assert.equal(ids.announced('call_ours'), 'look_up');
  assert.equal(ids.has('call_skill'), false, "the agent's own call, by its field, is never one an MCP call can take");
});

test("announcedTool reads the recipe's announces field, never a title: Goose's _meta toolName (`agentrun__<tool>`), Cursor's rawInput (providerIdentifier, toolName)", () => {
  assert.equal(typeof calls.announcedTool, 'function', "calls.ts reads the recipe's announces field (announcedTool)");
  const { announcedTool } = calls;
  // Goose: the tool's name as the model calls it, our server's prefix stripped.
  assert.equal(announcedTool(gooseCall('c', 'agentrun__look_up', { q: 'x' }), GOOSE, TOOLS), 'look_up');
  assert.equal(announcedTool(gooseCall('c', 'skills__load_skill', { name: 'x' }), GOOSE, TOOLS), null, "the agent's own tool");
  assert.equal(announcedTool(gooseCall('c', 'look_up', {}), GOOSE, TOOLS), null, 'no server prefix: not ours');
  assert.equal(announcedTool(gooseCall('c', 'agentrun__drop_tables', {}), GOOSE, TOOLS), null, 'our server, a tool it does not list');
  assert.equal(announcedTool({ toolCallId: 'c', title: 'agentrun__look_up', rawInput: { q: 'x' } }, GOOSE, TOOLS), undefined, 'no field: a title is never read');
  assert.equal(announcedTool(gooseCall('c', 'agentrun__look_up', {}), undefined, TOOLS), undefined, 'a recipe that declares no field reads none');
  // Cursor: the server and the tool in two fields of the late update's rawInput.
  const cursorUpdate = (providerIdentifier, toolName) => ({ toolCallId: 'c', title: 'agentrun: look_up', rawInput: { providerIdentifier, toolName, args: { q: 'x' } } });
  assert.equal(announcedTool(cursorUpdate('agentrun', 'look_up'), CURSOR, TOOLS), 'look_up');
  assert.equal(announcedTool(cursorUpdate('github', 'look_up'), CURSOR, TOOLS), null, "another server's tool named like ours");
  assert.equal(announcedTool({ toolCallId: 'c', title: 'MCP: tool', rawInput: {} }, CURSOR, TOOLS), undefined, "Cursor's untitled announcement names nothing yet");
});

test('a title naming our tool on a native read call never sets announced: only the recipe\'s field does', () => {
  // Before: the tool_call's title (`agentrun__write`, the model's text on a read Cursor titles as it likes) set
  // announced, which Cursor's title tie then answered allow_once without the gate.
  assert.equal(typeof calls.announceCall, 'function', "calls.ts reads the recipe's announces field (announceCall)");
  const ids = new CallIds();
  calls.announceCall(ids, { toolCallId: 'call_read', title: 'agentrun__write', kind: 'read', rawInput: { path: 'notes.md' } }, CURSOR, TOOLS);
  assert.equal(ids.announced('call_read'), undefined);
});

// Mutant guards: each fails with the check it names removed from calls.ts.
test("the kind guard: a native execute announced first with our call's arguments never takes our MCP call's id, even one whose field names our tool", async () => {
  const signal = new AbortController().signal;
  // No field on either: both are matched by their arguments alone.
  const bare = new CallIds();
  calls.announceCall(bare, { toolCallId: 'native_0', title: 'Run lookup', kind: 'execute', rawInput: { q: 'x' } }, CURSOR, TOOLS);
  calls.announceCall(bare, { toolCallId: 'call_1', title: 'MCP: tool', kind: 'other', rawInput: { q: 'x' } }, CURSOR, TOOLS);
  assert.equal(await bare.take('look_up', { q: 'x' }, signal, 50), 'call_1');
  assert.equal(bare.has('native_0'), false, 'a call with effects of its own is never kept for an MCP call');
  // A shell whose field names our tool, announced first.
  const named = new CallIds();
  calls.announceCall(named, gooseCall('call_shell', 'agentrun__look_up', { q: 'x' }, 'execute'), GOOSE, TOOLS);
  calls.announceCall(named, gooseCall('call_ours', 'agentrun__look_up', { q: 'x' }), GOOSE, TOOLS);
  assert.equal(await named.take('look_up', { q: 'x' }, signal, 50), 'call_ours');
  assert.equal(named.announced('call_shell'), undefined);
});

test("the update's kind: a late update with an effect kind never names its call ours, whatever its rawInput says", async () => {
  const signal = new AbortController().signal;
  const naming = { providerIdentifier: 'agentrun', toolName: 'look_up', args: { q: 'x' } };
  const shell = new CallIds();
  calls.announceCall(shell, { toolCallId: 'c', title: 'MCP: tool', kind: 'other', rawInput: {} }, CURSOR, TOOLS);
  calls.nameCall(shell, { toolCallId: 'c', kind: 'execute', rawInput: naming }, CURSOR, TOOLS);
  assert.equal(shell.announced('c'), undefined, "the update's kind has effects of its own");
  assert.equal(await shell.take('look_up', { q: 'x' }, signal, 50), undefined);
  const announcedAsShell = new CallIds();
  calls.announceCall(announcedAsShell, { toolCallId: 'd', title: 'MCP: tool', kind: 'execute', rawInput: {} }, CURSOR, TOOLS);
  calls.nameCall(announcedAsShell, { toolCallId: 'd', rawInput: naming }, CURSOR, TOOLS);
  assert.equal(announcedAsShell.announced('d'), undefined, "the tool_call's kind has effects of its own");
  // The same update with no effect kind names it, and the MCP call runs under its id.
  const ours = new CallIds();
  calls.announceCall(ours, { toolCallId: 'e', title: 'MCP: tool', kind: 'other', rawInput: {} }, CURSOR, TOOLS);
  calls.nameCall(ours, { toolCallId: 'e', rawInput: naming }, CURSOR, TOOLS);
  assert.equal(ours.announced('e'), 'look_up');
  assert.equal(await ours.take('look_up', { q: 'x' }, signal, 50), 'e');
});

test("announcedTool's prefix check: another server's tool whose prefix is as long as ours (`slackbot__look_up`) is never ours", () => {
  // Without the check, slicing off ten characters turns `slackbot__look_up` into our look_up.
  assert.equal(calls.announcedTool(gooseCall('c', 'slackbot__look_up', {}), GOOSE, TOOLS), null);
});

test("an announcement naming no tool with empty input (Cursor's untitled `MCP: tool`, rawInput {}) is never matched by its arguments: a parallel no-argument call of another tool never takes its id", async () => {
  // Before: it was kept under the arguments {}, so the first MCP call of any tool with no arguments took its id before
  // Cursor's late update named the call. Held so only on a recipe whose announces field names its calls (Cursor's).
  const ids = new CallIds();
  const signal = new AbortController().signal;
  calls.announceCall(ids, { toolCallId: 'call_cursor', title: 'MCP: tool', kind: 'other', rawInput: {} }, CURSOR, TOOLS);
  assert.equal(await ids.take('check_echo', {}, signal, 50), undefined, "another tool's call with no arguments");
  // The late update names it; then its own MCP call takes it.
  calls.nameCall(ids, { toolCallId: 'call_cursor', rawInput: { providerIdentifier: 'agentrun', toolName: 'look_up', args: {} } }, CURSOR, TOOLS);
  assert.equal(await ids.take('look_up', {}, signal, 50), 'call_cursor');
});

test("arguments the field holds as anything but an object are matched as none: a call its tool_call names as ours with such arguments is matched by its tool at once, as one a late update names", async () => {
  // Before: announceCall keyed `"rawInput.args": "oops"` as {} (so it waited out the wait for any call with arguments),
  // while nameCall keyed the same arguments by the tool alone.
  const ids = new CallIds();
  calls.announceCall(ids, { toolCallId: 'c', title: 'agentrun: look_up', kind: 'other', rawInput: { providerIdentifier: 'agentrun', toolName: 'look_up', args: 'oops' } }, CURSOR, TOOLS);
  assert.equal(ids.announced('c'), 'look_up');
  const started = Date.now();
  assert.equal(await ids.take('look_up', { q: 'x' }, new AbortController().signal, 300), 'c');
  assert.ok(Date.now() - started < 50, `matched at once, not after the wait (${Date.now() - started} ms)`);
});

test('on a recipe with no announces field, a call with no arguments is matched by its arguments at once: its {} announcement waits for no name', async () => {
  // Before: every {} announcement that named no tool waited for a later update to name it, a name only a recipe with
  // announces gives. On any other recipe (antigravity.json's) a no-argument call of ours waited out the 10 s and ran
  // under an id of the adapter's, not the agent's.
  const ids = new CallIds();
  calls.announceCall(ids, { toolCallId: 'c1', title: 'now', kind: 'other', rawInput: {} }, undefined, TOOLS);
  const started = Date.now();
  assert.equal(await ids.take('look_up', {}, new AbortController().signal, 300), 'c1');
  assert.ok(Date.now() - started < 50, `matched at once, not after the wait (${Date.now() - started} ms)`);
});

/** `promise`'s value if it is settled before the event loop turns, else 'waited'. */
const atOnce = (promise) => Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve('waited')))]);

test('on a recipe with no announces field, a call announced with no input at all is taken at once by an MCP call nothing else matches', async () => {
  // Before: add() kept nothing for it, so its MCP call waited out the 10 s, ran under an id of the adapter's (counted a
  // second time against a plan's limit, memoized under a key a resume never asks again).
  const ids = new CallIds();
  const stop = new AbortController();
  calls.announceCall(ids, { toolCallId: 'bare', title: 'Lookup', kind: 'other' }, undefined, TOOLS);
  calls.announceCall(ids, { toolCallId: 'args', title: 'Write', kind: 'other', rawInput: { path: 'a.txt' } }, undefined, TOOLS);
  assert.equal(await atOnce(ids.take('write', { path: 'a.txt' }, stop.signal, 60_000)), 'args', 'arguments that match come first');
  assert.equal(await atOnce(ids.take('look_up', { q: 'acme' }, stop.signal, 60_000)), 'bare');
  stop.abort();
});

test('a call announced with no input, named by nothing, never wakes a waiting MCP call: that call takes its own announcement, and the bare one only once its wait is over', async () => {
  const ids = new CallIds();
  const signal = new AbortController().signal;
  const waiting = ids.take('look_up', { q: 'acme' }, signal, 60_000);
  calls.announceCall(ids, { toolCallId: 'native', title: 'Thinking', kind: 'think' }, undefined, TOOLS);
  calls.announceCall(ids, { toolCallId: 'own', title: 'Lookup', kind: 'other', rawInput: { q: 'acme' } }, undefined, TOOLS);
  assert.equal(await waiting, 'own');
  // Already there: a later MCP call that nothing else matches takes the bare one at once.
  assert.equal(await ids.take('look_up', { q: 'other' }, signal, 1), 'native');
  // Announced during a wait that nothing else ends: taken when the wait is over (loose), not before.
  const late = ids.take('look_up', { q: 'late' }, signal, 1);
  calls.announceCall(ids, { toolCallId: 'native_2', title: 'Thinking', kind: 'think' }, undefined, TOOLS);
  assert.equal(await late, 'native_2');
});

test('an ended call the model tries again with the same arguments: the retry takes its own id in either order, the ended one only when none live is left', async () => {
  const signal = new AbortController().signal;
  const hurry = (taking) => Promise.race([taking, new Promise((resolve) => setTimeout(() => resolve('waited'), 2_000).unref())]);
  // No extra declared: each announcement is kept under one key. Before, the ended one stayed listed and was the oldest
  // exact match, so the retry's MCP call took it at once.
  const after = new CallIds();
  calls.announceCall(after, gooseCall('call_s', 'agentrun__look_up', { q: 'y' }), GOOSE, TOOLS);
  after.settle('call_s');
  calls.announceCall(after, gooseCall('call_r', 'agentrun__look_up', { q: 'y' }), GOOSE, TOOLS);
  assert.equal(await hurry(after.take('look_up', { q: 'y' }, signal, 60_000)), 'call_r');
  const before = new CallIds();
  calls.announceCall(before, gooseCall('call_s', 'agentrun__look_up', { q: 'y' }), GOOSE, TOOLS);
  before.settle('call_s');
  const early = before.take('look_up', { q: 'y' }, signal, 60_000);
  calls.announceCall(before, gooseCall('call_r', 'agentrun__look_up', { q: 'y' }), GOOSE, TOOLS);
  assert.equal(await hurry(early), 'call_r');
  // Its own late MCP call (a cancel reported it failed while the call was on its way) still takes it, after the hold.
  const own = new CallIds(20);
  calls.announceCall(own, gooseCall('call_s', 'agentrun__look_up', { q: 'y' }), GOOSE, TOOLS);
  own.settle('call_s');
  assert.equal(await hurry(own.take('look_up', { q: 'y' }, signal, 60_000)), 'call_s');
});

test("a late MCP call of an ended call takes its own announcement before a live one that matches it less closely: one naming no tool, or reporting no input, or neither", async () => {
  const signal = new AbortController().signal;
  const hurry = (taking) => Promise.race([taking, new Promise((resolve) => setTimeout(() => resolve('waited'), 2_000).unref())]);
  // On a recipe with no announces field: call_s ended (a cancel reported it failed while its MCP call was on its way),
  // and a call of the agent's own (a think) is announced with no input. Before, the late MCP call took the think's id at
  // once, its arguments' own announcement being ended; main took call_s, which it kept live.
  const think = new CallIds(20);
  calls.announceCall(think, { toolCallId: 'call_s', title: 'Lookup', kind: 'other', rawInput: { q: 'y' } }, undefined, TOOLS);
  think.settle('call_s');
  calls.announceCall(think, { toolCallId: 'native', title: 'Thinking', kind: 'think' }, undefined, TOOLS);
  assert.equal(await hurry(think.take('look_up', { q: 'y' }, signal, 60_000)), 'call_s', 'not the think');
  assert.equal(await hurry(think.take('look_up', { q: 'other' }, signal, 60_000)), 'native', 'which another call still takes');
  // Its own arguments under no tool name, and its tool with no input: both match it less closely than call_s does.
  const toolless = new CallIds(20);
  toolless.add('call_s', 'look_up', { q: 'y' });
  toolless.settle('call_s');
  toolless.add('call_x', undefined, { q: 'y' });
  assert.equal(await hurry(toolless.take('look_up', { q: 'y' }, signal, 60_000)), 'call_s', 'not the one naming no tool');
  const inputless = new CallIds(20);
  inputless.add('call_s', 'look_up', { q: 'y' });
  inputless.settle('call_s');
  inputless.add('call_t', 'look_up', undefined);
  assert.equal(await hurry(inputless.take('look_up', { q: 'y' }, signal, 60_000)), 'call_s', 'not the one reporting no input');
  // A live one under its very arguments still comes first (a retry, above).
  const retry = new CallIds(20);
  retry.add('call_s', 'look_up', { q: 'y' });
  retry.settle('call_s');
  retry.add('call_x', undefined, { q: 'y' });
  retry.add('call_r', 'look_up', { q: 'y' });
  assert.equal(await hurry(retry.take('look_up', { q: 'y' }, signal, 60_000)), 'call_r');
});

test('a bare announcement whose call ended is dropped: a later MCP call never takes the id of an agent call that is over', async () => {
  const ids = new CallIds();
  calls.announceCall(ids, { toolCallId: 'done', title: 'Thinking', kind: 'think' }, undefined, TOOLS);
  ids.settle('done');
  assert.equal(ids.has('done'), false);
  assert.equal(await ids.take('look_up', { q: 'acme' }, new AbortController().signal, 1), undefined);
});

test('on a recipe whose announces field names its calls, one it names nothing for with input that is no object stays the agent\'s own', async () => {
  const ids = new CallIds();
  calls.announceCall(ids, { toolCallId: 'odd', title: 'x', kind: 'other', rawInput: 'text' }, GOOSE, TOOLS);
  assert.equal(ids.has('odd'), false);
  assert.equal(await ids.take('look_up', { q: 'acme' }, new AbortController().signal, 1), undefined);
});
