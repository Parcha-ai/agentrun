#!/usr/bin/env node
// The learn-classify loop: one company per run, in order. Each run starts at the agent repository's main, the host
// proposes what it noted and saved, curate merges it (with this example's two gates), and the next run starts at the new
// main. One JSON row per run goes to <out>/runs.jsonl. A stopped pass resumes where it stopped.
//   node examples/learn-classify/runner.mjs [--out <dir>] --scripted [--data <dir>] [--jobs <n>]
//   node examples/learn-classify/runner.mjs [--out <dir>] --live --cap-usd <usd> [--jobs <n>] [--run-cap-usd <usd>]
//   node examples/learn-classify/runner.mjs [--out <dir>] (--scripted | --live --cap-usd <usd>) --sealed --at seed|main|<sha>
// --out defaults to examples/learn-classify/out.
import { local, openRepo } from '@parcha/pi-git-remote';
import { AGENT_STORE_FILE, carryBack, createAgentHome, openAgentHome, runPaths } from '@parcha/pi-durable-agent';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { writeCurve } from './curve.mjs';
import {
  AGENT_DIR, agentHomeFor, curateJob, finishJob, groupsOf, jobInput, meteredJudge, prepareRun, readAgentAt, runJob, usageOfStore,
} from './host.mjs';
import { writeRecording } from './recording.mjs';
import { rowOf, spendOf } from './row.mjs';
import { agentScript, FIXTURES, fixtureWeb, scriptedJev, scriptedModel } from './scripted.mjs';
import { domainOf, fetchPageTool } from './tools.mjs';

export const DATA = join(import.meta.dirname, 'data');
/** Where a pass writes when no --out is given, as the demo's contract names it. */
export const OUT = join(import.meta.dirname, 'out');
const HOST = 'learn-classify';

const readJsonIf = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);
export const readRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const gitEnv = (home) => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: home });

async function agentFiles() {
  const files = {
    'agent.json': await readFile(join(AGENT_DIR, 'agent.json'), 'utf8'),
    'AGENTS.md': await readFile(join(AGENT_DIR, 'AGENTS.md'), 'utf8'),
  };
  for (const name of await readdir(join(AGENT_DIR, 'skills'))) files[`.agents/skills/${name}/SKILL.md`] = await readFile(join(AGENT_DIR, 'skills', name, 'SKILL.md'), 'utf8');
  return files;
}

/** The pass's directory: the agent's bare repository (its remote), the host's clone, and `meta.json` with the seed commit,
 *  the agent as it starts, with nothing learned. A directory serves one mode. */
export async function openOut(out, { mode }) {
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
      const seed = await repo.commitTo('main', { files: await agentFiles(), message: 'the agent: definition, rules and the classify skill' });
      await repo.push(seed.sha, 'main');
      seedSha = seed.sha;
    }
    meta = { seedSha, mode, created: new Date().toISOString() };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }
  if (meta.mode !== mode) throw new Error(`${out} holds a ${meta.mode} pass; a ${mode} pass needs its own --out`);
  return { repo, bare, meta };
}

/** The label set, the companies, and the filing conventions the truth set's build report names (cik to convention): the
 *  host never shows those to the agent; a row's company is marked when it is under one, to check what the notes learned. */
const loadData = (data) => ({
  labels: JSON.parse(readFileSync(join(data, 'sic2.json'), 'utf8')),
  companies: JSON.parse(readFileSync(join(data, 'companies.json'), 'utf8')),
  conventions: Object.fromEntries((readJsonIf(join(data, 'build-report.json'))?.conventions ?? []).flatMap((c) => c.companies.map((company) => [company.cik, c.convention]))),
});

/** The $0 parts: the scripted agent and Jev, and lane C1's fetch_page reading fixture pages instead of the web. A data
 *  directory without pages.json gets 404s. */
export function scriptedParts({ data = FIXTURES } = {}) {
  const { labels, companies, conventions } = loadData(data);
  const pages = readJsonIf(join(data, 'pages.json')) ?? {};
  const truthByName = Object.fromEntries(companies.map((c) => [c.name, c.sic2]));
  return {
    mode: 'scripted', providers: 'scripted', modelName: 'faux/scripted', labels, companies, conventions,
    judge: () => scriptedJev({ truthByName, groups: groupsOf(labels) }),
    fetchFor: (job) => fetchPageTool({ allowDomain: domainOf(job.website), fetch: fixtureWeb(pages) }),
    modelFor: (job, run) => scriptedModel({ root: agentScript({ job, offered: run.workflows.loaded.map((w) => w.name), truth: job.sic2, page: pages[job.website] }) }),
  };
}

/** The paid parts: the model and Jev through the gateway (models.mjs), and fetch_page on the job's domain and Wikipedia. */
export async function liveParts({ data = DATA, model = 'gpt-6-luna', thinking = 'medium', env = process.env } = {}) {
  const { gatewayJev, gatewayModel, gatewayOf } = await import('./models.mjs');
  const gateway = gatewayOf(env);
  const { labels, companies, conventions } = loadData(data);
  const jev = gatewayJev(gateway);
  return {
    mode: 'live', providers: 'real', modelName: `gateway/${model}`, labels, companies, conventions,
    judge: () => jev,
    fetchFor: (job) => fetchPageTool({ allowDomain: domainOf(job.website) }),
    modelFor: () => gatewayModel(gateway, { model, thinking }),
  };
}

const short = (sha) => (sha ? sha.slice(0, 7) : '-');
const usd = (n) => (n === null ? 'unknown' : `$${n.toFixed(4)}`);
export function lineOf(row, convention) {
  const how = row.byWorkflow ? `by ${row.workflowsUsed.find((u) => u.outcome === 'complete' && u.name)?.name ?? 'a draft workflow'}` : 'by hand';
  const curated = [
    ...row.curate.admitted.map((n) => `admitted ${n}`), ...row.curate.promoted.map((n) => `promoted ${n}`), ...row.curate.demoted.map((n) => `demoted ${n}`),
    ...row.curate.held.map((h) => `held ${h.workflow ?? h.id ?? `note ${h.candidate}`}`), ...row.curate.refused.map((h) => `refused ${h.workflow ?? h.id ?? `note ${h.candidate}`}`),
  ];
  return `run ${row.run} ${row.split === 'run' ? '' : `(${row.split}) `}${row.answer ?? 'no answer'} vs ${row.truth} ${row.correct ? 'correct' : 'wrong'}${convention ? ' (a filing convention)' : ''}, ${how}, ${usd(row.costUsd)} (Jev ${usd(row.judgeCostUsd)})`
    + `${row.workflowsSaved.length ? `, saved ${row.workflowsSaved.join(', ')}` : ''}${curated.length ? `; curate ${curated.join(', ')}` : ''}; main ${short(row.seedSha)} -> ${short(row.afterSha)}`;
}

/** What the pass has spent, as far as it is known, from every job's progress file: each finished job's known parts and
 *  each abandoned attempt's model spend. A part whose price is unknown counts nothing here; the row says null for it. */
function knownSpend(out) {
  const dir = join(out, 'progress');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJsonIf(join(dir, f)) ?? {})
    .reduce((sum, p) => sum + (p.knownUsd ?? 0) + (p.abandoned ?? []).reduce((s, a) => s + a.costUsd, 0), 0);
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
    const prepared = await prepareRun({ home, repo, host: HOST, runId, input: jobInput(job) });
    save({ ...p, phase: 'started', seedSha: prepared.sha, offered: prepared.workflows.loaded.map((w) => w.name), started: Date.now() });
    const runJudge = meteredJudge(judge);
    const measure = await runJob({ run: prepared, job, model: parts.modelFor(job, prepared), judge: runJudge, fetchPage: parts.fetchFor(job), labels: parts.labels, limitUsd: runCapUsd });
    save({ ...p, phase: 'ran', measure, ended: Date.now() });
    if (measure.stopped) log(`  ${runId} stopped: ${measure.stopped}`);
  }
  const run = { runId, ...runPaths(home, runId) };
  if (p.phase === 'ran') save({ ...p, phase: 'proposed', finished: await finishJob({ home, repo, run, job, measure: p.measure }) });
  if (p.phase === 'proposed') {
    const curateJudge = meteredJudge(judge);
    const curated = await curateJob({ repo, judge: curateJudge });
    save({ ...p, phase: 'curated', curated, curateJudge: { ...curateJudge.meter }, afterSha: curated.report.main });
  }
  const spend = spendOf(p.measure, p.curateJudge);
  save({ ...p, knownUsd: spend.knownUsd });
  const recording = record
    ? await writeRecording({ into: join(out, 'recordings'), run, job, model: parts.modelName, providers: parts.providers, started: p.started, ended: p.ended, spend, modelUsd: p.measure.unpricedAnswers ? null : p.measure.usage.costUsd })
    : null;
  return rowOf({ run: job.order, runId, job, seedSha: p.seedSha, afterSha: p.afterSha, offered: p.offered, measure: p.measure, finished: p.finished, curated: p.curated, curateJudge: p.curateJudge, recording });
}

/** The learning pass: the first `jobs` companies of split "run", in order, until the spend reaches `capUsd`. */
export async function runLoop({ out, parts, jobs, capUsd, runCapUsd, record = true, log = () => {} }) {
  out = resolve(out);
  const { repo, meta } = await openOut(out, { mode: parts.mode });
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
  for (const job of queue) {
    if (done.has(job.order)) continue;
    if (capUsd !== undefined && spentNow() >= capUsd) { stoppedBy = `spent ${usd(spentNow())}, at or over the cap of ${usd(capUsd)}`; break; }
    const row = await oneJob({ out, repo, home, parts, judge, job, runCapUsd, record, log });
    appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
    rows.push(row);
    log(lineOf(row, parts.conventions?.[job.cik]));
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
  const { repo, meta } = await openOut(out, { mode: parts.mode });
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
  let spent = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  let stoppedBy = null;
  log(`learn-classify: sealed pass at ${label}${sha === meta.seedSha ? ' (the seed: nothing learned)' : ''}, ${queue.length} companies`);
  for (const [i, job] of queue.entries()) {
    if (done.has(job.cik)) continue;
    if (capUsd !== undefined && spent >= capUsd) { stoppedBy = `spent ${usd(spent)}, at or over the cap of ${usd(capUsd)}`; break; }
    let attempt = 1;
    const idOf = (n) => `sealed-${job.cik}${n === 1 ? '' : `-a${n}`}`;
    while (existsSync(runPaths(home, idOf(attempt)).dir)) {
      await carryBack(home, { runId: idOf(attempt) }, { outcome: 'abandoned' }).catch(() => {});
      attempt += 1;
    }
    const prepared = await prepareRun({ home, repo, host: HOST, runId: idOf(attempt), input: jobInput(job), ref: sha });
    const started = Date.now();
    const runJudge = meteredJudge(judge);
    const measure = await runJob({ run: prepared, job, model: parts.modelFor(job, prepared), judge: runJudge, fetchPage: parts.fetchFor(job), labels: parts.labels, limitUsd: runCapUsd });
    const run = { runId: prepared.runId, ...runPaths(home, prepared.runId) };
    const finished = await finishJob({ home, repo, run, job, measure, propose: false });
    const recording = record
      ? await writeRecording({ into: join(out, 'sealed', label, 'recordings'), run, job, model: parts.modelName, providers: parts.providers, started, ended: Date.now(), spend: spendOf(measure), modelUsd: measure.unpricedAnswers ? null : measure.usage.costUsd })
      : null;
    const row = rowOf({ run: i + 1, runId: prepared.runId, job, seedSha: sha, afterSha: sha, offered: prepared.workflows.loaded.map((w) => w.name), measure, finished, curated: null, recording });
    spent += spendOf(measure).knownUsd;
    appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
    rows.push(row);
    log(lineOf(row, parts.conventions?.[job.cik]));
  }
  const correct = rows.filter((r) => r.correct).length;
  log(`sealed at ${label}: ${correct} of ${rows.length} correct${stoppedBy ? `; stopped: ${stoppedBy}` : ''}`);
  await writeCurve(out);
  return { rows, sha, label, correct, stoppedBy };
}

const USAGE = 'usage: node examples/learn-classify/runner.mjs [--out <dir>] (--scripted [--data <dir>] | --live --cap-usd <usd> [--model <id>] [--thinking <level>]) [--jobs <n>] [--run-cap-usd <usd>] [--no-record] [--sealed --at seed|main|<sha>]';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        out: { type: 'string' }, scripted: { type: 'boolean' }, live: { type: 'boolean' }, data: { type: 'string' }, jobs: { type: 'string' },
        'cap-usd': { type: 'string' }, 'run-cap-usd': { type: 'string' }, 'no-record': { type: 'boolean' }, sealed: { type: 'boolean' }, at: { type: 'string' },
        model: { type: 'string' }, thinking: { type: 'string' },
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
    const parts = values.live
      ? await liveParts({ ...(values.data ? { data: resolve(values.data) } : {}), ...(values.model ? { model: values.model } : {}), ...(values.thinking ? { thinking: values.thinking } : {}) })
      : scriptedParts(values.data ? { data: resolve(values.data) } : {});
    const common = { out: values.out ?? OUT, parts, capUsd: number('cap-usd'), runCapUsd: number('run-cap-usd'), log: (line) => console.log(line) };
    const result = values.sealed
      ? await runSealed({ ...common, at: values.at, record: !values['no-record'] })
      : await runLoop({ ...common, jobs: number('jobs'), record: !values['no-record'] });
    if (result.stoppedBy) process.exitCode = 3;
  } catch (error) {
    console.error(`learn-classify failed: ${error.stack ?? error}`);
    process.exit(1);
  }
}
