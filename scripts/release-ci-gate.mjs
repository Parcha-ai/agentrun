// The release's precondition: the tagged commit passed every check main's ruleset requires when it reached main. The release
// trusts that run instead of running the suites again, so anything it cannot read as a pass stops the release.
//   node scripts/release-ci-gate.mjs   (GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN; exits 0 only on a pass)
import { isMain } from './is-main.mjs';

/**
 * The checks main's rulesets require (verify and lean today), from GET /repos/{repo}/rules/branches/main: every
 * required_status_checks rule's contexts, in order, once each. A ruleset that requires none gives a release nothing to trust.
 */
export function requiredChecks(rules) {
  if (!Array.isArray(rules)) throw new Error('the rules of main could not be read');
  const contexts = rules.filter(rule => rule?.type === 'required_status_checks')
    .flatMap(rule => (Array.isArray(rule.parameters?.required_status_checks) ? rule.parameters.required_status_checks : []))
    .map(check => check?.context).filter(context => typeof context === 'string' && context);
  if (!contexts.length) throw new Error('the ruleset of main requires no status check, so no CI run can vouch for a release');
  return [...new Set(contexts)];
}

/**
 * The verdict on ci.yml's push runs on main for one commit, newest first, each with the latest attempt of its jobs:
 * `{ pass: true, run, checks }` when the newest run of exactly `sha` concluded `success` on a job named exactly each of
 * `required`, or `{ pass: false, reason }` for anything else, input that is not the expected shape included. A merge-queue
 * run, a pull request's run or a run of another commit is never the verdict, even where its commit matches.
 */
export function ciVerdict(sha, runs, required) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) return { pass: false, reason: `not a commit sha: ${JSON.stringify(sha)}` };
  if (!Array.isArray(required) || !required.length) return { pass: false, reason: 'no required check to hold the run to' };
  if (!Array.isArray(runs)) return { pass: false, reason: 'the CI runs could not be read' };
  const own = runs.filter(run => run?.head_sha === sha && run?.event === 'push' && run?.head_branch === 'main');
  if (!own.length) return { pass: false, reason: `ci.yml has no push run on main for ${sha}` };
  const run = own[0];
  if (run.status !== 'completed') return { pass: false, reason: `ci.yml run ${run.id} on ${sha} is ${run.status}; wait for it to finish` };
  if (!Array.isArray(run.jobs)) return { pass: false, reason: `the jobs of ci.yml run ${run.id} could not be read` };
  for (const name of required) if (!run.jobs.some(job => job?.name === name)) return { pass: false, reason: `ci.yml run ${run.id} has no ${name} job` };
  const red = run.jobs.filter(job => required.includes(job?.name) && job.conclusion !== 'success');
  if (red.length) return { pass: false, reason: `ci.yml run ${run.id}: ${red.map(job => `${job.name} is ${job.conclusion ?? job.status}`).join(', ')}` };
  return { pass: true, run: run.id, checks: [...required] };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * GETs `url` as JSON, three attempts 10 s apart; a request that never got an answer counts as a failed attempt. With `absent`,
 * a 404 is that value instead of a failure. Anything else that is not a 2xx throws, naming the status.
 */
export async function getJson(url, { token, fetchImpl = fetch, wait = sleep, absent, accept = 'application/vnd.github+json' } = {}) {
  const headers = { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) }).catch(error => ({ ok: false, status: error.name }));
    if (response.ok) return response.json();
    if (response.status === 404 && absent !== undefined) return absent;
    if (attempt === 3) {
      const { host, pathname, search } = new URL(url);
      throw new Error(`${host === 'api.github.com' ? 'GitHub' : host} answered ${response.status} for ${pathname.slice(1)}${search}`);
    }
    await wait(10_000);
  }
}

const api = (path, token, fetchImpl, wait) => getJson(`https://api.github.com/${path}`, { token, fetchImpl, wait });

/** Reads main's required checks, the push runs on main for `sha` and the latest attempt of the newest run's jobs, then returns `ciVerdict`. */
export async function readCiVerdict({ repository, sha, token, fetchImpl = fetch, wait = sleep }) {
  const required = requiredChecks(await api(`repos/${repository}/rules/branches/main`, token, fetchImpl, wait));
  const { workflow_runs: runs } = await api(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`, token, fetchImpl, wait);
  const newest = Array.isArray(runs) ? runs.find(run => run?.head_sha === sha && run?.event === 'push' && run?.head_branch === 'main') : undefined;
  if (newest?.status === 'completed') newest.jobs = (await api(`repos/${repository}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`, token, fetchImpl, wait)).jobs;
  return ciVerdict(sha, runs, required);
}

if (isMain(import.meta)) {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GH_TOKEN: token } = process.env;
  try {
    const verdict = await readCiVerdict({ repository, sha, token });
    if (verdict.pass) console.log(`ci.yml run ${verdict.run}, the push run on main of ${sha}, passed every required check (${verdict.checks.join(', ')})`);
    else { console.error(`::error::${verdict.reason}`); process.exitCode = 1; }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : 'the CI verdict could not be read'}`);
    process.exitCode = 1;
  }
}
