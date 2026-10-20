#!/usr/bin/env node
// The learn-classify loop: one company per run, in order. Each run starts at the agent repository's main, the host
// proposes what it noted and saved, curate merges it (with this example's two gates), and the next run starts at the new
// main. One JSON row per run goes to <out>/runs.jsonl. A stopped pass resumes where it stopped.
//   node examples/learn-classify/runner.mjs [--out <dir>] --scripted [--data <dir>] [--jobs <n>]
//   node examples/learn-classify/runner.mjs [--out <dir>] --live --cap-usd <usd> [--jobs <n>] [--run-cap-usd <usd>]
//   node examples/learn-classify/runner.mjs [--out <dir>] (--scripted | --live --cap-usd <usd>) --sealed --at seed|main|<sha>
// --set v2 runs the hard job (CLASSIFY-CONTRACT.md v2). --out defaults to examples/learn-classify/out.
import { local, openRepo } from '@parcha/pi-git-remote';
import { AGENT_STORE_FILE, carryBack, createAgentHome, openAgentHome, runPaths } from '@parcha/pi-durable-agent';
import { execFileSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { writeCurve } from './curve.mjs';
import {
  agentHomeFor, curateJob, finishJob, groupsOf, meteredJudge, prepareRun, readAgentAt, runJob, textsRead, toolResultsOf, toolStats, usageOfStore,
} from './host.mjs';
import { writeRecording } from './recording.mjs';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { jobRecordOf } from './job-record.mjs';
import { lineageOf } from './lineage.mjs';
import { curateOf, rowOf, rowOfV2, spendOf } from './row.mjs';
import { scoreV2 } from './score-v2.mjs';
import { agentScript, agentScriptV2, FIXTURES, FIXTURES_V2, fakeHardTools, fixtureWeb, scriptedJev, scriptedModel } from './scripted.mjs';
import { SETS } from './sets.mjs';
import { ANY_HOST, domainOf, fetchPageTool } from './tools.mjs';
import { promotedFor } from './dispatch.mjs';
import { passSelfTest } from './selftest.mjs';
import { writeHosts } from './tools-v2.mjs';

export const DATA = join(import.meta.dirname, 'data');
/** Where a pass writes when no --out is given, as the demo's contract names it. */
export const OUT = join(import.meta.dirname, 'out');
const HOST = 'learn-classify';

const readJsonIf = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);
export const readRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const gitEnv = (home) => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: home });

async function agentFiles(dir) {
  const files = {
    'agent.json': await readFile(join(dir, 'agent.json'), 'utf8'),
    'AGENTS.md': await readFile(join(dir, 'AGENTS.md'), 'utf8'),
  };
  for (const name of await readdir(join(dir, 'skills'))) files[`.agents/skills/${name}/SKILL.md`] = await readFile(join(dir, 'skills', name, 'SKILL.md'), 'utf8');
  return files;
}

/** The pass's directory: the agent's bare repository (its remote), the host's clone, and `meta.json` with the seed commit,
 *  the agent as it starts, with nothing learned. A directory serves one mode and one set. */
export async function openOut(out, { mode, set = SETS.v1 }) {
  await mkdir(out, { recursive: true });
  const bare = join(out, 'agent.git');
  if (!existsSync(bare)) execFileSync('git', ['init', '-q', '--bare', '--template=', '-b', 'main', bare], { env: gitEnv(out) });
  const repo = await openRepo({ dir: join(out, 'host-repo'), remote: local(bare) });
  const metaPath = join(out, 'meta.json');
  let meta = readJsonIf(metaPath);
  if (!meta) {
    await repo.fetch();
    let seedSha = await repo.resolve('main');
    if (!seedSha) {
      const seed = await repo.commitTo('main', { files: await agentFiles(set.agentDir), message: 'the agent: definition, rules and the classify skill' });
      await repo.push(seed.sha, 'main');
      seedSha = seed.sha;
    }
    meta = { seedSha, mode, set: set.name, created: new Date().toISOString() };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }
  if (meta.mode !== mode) throw new Error(`${out} holds a ${meta.mode} pass; a ${mode} pass needs its own --out`);
  if ((meta.set ?? 'v1') !== set.name) throw new Error(`${out} holds a ${meta.set ?? 'v1'} pass; a ${set.name} pass needs its own --out`);
  return { repo, bare, meta };
}

/** The filing conventions the truth set's build report names (cik to convention): the host never shows them to the
 *  agent; a row's company is marked when it is under one, to check what the notes learned. */
const conventionsOf = (report) => Object.fromEntries((report?.conventions ?? []).flatMap((c) => c.companies.map((company) => [company.cik, c.convention])));

/** Where fetch_page may go: in v1 the company's domain and Wikipedia; in v2 any public host but the refused list, so a
 *  workflow that has to find the official site reads it without the paid browser. */
const allowedDomain = (job, set) => (set === SETS.v2 ? ANY_HOST : domainOf(job.website));
/** The scripted pass's DNS: every fixture host is a public address, and nothing is looked up. */
const fixtureLookup = async () => [{ address: '93.184.216.34', family: 4 }];

/** The $0 parts: the scripted agent and Jev, lane C1's fetch_page reading fixture pages instead of the web, and in v2
 *  fakes of lane C3's tools over the fixtures. A data directory without pages.json gets 404s. */
export function scriptedParts({ set = SETS.v1, data = set === SETS.v2 ? FIXTURES_V2 : FIXTURES } = {}) {
  const d = set.load(data);
  const pages = readJsonIf(join(data, 'pages.json')) ?? {};
  const v2 = set === SETS.v2;
  const truthByName = Object.fromEntries(d.companies.map((c) => [c.name, v2 ? c.sic : c.sic2]));
  const fakes = v2 ? fakeHardTools({ pages, documents: readJsonIf(join(data, 'documents.json')) ?? {}, search: readJsonIf(join(data, 'search.json')) ?? {} }) : undefined;
  return {
    mode: 'scripted', providers: 'scripted', modelName: 'faux/scripted', set, data: d, labels: d.labels, companies: d.companies, conventions: conventionsOf(d.report),
    judge: () => scriptedJev({ truthByName, groups: groupsOf(v2 ? d.codes : d.labels), segments: v2 ? readJsonIf(join(data, 'judge.json')) ?? {} : {} }),
    toolsFor: async (job) => [fetchPageTool({ allowDomain: allowedDomain(job, set), fetch: fixtureWeb(pages), lookup: fixtureLookup }), ...(fakes ? fakes.tools() : [])],
    modelFor: (job, run) => scriptedModel(v2
      ? agentScriptV2({ job, offered: run.workflows.loaded.map((w) => w.name), fixtures: { truth: readJsonIf(join(data, 'answers.json')) ?? {} } })
      : { root: agentScript({ job, offered: run.workflows.loaded.map((w) => w.name), truth: job.sic2, page: pages[job.website] }) }),
  };
}

/** The paid parts: the model and Jev through the gateway (models.mjs), fetch_page, and in v2 lane C3's tools
 *  (tools-v2.mjs: search and the browser on Browserbase with the key read at each call, else a local Chrome; the eyes
 *  through the gateway), their evidence and the browser's profile under the run's own directory. */
export async function liveParts({ set = SETS.v1, data = DATA, model, thinking, env = process.env } = {}) {
  const { gatewayJev, gatewayModels, gatewayOf, ROOT } = await import('./models.mjs');
  const gateway = gatewayOf(env);
  // The root agent on Opus at high thinking unless --model / --thinking name another; the nodes on the host's NODE.
  const models = await gatewayModels(gateway, { root: { model: model ?? ROOT.model, thinking: thinking ?? ROOT.thinking } });
  const d = set.load(data);
  const jev = gatewayJev(gateway);
  let hard;
  if (set === SETS.v2) {
    try { hard = await import('./tools-v2.mjs'); } catch (error) { throw new Error(`--set v2 --live needs lane C3's tools-v2.mjs: ${error.message}`); }
  }
  return {
    mode: 'live', providers: 'real', modelName: `gateway/${models.agent.model.modelId}`, set, data: d, labels: d.labels, companies: d.companies, conventions: conventionsOf(d.report),
    judge: () => jev,
    toolsFor: async (job, run) => [
      fetchPageTool({ allowDomain: allowedDomain(job, set) }),
      ...(hard ? await hard.hardJobTools({ root: join(run.dir, 'evidence'), profileRoot: join(run.dir, 'chrome'), eyes: await hard.gatewayEyes(gateway), env }) : []),
    ],
    modelFor: () => models,
    // The browser's guard on the browser the pass will use, checked by the pass's self-test.
    ...(hard ? { browserCheck: (dir) => hard.guardSelfTest({ root: dir, profileRoot: join(dir, 'chrome'), env }) } : {}),
  };
}

/** Every live pass checks itself before its first job (selftest.mjs): no tool runs a command or code, a code node is
 *  refused, and its browser refuses a redirect to sec.gov. A failure stops the pass there. */
async function selfTest({ out, repo, parts, log }) {
  if (parts.mode === 'live') await passSelfTest({ out, repo, parts, log });
}

/** One run of the agent with the set's tools, answer and job text. */
async function runSet({ parts, repo, run, job, judge, limitUsd }) {
  const { set, data } = parts;
  const effects = [...(await parts.toolsFor(job, run)), ...set.labelTools(data)];
  const answer = set.answer(data);
  // A promoted workflow that answers the whole job runs first, by the host (dispatch.mjs), unless the pass says not to.
  const dispatch = parts.dispatch === false ? null : await promotedFor({ repo, run, answer, input: set.input(job) });
  return runJob({ run, job, model: await parts.modelFor(job, run), judge, effects, answer, text: set.text, limitUsd, dispatch });
}

/** A v2 run's score and tool facts, read from its closed store; the scoring's own Jev is metered apart from the run. */
async function scoreRun({ parts, run, job, measure, hostsDir }) {
  const { data } = parts;
  const results = toolResultsOf(run.storePath);
  await writeHosts({ dir: hostsDir, runId: run.runId, results });
  const judge = meteredJudge(parts.judge());
  const report = data.report?.companies?.find((c) => c.cik === job.cik);
  const score = await scoreV2({ answer: measure.answer, company: job, report, rules: data.report?.scoring ?? [], read: textsRead(results), codes: data.codes, judge: judge.run });
  return { score, stats: toolStats(results), scoringJudge: { ...judge.meter } };
}

const short = (sha) => (sha ? sha.slice(0, 7) : '-');
const usd = (n) => (n === null ? 'unknown' : `$${n.toFixed(4)}`);
export function lineOf(row, convention = row.convention) {
  if (row.set === 'v2') return lineOfV2(row);
  const how = row.byWorkflow ? `by ${row.workflowsUsed.find((u) => u.outcome === 'complete' && u.name)?.name ?? 'a draft workflow'}` : 'by hand';
  const curated = [
    ...row.curate.admitted.map((n) => `admitted ${n}`), ...row.curate.promoted.map((n) => `promoted ${n}`), ...row.curate.demoted.map((n) => `demoted ${n}`),
    ...row.curate.held.map((h) => `held ${h.workflow ?? h.id ?? `note ${h.candidate}`}`), ...row.curate.refused.map((h) => `refused ${h.workflow ?? h.id ?? `note ${h.candidate}`}`),
  ];
  return `run ${row.run} ${row.split === 'run' ? '' : `(${row.split}) `}${row.answer ?? 'no answer'} vs ${row.truth} ${row.correct ? 'correct' : 'wrong'}${convention ? ' (a filing convention)' : ''}, ${how}, ${usd(row.costUsd)} (Jev ${usd(row.judgeCostUsd)})`
    + `${row.workflowsSaved.length ? `, saved ${row.workflowsSaved.join(', ')}` : ''}${curated.length ? `; curate ${curated.join(', ')}` : ''}; main ${short(row.seedSha)} -> ${short(row.afterSha)}`;
}

function lineOfV2(row) {
  const how = row.byWorkflow ? `by ${row.workflowsUsed.find((u) => u.outcome === 'complete' && u.name)?.name ?? 'a draft workflow'}` : 'by hand';
  const segment = row.segmentCorrect === null ? 'segment not scored' : `segment ${row.segmentCorrect ? 'right' : 'wrong'}`;
  const cites = row.evidenceSupported === null ? 'no cites' : `cites ${Math.round(row.evidenceSupported * 100)}% supported`;
  return `run ${row.run} ${row.split === 'run' ? '' : `(${row.split}) `}${row.sic4Answer ?? 'no answer'} vs ${row.sic4Truth} ${row.sicCorrect4 ? 'right' : row.sicCorrect2 ? 'group right' : 'wrong'}, ${segment}, ${cites}, ${how}, ${usd(row.costUsd)} (Jev ${usd(row.judgeCostUsd)}, browser ${usd(row.browserCostUsd)})`
    + `${row.workflowsSaved.length ? `, saved ${row.workflowsSaved.join(', ')}` : ''}; main ${short(row.seedSha)} -> ${short(row.afterSha)}`;
}

/** What the pass has spent, as far as it is known, from every job's progress file: each finished job's known parts, the
 *  scorer's Jev, and each abandoned attempt's model spend. A part whose price is unknown counts nothing here; the row says null for it. */
function knownSpend(out) {
  const dir = join(out, 'progress');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJsonIf(join(dir, f)) ?? {})
    .reduce((sum, p) => sum + (p.knownUsd ?? 0) + (p.scoringJudge?.costUsd ?? 0) + (p.abandoned ?? []).reduce((s, a) => s + a.costUsd, 0), 0);
}

/**
 * One job, in phases kept in <out>/progress/<run>.json, so a stopped pass picks the job up where it stopped: a run that
 * never finished is abandoned (carried back, its spend kept) and the job starts again as the next attempt; a finished
 * run is proposed and curated (both are idempotent) and gets its row.
 */
async function oneJob({ out, repo, home, parts, judge, job, runCapUsd, record, log }) {
  const base = `run-${String(job.order).padStart(3, '0')}`;
  mkdirSync(join(out, 'progress'), { recursive: true });
  const progressPath = join(out, 'progress', `${base}.json`);
  let p = readJsonIf(progressPath) ?? { attempt: 1, phase: 'new', abandoned: [] };
  const save = (next) => { p = next; writeFileSync(progressPath, `${JSON.stringify(p, null, 2)}\n`); };
  const idOf = (attempt) => (attempt === 1 ? base : `${base}-a${attempt}`);
  if (p.phase === 'started') {
    const run = { runId: idOf(p.attempt), ...runPaths(home, idOf(p.attempt)) };
    const costUsd = existsSync(run.storePath) ? usageOfStore(run.storePath).costUsd : 0;
    await carryBack(home, run, { outcome: 'abandoned' }).catch(() => {});
    save({ ...p, attempt: p.attempt + 1, phase: 'new', abandoned: [...p.abandoned, { runId: run.runId, costUsd }] });
    log(`  ${run.runId} did not finish before the stop: abandoned (${usd(costUsd)} of model spend), starting ${idOf(p.attempt)}`);
  }
  const runId = idOf(p.attempt);
  if (p.phase === 'new') {
    const prepared = await prepareRun({ home, repo, host: HOST, runId, input: parts.set.input(job) });
    save({ ...p, phase: 'started', seedSha: prepared.sha, offered: prepared.workflows.loaded.map((w) => w.name), started: Date.now() });
    const runJudge = meteredJudge(judge);
    const measure = await runSet({ parts, repo, run: prepared, job, judge: runJudge, limitUsd: runCapUsd });
    save({ ...p, phase: 'ran', measure, ended: Date.now() });
    if (measure.stopped) log(`  ${runId} stopped: ${measure.stopped}`);
  }
  const run = { runId, ...runPaths(home, runId) };
  if (p.phase === 'ran') {
    const finished = await finishJob({ home, repo, run, job, measure: p.measure });
    save({ ...p, phase: 'proposed', finished, ...(parts.set === SETS.v2 ? await scoreRun({ parts, run, job, measure: p.measure, hostsDir: join(out, 'hosts') }) : {}) });
  }
  if (p.phase === 'proposed') {
    const curateJudge = meteredJudge(judge);
    const curated = await curateJob({ repo, judge: curateJudge });
    save({ ...p, phase: 'curated', curated, curateJudge: { ...curateJudge.meter }, afterSha: curated.report.main });
  }
  if (!p.lineage) {
    const admitted = curateOf(p.curated, runId, p.finished?.proposal?.withheld).admitted;
    save({ ...p, lineage: await lineageOf({ admitted, seedSha: p.seedSha, afterSha: p.afterSha, read: (path, sha) => repo.read(path, sha), list: (prefix, sha) => repo.list(prefix, sha) }) });
  }
  const tools = p.stats ? [p.stats.browserCostUsd, p.stats.searchCostUsd, p.stats.documentCostUsd] : [];
  const spend = spendOf(p.measure, p.curateJudge, tools);
  save({ ...p, knownUsd: spend.knownUsd });
  const recording = record
    ? await writeRecording({ into: join(out, 'recordings'), run, job, model: parts.modelName, providers: parts.providers, started: p.started, ended: p.ended, spend, modelUsd: p.measure.unpricedAnswers ? null : p.measure.usage.costUsd })
    : null;
  const v1 = { run: job.order, runId, job, seedSha: p.seedSha, afterSha: p.afterSha, offered: p.offered, measure: p.measure, finished: p.finished, curated: p.curated, curateJudge: p.curateJudge, recording, convention: parts.conventions?.[job.cik] };
  return parts.set === SETS.v2 ? rowOfV2({ ...v1, score: p.score, stats: p.stats, scoringJudge: p.scoringJudge, lineage: p.lineage, jobRecord: jobRecordOf(recordingLines(run.storePath).lines) }) : rowOf(v1);
}

/** The learning pass: the first `jobs` companies of split "run", in order, until the spend reaches `capUsd`. */
export async function runLoop({ out, parts, jobs, capUsd, runCapUsd, record = true, log = () => {} }) {
  out = resolve(out);
  const { repo, meta } = await openOut(out, { mode: parts.mode, set: parts.set });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const rowsPath = join(out, 'runs.jsonl');
  const rows = readRows(rowsPath);
  const done = new Set(rows.map((r) => r.run));
  const queue = parts.companies.filter((c) => c.split === 'run').sort((a, b) => a.order - b.order).slice(0, jobs ?? Infinity);
  const judge = parts.judge();
  const spentNow = () => knownSpend(out);
  writeFileSync(join(out, 'conventions.json'), `${JSON.stringify(parts.conventions ?? {}, null, 2)}\n`);
  let stoppedBy = null;
  log(`learn-classify: ${parts.mode} pass in ${out}, seed ${short(meta.seedSha)}, ${queue.length} job(s)${capUsd === undefined ? '' : `, cap ${usd(capUsd)}`}`);
  if (queue.some((job) => !done.has(job.order))) await selfTest({ out, repo, parts, log });
  for (const job of queue) {
    if (done.has(job.order)) continue;
    if (capUsd !== undefined && spentNow() >= capUsd) { stoppedBy = `spent ${usd(spentNow())}, at or over the cap of ${usd(capUsd)}`; break; }
    const row = await oneJob({ out, repo, home, parts, judge, job, runCapUsd, record, log });
    appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
    rows.push(row);
    log(lineOf(row));
  }
  await writeCurve(out);
  if (stoppedBy) log(`stopped: ${stoppedBy}`);
  return { rows, stoppedBy, spentUsd: spentNow(), seedSha: meta.seedSha };
}

async function homeAt(dir, repo, sha) {
  if (existsSync(join(dir, AGENT_STORE_FILE))) return openAgentHome(dir);
  const { definition, skills } = await readAgentAt(repo, sha);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return createAgentHome(dir, { definition, skills, sha });
}

/** The sealed companies at one commit of the agent repository, with no learning: nothing is proposed or curated. Its own
 *  agent home, kept at that commit. Rows go to <out>/sealed-<sha12>.jsonl. */
export async function runSealed({ out, parts, at = 'main', capUsd, runCapUsd, record = false, log = () => {} }) {
  out = resolve(out);
  const { repo, meta } = await openOut(out, { mode: parts.mode, set: parts.set });
  await repo.fetch();
  const sha = at === 'seed' ? meta.seedSha : await repo.resolve(at);
  if (!sha) throw new Error(`the agent repository has no ${at}`);
  const label = sha.slice(0, 12);
  const home = await homeAt(join(out, 'sealed', label, 'home'), repo, sha);
  const rowsPath = join(out, `sealed-${label}.jsonl`);
  const rows = readRows(rowsPath);
  const done = new Set(rows.map((r) => r.cik));
  const queue = parts.companies.filter((c) => c.split === 'sealed').sort((a, b) => a.cik.localeCompare(b.cik));
  const judge = parts.judge();
  let spent = rows.reduce((sum, r) => sum + (r.costUsd ?? 0) + (r.scoreCostUsd ?? 0), 0);
  let stoppedBy = null;
  log(`learn-classify: sealed pass at ${label}${sha === meta.seedSha ? ' (the seed: nothing learned)' : ''}, ${queue.length} companies`);
  if (queue.some((job) => !done.has(job.cik))) await selfTest({ out, repo, parts, log });
  for (const [i, job] of queue.entries()) {
    if (done.has(job.cik)) continue;
    if (capUsd !== undefined && spent >= capUsd) { stoppedBy = `spent ${usd(spent)}, at or over the cap of ${usd(capUsd)}`; break; }
    let attempt = 1;
    const idOf = (n) => `sealed-${job.cik}${n === 1 ? '' : `-a${n}`}`;
    while (existsSync(runPaths(home, idOf(attempt)).dir)) {
      await carryBack(home, { runId: idOf(attempt) }, { outcome: 'abandoned' }).catch(() => {});
      attempt += 1;
    }
    const prepared = await prepareRun({ home, repo, host: HOST, runId: idOf(attempt), input: parts.set.input(job), ref: sha });
    const started = Date.now();
    const runJudge = meteredJudge(judge);
    const measure = await runSet({ parts, repo, run: prepared, job, judge: runJudge, limitUsd: runCapUsd });
    const run = { runId: prepared.runId, ...runPaths(home, prepared.runId) };
    const finished = await finishJob({ home, repo, run, job, measure, propose: false });
    const scored = parts.set === SETS.v2 ? await scoreRun({ parts, run, job, measure, hostsDir: join(out, 'sealed', label, 'hosts') }) : undefined;
    const tools = scored ? [scored.stats.browserCostUsd, scored.stats.searchCostUsd, scored.stats.documentCostUsd] : [];
    const recording = record
      ? await writeRecording({ into: join(out, 'sealed', label, 'recordings'), run, job, model: parts.modelName, providers: parts.providers, started, ended: Date.now(), spend: spendOf(measure, undefined, tools), modelUsd: measure.unpricedAnswers ? null : measure.usage.costUsd })
      : null;
    const v1 = { run: i + 1, runId: prepared.runId, job, seedSha: sha, afterSha: sha, offered: prepared.workflows.loaded.map((w) => w.name), measure, finished, curated: null, recording, convention: parts.conventions?.[job.cik] };
    const phase = sha === meta.seedSha ? 'before' : 'after';
    const row = scored ? rowOfV2({ ...v1, score: scored.score, stats: scored.stats, scoringJudge: scored.scoringJudge, phase, jobRecord: jobRecordOf(recordingLines(run.storePath).lines) }) : { ...rowOf(v1), phase };
    spent += spendOf(measure, undefined, tools).knownUsd + (scored?.scoringJudge.costUsd ?? 0);
    appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
    rows.push(row);
    log(lineOf(row));
  }
  const correct = rows.filter((r) => r.correct).length;
  log(`sealed at ${label}: ${correct} of ${rows.length} correct${stoppedBy ? `; stopped: ${stoppedBy}` : ''}`);
  await writeCurve(out);
  return { rows, sha, label, correct, stoppedBy };
}

const USAGE = 'usage: node examples/learn-classify/runner.mjs [--out <dir>] [--set v1|v2] (--scripted [--data <dir>] | --live --cap-usd <usd> [--model <root model id>] [--thinking <root level>]) [--jobs <n>] [--run-cap-usd <usd>] [--no-record] [--no-dispatch] [--sealed --at seed|main|<sha>]';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        out: { type: 'string' }, scripted: { type: 'boolean' }, live: { type: 'boolean' }, data: { type: 'string' }, jobs: { type: 'string' },
        'cap-usd': { type: 'string' }, 'run-cap-usd': { type: 'string' }, 'no-record': { type: 'boolean' }, sealed: { type: 'boolean' }, at: { type: 'string' },
        'no-dispatch': { type: 'boolean' },
        model: { type: 'string' }, thinking: { type: 'string' }, set: { type: 'string' },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const number = (name) => {
    if (values[name] === undefined) return undefined;
    const n = Number(values[name]);
    if (!Number.isFinite(n) || n < 0) { console.error(`--${name} is not a non-negative number\n${USAGE}`); process.exit(2); }
    return n;
  };
  if (values.scripted === values.live || (values.live && values['cap-usd'] === undefined) || (values.sealed && !values.at)) {
    console.error(USAGE);
    process.exit(2);
  }
  if (values.thinking === 'off') { console.error('--thinking off is not allowed: every model call thinks'); process.exit(2); }
  try {
    const set = SETS[values.set ?? 'v1'];
    if (!set) { console.error(`--set is v1 or v2\n${USAGE}`); process.exit(2); }
    const parts = values.live
      ? await liveParts({ set, ...(values.data ? { data: resolve(values.data) } : {}), ...(values.model ? { model: values.model } : {}), ...(values.thinking ? { thinking: values.thinking } : {}) })
      : scriptedParts({ set, ...(values.data ? { data: resolve(values.data) } : {}) });
    if (values['no-dispatch']) parts.dispatch = false;
    const out = resolve(values.out ?? OUT);
    try {
      mkdirSync(out, { recursive: true });
      accessSync(out, constants.W_OK);
    } catch (error) {
      console.error(`--out ${out} is not writable (${error.code ?? error.message}); in a take only /run is: use --out /run/out`);
      process.exit(2);
    }
    const common = { out, parts, capUsd: number('cap-usd'), runCapUsd: number('run-cap-usd'), log: (line) => console.log(line) };
    const result = values.sealed
      ? await runSealed({ ...common, at: values.at, record: !values['no-record'] })
      : await runLoop({ ...common, jobs: number('jobs'), record: !values['no-record'] });
    if (result.stoppedBy) process.exitCode = 3;
  } catch (error) {
    console.error(`learn-classify failed: ${error.stack ?? error}`);
    process.exit(1);
  }
}
