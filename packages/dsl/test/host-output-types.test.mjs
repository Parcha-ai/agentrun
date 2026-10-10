// applyHostOutputTypes: a prose artifact of a host's output type becomes the report writer. Without options a type is
// matched exactly, as before; with `normalizeType` an authored spelling is first mapped to the host's name for it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHostOutputTypes, runWorkflow, validateWorkflow } from '../dist/index.js';

const host = { name: 'Host', outputTypes: { research_report: { kind: 'prose', description: 'the research report' }, case_file: { kind: 'file', description: 'the case file' } } };
const ALIASES = { report: 'research_report', brief: 'research_report' };
// A host's normaliser, as a harness writes one: trim, lowercase, dashes and spaces to underscores, aliases, then
// only a type the host knows.
const normalizeType = (type) => {
  const name = type.trim().toLowerCase().replace(/[-\s]+/g, '_');
  const canonical = ALIASES[name] ?? name;
  return Object.hasOwn(host.outputTypes, canonical) ? canonical : null;
};
const Count = { type: 'object', required: ['count'], properties: { count: { type: 'number' } } };
const workflow = (type) => ({
  v: 2, name: 'host-types', schemas: { Count }, output: { schemaId: 'Count', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'extract', label: 'count', instructions: 'Count the apples.', out: 'Count', as: 'result' },
    { node: 'artifact', label: 'write', type, instructions: 'Render the count as the report.', requires: ['result'] },
  ] },
});
const typeOfTerminal = (view) => view.root.steps[1].type;

test('without options, a type is matched exactly: the behavior before the option existed', () => {
  assert.equal(typeOfTerminal(applyHostOutputTypes(workflow('research_report'), host)), 'report');
  for (const spelling of ['Research-Report', ' research report ', 'RESEARCH_REPORT', 'brief']) {
    assert.equal(typeOfTerminal(applyHostOutputTypes(workflow(spelling), host)), spelling, `${JSON.stringify(spelling)} is left as authored`);
  }
  assert.equal(typeOfTerminal(applyHostOutputTypes(workflow('Research-Report'), host, {})), 'Research-Report', 'an empty options object is the same');
});

test('with normalizeType, an authored spelling of a prose type becomes the report writer', () => {
  for (const spelling of ['research_report', 'Research-Report', ' research report ', 'RESEARCH_REPORT', 'brief', 'Report']) {
    assert.equal(typeOfTerminal(applyHostOutputTypes(workflow(spelling), host, { normalizeType })), 'report', JSON.stringify(spelling));
  }
});

test('with normalizeType, a type it maps to nothing, or to a file type, is left as authored', () => {
  for (const spelling of ['Research Notes', 'case-file', 'Case File', 'markdown-ish']) {
    assert.equal(typeOfTerminal(applyHostOutputTypes(workflow(spelling), host, { normalizeType })), spelling, JSON.stringify(spelling));
  }
  // A normaliser that returns undefined names nothing, as null does.
  assert.equal(typeOfTerminal(applyHostOutputTypes(workflow('Research-Report'), host, { normalizeType: () => undefined })), 'Research-Report');
});

test('with normalizeType, the host decides: a name it maps to nothing stays as authored, even an exact prose name', () => {
  for (const rejects of [() => null, () => undefined]) {
    assert.equal(typeOfTerminal(applyHostOutputTypes(workflow('research_report'), host, { normalizeType: rejects })), 'research_report', String(rejects));
  }
});

test('the authored document is never changed, and a host with no prose type is a no-op', () => {
  const authored = workflow('Research-Report');
  const before = structuredClone(authored);
  applyHostOutputTypes(authored, host, { normalizeType });
  assert.deepEqual(authored, before);
  const filesOnly = { name: 'Host', outputTypes: { case_file: host.outputTypes.case_file } };
  assert.equal(applyHostOutputTypes(authored, filesOnly, { normalizeType }), authored);
});

test('the normalised view validates and runs as a report through the public interpreter', async () => {
  const view = applyHostOutputTypes(workflow('Research-Report'), host, { normalizeType });
  assert.equal(validateWorkflow(view, { inputKeys: [] }).ok, true);
  const run = await runWorkflow(view, {}, { runNode: async (request) => request.kind === 'report' ? { report_markdown: 'There are three apples, as the request says.' } : { count: 3 } });
  assert.equal(run.status, 'complete');
});
