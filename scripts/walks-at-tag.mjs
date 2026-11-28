#!/usr/bin/env node
// Which walks walked a release: for a tag, each walk workflow's runs that walked it, and one table of each walk, the run
// it is judged by, its result and the jobs that failed. A run walked the tag when it ran at the tag's commit (main's push
// of the release, or a dispatch at the tag), or ran after the tag's publish (workflow_run, whose own sha is main's tip),
// which the daily walk and the install walk name in their run-name ("... at <tag>"). Red (exit 1) when a walk has no
// such run or its run did not pass, a known (parked) failure included; the table names that one as known.
//   GH_TOKEN=... node scripts/walks-at-tag.mjs v0.1.0-beta.68     the table on stdout, and in the job's summary in CI
//   ... node scripts/walks-at-tag.mjs v0.1.0-beta.68 --issue      also the one issue "walks at <tag>: <walks> not green":
//       opened or moved to this tag while red, closed at green, left alone while a walk is still running
//   INPUT_TAG= EVENT= TITLE= SHA= ... node scripts/walks-at-tag.mjs --find-tag     "tag=<tag>" (empty when none) for
//       $GITHUB_OUTPUT: the tag a finished walk ran for (.github/workflows/walks-at-tag.yml)
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

// The shape of a release tag: the only thing read from an operator's input or a run's name.
const RELEASE_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;

/** The tag a finished walk ran for, '' when none: the operator's input; after a publish (workflow_run, at main's tip),
 *  the run's name, "<walk> at <tag>"; else a tag at the run's commit. Only a tag that exists (`tags`, every one in the
 *  repository), and only one shaped like a release's. */
export function findTag({ input, event, title, sha, tags }) {
  if (input) {
    if (!RELEASE_TAG.test(input)) throw new Error(`${JSON.stringify(input)} is not a release tag (v1.2.3 or v1.2.3-beta.4)`);
    return input;
  }
  const named = event === 'workflow_run' ? / at (\S+)$/.exec(title ?? '')?.[1] : undefined;
  const found = named ? tags.find((t) => t.name === named) : tags.find((t) => t.commit.sha === sha);
  return found && RELEASE_TAG.test(found.name) ? found.name : '';
}

/** Release tags in version order (semver: numbers by value, a release after its prereleases), for sort. */
export function compareTags(a, b) {
  const parts = (tag) => {
    const [, core, pre] = /^v([^-]+)(?:-(.+))?$/.exec(tag);
    return { core: core.split('.').map(Number), pre: pre?.split('.') };
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre || !y.pre) return (x.pre ? -1 : 0) + (y.pre ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const numeric = /^\d+$/.test(p) && /^\d+$/.test(q);
    return numeric ? Number(p) - Number(q) : p < q ? -1 : 1;
  }
  return 0;
}

/** The newest release tag among `tags` (the repository's), by version. */
export function latestTag(tags) {
  return tags.map(({ name }) => name).filter((name) => RELEASE_TAG.test(name)).sort(compareTags).at(-1);
}

/** The runs that walked the tag: at its commit, or after its publish with the tag in the run's name. A post-publish run
 *  counts only by its name: its own sha is main's tip when it started, which a later tag may name. */
export function runsAtTag(runs, { tag, sha }) {
  return runs.filter((r) => (r.event === 'workflow_run' ? names(r.display_title, tag) : r.head_sha === sha));
}

/** Every page of a GitHub list (`key` in each page's answer, or the answer itself when no key), 100 at a time, until a
 *  short page. */
export function allPages(get, path, key) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const answer = get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = key ? answer[key] : answer;
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
  const broken = rows.filter(({ said }) => said !== 'PASS').map(({ name }) => name);
  return { red: broken.length > 0, broken, pending: rows.some(({ said }) => said === 'running'), table };
}

const PREFIX = 'walks at ';
const SUFFIX = ' not green';

/** The gh commands for the one issue that tracks a release's walks, "walks at <tag>: <walks> not green", among `open`:
 *  none while a walk still runs; a red tag opens it, or moves the open one to this tag; a green tag closes it. Only the
 *  newest release (`latest`) drives it: an older tag's walk finishing late or rerun says nothing about the release out now. */
export function issuePlan({ tag, latest, red, broken, pending, table, open, run }) {
  if (pending || tag !== latest) return [];
  const ours = open.find((issue) => issue.title.startsWith(PREFIX) && issue.title.endsWith(SUFFIX));
  if (!red) return ours ? [['issue', 'close', String(ours.number), '--comment', `Every walk green at ${tag}: ${run}`]] : [];
  const title = `${PREFIX}${tag}: ${broken.join(', ')}${SUFFIX}`;
  if (!ours) return [['issue', 'create', '--title', title, '--body', table]];
  return [
    ['issue', 'edit', String(ours.number), '--title', title, '--body', table],
    ['issue', 'comment', String(ours.number), '--body', `${tag}: ${broken.join(', ')}${SUFFIX}. ${run}`],
  ];
}

if (isMain(import.meta)) {
  const [tag, flag] = process.argv.slice(2);
  const cli = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const gh = (path) => JSON.parse(cli(['api', path]));
  const repo = 'repos/{owner}/{repo}';
  if (tag === '--find-tag') {
    const { INPUT_TAG: input, EVENT: event, TITLE: title, SHA: sha } = process.env;
    console.log(`tag=${findTag({ input, event, title, sha, tags: input ? [] : allPages(gh, `${repo}/tags`) })}`);
    process.exit(0);
  }
  if (!tag || !RELEASE_TAG.test(tag)) {
    console.error('usage: node scripts/walks-at-tag.mjs <release tag> [--issue] | --find-tag');
    process.exit(2);
  }
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
  const said = report(tag, sha, byFile);
  process.stdout.write(said.table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, said.table);
  if (flag === '--issue') {
    const open = JSON.parse(cli(['issue', 'list', '--state', 'open', '--author', 'app/github-actions', '--limit', '100', '--json', 'number,title']));
    const latest = latestTag(allPages(gh, `${repo}/tags`));
    const plan = issuePlan({ ...said, tag, latest, open, run: process.env.RUN_URL ?? '' });
    if (tag !== latest) console.log(`${tag} is not the newest release (${latest}): the issue follows that one.`);
    if (said.pending) console.log('A walk is still running: the issue waits for the last one to finish.');
    for (const args of plan) console.log(cli(args).trim() || `gh ${args.slice(0, 3).join(' ')}`);
  }
  process.exit(said.red && !(flag === '--issue' && said.pending) ? 1 : 0);
}
