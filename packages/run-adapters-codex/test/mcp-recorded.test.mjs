// Codex's own MCP client calls the session's door, and recorded() (src/mcp.ts) records each call in the drive's session
// before it is sent, by Codex's call id. A call id the records already hold is answered from them: whole, up to the host's
// bound on a tool result (HOST_RESULT_MAX_CHARS), never cut to the step's default.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST_RESULT_MAX_CHARS } from '@parcha/agentrun-kernel';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { recorded } from '../dist/mcp.js';

test("a call id the records already hold is answered from them whole, up to the host's bound, as the server answered it", async () => {
  const drive = await openDrive({ writer: await memorySessionStore().open('run-1'), signal: new AbortController().signal });
  const long = 'x'.repeat(50_000);
  let sent = 0;
  const mcp = { servers: [{ name: 'fake', tools: [{ name: 'big', inputSchema: { type: 'object' } }] }], call: async () => (sent += 1, { content: [{ type: 'text', text: long }] }) };
  const door = recorded(mcp, drive, () => ({ barrier: async () => true, recovered: () => undefined }));
  const context = { signal: new AbortController().signal, callId: 'call_big' };
  const first = await door.call('fake', 'big', {}, context);
  assert.equal(first.content[0].text.length, long.length);
  const again = await door.call('fake', 'big', {}, context);
  assert.equal(sent, 1, 'never sent again');
  assert.ok(long.length <= HOST_RESULT_MAX_CHARS);
  assert.equal(again.content[0].text.length, long.length, 'the recorded answer is the whole answer');
});
