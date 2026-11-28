#!/usr/bin/env node
// Which walks walked a release: for a tag, each walk workflow's runs that walked it, and one table of each walk, the run
// it is judged by, its result and the jobs that failed. A run walked the tag when it ran at the tag's commit (main's push
// of the release, or a dispatch at the tag), or ran after the tag's publish (workflow_run, whose own sha is main's tip),
// which the daily walk and the install walk name in their run-name ("... at <tag>"). Red (exit 1) when a walk has no
// such run or its run did not pass, a known (parked) failure included; the table names that one as known.
//   GH_TOKEN=... node scripts/walks-at-tag.mjs v0.1.0-beta.68     the table on stdout, and in the job's summary in CI
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isMain } from './is-main.mjs';

export const WALKS = [
  { file: 'install-walk.yml', name: 'Install walk' },
  { file: 'helm-walk.yml', name: 'Helm walk' },
  { file: 'selfhost-walk.yml', name: 'Self-host walk' },
  { file: 'ways-in-daily.yml', name: 'Ways in' },
];

// Failures already known and parked on someone who isn't a lane: the table names them as such, and they still count red.
// Each is a job's name in its workflow (the test checks it), so a renamed job loses the label instead of hiding a failure.
export const KNOWN = [
  { file: 'ways-in-daily.yml', job: "Railway's published template, on Railway", why: 'the published template is being republished' },
];

const label = (file, job) => {
  const known = KNOWN.find((k) => k.file === file && k.job === job);
  return known ? `${job} (known, parked: ${known.why})` : job;
};

const names = (title, tag) => (title ?? '').split(/\s+/).includes(tag);

/** The runs that walked the tag: at its commit, or after its publish with the tag in the run's name. A post-publish run
 *  counts only by its name: its own sha is main's tip when it started, which a later tag may name. */
export function runsAtTag(runs, { tag, sha }) {
  return runs.filter((r) => (r.event === 'workflow_run' ? names(r.display_title, tag) : r.head_sha === sha));
}

/** Every page of a GitHub list (`key` in each page's answer), 100 at a time, until a short page. */
export function allPages(get, path, key) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const items = get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)[key];
    all.push(...items);
    if (items.length < 100) return all;
  }
}

/** The run a walk is judged by: the latest that finished green, else the latest. */
export function best(runs) {
  const latest = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return latest.find((r) => r.status === 'completed' && r.conclusion === 'success') ?? latest[0];
}

function result(r) {
  if (!r) return 'not walked';
  if (r.status !== 'completed') return 'running';
  if (r.conclusion === 'success') return 'PASS';
  if (r.conclusion === 'failure') return 'FAIL';
  return r.conclusion;
}

/** The table, from each walk's judged run and its failed jobs, keyed by workflow file; red unless every walk passed. */
export function report(tag, sha, byFile) {
  const rows = WALKS.map(({ file, name }) => {
    const { run, failed = [] } = byFile[file] ?? {};
    return { name, said: result(run), url: run?.html_url ?? '', failed: failed.map((job) => label(file, job)) };
  });
  const table = [
    `## Walks at ${tag} (${sha.slice(0, 10)})`,
    '',
    '| walk | result | run | failed jobs |',
    '| --- | --- | --- | --- |',
    ...rows.map(({ name, said, url, failed }) => `| ${name} | ${said} | ${url} | ${failed.join(', ')} |`),
    '',
  ].join('\n');
  return { red: rows.some(({ said }) => said !== 'PASS'), table };
}

if (isMain(import.meta)) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('usage: node scripts/walks-at-tag.mjs <tag>');
    process.exit(2);
  }
  const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  const repo = 'repos/{owner}/{repo}';
  let object = gh(`${repo}/git/ref/tags/${tag}`).object;
  // An annotated tag points at a tag object, which points at the commit.
  while (object.type === 'tag') object = gh(`${repo}/git/tags/${object.sha}`).object;
  const sha = object.sha;
  const byFile = {};
  for (const { file } of WALKS) {
    const at = allPages(gh, `${repo}/actions/workflows/${file}/runs?head_sha=${sha}`, 'workflow_runs');
    const after = allPages(gh, `${repo}/actions/workflows/${file}/runs?event=workflow_run`, 'workflow_runs');
    const run = best(runsAtTag([...at, ...after.filter((r) => !at.some((a) => a.id === r.id))], { tag, sha }));
    const failed = run && run.status === 'completed' && run.conclusion !== 'success'
      ? allPages(gh, `${repo}/actions/runs/${run.id}/jobs`, 'jobs').filter((j) => j.conclusion === 'failure').map((j) => j.name)
      : [];
    byFile[file] = { run, failed };
  }
  const { red, table } = report(tag, sha, byFile);
  process.stdout.write(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  process.exit(red ? 1 : 0);
}
