// A host tool call's images are kept by the tool bridge, by its call id, until code mode's request handler takes them for
// the answer to Codex (host/process.ts toolBridge, code-mode.ts `request`). A call whose answer throws after its images
// were kept must still have them taken: otherwise each such call leaves its images in the bridge for the session's life.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codeMode } from '../dist/code-mode.js';

const PNG = 'iVBORw0KGgo=';

/** A bridge as code mode sees it: one granted tool, and images kept by call id as host/process.ts keeps them. */
function bridgeOf() {
  const images = new Map();
  return {
    images,
    get: (name) => (name === 'read' ? { name: 'read', replay: 'safe' } : undefined),
    takeImages: (callId) => {
      const taken = images.get(callId);
      images.delete(callId);
      return taken;
    },
  };
}

async function handlerOf(bridge) {
  const drive = await openDrive({ writer: await memorySessionStore().open('images'), signal: new AbortController().signal });
  const journal = { append() {}, flush: async () => {}, read: async () => [] };
  const mode = codeMode({ ctx: drive, machine: {}, journal, logged: new Set(), synced: async () => {}, bridge, log() {}, lines: [], rpc: () => ({ request: async () => ({}) }), guard: (p) => p, threadId: () => 't', tries: 1 });
  return mode.request;
}

test("a call whose answer throws after the bridge kept its images leaves none behind", async () => {
  const bridge = bridgeOf();
  const request = await handlerOf(bridge);
  // The harness's own handler runs the call (the bridge keeps its images as it answers), then fails building its answer.
  const next = async (req) => {
    bridge.images.set(String(req.params.callId), [{ mimeType: 'image/png', data: PNG }]);
    throw new Error('the answer could not be built');
  };
  await assert.rejects(request(next)({ method: 'item/tool/call', params: { callId: 'call_read', tool: 'read', arguments: {} } }), /could not be built/);
  assert.equal(bridge.images.size, 0, `the call's images were taken, not left in the bridge: ${[...bridge.images.keys()].join(', ')}`);
});

test("a call that answers still gets its images on the answer, and none are left behind", async () => {
  const bridge = bridgeOf();
  const request = await handlerOf(bridge);
  const next = async (req) => {
    bridge.images.set(String(req.params.callId), [{ mimeType: 'image/png', data: PNG }]);
    return { contentItems: [{ type: 'inputText', text: 'frame.png: image/png' }], success: true };
  };
  const answer = await request(next)({ method: 'item/tool/call', params: { callId: 'call_read', tool: 'read', arguments: {} } });
  assert.deepEqual(answer.contentItems.map((item) => item.type), ['inputText', 'inputImage']);
  assert.equal(bridge.images.size, 0);
});
