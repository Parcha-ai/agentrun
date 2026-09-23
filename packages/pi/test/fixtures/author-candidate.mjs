// Test-only scripted Pi session for candidate retention and host acceptance.
import { readFile } from 'node:fs/promises';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { authorWorkflow, createPiRunner } from '@parcha/agentrun-pi';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}
const outputDir = option('--out', './candidates/pi-example');
const execute = args.includes('--run');
if (args.some(arg => arg !== '--run')) throw new Error('Usage: node test/fixtures/author-candidate.mjs [--run] [--out directory]');

const schema = { type: 'object', properties: { count: { type: 'integer', minimum: 0 } }, required: ['count'], additionalProperties: false };
const scriptedCandidate = {
  v: 2, name: 'extract-count',
  schemas: {
    Input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    Count: schema,
  },
  input: { schemaId: 'Input' }, output: { schemaId: 'Count', path: 'result' },
  root: { node: 'extract', label: 'extract-count', instructions: 'Read text from the JSON input. Return the nonnegative integer count mentioned in text.', requires: ['text'], out: 'Count', as: 'result' },
};

const offlinePi = {
  model: {}, modelRuntime: {}, maxTurns: 2, timeoutMs: 10_000,
  async sessionFactory(config) {
    let listener = () => {};
    const authoring = config.resourceLoader.getSystemPrompt().includes('You author AgentRun DSL');
    return { session: {
      subscribe(fn) { listener = fn; return () => {}; },
      async abort() {}, dispose() {},
      async prompt(text) {
        listener({ type: 'turn_start' });
        const value = authoring ? structuredClone(scriptedCandidate) : { count: Number(JSON.parse(text).text.match(/\d+/)?.[0]) };
        await config.customTools.find(tool => tool.name === 'submit').execute('offline-submit', { value });
        listener({ type: 'turn_end' });
      },
    } };
  },
};
const pi = offlinePi;
// This example allows no execution tools, even if the host configuration has some.
const runNode = createPiRunner({ ...pi, tools: [] });
const fixtures = [
  { input: { text: 'There are 0 apples.' }, expected: 0 },
  { input: { text: 'There are 5 oranges.' }, expected: 5 },
  { input: { text: 'The basket contains 12 pears.' }, expected: 12 },
];
let fixtureChecks = 0;
const candidate = await authorWorkflow({
  request: 'Create one extract node that reads the text input field and returns {count: nonnegative integer}. Declare an input schema requiring text, an output schema requiring count, and no tools or effects. Instructions refer to JSON input; they are literal text. Inputs contain exactly one numeric count.',
  outputDir, inputKeys: ['text'], pi, maxCandidates: 3,
  async acceptance(workflow) {
    // Fixed host policy and expectations live outside the generated workflow.
    // Keep this example's acceptance execution restricted to a single tool-free node.
    if (workflow.root.node !== 'extract' || (workflow.root.tools?.length ?? 0) !== 0 || workflow.root.verify) {
      return ['This host accepts one extract node with no tools or semantic verifier.'];
    }
    for (const { input, expected } of fixtures) {
      let result;
      try { result = await runWorkflow(workflow, input, { runNode }); }
      catch (error) { return [`Fixture ${JSON.stringify(input)} failed: ${error.message}`]; }
      fixtureChecks++;
      if (result.status !== 'complete' || result.output?.count !== expected || Object.keys(result.output).length !== 1) {
        return [`Fixture ${JSON.stringify(input)} must produce exactly ${JSON.stringify({ count: expected })}.`];
      }
    }
    return [];
  },
});
console.log(JSON.stringify({
  mode: 'offline scripted Pi (no inference)',
  candidate: candidate.path, checks: candidate.checks, fixtureChecks,
  status: 'retained candidate; not activated',
}, null, 2));

if (execute) {
  // Reload the retained artifact, then explicitly execute it on a separate input.
  // Production hosts should pin its digest and retain their last working version.
  const retained = JSON.parse(await readFile(candidate.path, 'utf8'));
  const result = await runWorkflow(retained, { text: 'There are 3 apples.' }, { runNode });
  if (result.status !== 'complete' || result.output?.count !== 3) throw new Error('Explicit run did not produce the expected count');
  console.log(JSON.stringify({ status: result.status, output: result.output }, null, 2));
} else {
  console.log('Candidate and fixture results retained. Add --run to explicitly run the accepted candidate on a new input.');
}
