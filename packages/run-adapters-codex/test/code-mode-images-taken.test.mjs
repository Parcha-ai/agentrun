// A host tool call's images and value are kept by the tool bridge, by its call id, until code mode's request handler takes
// them for the answer to Codex (host/process.ts toolBridge, code-mode.ts `request`). A call whose answer throws after they
// were kept must still have them taken: otherwise each such call leaves them in the bridge for the session's life. The
// model's own call gets its words and its images; a script's nested call of a tool with a value (a computer tool's) gets
// the value as JSON, its images' data back in it, and of any other tool the words with the images after them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codeMode, scriptAnswer, withImageData } from '../dist/code-mode.js';

const PNG = 'iVBORw0KGgo=';
const NESTED = 'exec-0b7c4c1e-2f0e-4e57-9a43-5d2f8c1b9e10';

/** A bridge as code mode sees it: two granted tools, and images and values kept by call id as host/process.ts keeps them. */
function bridgeOf() {
  const extras = new Map();
  return {
    extras,
    get: (name) => (name === 'read' || name === 'computer_screenshot' ? { name, replay: 'safe' } : undefined),
    take: (callId) => {
      const taken = extras.get(callId);
      extras.delete(callId);
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
    bridge.extras.set(String(req.params.callId), { images: [{ mimeType: 'image/png', data: PNG }] });
    throw new Error('the answer could not be built');
  };
  await assert.rejects(request(next)({ method: 'item/tool/call', params: { callId: 'call_read', tool: 'read', arguments: {} } }), /could not be built/);
  assert.equal(bridge.extras.size, 0, `the call's images were taken, not left in the bridge: ${[...bridge.extras.keys()].join(', ')}`);
});

test("a call that answers still gets its images on the answer, and none are left behind", async () => {
  const bridge = bridgeOf();
  const request = await handlerOf(bridge);
  const next = async (req) => {
    bridge.extras.set(String(req.params.callId), { images: [{ mimeType: 'image/png', data: PNG }] });
    return { contentItems: [{ type: 'inputText', text: 'frame.png: image/png' }], success: true };
  };
  const answer = await request(next)({ method: 'item/tool/call', params: { callId: 'call_read', tool: 'read', arguments: {} } });
  assert.deepEqual(answer.contentItems.map((item) => item.type), ['inputText', 'inputImage']);
  assert.equal(bridge.extras.size, 0);
});

test("the model's own call of a computer tool gets its words and its image; a script's nested call gets the value, the image whole in it", async () => {
  const bridge = bridgeOf();
  const request = await handlerOf(bridge);
  const value = { type: 'image', mimeType: 'image/png', width: 1280, height: 800 };
  const next = async (req) => {
    bridge.extras.set(String(req.params.callId), { images: [{ mimeType: 'image/png', data: PNG }], structured: value });
    return { contentItems: [{ type: 'inputText', text: 'the screen, 1280×800 px' }], success: true };
  };
  const own = await request(next)({ method: 'item/tool/call', params: { callId: 'call_shot', tool: 'computer_screenshot', arguments: {} } });
  assert.deepEqual(own.contentItems, [{ type: 'inputText', text: 'the screen, 1280×800 px' }, { type: 'inputImage', imageUrl: `data:image/png;base64,${PNG}` }]);
  const nested = await request(next)({ method: 'item/tool/call', params: { callId: NESTED, tool: 'computer_screenshot', arguments: {} } });
  assert.deepEqual(nested.contentItems, [{ type: 'inputText', text: JSON.stringify({ ...value, data: PNG }) }]);
  assert.equal(nested.success, true);
  assert.equal(bridge.extras.size, 0);
});

test("a script's nested call of a tool with no value gets its words and its images, as data: URLs", () => {
  const answer = { contentItems: [{ type: 'inputText', text: 'frame.png: image/png' }], success: true };
  assert.deepEqual(scriptAnswer(answer, { images: [{ mimeType: 'image/png', data: PNG }] }).contentItems, [answer.contentItems[0], { type: 'inputImage', imageUrl: `data:image/png;base64,${PNG}` }]);
  assert.equal(scriptAnswer(answer, undefined), answer);
  const failed = { contentItems: [{ type: 'inputText', text: 'refused' }], success: false };
  assert.equal(scriptAnswer(failed, { structured: { steps: [] } }), failed, "a failure answers its words");
});

test("withImageData puts each image's data back in order, deep in the value, and leaves the rest as it is", () => {
  const value = { state: 's2', after: { image: { type: 'image', mimeType: 'image/png' } }, shots: [{ type: 'image', mimeType: 'image/jpeg' }], text: 'image' };
  assert.deepEqual(withImageData(value, [{ mimeType: 'image/png', data: 'AAA' }, { mimeType: 'image/jpeg', data: 'BBB' }]), {
    state: 's2', after: { image: { type: 'image', mimeType: 'image/png', data: 'AAA' } }, shots: [{ type: 'image', mimeType: 'image/jpeg', data: 'BBB' }], text: 'image',
  });
  assert.deepEqual(withImageData(value, []), value);
});
