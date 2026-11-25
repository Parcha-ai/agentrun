// How an MCP call of ours gets the agent's own tool call id (src/calls.ts): matched to the tool_call that announced it by
// the tool and the arguments, never to another call's announcement. Which tool of ours an announcement names is read from
// the recipe's `announces` field (announcedTool), never from a title. And which titles name our tool for Cursor's tie
// (ourTool).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as calls from '../dist/calls.js';

const { CallIds, ourTool } = calls;
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
  // Nothing else came: the bare one is taken when the wait is over.
  assert.equal(await ids.take('look_up', { q: 'other' }, signal, 1), 'native');
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
