#!/usr/bin/env node
// Which walks walked a release: for a tag, each walk workflow's runs that walked it, and one table of each walk, the run
// it is judged by, its result and the jobs that failed. A run walked the tag when it ran at the tag's commit (main's push
// of the release, or a dispatch at the tag), or ran after the tag's publish (workflow_run, whose own sha is main's tip),
// which the daily walk and the install walk name in their run-name ("... at <tag>"). Red (exit 1) when a walk has no
// such run or its run did not pass.
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

const names = (title, tag) => (title ?? '').split(/\s+/).includes(tag);

/** The runs that walked the tag: at its commit, or after its publish with the tag in the run's name. */
export function runsAtTag(runs, { tag, sha }) {
  return runs.filter((r) => r.head_sha === sha || (r.event === 'workflow_run' && names(r.display_title, tag)));
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
    return { name, said: result(run), url: run?.html_url ?? '', failed };
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
    const at = gh(`${repo}/actions/workflows/${file}/runs?head_sha=${sha}&per_page=100`).workflow_runs;
    const after = gh(`${repo}/actions/workflows/${file}/runs?event=workflow_run&per_page=100`).workflow_runs;
    const run = best(runsAtTag([...at, ...after.filter((r) => !at.some((a) => a.id === r.id))], { tag, sha }));
    const failed = run && run.status === 'completed' && run.conclusion !== 'success'
      ? gh(`${repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs.filter((j) => j.conclusion === 'failure').map((j) => j.name)
      : [];
    byFile[file] = { run, failed };
  }
  const { red, table } = report(tag, sha, byFile);
  process.stdout.write(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  process.exit(red ? 1 : 0);
}
