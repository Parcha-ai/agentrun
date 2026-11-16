// A host tool's images on Codex are checked before they reach the model, as claude-agent's are (toolImageProblems): a
// type the model takes (image/<x>, no parameters), base64. One that can't be sent is the call's error, naming the tool and
// the image, not a request refused later.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeTool } from '@parcha/agentrun-kernel/process';
import { toolImageProblems } from '../dist/tool-images.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
/** The tool `read` answering `images`, bridged as the adapter bridges it: its images checked by toolImageProblems. */
const toolWith = (images) => bridgeTool({ name: 'read', description: 'Read.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'a picture', images }) }, { imageProblems: (shown) => toolImageProblems('read', shown) });
const run = (tool) => tool.execute({}, { stepId: 'tool:c1', signal: new AbortController().signal });

test("an image Codex's model can't take is the call's error, by the tool's name and the image's place; a good one goes through", async () => {
  await assert.rejects(run(toolWith([{ mimeType: 'image/png', data: PNG }, { mimeType: 'image/png;charset=x', data: PNG }])), /the tool read's image 2 .*image\/png;charset=x/);
  await assert.rejects(run(toolWith([{ mimeType: 'text/html', data: PNG }])), /the tool read's image 1 .*text\/html/);
  await assert.rejects(run(toolWith([{ mimeType: 'image/png', data: 'not base64!' }])), /the tool read's image 1 is not base64/);
  assert.deepEqual(await run(toolWith([{ mimeType: 'image/png', data: PNG }])), { text: 'a picture', images: [{ mimeType: 'image/png', data: PNG }] });
});
