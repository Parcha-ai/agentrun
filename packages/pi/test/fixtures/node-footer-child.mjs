// One process over one SQLite file, for a node's user turn across the change that made its delivery contract a part of
// its own. `before` plays a build from before it: the runner's attempt goes out with the node's input and its contract
// as one string, joined by a newline as that build wrote them, and the process kills itself inside the model request.
// `after` is this build: it opens the file, lets pi resume, reaches the same node, whose request is answered with a
// record, then runs a second node. Every model request prints its user turn as the model got it.
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { hostScope, nodeRunner } from '@parcha/agentrun-pi/durable';

const [mode, file] = process.argv.slice(2);
const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const say = (row) => console.log(JSON.stringify(row));

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 6 }, () => (context) => {
  say({ event: 'request', user: context.messages.find((message) => message.role === 'user')?.content });
  if (mode === 'before') { process.kill(process.pid, 'SIGKILL'); for (;;); }
  return fauxAssistantMessage([fauxToolCall('submit', { verdict: 'buy' })], { stopReason: 'toolUse' });
}));
const models = createModels();
models.setProvider(faux.provider);
const nodes = nodeRunner({
  agent: () => ({ model: { provider: 'faux', modelId: 'faux-1' } }),
  onNodeOpen: (node) => { say({ event: 'open', session: node.sessionId, conversation: Number(node.conversationId), resumed: node.resumed }); },
});
const registry = createRegistry();
registry.install(nodes.extension);
const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);

/** The user turn as a build from before the change submitted it: its text parts joined by a newline. */
const joined = (content) => (Array.isArray(content) ? content.map((part) => part.text).join('\n') : content);
/** A scope whose conversations submit that way; the handle is proxied, not copied, so its methods keep their `this`. */
const asBefore = (scope) => ({
  ...scope,
  conversation: async (id, context) => {
    const handle = await scope.conversation(id, context);
    return handle && new Proxy(handle, {
      get(target, key) {
        if (key === 'submit') return (submission, at) => target.submit({ ...submission, content: joined(submission.content) }, at);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  },
});
const node = (at, claim) => ({
  kind: 'decide', label: 'Verdict', executionPath: `/root/steps/${at}`, system: ['Decide buy or pass.'], user: JSON.stringify({ claim }), schema: SCHEMA,
  step: { sessionId: `run-1:step:/root/steps/${at}:a0`, attempt: 0, earlierSessionIds: [] },
});

const { runNode } = nodes.on(mode === 'before' ? asBefore(hostScope(harness)) : hostScope(harness), ctx);
// As a workflow that resumes reaches its nodes after pi has resumed what was in flight.
if (mode === 'after') { harness.resume(); await sleep(300); }
say({ event: 'record', record: await runNode(node(0, 'x')) });
say({ event: 'record', record: await runNode(node(1, 'y')) });
await harness.close(ctx);
