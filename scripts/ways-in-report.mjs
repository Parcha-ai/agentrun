#!/usr/bin/env node
// The daily walk's report (.github/workflows/ways-in-daily.yml): one table of every way in, what its row walks and the
// row's result, then each walk's own rows; and the issue that tracks a red one. Its rows are the workflow's jobs, one
// per way in, keyed by job id (ways-in-daily.test.mjs holds the two to each other).
//   NEEDS='${{ toJSON(needs) }}' RUN_URL=... node scripts/ways-in-report.mjs <reports dir>           the table, in the
//       job's summary (else on stdout); <reports dir>/walk-report-<job>/* holds a walk's own report, where it wrote one
//   ... node scripts/ways-in-report.mjs <reports dir> --issue   with GH_TOKEN: a red run opens the issue "ways in: <rows>
//       broke", or updates the one open; a green run closes it
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './is-main.mjs';

export const ROWS = [
  { job: 'npx', name: 'npx', walks: "the README's `npx @parcha/agentrun`, from npm as published, to a first run" },
  { job: 'launcher', name: 'launcher', walks: "main's launcher, packed: install.sh in a container (x64, arm64), a first run, a VPS, systemd and launchd (install-walk.yml)" },
  { job: 'docker', name: 'Docker', walks: "main's image: deploy/compose.yaml's server and two runners, to a run" },
  { job: 'railway', name: 'Railway', walks: "main's image, run as the Railway template's service runs (deploy/railway/local-walk.mjs)" },
  { job: 'helm', name: 'Helm', walks: "main's chart and image on kind: install, first run, upgrade, uninstall (helm-walk.yml)" },
  { job: 'coolify', name: 'Coolify', walks: "main's template and image on Coolify: deploy, first run and its page in the console, remove (selfhost-walk.yml)" },
  { job: 'dokploy', name: 'Dokploy', walks: "main's template and image on Dokploy: deploy, first run and its page in the console, remove (selfhost-walk.yml)" },
  { job: 'railway-hosted', name: 'Railway (hosted)', walks: "the README's Deploy on Railway template as published, on Railway: deploy, setup with the token, a first run on a capped key, deleted (deploy/railway/publish-and-walk.sh --walk)" },
  { job: 'render-hosted', name: 'Render (hosted)', walks: "render.yaml's service, made through Render's API, on Render: deploy, setup with the token, a first run on a capped key, deleted (deploy/render/walk.mjs)" },
];
const PREFIX = 'ways in: ';
const SUFFIX = ' broke';

/** A row's result as the table says it: PASS, FAIL, or GitHub's word (cancelled, skipped) for the rest. A hosted row
 *  that walked nothing (no secrets yet, or a pull request's run) passes: its job's `skip` output says why. */
function said({ result, outputs } = {}, image) {
  if (result === 'success' && outputs?.skip) return `not walked: ${outputs.skip}`;
  if (result === 'success') return 'PASS';
  if (result === 'failure') return 'FAIL';
  if (result === 'skipped' && image !== 'success') return "not walked: main's image did not build";
  return result ?? 'not run';
}

/** The table and its rows' reports from the jobs' results (`needs`) and the walks' reports by job id. */
export function summarize(needs, reports, runUrl) {
  const broken = ROWS.filter(({ job }) => needs[job]?.result !== 'success').map(({ name }) => name);
  const lines = [
    `## Ways in, walked on ${broken.length ? 'red' : 'green'}`,
    '',
    `Run: ${runUrl}`,
    '',
    '| way in | walks | result |',
    '| --- | --- | --- |',
    ...ROWS.map(({ job, name, walks }) => `| ${name} | ${walks} | ${said(needs[job], needs.image?.result)} |`),
  ];
  for (const { job, name } of ROWS) if (reports[job]) lines.push('', `### ${name}`, '', reports[job].trim());
  return { broken, title: broken.length ? `${PREFIX}${broken.join(', ')}${SUFFIX}` : undefined, table: `${lines.join('\n')}\n` };
}

/** The gh commands for the tracking issue: the one open "ways in: ... broke" issue, if any, among `open`. */
export function issuePlan({ broken, title, open, body, run }) {
  const ours = open.find((issue) => issue.title.startsWith(PREFIX) && issue.title.endsWith(SUFFIX));
  if (broken.length === 0) return ours ? [['issue', 'close', String(ours.number), '--comment', `Every way in walked green: ${run}`]] : [];
  if (!ours) return [['issue', 'create', '--title', title, '--body', body]];
  return [
    ['issue', 'edit', String(ours.number), '--title', title, '--body', body],
    ['issue', 'comment', String(ours.number), '--body', `Still red: ${broken.join(', ')}. ${run}`],
  ];
}

/** Each walk's report, from <dir>/walk-report-<job>/ (the first file there). */
function readReports(dir) {
  const reports = {};
  for (const { job } of ROWS) {
    const at = join(dir, `walk-report-${job}`);
    const files = existsSync(at) ? readdirSync(at) : [];
    if (files.length) reports[job] = readFileSync(join(at, files[0]), 'utf8');
  }
  return reports;
}

if (isMain(import.meta)) {
  const [dir, flag] = process.argv.slice(2);
  const run = process.env.RUN_URL;
  const { broken, title, table } = summarize(JSON.parse(process.env.NEEDS), readReports(dir), run);
  if (flag === '--issue') {
    const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const open = JSON.parse(gh(['issue', 'list', '--state', 'open', '--author', 'app/github-actions', '--limit', '100', '--json', 'number,title']));
    for (const args of issuePlan({ broken, title, open, body: table, run })) console.log(gh(args).trim() || `gh ${args.slice(0, 3).join(' ')}`);
  } else if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  else process.stdout.write(table);
}
