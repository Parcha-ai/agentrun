import assert from 'node:assert/strict';

// Prewritten fixtures exercise control flow only. No model, network, or account calls.
const answer = (text, source) => ({ text, sources: [source] });
export const scenarios = {
  password: {
    input: { request: 'How do I reset my password?' },
    found: answer('Select Forgot password on the sign-in page and follow the email link.', 'help:password-reset'),
    initial: ['yes', 0.97],
  },
  invoice: {
    input: { request: 'Where can I download my invoice?' },
    found: answer('Open Settings → Billing → Invoices, then select Download.', 'help:invoices'),
    initial: ['yes', 0.96],
  },
  payment: {
    input: { request: 'My payment failed. Can you investigate?' },
    found: answer('Check that your payment method is up to date.', 'help:payment-failures'),
    initial: ['no', 0.95],
    investigated: answer('The payment record reports an expired card. Update the card in Settings → Billing and retry.', 'fixture:payment-record-expired-card'),
    recheck: ['yes', 0.96],
  },
  unresolved: {
    input: { request: 'My payment failed, but I cannot identify the account.' },
    found: answer('Check that your payment method is up to date.', 'help:payment-failures'),
    initial: ['uncertain', 0.98],
    investigated: answer('No account can be identified from the supplied information. A support person must request account details.', 'fixture:account-lookup-no-match'),
    recheck: ['uncertain', 0.98],
  },
};

export function createScriptedAdapters(scenario, overrides = {}) {
  const fixture = scenarios[scenario];
  if (!fixture) throw new Error(`No scripted support scenario: ${scenario}`);
  const found = overrides.found ?? fixture.found;
  const calls = [];
  const events = [];
  const fixtureChoice = (question, [choice, confidence]) => ({
    type: 'choice', choice, confidence,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [
      key, key === choice ? confidence : (1 - confidence) / (Object.keys(question.criteria).length - 1),
    ])),
  });
  const deps = {
    async runEffect({ node, input }) {
      assert.equal(node.via, 'tool');
      assert.equal(node.tool, 'help.search', 'Only a read-only help lookup is allowed.');
      assert.deepEqual(input, fixture.input);
      calls.push({ kind: 'tool', label: node.label, tool: node.tool, input });
      return structuredClone(found);
    },
    async runJudge({ kind, label, state, questions }) {
      assert.equal(kind, 'judge');
      assert.ok(['check-existing-answer', 'recheck-agent-answer'].includes(label));
      assert.deepEqual(Object.keys(questions), ['answersRequest']);
      assert.equal(questions.answersRequest.type, 'choice');
      assert.equal(state.request, fixture.input.request);
      const recheck = label === 'recheck-agent-answer';
      assert.deepEqual(state.answer, recheck ? (overrides.agentOutput ?? fixture.investigated) : found);
      const result = (recheck ? overrides.recheck ?? fixture.recheck : overrides.initial ?? fixture.initial);
      if (!result) throw new Error('No scripted judgment for this stage.');
      calls.push({ kind: 'judge', label, input: structuredClone(state) });
      return { answers: { answersRequest: fixtureChoice(questions.answersRequest, result) } };
    },
    async runNode({ kind, label, user, tools, schema }) {
      assert.equal(kind, 'agent');
      assert.equal(label, 'investigate');
      assert.deepEqual(tools, ['support.read']);
      assert.deepEqual(JSON.parse(user), { request: fixture.input.request, existingAnswer: found });
      assert.deepEqual(schema.required, ['text', 'sources']);
      calls.push({ kind: 'agent', label, input: JSON.parse(user) });
      const output = overrides.agentOutput ?? fixture.investigated;
      if (!output) throw new Error('The fixture has no agent response: this request should not invoke an agent.');
      return structuredClone(output);
    },
    onEvent: event => events.push(event),
  };
  return { deps, calls, events };
}
