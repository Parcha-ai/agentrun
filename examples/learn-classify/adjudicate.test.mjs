// The adjudication pass at $0: the host's codes tool refuses until stage 1 is recorded (driven directly, and through a
// scripted adjudicator); what a run is given carries no label of the teacher or of any arm; the MCC job's guards hold for
// the adjudicator's tools; and a scripted pass writes stage 1 and stage 2 for unblind, judges an ungrounded verdict once
// more, pins its inputs in meta.json, resumes, and refuses changed inputs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { candidateTable, unblind } from '../learn-mcc/adjudication.mjs';
import { groupOf, loadGroups } from '../learn-mcc/score-mcc.mjs';
import { adjudicationRun, jobTextAdjudicate, sampleJobs } from './adjudicate-job.mjs';
import { PROTOCOL, runAdjudication } from './eval-adjudicate.mjs';
import { openOut, scriptedParts } from './runner.mjs';
import { SETS } from './sets.mjs';
import { ADJUDICATOR_TOOLS, adjudicationSelfTest } from './selftest.mjs';
import { REFUSED_MCC_DOMAINS, refusedUrl } from './tools.mjs';

const GROUPS = loadGroups();
const SALT = 'fixture-order-salt-0123456789abcdefghijklmnop';
const MARKER = 'TEACHER-ONLY-MARKER';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-classify-adjudicate-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Four invented merchants: one plainly judged, one whose scripted adjudicator asks for the codes before stage 1 and tries a
// site that lists merchants' codes, one whose quote is not on its page, and one whose site does not load.
const MERCHANTS = [
  { merchantId: 'adj-001', name: 'Brightleaf Tea House', website: 'https://brightleaf-tea.example/', teacherMcc: '5499', hand: '5499', learn: '5999' },
  { merchantId: 'adj-002', name: 'Northgate Vapor Supply', website: 'https://northgate-vapor.example/', teacherMcc: '5993', hand: '5999', learn: '5993' },
  { merchantId: 'adj-003', name: 'Quiet Harbor Prints', website: 'https://quietharbor-prints.example/', teacherMcc: '5970', hand: '5970', learn: '7333' },
  { merchantId: 'adj-004', name: 'Paperlane Studio', website: 'https://paperlane-studio.example/', teacherMcc: '5943', hand: '5943', learn: '5943' },
];
const PAGES = {
  'https://brightleaf-tea.example/': { title: 'Brightleaf Tea House', text: 'Brightleaf Tea House. We blend and sell loose leaf teas online, shipped within two days. Returns are accepted within 30 days; see our refund policy and terms of service.' },
  'https://northgate-vapor.example/': { title: 'Northgate Vapor Supply', text: 'Northgate Vapor Supply. We sell e-cigarettes, vape kits and e-liquids to adults over 21. See our terms and refund policy.' },
  'https://quietharbor-prints.example/': { title: 'Quiet Harbor Prints', text: 'Quiet Harbor Prints. Framed art prints of harbor scenes, made to order and shipped in three weeks. Terms and refunds below.' },
};
const VERDICTS = {
  'Brightleaf Tea House': { own: '5499', group: '5000-5599', tiers: ['low'], quote: 'We blend and sell loose leaf teas online', accept: ['5499'] },
  'Northgate Vapor Supply': { own: '5993', tiers: ['high'], quote: 'We sell e-cigarettes, vape kits and e-liquids', accept: ['5993'], codesFirst: true, refusedRead: 'https://awardwallet.com/merchants/NORTHGATE_1' },
  'Quiet Harbor Prints': { own: '5970', tiers: ['medium'], quote: 'Oil-painted harbor canvases by local artists', accept: ['5970'] },
  'Paperlane Studio': { unjudgeable: 'the site does not load' },
};

/** A pass's inputs in a scratch directory: the data (pages, the refused sites, the scripted verdicts), the sealed sample
 *  with its teacher blocks, its commitments, the order salt, and the candidates over two arms. */
function inputs(dir) {
  const data = join(dir, 'data');
  const sample = MERCHANTS.map((m, i) => ({
    merchantId: m.merchantId, id: m.merchantId, name: m.name, website: m.website, order: i + 1, stratum: `${MARKER}-stratum`, vertical: `${MARKER}-vertical`,
    teacher: { mcc: m.teacherMcc, riskTier: null, description: `${MARKER} description`, rationale: `${MARKER} rationale`, flagsText: `${MARKER} flags`, evidenceUrls: [`https://${MARKER.toLowerCase()}.example/`], confidence: 0.9 },
  }));
  const arms = [{ name: 'hand', rows: MERCHANTS.map((m) => ({ merchantId: m.merchantId, mccAnswer: m.hand, riskAnswer: 'low' })) }, { name: 'learn', rows: MERCHANTS.map((m) => ({ merchantId: m.merchantId, mccAnswer: m.learn, riskAnswer: 'medium' })) }];
  const files = { sample: join(dir, 'sample.json'), candidates: join(dir, 'candidates.json'), commitments: join(dir, 'commitments.json'), orderSalt: join(dir, 'order-salt') };
  return { data, sample, arms, files };
}

async function writeInputs(dir) {
  const given = inputs(dir);
  await mkdir(given.data, { recursive: true });
  writeFileSync(join(given.data, 'pages.json'), JSON.stringify(PAGES));
  writeFileSync(join(given.data, 'refused-hosts.json'), JSON.stringify({ hosts: ['awardwallet.com'] }));
  writeFileSync(join(given.data, 'adjudicate.json'), JSON.stringify(VERDICTS));
  writeFileSync(given.files.sample, JSON.stringify(given.sample));
  writeFileSync(given.files.commitments, JSON.stringify({ count: given.sample.length, split: 'adjudication', fields: [], commitments: given.sample.map((m) => ({ order: m.order, sha256: sha256(m.merchantId) })) }));
  writeFileSync(given.files.orderSalt, `${SALT}\n`);
  writeFileSync(given.files.candidates, JSON.stringify(candidateTable({ sample: given.sample, arms: given.arms, salt: SALT, groups: GROUPS }).candidates));
  return given;
}

test('codes refuses until stage 1 is recorded: the host tool driven directly, each run with its own stage', async () => {
  const candidates = [{ code: '5999', title: GROUPS.codes['5999'] }, { code: '5499', title: GROUPS.codes['5499'] }];
  const first = adjudicationRun({ candidates, groups: GROUPS });
  const site = first.tools.find((t) => t.name === 'site');
  const codes = first.tools.find((t) => t.name === 'codes');
  assert.deepEqual(first.tools.map((t) => t.name), ['site', 'codes']);
  assert.match((await codes.run({})).refused, /Record stage 1 with site first/);
  assert.deepEqual(first.answer.problems({ codes: [] }), ['record stage 1 with site first'], 'no verdict before stage 1');
  const evidence = [{ url: 'https://brightleaf-tea.example/', quote: 'We blend and sell loose leaf teas online' }];
  assert.match((await site.run({ own: { mcc: '0000', evidence }, risk: { tiers: ['low'], evidence } })).refused, /own\.mcc must be a code from mcc_codes/);
  assert.ok((await codes.run({})).refused, 'a refused stage 1 records nothing');
  assert.match((await site.run({ own: { mcc: '5499', evidence }, risk: { tiers: ['low', 'high'], evidence } })).refused, /one tier, or two next to each other/);
  assert.deepEqual(await site.run({ own: { mcc: '5499', evidence }, risk: { tiers: ['low'], evidence } }), { recorded: true, next: 'Call codes for the candidate codes.' });
  assert.deepEqual(await codes.run({}), { candidates });
  assert.match((await site.run({ own: { mcc: '5999', evidence }, risk: { tiers: ['low'], evidence } })).refused, /already recorded/, 'stage 1 is recorded once');
  // Another merchant's run starts with nothing recorded: the stage is the run's own.
  const second = adjudicationRun({ candidates, groups: GROUPS });
  assert.match((await second.tools.find((t) => t.name === 'codes').run({})).refused, /Record stage 1 with site first/);
  assert.deepEqual(first.answer.problems({ codes: [{ code: '5999', acceptable: false, evidence }] }), ['5499 is not judged']);
  assert.deepEqual(first.record({ codes: candidates.map((c) => ({ code: c.code, acceptable: c.code === '5499', evidence })) }).stage2.codes['5499'], { acceptable: true, evidence });
});

test('what a run is given carries no label: the job is the name and the website, a candidate is a code and its title', async (t) => {
  const dir = await scratch(t);
  const given = await writeInputs(dir);
  const jobs = sampleJobs(given.sample);
  for (const job of jobs) {
    assert.deepEqual(Object.keys(job).sort(), ['cik', 'merchantId', 'name', 'order', 'website']);
    assert.deepEqual(SETS.adjudicate.input(job), { name: job.name, website: job.website });
    assert.doesNotMatch(jobTextAdjudicate(job), new RegExp(MARKER));
  }
  const candidates = JSON.parse(readFileSync(given.files.candidates, 'utf8'));
  for (const list of Object.values(candidates)) for (const c of list) assert.deepEqual(Object.keys(c).sort(), ['code', 'title']);
  assert.ok(!JSON.stringify(candidates).match(/hand|learn|teacher|learner/i), 'no candidate says whose it is');
  // A whole scripted pass: no run's recording holds anything of the teacher's block, its stratum or an arm's name.
  const out = join(dir, 'out');
  await runAdjudication({ out, parts: scriptedParts({ set: SETS.adjudicate, data: given.data }), passId: 'p0', files: given.files });
  const recordings = join(out, 'adjudication', 'p0', 'recordings');
  const text = readdirSync(recordings).map((run) => readFileSync(join(recordings, run, 'events.jsonl'), 'utf8')).join('\n');
  assert.ok(text.includes('Brightleaf Tea House'), 'the recordings are read');
  assert.doesNotMatch(text, new RegExp(`${MARKER}|"teacher"|learner|\\bhand\\b`, 'i'));
});

test('the guards hold for the adjudicator: refused sites stay refused, every code is offered, no learning tool', async (t) => {
  const dir = await scratch(t);
  const given = await writeInputs(dir);
  const parts = scriptedParts({ set: SETS.adjudicate, data: given.data });
  const [job] = sampleJobs(given.sample);
  const fetch = (await parts.toolsFor(job, { dir })).find((tool) => tool.name === 'fetch_page');
  for (const url of ['https://awardwallet.com/merchants/X', `https://www.${REFUSED_MCC_DOMAINS[0]}/merchant/1`, 'https://mcclookup.net/brightleaf', 'https://www.sec.gov/cgi-bin/browse-edgar']) {
    assert.ok((await fetch.run({ url })).refused, `${url} is refused`);
    assert.ok(refusedUrl(url), `${url} is refused by every reader's policy`);
  }
  assert.equal((await fetch.run({ url: job.website })).ok, true, 'the merchant\'s own site is read');
  // The adjudicator's own code may be a brand's: mcc_groups and mcc_codes serve the whole table.
  const [groups, codes] = SETS.adjudicate.labelTools(parts.data);
  assert.ok((await groups.run({})).groups.some((g) => g.code === '3000-3299'));
  const airlines = (await codes.run({ group: '3000-3299' })).codes;
  assert.ok(airlines.some((c) => c.code === '3000') && airlines.every((c) => groupOf(c.code, GROUPS) === 'airlines'));
  assert.ok((await codes.run({})).codes.length === Object.keys(GROUPS.codes).length);
  const agent = JSON.parse(readFileSync(join(SETS.adjudicate.agentDir, 'agent.json'), 'utf8'));
  assert.deepEqual(agent.tools.filter((name) => ['learn', 'agentrun'].includes(name)), [], 'the adjudicator does not learn or write workflows');
  // The scripted adjudicator that tried a code-listing site has that refusal counted on its manifest line.
  await runAdjudication({ out: join(dir, 'out'), parts, passId: 'p0', files: given.files });
  const lines = readFileSync(join(dir, 'out', 'adjudication', 'p0', 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.merchantId === 'adj-002').mccLookupRefused, 1);
  // Its runs have the host's tools alone: no learn extension, no <learned> section, no agentrun tool.
  const events = readFileSync(join(dir, 'out', 'adjudication', 'p0', lines[0].recording, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(events.find((e) => e.kind === 'pi.agent').data.value.extensions, ['learn-classify.tools']);
  assert.ok(!events.some((e) => e.kind === 'pi.system' && e.data.model.some((m) => m.sections?.learned)), 'no <learned> section');
  assert.ok(lines.filter((l) => l.merchantId !== 'adj-002').every((l) => l.mccLookupRefused === 0));
});

test('a scripted pass: stage 1 and 2 for unblind, an ungrounded verdict judged once more, inputs pinned, resumed, refused when they move', async (t) => {
  const dir = await scratch(t);
  const given = await writeInputs(dir);
  const out = join(dir, 'out');
  const parts = scriptedParts({ set: SETS.adjudicate, data: given.data });
  const result = await runAdjudication({ out, parts, passId: 'p1', files: given.files });
  assert.deepEqual(result.judged.sort(), ['adj-001', 'adj-002', 'adj-003', 'adj-004']);
  assert.equal(result.runCapUsd, 3, 'a run stops past the adjudicator home\'s max_cost_usd');
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.ungrounded, [{ merchantId: 'adj-003', ungrounded: ['own', 'risk', ...JSON.parse(readFileSync(given.files.candidates, 'utf8'))['adj-003'].map((c) => c.code)] }]);
  const pass = join(out, 'adjudication', 'p1');
  const manifest = readFileSync(join(pass, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const harbor = manifest.filter((l) => l.merchantId === 'adj-003');
  assert.equal(harbor.length, 2, 'judged once more');
  assert.equal(harbor[1].rerunOf, harbor[0].runId);
  assert.ok(manifest.every((l) => l.recording && typeof l.costUsd === 'number'), 'every attempt is recorded and costed');
  assert.deepEqual(manifest.filter((l) => l.merchantId !== 'adj-003').map((l) => l.grounded), [true, true, null], 'grounded, grounded, unjudgeable');
  // The codes the agent asked for before stage 1 were refused, and given after it.
  const vapor = readFileSync(join(pass, 'recordings', manifest.find((l) => l.merchantId === 'adj-002').recording.split('/')[1], 'events.jsonl'), 'utf8');
  assert.ok(vapor.indexOf('Record stage 1 with site first') >= 0 && vapor.indexOf('Record stage 1 with site first') < vapor.indexOf('"candidates":[{'));
  const stage1 = JSON.parse(readFileSync(join(pass, 'stage1.json'), 'utf8'));
  const stage2 = JSON.parse(readFileSync(join(pass, 'stage2.json'), 'utf8'));
  assert.deepEqual(stage1['adj-001'].risk.tiers, ['low']);
  assert.equal(stage1['adj-001'].own.mcc, '5499');
  assert.deepEqual(stage1['adj-004'], { unjudgeable: 'the site does not load' });
  assert.deepEqual(Object.keys(stage2['adj-001'].codes).sort(), ['5499', '5999']);
  // unblind reads the pass's files as they are, for each arm.
  const items = (arm) => given.sample.map((merchant) => ({ merchant, answer: { mcc: arm.rows.find((r) => r.merchantId === merchant.merchantId).mccAnswer, riskTier: arm.rows[0].riskAnswer } }));
  const learn = unblind({ items: items(given.arms[1]), stage1, stage2 });
  assert.equal(learn.unjudgeable.length, 1);
  assert.deepEqual(learn.learner.find((r) => r.merchantId === 'adj-001').mccAdjRight, false);
  assert.deepEqual(learn.learner.find((r) => r.merchantId === 'adj-002').mccAdjRight, true);
  // meta.json pins the inputs by sha256, the commitments and the order salt among them.
  const meta = JSON.parse(readFileSync(join(pass, 'meta.json'), 'utf8'));
  assert.equal(meta.pins.commitments.sha256, sha256(readFileSync(given.files.commitments)));
  assert.equal(meta.pins.orderSalt.sha256, sha256(readFileSync(given.files.orderSalt)));
  assert.equal(meta.pins.candidates.sha256, sha256(readFileSync(given.files.candidates)));
  assert.equal(meta.pins.protocol.sha256, sha256(readFileSync(PROTOCOL)), 'the protocol, learn-mcc\'s ADJUDICATION.md');
  // Resumed: nothing is judged again.
  const again = await runAdjudication({ out, parts, passId: 'p1', files: given.files });
  assert.deepEqual(again.judged, []);
  // A changed input is a new pass: the same pass id refuses it.
  writeFileSync(given.files.orderSalt, `${SALT}-moved\n`);
  await assert.rejects(runAdjudication({ out, parts, passId: 'p1', files: given.files }), /pinned with other inputs \(orderSalt\)/);
  // So is a changed protocol (learn-mcc's ADJUDICATION.md, pinned by default).
  writeFileSync(given.files.orderSalt, `${SALT}\n`);
  const protocol = join(dir, 'ADJUDICATION.md');
  writeFileSync(protocol, `${readFileSync(PROTOCOL, 'utf8')}\nA changed rule.\n`);
  await assert.rejects(runAdjudication({ out, parts, passId: 'p1', files: { ...given.files, protocol } }), /pinned with other inputs \(protocol\)/);
  assert.deepEqual((await runAdjudication({ out, parts, passId: 'p1', files: given.files })).judged, [], 'the pinned protocol resumes');
  // Commitments that do not cover the sample stop the pass before any run.
  writeFileSync(given.files.commitments, JSON.stringify({ count: 1, commitments: [{ order: 1, sha256: 'x' }] }));
  await assert.rejects(runAdjudication({ out, parts, passId: 'p2', files: given.files }), /one commitment per sample row/);
});

test('a live adjudication pass runs its self-test first: the root thinks, it is offered no learning tool, codes refuses before stage 1', async (t) => {
  const dir = await scratch(t);
  const given = await writeInputs(dir);
  const base = scriptedParts({ set: SETS.adjudicate, data: given.data });
  const browserCheck = async () => ({ browser: 'browserbase', refused: [], blocked: ['awardwallet.com'], costUsd: 0 });
  const parts = { ...base, mode: 'live', browserCheck, modelFor: async () => ({ agent: { model: { provider: 'faux', modelId: 'claude-opus-5-5' }, thinkingLevel: 'high' } }) };
  const [job] = sampleJobs(given.sample);
  const candidates = JSON.parse(readFileSync(given.files.candidates, 'utf8'))[job.merchantId];
  const adjudicator = () => adjudicationRun({ candidates, groups: GROUPS });
  const out = join(dir, 'out');
  const { repo } = await openOut(out, { mode: 'live', set: SETS.adjudicate });
  const report = await adjudicationSelfTest({ out, repo, parts, job, adjudicator: adjudicator() });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.tools.root, [...ADJUDICATOR_TOOLS].sort());
  assert.equal(report.browser.ok, true);
  assert.deepEqual(report.models, { root: { model: 'claude-opus-5-5', thinking: 'high' }, rootRequests: ['claude-opus-5-5 high'] });
  assert.match(report.codesBeforeStage1.refused, /Record stage 1 with site first/);
  // A tool that learns, a root that does not think, a browser without its check, a browser on the host: each stops the pass.
  const learn = { name: 'learn', description: 'Learn.', parameters: { type: 'object', properties: {} }, resultSchema: { type: 'object' }, run: async () => ({}) };
  for (const [bad, problem] of [
    [{ ...parts, toolsFor: async (j, r) => [...(await parts.toolsFor(j, r)), learn] }, /offered learn, not an adjudicator's tool/],
    [{ ...parts, modelFor: async () => ({ agent: { model: { provider: 'faux', modelId: 'claude-opus-5-5' }, thinkingLevel: 'off' } }) }, /the root model does not think/],
    [{ ...parts, browserCheck: undefined }, /the pass has a browser and no browser check/],
    [{ ...parts, browserCheck: async () => ({ ...(await browserCheck()), browser: 'chrome' }) }, /browser is chrome, not Browserbase/],
  ]) {
    const other = join(await scratch(t), 'out');
    const { repo: otherRepo } = await openOut(other, { mode: 'live', set: SETS.adjudicate });
    await assert.rejects(adjudicationSelfTest({ out: other, repo: otherRepo, parts: bad, job, adjudicator: adjudicator() }), problem);
  }
  // Through the pass: the self-test's report is written before the first verdict, and the runs follow.
  const pass = join(await scratch(t), 'out');
  const result = await runAdjudication({ out: pass, parts: { ...base, mode: 'live', browserCheck }, passId: 'p0', files: given.files, jobs: 1, runCapUsd: 1.5 });
  assert.equal(JSON.parse(readFileSync(join(pass, 'selftest.json'), 'utf8')).ok, true);
  assert.deepEqual([result.judged, result.runCapUsd], [['adj-001'], 1.5]);
});

test('the runner refuses the adjudicate set: it has its own pass', () => {
  const runner = join(import.meta.dirname, 'runner.mjs');
  const run = spawnSync(process.execPath, [runner, '--set', 'adjudicate', '--scripted', '--jobs', '1'], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /the adjudicate set runs with eval-adjudicate\.mjs/);
});
