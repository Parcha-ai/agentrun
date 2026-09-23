import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { runResearch, offlineResearchAdapters } from './research-live.mjs';
import { evaluateEvidence, scriptedEvidenceDecision } from './research-eval.mjs';
import { evidenceCases } from './research-eval-cases.mjs';
import { loadEvidenceCases, loadResearchAdapters, parseOptions, safeErrorKind, saveReport, validateEvidenceCases } from './research-runtime.mjs';

test('same typed research workflow runs against a bundled corpus with observable adapter counts', async () => {
  const result = await runResearch();
  assert.equal(result.status, 'complete');
  assert.equal(result.mode, 'scripted');
  assert.deepEqual(result.calls, { tool: 3, decision: 3, agent: 5 });
  assert.deepEqual(result.output.findings.map(finding => finding.sources.map(source => source.id)), [['review-guide'], ['editor-trial'], ['search-trial']]);
  assert.match(result.workflowSha256, /^[a-f0-9]{64}$/);
});

test('an agent cannot invent a cited source or alter the supplied source text', async () => {
  const adapters = offlineResearchAdapters();
  const original = adapters.runNode;
  adapters.runNode = async params => {
    const value = await original(params);
    if (params.label.endsWith('write-report')) value.findings[0].sources[0].text = 'Invented evidence';
    return value;
  };
  await assert.rejects(runResearch({ adapters }), error => error.code === 'citation');
});

test('no selected evidence escalates instead of running writers or returning a report', async () => {
  const adapters = offlineResearchAdapters();
  adapters.runJudge = async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.01 }])) });
  const result = await runResearch({ adapters });
  assert.equal(result.status, 'escalated');
  assert.equal(result.calls.agent, 1);
  assert.equal(result.output, undefined);
});

test('gold labels are not sent to the decision adapter; the exact question rubric is retained', async () => {
  const report = await evaluateEvidence({ runJudge: async params => {
    assert.deepEqual(Object.keys(params.state).sort(), ['items', 'subquestion']);
    assert.deepEqual(Object.keys(params.state.items[0].item).sort(), ['id', 'text']);
    assert.equal(params.state.items[0].item.id, 'candidate');
    assert.match(params.questions['0.answersQuestion'].instructions, /contradicting/);
    return scriptedEvidenceDecision(params);
  } });
  assert.equal(report.total, 6);
  assert.equal(report.passed, 6);
  assert.equal(report.decisions.find(row => row.id === 'contrary').selected, true);
  assert.equal(report.decisions.find(row => row.id === 'insufficient').selected, false);
  assert.match(report.rubric.properties.answersQuestion.criteria.true, /contrary/);
});

test('SIGINT cancels a running CLI without dumping the provider error or saving a completed report', { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'research-cancel-'));
  let child;
  try {
    const config = join(temp, 'waiting.mjs');
    await writeFile(config, 'export default { runJudge: async () => { process.stdout.write("ready\\n"); return new Promise(() => {}); } };');
    child = spawn(process.execPath, ['examples/research-eval.mjs', '--live', '--config', config, '--out', join(temp, 'cancelled.json')], { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('CLI exited before its adapter started'))); });
    child.kill('SIGINT');
    assert.deepEqual(await ended, { code: 130, signal: null });
    assert.match(stderr, /cancelled/);
    await assert.rejects(readFile(join(temp, 'cancelled.json')), error => error.code === 'ENOENT');
  } finally { child?.kill('SIGKILL'); await rm(temp, { recursive: true, force: true }); }
});

test('schema-valid wrong decisions fail independent evaluation', async () => {
  const report = await evaluateEvidence({ runJudge: async ({ questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.95 }])),
    usage: { input_tokens: 10, output_tokens: 2 }, secret: 'must-not-be-exported',
  }) });
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 4);
  assert.equal(JSON.stringify(report).includes('must-not-be-exported'), false);
});

test('changing independent expectations cannot change scripted model outputs', async () => {
  const report = await evaluateEvidence({ cases: evidenceCases.map(row => ({ ...row, keep: !row.keep })) });
  assert.equal(report.failed, 6);
});

test('a first-edit threshold change appears in the evaluation report and changes actual decisions', async () => {
  const scratch = new URL('../.release/', import.meta.url);
  await mkdir(scratch, { recursive: true });
  const temp = await mkdtemp(fileURLToPath(new URL('research-threshold-', scratch)));
  try {
    for (const filename of ['research-eval.mjs', 'research-runtime.mjs', 'research-eval-cases.mjs', 'typed-research.ts']) {
      await copyFile(new URL(filename, import.meta.url), join(temp, filename));
    }
    const definition = join(temp, 'typed-research.ts');
    const source = await readFile(definition, 'utf8');
    assert.equal(source.split('gte: 0.8').length, 2);
    await writeFile(definition, source.replace('gte: 0.8', 'gte: 0.99'));
    const result = spawnSync(process.execPath, [join(temp, 'research-eval.mjs')], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.threshold, 0.99);
    assert.equal(report.passed, 4);
    assert.equal(report.failed, 2);
    assert.equal(report.decisions.find(row => row.id === 'direct').selected, false);
    assert.equal(report.decisions.find(row => row.id === 'contrary').selected, false);
    assert.notEqual(report.workflowSha256, (await evaluateEvidence()).workflowSha256);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('cancellation before work refuses calls; cancellation during an uncooperative adapter settles', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(runResearch({ signal: controller.signal, adapters: {} }), /stop/);
  const inFlight = new AbortController();
  const running = evaluateEvidence({ signal: inFlight.signal, runJudge: () => {
    queueMicrotask(() => inFlight.abort(new Error('stop decision')));
    return new Promise(() => {});
  } });
  await assert.rejects(running, /stop decision/);
});

test('configuration is opt-in and safe errors omit module failure bodies', async () => {
  assert.throws(() => parseOptions(['--config', 'x.mjs']), /requires --live/);
  assert.throws(() => parseOptions(['--live', '--model', 'anything']), /Use/);
  const temp = await mkdtemp(join(tmpdir(), 'research-config-'));
  try {
    await writeFile(join(temp, 'bad.mjs'), 'throw new Error("secret-provider-token")');
    await assert.rejects(loadResearchAdapters({ config: join(temp, 'bad.mjs') }), error => error.code === 'configuration' && !error.message.includes('secret-provider-token') && /Error kind: Error/.test(error.message));
    await writeFile(join(temp, 'syntax.mjs'), 'this is not valid javascript');
    await assert.rejects(loadResearchAdapters({ config: join(temp, 'syntax.mjs') }), /Error kind: SyntaxError/);
    await assert.rejects(loadResearchAdapters({ config: join(temp, 'absent.mjs') }), /ERR_MODULE_NOT_FOUND/);
    assert.equal(safeErrorKind({ name: 'secret-name', code: 'secret-code', message: 'secret-message' }), 'unclassified_error');
    assert.equal(safeErrorKind({ name: 'JevError', code: 'configuration', message: 'secret-message' }), 'JevError/configuration');
    await writeFile(join(temp, 'good.mjs'), 'export default { runJudge: async () => ({}) };');
    assert.equal(typeof (await loadResearchAdapters({ config: join(temp, 'good.mjs'), agents: false })).runJudge, 'function');
    await assert.rejects(loadResearchAdapters({ config: join(temp, 'good.mjs') }), /runNode/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('deadline option is bounded, explicit and active during a stalled adapter request', { timeout: 10_000 }, async () => {
  assert.equal(parseOptions([]).deadlineSeconds, 600);
  assert.equal(parseOptions(['--deadline', '3600']).deadlineSeconds, 3600);
  for (const value of ['0', '-1', '3601', '1.5', 'Infinity', 'NaN', '10x', '']) {
    assert.throws(() => parseOptions(['--deadline', value]), /integer from 1 to 3600/);
  }
  assert.throws(() => parseOptions(['--deadline']), /integer from 1 to 3600/);
  assert.throws(() => parseOptions(['--deadline', '1', '--deadline', '2']), /Use/);
  const temp = await mkdtemp(join(tmpdir(), 'research-deadline-'));
  try {
    const config = join(temp, 'waiting.mjs');
    await writeFile(config, 'export default {runJudge: () => new Promise(() => {})};');
    const result = spawnSync(process.execPath, ['examples/research-eval.mjs', '--live', '--config', config, '--deadline', '1'], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 130, result.stderr);
    assert.match(result.stderr, /exceeded its 1-second deadline/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('report publication is private, complete and refuses replacing existing evidence', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'research-save-'));
  try {
    const path = join(temp, 'report.json');
    await saveReport(path, { status: 'complete', value: 'original' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const original = await readFile(path, 'utf8');
    await assert.rejects(saveReport(path, { status: 'complete', value: 'replacement' }), /already exists/);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(await readdir(temp), ['report.json']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('cancellation during report writing removes its temporary file without publishing a partial result', { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'research-save-cancel-'));
  const controller = new AbortController();
  let observed = false;
  const watcher = watch(temp, (event, filename) => {
    if (event === 'rename' && filename?.startsWith('.report.json.partial-')) {
      observed = true;
      controller.abort(new Error('cancel during save'));
    }
  });
  try {
    // Long enough to witness creation while writeFile is writing in chunks.
    await assert.rejects(saveReport(join(temp, 'report.json'), { evidence: 'x'.repeat(16 * 1024 * 1024) }, controller.signal), /cancel during save/);
    assert.equal(observed, true);
    assert.deepEqual(await readdir(temp), []);
  } finally { watcher.close(); await rm(temp, { recursive: true, force: true }); }
});

test('offline CLIs run with no configuration; evaluation failure exits nonzero and never overwrites evidence', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'research-cli-'));
  const root = new URL('../', import.meta.url);
  try {
    const run = args => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
    const first = run(['examples/research-live.mjs']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).mode, 'scripted');
    const out = join(temp, 'evaluation.json');
    const evaluated = run(['examples/research-eval.mjs', '--out', out]);
    assert.equal(evaluated.status, 0, evaluated.stderr);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).passed, 6);
    const original = await readFile(out, 'utf8');
    assert.notEqual(run(['examples/research-eval.mjs', '--out', out]).status, 0);
    assert.equal(await readFile(out, 'utf8'), original);
    await writeFile(join(temp, 'wrong.mjs'), 'export default { runJudge: async ({questions}) => ({answers: Object.fromEntries(Object.keys(questions).map(id => [id, {type:"noul",noul:0.99}]))}) };');
    const wrong = run(['examples/research-eval.mjs', '--live', '--config', join(temp, 'wrong.mjs')]);
    assert.equal(wrong.status, 2, wrong.stderr);
    assert.equal(JSON.parse(wrong.stdout).failed, 4);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('human summaries preserve full saved JSON and nonzero evaluation failure status', async () => {
  assert.equal(parseOptions(['--summary']).summary, true);
  assert.equal(parseOptions([]).summary, false);
  assert.throws(() => parseOptions(['--summary', '--summary']), /Use/);
  const temp = await mkdtemp(join(tmpdir(), 'research-summary-'));
  try {
    const run = args => spawnSync(process.execPath, args, { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30_000 });
    const out = join(temp, 'research.json');
    const research = run(['examples/research-live.mjs', '--summary', '--out', out]);
    assert.equal(research.status, 0, research.stderr);
    assert.match(research.stdout, /Scripted research/);
    assert.match(research.stdout, /Report: Pilot the repository/);
    assert.match(research.stdout, /3 findings; 3 distinct sources cited/);
    assert.match(research.stdout, /Calls: 3 tools, 3 system one decisions, 5 model steps/);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).output.findings.length, 3);
    const evaluationOut = join(temp, 'evaluation.json');
    const evaluation = run(['examples/research-eval.mjs', '--summary', '--out', evaluationOut]);
    assert.equal(evaluation.status, 0, evaluation.stderr);
    assert.match(evaluation.stdout, /fixture decisions, not model quality/);
    assert.equal(evaluation.stdout.match(/^PASS /gm).length, 6);
    assert.match(evaluation.stdout, /6\/6 cases passed. Threshold: 0.8/);
    assert.equal(JSON.parse(await readFile(evaluationOut, 'utf8')).decisions.length, 6);
    const wrongConfig = join(temp, 'wrong.mjs');
    await writeFile(wrongConfig, 'export default {runJudge: async ({questions}) => ({answers: Object.fromEntries(Object.keys(questions).map(id => [id, {type:"noul",noul:0.99}]))})};');
    const wrong = run(['examples/research-eval.mjs', '--live', '--config', wrongConfig, '--summary']);
    assert.equal(wrong.status, 2, wrong.stderr);
    assert.equal(wrong.stdout.match(/^FAIL /gm).length, 4);
    assert.match(wrong.stdout, /2\/6 cases passed/);
    const emptyConfig = join(temp, 'empty.mjs');
    await writeFile(emptyConfig, `import {researchFixtures} from ${JSON.stringify(new URL('typed-research-fixtures.ts', import.meta.url).href)};
const adapters=researchFixtures().deps;adapters.runJudge=async ({questions})=>({answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'noul',noul:0.01}]))});export default adapters;`);
    const escalated = run(['examples/research-live.mjs', '--live', '--config', emptyConfig, '--summary']);
    assert.equal(escalated.status, 2, escalated.stderr);
    assert.match(escalated.stdout, /Needs research:/);
    assert.match(escalated.stdout, /Stopped without a report/);
    assert.match(escalated.stdout, /1 model step\./);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('custom labeled cases run through the CLI without leaking gold labels and wrong decisions fail', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'research-custom-cases-'));
  try {
    const cases = [
      { id: 'private-gold-positive', question: 'Can guests edit?', text: 'Guests edited a page during the trial.', keep: true, reason: 'DO_NOT_LEAK_LABEL: observed editing.' },
      { id: 'private-gold-negative', question: 'Can guests edit?', text: 'The cafeteria is open.', keep: false, reason: 'DO_NOT_LEAK_LABEL: unrelated subject.' },
    ];
    const path = join(temp, 'cases.json');
    await writeFile(path, JSON.stringify(cases));
    assert.deepEqual(await loadEvidenceCases(path), cases);
    const config = join(temp, 'decision.mjs');
    await writeFile(config, `import assert from 'node:assert/strict';
export default {runJudge: async params => {
 assert.deepEqual(Object.keys(params.state).sort(),['items','subquestion']);
 assert.deepEqual(Object.keys(params.state.items[0].item).sort(),['id','text']);
 assert.equal(params.state.items[0].item.id,'candidate');
 assert.equal(/private-gold|DO_NOT_LEAK_LABEL/.test(JSON.stringify(params)),false);
 return {answers:Object.fromEntries(Object.keys(params.questions).map(id=>[id,{type:'noul',noul:0.95}]))};
}};`);
    const out = join(temp, 'report.json');
    const run = args => spawnSync(process.execPath, args, { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30_000 });
    const evaluated = run(['examples/research-eval.mjs', '--live', '--cases', path, '--config', config, '--out', out]);
    assert.equal(evaluated.status, 2, evaluated.stderr);
    const report = JSON.parse(evaluated.stdout);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), report);
    assert.equal(report.dataset, 'custom-research-evidence');
    assert.equal(report.datasetSha256, createHash('sha256').update(JSON.stringify(cases)).digest('hex'));
    assert.equal(report.total, 2);
    assert.equal(report.failed, 1);
    assert.equal(report.limitations.some(text => /six fictional/i.test(text)), false);
    const summary = run(['examples/research-eval.mjs', '--live', '--cases', path, '--config', config, '--summary']);
    assert.equal(summary.status, 2);
    assert.match(summary.stdout, /2 custom cases/);
    assert.match(summary.stdout, /1\/2 cases passed/);
    const changed = await evaluateEvidence({ cases: cases.map(row => ({ ...row, keep: !row.keep })),
      runJudge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.95 }])) }), mode: 'live' });
    assert.notEqual(changed.datasetSha256, report.datasetSha256);
    assert.deepEqual(changed.decisions.map(row => row.selected), report.decisions.map(row => row.selected));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('custom case validation bounds records and fields without repeating input contents', async () => {
  const good = { id: 'case-1', question: 'Can guests edit?', text: 'A guest edited a page.', keep: true, reason: 'Observed edit.' };
  const invalid = [null, [], Array.from({ length: 101 }, (_, i) => ({ ...good, id: `case-${i}` })), [good, good],
    [{ ...good, keep: 'secret-invalid-value' }], [{ ...good, extra: 'secret-invalid-value' }],
    [{ ...good, id: '\u001bsecret-invalid-value' }], [{ ...good, question: ' ' }],
    [{ ...good, text: 'x'.repeat(24 * 1024 + 1) }], [{ ...good, reason: 'x'.repeat(4097) }],
    [{ ...good, question: 'x'.repeat(4097) }]];
  for (const value of invalid) assert.throws(() => validateEvidenceCases(value), error => error.code === 'cases' && !error.message.includes('secret-invalid-value'));
  const temp = await mkdtemp(join(tmpdir(), 'research-invalid-cases-'));
  try {
    const path = join(temp, 'cases.json');
    await writeFile(path, '{secret-invalid-value');
    await assert.rejects(loadEvidenceCases(path), error => error.code === 'cases' && !error.message.includes('secret-invalid-value'));
    await writeFile(path, ' '.repeat(1024 * 1024 + 1));
    await assert.rejects(loadEvidenceCases(path), /at most 1 MiB/);
    await assert.rejects(loadEvidenceCases(temp), /regular JSON file/);
    await writeFile(path, JSON.stringify([good]));
    const controller = new AbortController();
    controller.abort(new Error('stop reading cases'));
    await assert.rejects(loadEvidenceCases(path, controller.signal), /stop reading cases/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('sparse programmatic cases fail admission before any decision call', async () => {
  const cases = new Array(2);
  cases[0] = { id: 'valid-first', question: 'Can guests edit?', text: 'A guest edited a page.', keep: true, reason: 'Observed edit.' };
  let calls = 0;
  await assert.rejects(evaluateEvidence({ cases, runJudge: async () => { calls++; throw new Error('must not call'); } }),
    error => error.code === 'cases' && /Case 2: use exactly/.test(error.message));
  assert.equal(calls, 0);
});

test('custom cases require live evaluation and invalid datasets fail before adapter loading', async () => {
  assert.throws(() => parseOptions(['--cases', 'cases.json']), /requires --live/);
  assert.throws(() => parseOptions(['--live', '--cases', 'a.json', '--cases', 'b.json']), /Use/);
  assert.equal(parseOptions(['--cases', 'cases.json', '--live']).cases, 'cases.json');
  const temp = await mkdtemp(join(tmpdir(), 'research-case-admission-'));
  try {
    const path = join(temp, 'invalid.json');
    await writeFile(path, '[]');
    const run = args => spawnSync(process.execPath, args, { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30_000 });
    const invalid = run(['examples/research-eval.mjs', '--live', '--cases', path, '--config', join(temp, 'missing.mjs')]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /cases: Cases must be a JSON array/);
    const unsupported = run(['examples/research-live.mjs', '--live', '--cases', path, '--config', join(temp, 'missing.mjs')]);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /only supported by the research evaluator/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
