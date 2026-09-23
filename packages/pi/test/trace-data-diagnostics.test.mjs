import { WorkflowExtensionService } from '../dist/extension-service.js';
import assert from 'node:assert/strict';
import test from 'node:test';

function registerRegression(Service) {
  const workflow = code => ({
    v: 2, name: 'fictional-trace-data',
    schemas: { Result: { type: 'object', required: ['value'], additionalProperties: false,
      properties: { value: { type: 'number' } } } },
    output: { schemaId: 'Result', path: 'result' },
    root: { node: 'code', label: 'fictional-conversion', code },
  });
  const runCode = async (code, input = {}, limits = {}) => {
    const service = new Service({ limits });
    try {
      service.prepare(workflow(code), { allowExecutableCandidates: true });
      return await service.run(input, { deps: {} });
    } finally { await service.dispose(); }
  };

  test('fictional NaN and infinities are data rejection, not resource exhaustion', async () => {
    for (const raw of ['fictional-private-sentinel', 'Infinity', '-Infinity']) {
      const report = await runCode('s => ({result:{value:Number(s.raw)}})', { raw });
      assert.equal(report.status, 'failed');
      assert.equal(report.error.code, 'trace_invalid_data');
      assert.match(report.error.message, /Numbers must be finite/);
      assert.equal(report.traceTruncated, true);
      assert.deepEqual(report.calls, { agent: 0, judge: 0, tool: 0 });
      assert.equal(Object.hasOwn(report, 'output'), false);
      assert.doesNotMatch(JSON.stringify(report), /fictional-private-sentinel/);
    }
  });

  test('finite numeric output remains unchanged; nothing is coerced to null or zero', async () => {
    const report = await runCode('s => ({result:{value:Number(s.raw)}})', { raw: '12' });
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.output, { value: 12 });
    assert.equal(report.traceTruncated, undefined);
  });

  test('snapshot byte/depth/value bounds remain fail-closed resource failures', async () => {
    const fixtures = [
      ['s => ({result:{value:12}})', { maxEventBytes: 10 }],
      ['s => ({result:{value:"x".repeat(5000)}})', { maxEventBytes: 1024 }],
      ['s => { let v = {}; for (let i=0; i<140; i++) v={next:v}; return {result:{value:v}}; }', {}],
      ['s => ({result:{value:Array(100001).fill(0)}})', {}],
    ];
    for (const [code, limits] of fixtures) {
      const report = await runCode(code, {}, limits);
      assert.equal(report.status, 'failed');
      assert.equal(report.error.code, 'limit');
      assert.equal(report.traceTruncated, true);
      assert.equal(Object.hasOwn(report, 'output'), false);
    }
  });

  test('non-JSON cycles still reject without exposing cycle payloads', async () => {
    const report = await runCode('s => { const v={tag:"fictional-private-cycle"}; v.self=v; return {result:{value:v}}; }');
    assert.equal(report.status, 'failed');
    assert.equal(report.error.code, 'trace_invalid_data');
    assert.doesNotMatch(JSON.stringify(report), /fictional-private-cycle/);
  });

  test('observer errors remain non-execution and cannot alter finite output', async () => {
    const service = new Service();
    try {
      service.prepare(workflow('s => ({result:{value:12}})'), { allowExecutableCandidates: true });
      const report = await service.run({}, { deps: {}, onEvent: () => { throw new Error('fictional-observer-secret'); } });
      assert.equal(report.status, 'complete');
      assert.deepEqual(report.output, { value: 12 });
      assert.doesNotMatch(JSON.stringify(report), /fictional-observer-secret/);
    } finally { await service.dispose(); }
  });

  test('operator cancellation stays interrupted, not a trace failure', async () => {
    const service = new Service();
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    const graph = workflow('s => ({result:{value:12}})');
    graph.root = { node: 'agent', label: 'fictional-wait', instructions: 'Return a fictional number.', out: 'Result', as: 'result' };
    service.prepare(graph);
    const run = service.run({}, { deps: { runNode: () => { enter(); return pending; } } });
    await entered;
    service.stop();
    const report = await run;
    assert.equal(report.status, 'interrupted');
    assert.equal(report.error.code, 'cancelled');
    settle({ value: NaN });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.inspect().lastReport.error.code, 'cancelled');
    await service.dispose();
  });
}

registerRegression(WorkflowExtensionService);
