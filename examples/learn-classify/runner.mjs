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
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CURATE_CUTS_V01 } from './curate-cuts.mjs';
import { writeCurve } from './curve.mjs';
import {
  agentHomeFor, curateJob, finishJob, groupsOf, meteredJudge, prepareRun, readAgentAt, runJob, textsRead, toolResultsOf, toolStats, usageOfStore,
} from './host.mjs';
import { writeRecording } from './recording.mjs';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { jobRecordOf } from './job-record.mjs';
import { diskProbe, durableCommits } from './disk.mjs';
import { limitsOf } from './limits.mjs';
import { lineageOf } from './lineage.mjs';
import { curateOf, rowOf, rowOfV2, rowOfV4, spendOf } from './row.mjs';
import { scoreV2 } from './score-v2.mjs';
import { scoreV4 } from './score-v4.mjs';
import { agentScript, agentScriptV2, agentScriptV4, FIXTURES, FIXTURES_V2, FIXTURES_V4, fakeHardTools, fixtureWeb, scriptedJev, scriptedModel } from './scripted.mjs';
import { isHard, SETS } from './sets.mjs';
import { ANY_HOST, domainOf, fetchPageTool } from './tools.mjs';
import { answersTheJob, hostRecord, promotedFor } from './dispatch.mjs';
import { asyncGate, GATE, gateSpend } from './promotion-gate.mjs';
import { passSelfTest } from './selftest.mjs';
import { writeHosts } from './tools-v2.mjs';

export const DATA = join(import.meta.dirname, 'data');
/** Where a pass writes when no --out is given, as the demo's contract names it. */
export const OUT = join(import.meta.dirname, 'out');
const HOST = 'learn-classify';

const readJsonIf = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);
export const readRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const gitEnv = (home) => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: home });

/** One at a time: the agent repository's clone and the agent home take one job's step at a time, while the jobs' runs go
 *  on side by side. */
function serial() {
  let last = Promise.resolve();
  return (step) => {
    const next = last.then(step, step);
    last = next.catch(() => {});
    return next;
  };
}
const inline = (step) => step();

/** The companies of one split. The test split is opened once per finalist, so a pass on it says so. */
export function splitOf(companies, split, { openTest = false } = {}) {
  if (split === 'test' && !openTest) throw new Error('the test split is opened once per finalist: pass --open-test');
  return companies.filter((c) => c.split === split);
}
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.cik.localeCompare(b.cik);
const withEpoch = (row, job) => (job.epoch === undefined ? row : { ...row, epoch: job.epoch });
/** What a run keeps once its row is made, with dropEvidence: its store (what rescoring and the recording read), not the
 *  documents its tools fetched nor the browser's profile, which are most of a run's disk. */
const dropRunFiles = (dir) => { for (const part of ['evidence', 'chrome']) rmSync(join(dir, part), { recursive: true, force: true }); };

/** A sealed pass on another pass's repository (`from`: its agent.git, or a bundle of it): main is fetched once into
 *  this pass's own repository, the seed is that history's first commit, and the other repository is only read. */
export function adoptFrom(out, from, { mode, set }) {
  const metaPath = join(out, 'meta.json');
  if (existsSync(metaPath)) return;
  mkdirSync(out, { recursive: true });
  const bare = join(out, 'agent.git');
  const env = gitEnv(out);
  if (!existsSync(bare)) execFileSync('git', ['init', '-q', '--bare', '--template=', '-b', 'main', bare], { env });
  execFileSync('git', ['--git-dir', bare, 'fetch', '-q', '--no-tags', from, '+refs/heads/main:refs/heads/main'], { env });
  const roots = execFileSync('git', ['--git-dir', bare, 'rev-list', '--max-parents=0', 'main'], { env, encoding: 'utf8' }).split('\n').filter(Boolean);
  if (roots.length !== 1) throw new Error(`${from}: main has ${roots.length} first commits, not one seed`);
  writeFileSync(metaPath, `${JSON.stringify({ seedSha: roots[0], mode, set: set.name, from, created: new Date().toISOString() }, null, 2)}\n`);
}

async function agentFiles(dir) {
  const files = {
    'agent.json': await readFile(join(dir, 'agent.json'), 'utf8'),
    'AGENTS.md': await readFile(join(dir, 'AGENTS.md'), 'utf8'),
  };
  for (const name of await readdir(join(dir, 'skills'))) files[`.agents/skills/${name}/SKILL.md`] = await readFile(join(dir, 'skills', name, 'SKILL.md'), 'utf8');
  return files;
}

/** The pass's directory: the agent's bare repository (its remote), the host's clone, and `meta.json` with the seed commit,
 *  the agent as it starts, with nothing learned, from `agentDir` (the set's agent home unless named). A directory serves
 *  one mode, one set and one agent home: a pass that names a home other than the one it was seeded from is refused. */
export async function openOut(out, { mode, set = SETS.v1, agentDir }) {
  await mkdir(out, { recursive: true });
  const bare = join(out, 'agent.git');
  if (!existsSync(bare)) execFileSync('git', ['init', '-q', '--bare', '--template=', '-b', 'main', bare], { env: gitEnv(out) });
  const repo = await openRepo({ dir: join(out, 'host-repo'), remote: local(bare) });
  const metaPath = join(out, 'meta.json');
  let meta = readJsonIf(metaPath);
  const agent = await agentFiles(agentDir ?? set.agentDir);
  const agentSha256 = createHash('sha256').update(JSON.stringify(Object.entries(agent).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex');
  if (!meta) {
    await repo.fetch();
    let seedSha = await repo.resolve('main');
    if (!seedSha) {
      const seed = await repo.commitTo('main', { files: agent, message: 'the agent: definition, rules and the classify skill' });
      await repo.push(seed.sha, 'main');
      seedSha = seed.sha;
    }
    meta = { seedSha, mode, set: set.name, agentSha256, created: new Date().toISOString() };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }
  if (agentDir !== undefined && meta.agentSha256 !== undefined && meta.agentSha256 !== agentSha256) throw new Error(`${out} was seeded from another agent home than ${agentDir}; that pass needs its own --out`);
  if (meta.mode !== mode) throw new Error(`${out} holds a ${meta.mode} pass; a ${mode} pass needs its own --out`);
  if ((meta.set ?? 'v1') !== set.name) throw new Error(`${out} holds a ${meta.set ?? 'v1'} pass; a ${set.name} pass needs its own --out`);
  return { repo, bare, meta };
}

/** The filing conventions the truth set's build report names (cik to convention): the host never shows them to the
 *  agent; a row's company is marked when it is under one, to check what the notes learned. */
const conventionsOf = (report) => Object.fromEntries((report?.conventions ?? []).flatMap((c) => c.companies.map((company) => [company.cik, c.convention])));

/** Where fetch_page may go: in v1 the company's domain and Wikipedia; in v2 any public host but the refused list, so a
 *  workflow that has to find the official site reads it without the paid browser. */
const allowedDomain = (job, set) => (isHard(set) ? ANY_HOST : domainOf(job.website));
/** The scripted pass's DNS: every fixture host is a public address, and nothing is looked up. */
const fixtureLookup = async () => [{ address: '93.184.216.34', family: 4 }];

/** The $0 parts: the scripted agent and Jev, lane C1's fetch_page reading fixture pages instead of the web, and in v2 and
 *  v4 fakes of lane C3's tools over the fixtures. A data directory without pages.json gets 404s. */
export function scriptedParts({ set = SETS.v1, data = set === SETS.v4 ? FIXTURES_V4 : set === SETS.v2 ? FIXTURES_V2 : FIXTURES } = {}) {
  const d = set.load(data);
  const pages = readJsonIf(join(data, 'pages.json')) ?? {};
  const hard = isHard(set);
  const truthByName = Object.fromEntries(d.companies.map((c) => [c.name, hard ? c.sic : c.sic2]));
  const fakes = hard ? fakeHardTools({ pages, documents: readJsonIf(join(data, 'documents.json')) ?? {}, search: readJsonIf(join(data, 'search.json')) ?? {} }) : undefined;
  const truth = readJsonIf(join(data, 'answers.json')) ?? {};
  return {
    mode: 'scripted', providers: 'scripted', modelName: 'faux/scripted', set, data: d, labels: d.labels, companies: d.companies, conventions: conventionsOf(d.report), fakeCalls: fakes?.calls,
    judge: () => scriptedJev({ truthByName, groups: groupsOf(hard ? d.codes : d.labels), segments: hard ? readJsonIf(join(data, 'judge.json')) ?? {} : {} }),
    toolsFor: async (job) => [fetchPageTool({ allowDomain: allowedDomain(job, set), fetch: fixtureWeb(pages), lookup: fixtureLookup }), ...(fakes ? fakes.tools() : [])],
    modelFor: (job, run) => {
      const offered = run.workflows.loaded.map((w) => w.name);
      if (set === SETS.v4) return scriptedModel(agentScriptV4({ job, offered, fixtures: { truth } }));
      if (set === SETS.v2) return scriptedModel(agentScriptV2({ job, offered, fixtures: { truth } }));
      return scriptedModel({ root: agentScript({ job, offered, truth: job.sic2, page: pages[job.website] }) });
    },
  };
}

/** The paid parts: the model and Jev through the gateway (models.mjs), fetch_page, and in v2 lane C3's tools
 *  (tools-v2.mjs: search and the browser on Browserbase with the key read at each call, else a local Chrome; the eyes
 *  through the gateway), their evidence and the browser's profile under the run's own directory. */
export async function liveParts({ set = SETS.v1, data = DATA, model, thinking, env = process.env, archivedSec = false, edgarCache, lookup } = {}) {
  const { gatewayJev, gatewayModels, gatewayOf, ROOT } = await import('./models.mjs');
  const gateway = gatewayOf(env);
  // The root agent on Opus at high thinking unless --model / --thinking name another; the nodes on the host's NODE.
  const models = await gatewayModels(gateway, { root: { model: model ?? ROOT.model, thinking: thinking ?? ROOT.thinking } });
  const d = set.load(data);
  const jev = gatewayJev(gateway);
  let hard;
  if (isHard(set)) {
    try { hard = await import('./tools-v2.mjs'); } catch (error) { throw new Error(`--set ${set.name} --live needs lane C3's tools-v2.mjs: ${error.message}`); }
  }
  if (edgarCache !== undefined) {
    if (!archivedSec) throw new Error('edgarCache needs archivedSec: the cache serves only the Wayback copies of SEC pages');
    if (!hard) throw new Error(`edgarCache needs a hard set, not ${set.name}`);
    // Made once here so a cache with no manifest stops the pass before its first job.
    hard.snapshotFetch({ dir: edgarCache });
  }
  return {
    mode: 'live', providers: 'real', modelName: `gateway/${models.agent.model.modelId}`, set, data: d, labels: d.labels, companies: d.companies, conventions: conventionsOf(d.report),
    // With archivedSec every tool also opens the Wayback Machine's copy of an SEC page (tools.mjs), and nothing else there.
    archivedSec,
    judge: () => jev,
    toolsFor: async (job, run) => {
      // One snapshot cache per run: it reads C1's manifest when made, so captures added mid-pass reach later runs.
      const fetch = edgarCache !== undefined ? hard.snapshotFetch({ dir: edgarCache }) : undefined;
      const seams = { ...(fetch ? { fetch } : {}), ...(lookup ? { lookup } : {}) };
      return [
        fetchPageTool({ allowDomain: allowedDomain(job, set), archivedSec, ...seams }),
        // A PDF over read_document's in-memory cap is kept under the system's temporary directory, outside the pass's out
        // dir, so it never reaches a recording, the agent's repository or a page; the run disposes of it when it ends.
        ...(hard ? await hard.hardJobTools({ root: join(run.dir, 'evidence'), profileRoot: join(run.dir, 'chrome'), eyes: await hard.gatewayEyes(gateway), env, largeRoot: tmpdir(), archivedSec, ...seams }) : []),
      ];
    },
    modelFor: () => models,
    // The browser's guard on the browser the pass will use, checked by the pass's self-test.
    ...(hard ? { browserCheck: (dir) => hard.guardSelfTest({ root: dir, profileRoot: join(dir, 'chrome'), env, archivedSec }) } : {}),
  };
}

/** Every live pass checks itself before its first job (selftest.mjs): no tool runs a command or code, a code node is
 *  refused, and its browser refuses a redirect to sec.gov. A failure stops the pass there. */
async function selfTest({ out, repo, parts, log }) {
  if (parts.mode === 'live') await passSelfTest({ out, repo, parts, log });
}

/** One run of the agent with the set's tools, answer and job text. `dispatch`, when given, is what the host runs first
 *  instead of what main has promoted; with `hostOnly` the host's run of it is the whole run (the promotion gate's). */
async function runSet({ parts, repo, run, job, judge, limitUsd, lock = inline, dispatch: given, hostOnly = false }) {
  const { set, data } = parts;
  const effects = [...(await parts.toolsFor(job, run)), ...set.labelTools(data)];
  try {
    const answer = set.answer(data);
    // A promoted workflow that answers the whole job runs first, by the host (dispatch.mjs), unless the pass says not to.
    const dispatch = given ?? (parts.dispatch === false ? null : await lock(() => promotedFor({ repo, run, answer, input: set.input(job) })));
    return await runJob({ run, job, model: await parts.modelFor(job, run), judge, effects, answer, text: set.text, limitUsd, dispatch, hostOnly });
  } finally {
    // What a tool kept for this run alone (read_document's large files) goes when the run ends.
    await Promise.all(effects.map((effect) => effect.dispose?.()));
  }
}

/** A v2 run's score and tool facts, read from its closed store; the scoring's own Jev is metered apart from the run. */
async function scoreRun({ parts, run, job, measure, hostsDir }) {
  const { data } = parts;
  const results = toolResultsOf(run.storePath);
  await writeHosts({ dir: hostsDir, runId: run.runId, results });
  const judge = meteredJudge(parts.judge());
  const report = data.report?.companies?.find((c) => c.cik === job.cik);
  const score = parts.set === SETS.v4
    ? await scoreV4({ answer: measure.answer, company: job, read: textsRead(results), codes: data.codes, judge: judge.run })
    : await scoreV2({ answer: measure.answer, company: job, report, rules: data.report?.scoring ?? [], read: textsRead(results), codes: data.codes, judge: judge.run });
  return { score, stats: toolStats(results), scoringJudge: { ...judge.meter } };
}

const short = (sha) => (sha ? sha.slice(0, 7) : '-');
const usd = (n) => (n === null ? 'unknown' : `$${n.toFixed(4)}`);
/** What curate held or refused, by name: a workflow, a note by its id or place in the run, or the run's uses (curate's
 *  hold on them names nothing else). */
const curatedName = (h) => h.workflow ?? h.id ?? (h.candidate !== undefined ? `note ${h.candidate}` : 'the run\'s uses');

export function lineOf(row, convention = row.convention) {
  if (row.set === 'v2') return lineOfV2(row);
  const how = row.byWorkflow ? `by ${row.workflowsUsed.find((u) => u.outcome === 'complete' && u.name)?.name ?? 'a draft workflow'}` : 'by hand';
  const curated = [
    ...row.curate.admitted.map((n) => `admitted ${n}`), ...row.curate.promoted.map((n) => `promoted ${n}`), ...row.curate.demoted.map((n) => `demoted ${n}`),
    ...row.curate.held.map((h) => `held ${curatedName(h)}`), ...row.curate.refused.map((h) => `refused ${curatedName(h)}`),
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
 *  scorer's Jev, each abandoned attempt's model spend and each attempt a model error ended. A part whose price is unknown
 *  counts nothing here; the row says null for it. */
function knownSpend(out) {
  const dir = join(out, 'progress');
  if (!existsSync(dir)) return 0;
  const attempts = (list) => (list ?? []).reduce((s, a) => s + a.costUsd, 0);
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJsonIf(join(dir, f)) ?? {})
    .reduce((sum, p) => sum + (p.knownUsd ?? 0) + (p.scoringJudge?.costUsd ?? 0) + attempts(p.abandoned) + attempts(p.infraFailed), 0)
    + gateSpend(join(out, 'gate'));
}

/** A run the provider's errors ended, past the harness's own retries: the first time, not the job's outcome. */
const modelError = (measure) => measure?.status === 'unanswered' && measure.reason === 'model_error';
const attemptUsd = (measure) => measure.usage.costUsd + measure.judge.costUsd + (measure.toolSpend?.costUsd ?? 0);

/** A job's progress file, <out>/progress/<run>.json, and the run ids of its attempts. */
function progressOf(out, job) {
  const base = `run-${String(job.order).padStart(3, '0')}`;
  mkdirSync(join(out, 'progress'), { recursive: true });
  const path = join(out, 'progress', `${base}.json`);
  const state = { p: readJsonIf(path) ?? { attempt: 1, phase: 'new', abandoned: [] } };
  const save = (next) => { state.p = next; writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`); };
  return { state, save, idOf: (attempt) => (attempt === 1 ? base : `${base}-a${attempt}`) };
}

/** A job's first half: a run that never finished is abandoned (carried back, its spend kept) and the job starts again as
 *  the next attempt; a new attempt is prepared from main and run. A run a model error ended is run again once, as the next
 *  attempt (carried back as abandoned, its spend kept, never proposed); a second one is the job's outcome. `lock` takes the
 *  steps on the home and the repository one at a time, so the jobs in flight run side by side; `tally.curated`, read with
 *  the prepare, is how many runs main had learned from when this one was prepared. */
async function startJob({ out, repo, home, parts, judge, job, runCapUsd, log, lock = inline, tally }) {
  const { state, save, idOf } = progressOf(out, job);
  let p = state.p;
  for (;;) {
    if (p.phase === 'started') {
      const run = { runId: idOf(p.attempt), ...runPaths(home, idOf(p.attempt)) };
      const costUsd = existsSync(run.storePath) ? usageOfStore(run.storePath).costUsd : 0;
      await lock(() => carryBack(home, run, { outcome: 'abandoned' }).catch(() => {}));
      save(p = { ...p, attempt: p.attempt + 1, phase: 'new', abandoned: [...p.abandoned, { runId: run.runId, costUsd }] });
      log(`  ${run.runId} did not finish before the stop: abandoned (${usd(costUsd)} of model spend), starting ${idOf(p.attempt)}`);
    }
    if (p.phase === 'new') {
      // A stop inside the last prepare left its run in the home with no progress saying so: abandoned as a started one is.
      while (existsSync(runPaths(home, idOf(p.attempt)).dir)) {
        const run = { runId: idOf(p.attempt), ...runPaths(home, idOf(p.attempt)) };
        const costUsd = existsSync(run.storePath) ? usageOfStore(run.storePath).costUsd : 0;
        await lock(() => carryBack(home, run, { outcome: 'abandoned' }).catch(() => {}));
        save(p = { ...p, attempt: p.attempt + 1, abandoned: [...p.abandoned, { runId: run.runId, costUsd }] });
        log(`  ${run.runId} was started before the stop but never recorded: abandoned, starting ${idOf(p.attempt)}`);
      }
      const runId = idOf(p.attempt);
      let curatedBefore;
      const prepared = await lock(async () => {
        const run = await prepareRun({ home, repo, host: HOST, runId, input: parts.set.input(job) });
        curatedBefore = tally?.curated;
        return run;
      });
      save(p = { ...p, phase: 'started', seedSha: prepared.sha, offered: prepared.workflows.loaded.map((w) => w.name), started: Date.now(), ...(curatedBefore === undefined ? {} : { curatedBefore }) });
      const runJudge = meteredJudge(judge);
      const measure = await runSet({ parts, repo, run: prepared, job, judge: runJudge, limitUsd: runCapUsd, lock });
      save(p = { ...p, phase: 'ran', measure, ended: Date.now() });
      if (measure.stopped) log(`  ${runId} stopped: ${measure.stopped}`);
    }
    if (p.phase === 'ran' && modelError(p.measure) && !p.infraFailed?.length) {
      const runId = idOf(p.attempt);
      await lock(() => carryBack(home, { runId, ...runPaths(home, runId) }, { outcome: 'abandoned' }).catch(() => {}));
      const { measure, ended, ...rest } = p;
      save(p = { ...rest, attempt: p.attempt + 1, phase: 'new', infraFailed: [{ runId, reason: measure.reason, costUsd: attemptUsd(measure) }] });
      log(`  ${runId} ended on a model error: running it again once, as ${idOf(p.attempt)}`);
      continue;
    }
    return;
  }
}

/** A job's second half, after startJob: a finished run is scored, proposed and curated (each idempotent) and gets its row.
 *  The score reads the run's own closed store, so it goes on beside the other jobs; proposing, curating and reading main
 *  take the repository one job at a time, so curate stays the single writer of main. `tally` numbers each curate in the
 *  order it ran and freezes main at the pass's checkpoints. */
async function endJob({ out, repo, home, parts, judge, job, record, dropEvidence = false, lock = inline, tally, gate }) {
  const { state, save: write, idOf } = progressOf(out, job);
  let p = state.p;
  const save = (next) => { p = next; write(next); };
  const runId = idOf(p.attempt);
  const run = { runId, ...runPaths(home, runId) };
  if (p.phase === 'ran' && isHard(parts.set) && p.scoringJudge === undefined) {
    save({ ...p, ...await scoreRun({ parts, run, job, measure: p.measure, hostsDir: join(out, 'hosts') }) });
  }
  await lock(async () => {
    if (p.phase === 'ran') save({ ...p, phase: 'proposed', finished: await finishJob({ home, repo, run, job, measure: p.measure }) });
    if (p.phase === 'proposed') {
      // The promotion gate's verdicts that landed since the last curate are applied first, so this curate starts from them.
      const gated = gate ? await gate.apply({ repo, thresholds: parts.thresholds }) : [];
      const curateJudge = meteredJudge(judge);
      const curated = await curateJob({
        repo, judge: curateJudge, ...(parts.thresholds ? { thresholds: parts.thresholds } : {}),
        ...(parts.judgeCuts ? { judgeCuts: parts.judgeCuts } : {}),
        ...(parts.sticky ? { sticky: { file: join(out, 'curate-sticky.json'), cutsId: parts.cutsId ?? 'default' } } : {}),
        ...(gate ? { gate } : {}),
      });
      save({ ...p, phase: 'curated', curated, curateJudge: { ...curateJudge.meter }, afterSha: curated.report.main, ...(gated.length ? { gated } : {}), ...(tally ? { curatedIndex: ++tally.curated, curatedAt: new Date().toISOString() } : {}) });
      tally?.landed(job, p);
    }
    if (!p.lineage) {
      const admitted = curateOf(p.curated, runId, p.finished?.proposal?.withheld).admitted;
      save({ ...p, lineage: await lineageOf({ admitted, seedSha: p.seedSha, afterSha: p.afterSha, read: (path, sha) => repo.read(path, sha), list: (prefix, sha) => repo.list(prefix, sha) }) });
    }
  });
  const tools = p.stats ? [p.stats.browserCostUsd, p.stats.searchCostUsd, p.stats.documentCostUsd] : [];
  const spend = spendOf(p.measure, p.curateJudge, tools);
  save({ ...p, knownUsd: spend.knownUsd });
  const recording = record
    ? await writeRecording({ into: join(out, 'recordings'), run, job, model: parts.modelName, providers: parts.providers, started: p.started, ended: p.ended, spend, modelUsd: p.measure.unpricedAnswers ? null : p.measure.usage.costUsd })
    : null;
  const v1 = { run: job.order, runId, job, seedSha: p.seedSha, afterSha: p.afterSha, offered: p.offered, measure: p.measure, finished: p.finished, curated: p.curated, curateJudge: p.curateJudge, recording, convention: parts.conventions?.[job.cik] };
  const row = !isHard(parts.set) ? rowOf(v1)
    : (parts.set === SETS.v4 ? rowOfV4 : rowOfV2)({ ...v1, score: p.score, stats: p.stats, scoringJudge: p.scoringJudge, lineage: p.lineage, jobRecord: hostRecord(jobRecordOf(recordingLines(run.storePath).lines), p.measure.dispatch) });
  const attempts = [...p.abandoned, ...(p.infraFailed ?? [])].map((a) => a.runId);
  const limits = limitsOf([...attempts, runId].map((id) => runPaths(home, id).storePath), { at: p.started });
  if (dropEvidence) dropRunFiles(run.dir);
  return {
    ...row,
    ...(p.curatedBefore === undefined ? {} : { curatedBefore: p.curatedBefore, lag: job.order - 1 - p.curatedBefore }),
    ...(p.curatedIndex === undefined ? {} : { curatedIndex: p.curatedIndex }),
    ...(p.gated ? { gated: p.gated } : {}),
    rerunOf: p.infraFailed?.[0]?.runId ?? null, infraFailed: modelError(p.measure), limits,
    durableCommits: durableCommits(run.storePath), fsyncProbeMs: diskProbe(run.dir).fsyncMs,
  };
}

/**
 * The curates of a learning pass, counted in the order they ran (a resumed pass counts on from its progress files), and
 * main frozen by label in <out>/checkpoints.json, `{ sha, streamIndex, epoch, at }` each: "0" the seed, "N" main after
 * the Nth curate for each N of `checkpoints`, and "epoch-e" main when the last job of epoch e is curated (`alsoIncludes`
 * counts a later epoch's jobs curated before then, whose learning is in that main too). `stream` is the whole list, so an
 * epoch cut by --jobs never counts as ended. A label once passed is never moved; one passed before a stop is written when
 * the pass opens again. The file is replaced whole (written aside, then renamed).
 */
function curateTally({ out, stream, seedSha, checkpoints = [] }) {
  const path = join(out, 'checkpoints.json');
  const frozen = readJsonIf(path) ?? {};
  const epochOf = new Map(stream.map((job) => [job.order, job.epoch]));
  const landed = new Map();
  const tally = { curated: 0 };
  const dir = join(out, 'progress');
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f))) {
      const p = readJsonIf(join(dir, file));
      if (p?.phase !== 'curated') continue;
      tally.curated += 1;
      const order = Number(file.slice(4, -5));
      if (p.curatedIndex !== undefined) landed.set(p.curatedIndex, { sha: p.afterSha, epoch: epochOf.get(order), at: p.curatedAt ?? null });
    }
  }
  const epochs = [...new Set(stream.map((job) => job.epoch).filter((e) => e !== undefined))].sort((a, b) => a - b);
  const pass = () => {
    const before = Object.keys(frozen).length;
    const add = (label, entry) => { frozen[label] ??= entry; };
    add('0', { sha: seedSha, streamIndex: 0, epoch: null, at: new Date().toISOString() });
    for (const n of checkpoints) {
      const at = landed.get(n);
      if (at) add(String(n), { sha: at.sha, streamIndex: n, epoch: at.epoch ?? null, at: at.at });
    }
    for (const epoch of epochs) {
      const mine = [...landed].filter(([, l]) => l.epoch === epoch).map(([index]) => index);
      if (mine.length < stream.filter((job) => job.epoch === epoch).length) continue;
      const end = Math.max(...mine);
      const alsoIncludes = [...landed].filter(([index, l]) => l.epoch > epoch && index < end).length;
      add(`epoch-${epoch}`, { sha: landed.get(end).sha, streamIndex: end, epoch, at: landed.get(end).at, alsoIncludes });
    }
    if (Object.keys(frozen).length === before) return;
    writeFileSync(`${path}.tmp`, `${JSON.stringify(frozen, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  };
  tally.landed = (job, p) => {
    landed.set(p.curatedIndex, { sha: p.afterSha, epoch: epochOf.get(job.order), at: p.curatedAt });
    pass();
  };
  pass();
  return tally;
}

/**
 * The queue of a pass on a list (the hill-climb's fixed companies, or a TRAIN stream from stream.mjs): each
 * `{ cik, ticker?, epoch?, cause? }` in the list's order, numbered by its place in it. A company not in the split, one
 * listed twice in an epoch, a ticker that is not the company's or an epoch that is not a whole number from 1 is refused,
 * so a list cannot quietly run something else. A company may come back in a later epoch.
 */
export function listQueue(companies, list, split = 'run', { openTest = false } = {}) {
  if (!Array.isArray(list) || !list.length) throw new Error('--list is an empty list: give the companies to run, in order');
  splitOf(companies, split, { openTest });
  const seen = new Set();
  return list.map((item, i) => {
    const cik = String(item?.cik ?? '');
    const company = companies.find((c) => c.cik === cik);
    if (!company) throw new Error(`--list: ${cik || `entry ${i + 1}`} is not in the ${split} split`);
    if (company.split !== split) throw new Error(`--list: ${cik} (${company.ticker}) is ${company.split}: a pass on a list takes the ${split} split only`);
    if (item.epoch !== undefined && !(Number.isInteger(item.epoch) && item.epoch >= 1)) throw new Error(`--list: ${cik}'s epoch is a whole number from 1`);
    const key = `${cik}@${item.epoch ?? 1}`;
    if (seen.has(key)) throw new Error(`--list: ${cik} is listed twice${item.epoch === undefined ? '' : ` in epoch ${item.epoch}`}`);
    if (item.ticker !== undefined && item.ticker !== company.ticker) throw new Error(`--list: ${cik} is ${company.ticker}, not ${item.ticker}`);
    seen.add(key);
    return { ...company, order: i + 1, ...(item.epoch === undefined ? {} : { epoch: item.epoch }) };
  });
}

/** The promotion gate's bank (`--promotion-bank`): each `{ cik, ticker? }` of the list is a company of the data, never one
 *  of DEV or TEST, and never one the pass's queue runs, so the bank stays out of the stream. */
export function bankOf(companies, list, queue = []) {
  if (!Array.isArray(list) || !list.length) throw new Error('--promotion-bank is an empty list: give the bank\'s companies');
  const queued = new Set(queue.map((job) => job.cik));
  const seen = new Set();
  return list.map((item, i) => {
    const cik = String(item?.cik ?? '');
    const company = companies.find((c) => c.cik === cik);
    if (!company) throw new Error(`--promotion-bank: ${cik || `entry ${i + 1}`} is not in the data`);
    if (company.split === 'dev' || company.split === 'test') throw new Error(`--promotion-bank: ${cik} (${company.ticker}) is ${company.split}: the bank is TRAIN companies`);
    if (item.ticker !== undefined && item.ticker !== company.ticker) throw new Error(`--promotion-bank: ${cik} is ${company.ticker}, not ${item.ticker}`);
    if (queued.has(cik)) throw new Error(`--promotion-bank: ${cik} (${company.ticker}) is in the pass's queue: the bank stays out of the stream`);
    if (seen.has(cik)) throw new Error(`--promotion-bank: ${cik} is listed twice`);
    seen.add(cik);
    return company;
  });
}

/**
 * The promotion gate's runs (promotion-gate.mjs `replayGate`): one revision on one bank company by the host alone, from
 * the gate's own clone and agent home under <out>/gate, scored as the pass's runs are. A bank run proposes nothing and is
 * no use of the revision. A revision that does not answer the job for the company's input is not run, and has no answer.
 */
function bankRunner({ out, bare, parts, runCapUsd, dropEvidence }) {
  const lock = serial();
  let opened;
  const open = () => (opened ??= (async () => {
    const repo = await openRepo({ dir: join(out, 'gate', 'repo'), remote: local(bare) });
    await repo.fetch();
    return { repo, home: await homeAt(join(out, 'gate', 'home'), repo, await repo.resolve('main')) };
  })());
  return async ({ name, sha256, workflow, company, main }) => {
    const answer = parts.set.answer(parts.data);
    const input = parts.set.input(company);
    const judge = meteredJudge(parts.judge());
    if (!answersTheJob(workflow, answer.parameters, input)) {
      return { outcome: 'not-served', score: await scoreV4({ answer: null, company, read: [], codes: parts.data.codes, judge: judge.run }), costUsd: 0 };
    }
    const { repo, home } = await open();
    const prepared = await lock(async () => {
      let attempt = 1;
      const idOf = (n) => `bank-${sha256.slice(0, 12)}-${company.cik}${n === 1 ? '' : `-a${n}`}`;
      while (existsSync(runPaths(home, idOf(attempt)).dir)) {
        await carryBack(home, { runId: idOf(attempt) }, { outcome: 'abandoned' }).catch(() => {});
        attempt += 1;
      }
      return prepareRun({ home, repo, host: HOST, runId: idOf(attempt), input, ref: main });
    });
    const measure = await runSet({ parts, repo, run: prepared, job: company, judge, limitUsd: runCapUsd, lock, dispatch: { name, sha256, workflow, input }, hostOnly: true });
    const run = { runId: prepared.runId, ...runPaths(home, prepared.runId) };
    await lock(() => carryBack(home, run, { outcome: measure.stopped ? 'stopped' : 'completed' }));
    const scored = await scoreRun({ parts, run, job: company, measure, hostsDir: join(out, 'gate', 'hosts') });
    if (dropEvidence) dropRunFiles(run.dir);
    const tools = [scored.stats.browserCostUsd, scored.stats.searchCostUsd, scored.stats.documentCostUsd];
    return { outcome: measure.dispatch?.outcome ?? 'not-served', score: scored.score, costUsd: spendOf(measure, undefined, tools).knownUsd + scored.scoringJudge.costUsd };
  };
}

/** The learning pass: the first `jobs` companies of `split` ("run" unless named), in order (or of `list`, in its order),
 *  until the spend reaches `capUsd`. With `concurrency` K above 1 the `schedule` is `rolling` unless named: K jobs in
 *  flight, the next in the queue starting as one lands, each prepared from main as the last curate left it, and each
 *  curated as it lands. `batch` takes the queue in batches of K by place: a batch's runs all start from one main and go
 *  side by side, then each is curated in queue order, so learning lands between batches. Rows go to runs.jsonl as jobs
 *  land; `checkpoints` freezes main after those curates (curateTally). */
export async function runLoop({ out, parts, jobs, list, split = 'run', openTest = false, concurrency = 1, schedule = 'rolling', checkpoints = [], capUsd, runCapUsd, record = true, dropEvidence = false, gate: given, log = () => {} }) {
  if (!['rolling', 'batch'].includes(schedule)) throw new Error(`the schedule is rolling or batch, not ${schedule}`);
  out = resolve(out);
  const { repo, bare, meta } = await openOut(out, { mode: parts.mode, set: parts.set, agentDir: parts.agentDir });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const rowsPath = join(out, 'runs.jsonl');
  const rows = readRows(rowsPath);
  const done = new Set(rows.map((r) => r.run));
  const stream = list ? listQueue(parts.companies, list, split, { openTest }) : splitOf(parts.companies, split, { openTest }).sort(byOrder);
  const queue = stream.slice(0, jobs ?? Infinity);
  // With a bank, a promotion stands only when the replay gate passes it (promotion-gate.mjs). The gate runs beside the
  // stream, never holding it: a curate that would promote queues it, and a later curate applies its verdict. `gate` gives
  // the pass one already made.
  const gate = given ?? (parts.bank ? asyncGate({ bank: bankOf(parts.companies, parts.bank, stream), runOne: bankRunner({ out, bare, parts, runCapUsd, dropEvidence }), dir: join(out, 'gate'), ...(parts.bankConcurrency ? { concurrency: parts.bankConcurrency } : {}), log }) : undefined);
  const judge = parts.judge();
  const spentNow = () => knownSpend(out);
  const tally = curateTally({ out, stream, seedSha: meta.seedSha, checkpoints });
  writeFileSync(join(out, 'conventions.json'), `${JSON.stringify(parts.conventions ?? {}, null, 2)}\n`);
  let stoppedBy = null;
  const shape = concurrency === 1 ? '' : schedule === 'batch' ? ` in batches of ${concurrency}` : `, ${concurrency} in flight`;
  log(`learn-classify: ${parts.mode} pass in ${out}, seed ${short(meta.seedSha)}, ${queue.length} job(s)${shape}${capUsd === undefined ? '' : `, cap ${usd(capUsd)}`}`);
  if (queue.some((job) => !done.has(job.order))) await selfTest({ out, repo, parts, log });
  const lock = concurrency > 1 ? serial() : inline;
  const args = (job) => ({ out, repo, home, parts, judge, job, runCapUsd, record, dropEvidence, log, lock, tally, gate });
  const capped = () => {
    if (capUsd === undefined || spentNow() < capUsd) return false;
    stoppedBy ??= `spent ${usd(spentNow())}, at or over the cap of ${usd(capUsd)}`;
    return true;
  };
  const land = (job, row) => {
    const kept = withEpoch(row, job);
    appendFileSync(rowsPath, `${JSON.stringify(kept)}\n`);
    rows.push(kept);
    log(lineOf(kept));
  };
  if (schedule === 'batch') {
    for (let at = 0; at < queue.length; at += concurrency) {
      const batch = queue.slice(at, at + concurrency).filter((job) => !done.has(job.order));
      if (!batch.length) continue;
      if (capped()) break;
      await Promise.all(batch.map((job) => startJob(args(job))));
      for (const job of batch) land(job, await endJob(args(job)));
    }
  } else {
    const pending = queue.filter((job) => !done.has(job.order));
    let next = 0;
    const worker = async () => {
      while (next < pending.length && !stoppedBy && !capped()) {
        const job = pending[next++];
        await startJob(args(job));
        land(job, await endJob(args(job)));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pending.length)) }, worker));
  }
  // A comparison still on the bank finishes, so its verdict lands for the next curate (a resumed pass) to apply.
  if (gate) await gate.idle();
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

/** The companies of `split` ("sealed" unless named) at one commit of the agent repository, with no learning: nothing is
 *  proposed or curated, and every job is seeded from that commit. Its own agent home, kept at that commit. Rows go to
 *  <out>/sealed-<sha12>.jsonl, each numbered by the company's place in the split. `from` takes the commit from another
 *  pass's repository (adoptFrom); `concurrency` runs that many jobs side by side; `shard` { index, count } takes every
 *  count-th company from the index-th, for a pass spread over several takes. */
export async function runSealed({ out, parts, at = 'main', from, split = 'sealed', openTest = false, concurrency = 1, shard, capUsd, runCapUsd, record = false, dropEvidence = false, log = () => {} }) {
  out = resolve(out);
  if (from !== undefined) adoptFrom(out, from, { mode: parts.mode, set: parts.set });
  const { repo, meta } = await openOut(out, { mode: parts.mode, set: parts.set, agentDir: parts.agentDir });
  await repo.fetch();
  const sha = at === 'seed' ? meta.seedSha : await repo.resolve(at);
  if (!sha) throw new Error(`the agent repository has no ${at}`);
  const label = sha.slice(0, 12);
  const home = await homeAt(join(out, 'sealed', label, 'home'), repo, sha);
  const rowsPath = join(out, `sealed-${label}.jsonl`);
  const rows = readRows(rowsPath);
  const done = new Set(rows.map((r) => r.cik));
  const queue = splitOf(parts.companies, split, { openTest }).sort((a, b) => a.cik.localeCompare(b.cik))
    .map((job, i) => ({ job, place: i + 1 }))
    .filter(({ place }) => !shard || (place - 1) % shard.count === shard.index - 1);
  const pending = queue.filter(({ job }) => !done.has(job.cik));
  const judge = parts.judge();
  let spent = rows.reduce((sum, r) => sum + (r.costUsd ?? 0) + (r.scoreCostUsd ?? 0), 0);
  let stoppedBy = null;
  log(`learn-classify: sealed pass at ${label}${sha === meta.seedSha ? ' (the seed: nothing learned)' : ''}, ${queue.length} companies of ${split}${shard ? ` (shard ${shard.index}/${shard.count})` : ''}${concurrency > 1 ? `, ${concurrency} at once` : ''}`);
  if (pending.length) await selfTest({ out, repo, parts, log });
  const lock = concurrency > 1 ? serial() : inline;
  // One run of a job: an earlier attempt's directory is abandoned, then the run is prepared at `sha` and run. A home already
  // past `sha` keeps its own commit (it never moves back) and would run a later agent, so a run seeded from any other commit
  // is refused before it runs: one home per frozen commit.
  const runOnce = async (job) => {
    const prepared = await lock(async () => {
      let attempt = 1;
      const idOf = (n) => `sealed-${job.cik}${n === 1 ? '' : `-a${n}`}`;
      while (existsSync(runPaths(home, idOf(attempt)).dir)) {
        await carryBack(home, { runId: idOf(attempt) }, { outcome: 'abandoned' }).catch(() => {});
        attempt += 1;
      }
      return prepareRun({ home, repo, host: HOST, runId: idOf(attempt), input: parts.set.input(job), ref: sha });
    });
    if (prepared.sha !== sha) throw new Error(`refused: ${prepared.runId} was seeded from ${prepared.sha.slice(0, 12)}, not ${label}; its home is past the frozen commit (one home per commit)`);
    const started = Date.now();
    const measure = await runSet({ parts, repo, run: prepared, job, judge: meteredJudge(judge), limitUsd: runCapUsd, lock });
    return { prepared, started, measure };
  };
  const oneSealed = async ({ job, place }) => {
    let { prepared, started, measure } = await runOnce(job);
    // A run a model error ended is run again once; its spend is kept, and a second one is the job's outcome.
    const infraFailed = [];
    if (modelError(measure)) {
      infraFailed.push({ runId: prepared.runId, reason: measure.reason, costUsd: attemptUsd(measure) });
      spent += attemptUsd(measure);
      log(`  ${prepared.runId} ended on a model error: running it again once`);
      ({ prepared, started, measure } = await runOnce(job));
    }
    const run = { runId: prepared.runId, ...runPaths(home, prepared.runId) };
    const finished = await lock(() => finishJob({ home, repo, run, job, measure, propose: false }));
    const scored = isHard(parts.set) ? await scoreRun({ parts, run, job, measure, hostsDir: join(out, 'sealed', label, 'hosts') }) : undefined;
    const tools = scored ? [scored.stats.browserCostUsd, scored.stats.searchCostUsd, scored.stats.documentCostUsd] : [];
    const recording = record
      ? await writeRecording({ into: join(out, 'sealed', label, 'recordings'), run, job, model: parts.modelName, providers: parts.providers, started, ended: Date.now(), spend: spendOf(measure, undefined, tools), modelUsd: measure.unpricedAnswers ? null : measure.usage.costUsd })
      : null;
    const v1 = { run: place, runId: prepared.runId, job, seedSha: prepared.sha, afterSha: sha, offered: prepared.workflows.loaded.map((w) => w.name), measure, finished, curated: null, recording, convention: parts.conventions?.[job.cik] };
    const phase = sha === meta.seedSha ? 'before' : 'after';
    const scoredRow = scored ? (parts.set === SETS.v4 ? rowOfV4 : rowOfV2)({ ...v1, score: scored.score, stats: scored.stats, scoringJudge: scored.scoringJudge, phase, jobRecord: hostRecord(jobRecordOf(recordingLines(run.storePath).lines), measure.dispatch) }) : { ...rowOf(v1), phase };
    const limits = limitsOf([...infraFailed.map((f) => f.runId), run.runId].map((id) => runPaths(home, id).storePath), { at: started });
    const row = { ...scoredRow, rerunOf: infraFailed[0]?.runId ?? null, infraFailed: modelError(measure), limits, durableCommits: durableCommits(run.storePath), fsyncProbeMs: diskProbe(run.dir).fsyncMs };
    spent += spendOf(measure, undefined, tools).knownUsd + (scored?.scoringJudge.costUsd ?? 0);
    appendFileSync(rowsPath, `${JSON.stringify(row)}\n`);
    if (dropEvidence) dropRunFiles(run.dir);
    rows.push(row);
    log(lineOf(row));
  };
  let next = 0;
  // A job that throws (the seed check above among them) stops the pass: no worker takes another job, the ones in flight
  // finish, and the pass throws the first error.
  let failed = null;
  const worker = async () => {
    while (next < pending.length && !stoppedBy && !failed) {
      if (capUsd !== undefined && spent >= capUsd) { stoppedBy = `spent ${usd(spent)}, at or over the cap of ${usd(capUsd)}`; break; }
      try {
        await oneSealed(pending[next++]);
      } catch (error) {
        failed ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pending.length)) }, worker));
  if (failed) throw failed;
  const correct = rows.filter((r) => r.correct).length;
  log(`sealed at ${label}: ${correct} of ${rows.length} correct${stoppedBy ? `; stopped: ${stoppedBy}` : ''}`);
  await writeCurve(out);
  return { rows, sha, label, correct, stoppedBy };
}

const USAGE = 'usage: node examples/learn-classify/runner.mjs [--out <dir>] [--set v1|v2|v4] (--scripted [--data <dir>] | --live --cap-usd <usd> [--model <root model id>] [--thinking <root level>]) [--jobs <n>] [--run-cap-usd <usd>] [--no-record] [--no-dispatch] [--list <file>] [--promote-after <n>] [--split <name> [--open-test]] [--concurrency <n>] [--drop-evidence] [--agent-dir <dir>] [--edgar-archive [--edgar-cache <dir>]] [--schedule rolling|batch] [--checkpoints <n,n,...>] [--curate-cuts v0.1|default] [--curate-sticky] [--promotion-bank <file> [--promotion-bank-concurrency <n>]] [--sealed --at seed|main|<sha> [--from <agent.git or bundle>] [--shard <i>/<n>]]';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        out: { type: 'string' }, scripted: { type: 'boolean' }, live: { type: 'boolean' }, data: { type: 'string' }, jobs: { type: 'string' },
        'cap-usd': { type: 'string' }, 'run-cap-usd': { type: 'string' }, 'no-record': { type: 'boolean' }, sealed: { type: 'boolean' }, at: { type: 'string' },
        'no-dispatch': { type: 'boolean' },
        model: { type: 'string' }, thinking: { type: 'string' }, set: { type: 'string' }, list: { type: 'string' }, 'promote-after': { type: 'string' },
        split: { type: 'string' }, 'open-test': { type: 'boolean' }, from: { type: 'string' }, concurrency: { type: 'string' }, shard: { type: 'string' }, 'drop-evidence': { type: 'boolean' },
        'edgar-archive': { type: 'boolean' }, 'agent-dir': { type: 'string' }, 'edgar-cache': { type: 'string' }, schedule: { type: 'string' }, checkpoints: { type: 'string' },
        'curate-cuts': { type: 'string' }, 'curate-sticky': { type: 'boolean' }, 'promotion-bank': { type: 'string' }, 'promotion-bank-concurrency': { type: 'string' },
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
  if (values.list !== undefined && values.sealed) { console.error(`--list runs a learning pass: a sealed pass takes the sealed split\n${USAGE}`); process.exit(2); }
  const promoteAfter = values['promote-after'] === undefined ? undefined : Number(values['promote-after']);
  if (promoteAfter !== undefined && !(Number.isInteger(promoteAfter) && promoteAfter >= 1)) { console.error(`--promote-after is a whole number from 1\n${USAGE}`); process.exit(2); }
  const concurrency = values.concurrency === undefined ? 1 : Number(values.concurrency);
  if (!(Number.isInteger(concurrency) && concurrency >= 1)) { console.error(`--concurrency is a whole number from 1\n${USAGE}`); process.exit(2); }
  const shardMatch = values.shard === undefined ? null : /^(\d+)\/(\d+)$/.exec(values.shard);
  const shard = shardMatch ? { index: Number(shardMatch[1]), count: Number(shardMatch[2]) } : undefined;
  if (values.shard !== undefined && !(shard && shard.index >= 1 && shard.index <= shard.count)) { console.error(`--shard is i/N with 1 <= i <= N\n${USAGE}`); process.exit(2); }
  for (const name of ['shard', 'from']) {
    if (values[name] !== undefined && !values.sealed) { console.error(`--${name} takes a sealed pass\n${USAGE}`); process.exit(2); }
  }
  if (values.split === 'test' && !values['open-test']) { console.error('the test split is opened once per finalist: pass --open-test'); process.exit(2); }
  for (const name of ['schedule', 'checkpoints']) {
    if (values[name] !== undefined && values.sealed) { console.error(`--${name} takes a learning pass\n${USAGE}`); process.exit(2); }
  }
  if (values.schedule !== undefined && !['rolling', 'batch'].includes(values.schedule)) { console.error(`--schedule is rolling or batch\n${USAGE}`); process.exit(2); }
  const checkpoints = values.checkpoints === undefined ? undefined : values.checkpoints.split(',').map(Number);
  if (checkpoints && !checkpoints.every((n, i) => Number.isInteger(n) && n >= 1 && (i === 0 || n > checkpoints[i - 1]))) { console.error(`--checkpoints is ascending whole numbers from 1\n${USAGE}`); process.exit(2); }
  if (values['edgar-cache'] !== undefined && !values['edgar-archive']) { console.error(`--edgar-cache needs --edgar-archive: the cache serves only the Wayback copies of SEC pages\n${USAGE}`); process.exit(2); }
  let list;
  if (values.list !== undefined) {
    try { list = JSON.parse(readFileSync(resolve(values.list), 'utf8')); } catch (error) { console.error(`--list ${values.list}: ${error.message}`); process.exit(2); }
  }
  try {
    const set = SETS[values.set ?? 'v1'];
    if (!set) { console.error(`--set is v1, v2 or v4\n${USAGE}`); process.exit(2); }
    const parts = values.live
      ? await liveParts({ set, ...(values.data ? { data: resolve(values.data) } : {}), ...(values.model ? { model: values.model } : {}), ...(values.thinking ? { thinking: values.thinking } : {}), archivedSec: Boolean(values['edgar-archive']), ...(values['edgar-cache'] ? { edgarCache: resolve(values['edgar-cache']) } : {}) })
      : scriptedParts({ set, ...(values.data ? { data: resolve(values.data) } : {}) });
    if (values['no-dispatch']) parts.dispatch = false;
    if (values['agent-dir'] !== undefined) {
      const agentDir = resolve(values['agent-dir']);
      if (!existsSync(join(agentDir, 'agent.json'))) { console.error(`--agent-dir ${values['agent-dir']} is not an agent home (no agent.json)\n${USAGE}`); process.exit(2); }
      parts.agentDir = agentDir;
    }
    if (values['curate-cuts'] !== undefined) {
      if (values['curate-cuts'] !== 'v0.1' && values['curate-cuts'] !== 'default') { console.error(`--curate-cuts is v0.1 or default\n${USAGE}`); process.exit(2); }
      parts.judgeCuts = values['curate-cuts'] === 'v0.1' ? CURATE_CUTS_V01 : null;
      parts.cutsId = values['curate-cuts'];
      console.log(`learn-classify: curation judged by the ${values['curate-cuts'] === 'v0.1' ? 'pre-registered v0.1 cuts' : "package's default cuts"}`);
    }
    if (values['curate-sticky']) {
      parts.sticky = true;
      console.log('learn-classify: curation judges each learning by the worst answer its text has had (<out>/curate-sticky.json)');
    }
    if (values['promotion-bank'] !== undefined) {
      if (values.sealed) { console.error(`--promotion-bank gates a learning pass's promotions: a sealed pass promotes nothing\n${USAGE}`); process.exit(2); }
      if (set !== SETS.v4) { console.error(`--promotion-bank scores the v4 job: pass --set v4\n${USAGE}`); process.exit(2); }
      try { parts.bank = JSON.parse(readFileSync(resolve(values['promotion-bank']), 'utf8')); } catch (error) { console.error(`--promotion-bank ${values['promotion-bank']}: ${error.message}`); process.exit(2); }
      const inFlight = values['promotion-bank-concurrency'] === undefined ? GATE.concurrency : Number(values['promotion-bank-concurrency']);
      if (!(Number.isInteger(inFlight) && inFlight >= 1)) { console.error(`--promotion-bank-concurrency is a whole number from 1\n${USAGE}`); process.exit(2); }
      parts.bankConcurrency = inFlight;
      console.log(`learn-classify: a promotion stands only when it passes the replay gate on ${Array.isArray(parts.bank) ? parts.bank.length : 0} bank companies, ${inFlight} at once (<out>/gate)`);
    } else if (values['promotion-bank-concurrency'] !== undefined) {
      console.error(`--promotion-bank-concurrency takes --promotion-bank\n${USAGE}`);
      process.exit(2);
    }
    if (promoteAfter !== undefined) {
      parts.thresholds = { promoteAfter };
      console.log(`learn-classify: promotion after ${promoteAfter} clean uses`);
    }
    const out = resolve(values.out ?? OUT);
    try {
      mkdirSync(out, { recursive: true });
      accessSync(out, constants.W_OK);
    } catch (error) {
      console.error(`--out ${out} is not writable (${error.code ?? error.message}); in a take only /run is: use --out /run/out`);
      process.exit(2);
    }
    const common = {
      out, parts, capUsd: number('cap-usd'), runCapUsd: number('run-cap-usd'), concurrency, openTest: Boolean(values['open-test']), dropEvidence: Boolean(values['drop-evidence']), log: (line) => console.log(line),
      ...(values.split ? { split: values.split } : {}),
    };
    const result = values.sealed
      ? await runSealed({ ...common, at: values.at, record: !values['no-record'], ...(values.from ? { from: values.from } : {}), ...(shard ? { shard } : {}) })
      : await runLoop({ ...common, jobs: number('jobs'), list, record: !values['no-record'], ...(values.schedule ? { schedule: values.schedule } : {}), ...(checkpoints ? { checkpoints } : {}) });
    if (result.stoppedBy) process.exitCode = 3;
  } catch (error) {
    console.error(`learn-classify failed: ${error.stack ?? error}`);
    process.exit(1);
  }
}
