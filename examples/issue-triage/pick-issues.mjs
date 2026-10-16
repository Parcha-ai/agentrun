#!/usr/bin/env node
// node pick-issues.mjs <owner/name> [count]: the input of a live run, printed as JSON: the `count` (default 20) newest open issues that carry one of the maintainers' labels, and the
// label map. Read-only GETs (GITHUB_TOKEN optional). It runs before the workflow, outside it: the classifier never sees which labels these issues carry.
const [repo, count = '20'] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) { console.error('usage: node pick-issues.mjs owner/name [count]'); process.exit(2); }
const MAPS = { 'expressjs/express': { bug: 'bug', enhancement: 'feature', docs: 'docs', question: 'question', 'awaiting more info': 'needs-info' } };
const labelMap = MAPS[repo];
if (!labelMap) { console.error(`no label map for ${repo}: add its maintainers' labels to MAPS`); process.exit(2); }
const token = process.env.GITHUB_TOKEN?.trim();
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agentrun-issue-triage-demo', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
const found = [];
for (let page = 1; found.length < Number(count) && page <= 10; page += 1) {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100&page=${page}`, { headers });
  if (!response.ok) { console.error(`GitHub answered ${response.status}`); process.exit(1); }
  const issues = await response.json();
  if (!issues.length) break;
  for (const issue of issues) if (!issue.pull_request && issue.labels.some((label) => Object.hasOwn(labelMap, label.name))) found.push(issue);
}
const picked = found.slice(0, Number(count));
const composition = {};
for (const issue of picked) { const name = issue.labels.map((label) => label.name).find((n) => Object.hasOwn(labelMap, n)); composition[labelMap[name]] = (composition[labelMap[name]] ?? 0) + 1; }
process.stderr.write(`picked ${picked.length} issues; maintainers' labels (mapped): ${JSON.stringify(composition)}\n`);
console.log(JSON.stringify({ repo, numbers: picked.map((issue) => issue.number), label_map: labelMap }));
