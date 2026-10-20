// The run with no key: a scripted lead stands in for the model, and the fake browser serves three pages shaped like a
// practice site's (an index, a dropdown and two checkboxes). The lead cannot read the task, so it runs one script whatever
// is asked: it reads the page the browser opens on and submits what it read. Every answer says it is scripted.
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Fakes } from '@parcha/agentrun-reference';

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));

const SITE = 'https://practice.example.test';
const page = (path: string, title: string, text: string, html: string) => ({ url: `${SITE}${path}`, title, text, html });
export const PAGES = {
  [`${SITE}/`]: page('/', 'Practice', 'Practice pages: Dropdown, Checkboxes', `<h1>Practice pages</h1><ul><li><a href="${SITE}/dropdown">Dropdown</a></li><li><a href="${SITE}/checkboxes">Checkboxes</a></li></ul>`),
  [`${SITE}/dropdown`]: page('/dropdown', 'Dropdown', 'Dropdown List: Please select an option', '<h3>Dropdown List</h3><select id="dropdown"><option value="" selected disabled>Please select an option</option><option value="1">Option 1</option><option value="2">Option 2</option></select>'),
  [`${SITE}/checkboxes`]: page('/checkboxes', 'Checkboxes', 'Checkboxes: checkbox 1 (unticked), checkbox 2 (ticked)', '<h3>Checkboxes</h3><form id="checkboxes"><input type="checkbox"> checkbox 1<br><input type="checkbox" checked> checkbox 2</form>'),
};

/** The scripted lead: one read of the page the browser opens on, then that read submitted as the answer. */
export function scriptedLead(messages: readonly Message[]): AssistantMessage {
  const reads = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'browser_read');
  const last = reads.at(-1);
  if (!last) return call('browser_read', {});
  const first = textOf(last as Message).split('\n').find((line) => line.trim()) ?? '';
  return call('submit', { answer: `(scripted: no model read the task) The browser opened on a page that reads: ${first.slice(0, 200)}` });
}

/** The fakes the reference entry runs the agent on. */
export const fakes: Fakes = {
  model: scriptedLead, tools: {}, pages: PAGES, start: `${SITE}/`, responses: 64, tokensPerSecond: 400, lead: { input: ['text'] },
  judge: (async () => { throw new Error('the browser agent asks no typed question'); }) as unknown as Fakes['judge'],
};
