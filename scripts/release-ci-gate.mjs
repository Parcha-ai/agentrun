// The release's precondition: the tagged commit passed the required checks when it reached main. The release trusts that run
// instead of running the suites again, so anything it cannot read as a pass stops the release.
//   node scripts/release-ci-gate.mjs   (GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN; exits 0 only on a pass)
import { pathToFileURL } from 'node:url';

// The verify gates the main ruleset requires. Every other `verify (<node>)` gate of the run must pass as well; jobs that are
// not gates (real-chrome, the pi legs, lean) do not stop a release.
export const REQUIRED_GATES = ['verify (22.19.0)', 'verify (22.23.2)'];

/**
 * The verdict on ci.yml's push runs on main for one commit, newest first, each with the latest attempt of its jobs:
 * `{ pass: true, run }`, or `{ pass: false, reason }` for anything else, input that is not the expected shape included.
 */
export function ciVerdict(sha, runs) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) return { pass: false, reason: `not a commit sha: ${JSON.stringify(sha)}` };
  if (!Array.isArray(runs)) return { pass: false, reason: 'the CI runs could not be read' };
  const own = runs.filter(run => run?.head_sha === sha && run?.event === 'push' && run?.head_branch === 'main');
  if (!own.length) return { pass: false, reason: `ci.yml has no push run on main for ${sha}` };
  const run = own[0];
  if (run.status !== 'completed') return { pass: false, reason: `ci.yml run ${run.id} on ${sha} is ${run.status}; wait for it to finish` };
  if (!Array.isArray(run.jobs)) return { pass: false, reason: `the jobs of ci.yml run ${run.id} could not be read` };
  const gates = run.jobs.filter(job => typeof job?.name === 'string' && /^verify \(.+\)$/.test(job.name));
  for (const name of REQUIRED_GATES) if (!gates.some(job => job.name === name)) return { pass: false, reason: `ci.yml run ${run.id} has no ${name} job` };
  const red = gates.filter(job => job.conclusion !== 'success');
  if (red.length) return { pass: false, reason: `ci.yml run ${run.id}: ${red.map(job => `${job.name} is ${job.conclusion ?? job.status}`).join(', ')}` };
  return { pass: true, run: run.id };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(path, token, fetchImpl, wait) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(`https://api.github.com/${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) }).catch(error => ({ ok: false, status: error.name }));
    if (response.ok) return response.json();
    if (attempt === 3) throw new Error(`GitHub answered ${response.status} for ${path}`);
    await wait(10_000);
  }
}

/** Reads the push runs on main for `sha` and the latest attempt of the newest run's jobs, then returns `ciVerdict`. */
export async function readCiVerdict({ repository, sha, token, fetchImpl = fetch, wait = sleep }) {
  const { workflow_runs: runs } = await api(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=20`, token, fetchImpl, wait);
  const newest = Array.isArray(runs) ? runs.find(run => run?.head_sha === sha && run?.event === 'push' && run?.head_branch === 'main') : undefined;
  if (newest?.status === 'completed') newest.jobs = (await api(`repos/${repository}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`, token, fetchImpl, wait)).jobs;
  return ciVerdict(sha, runs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GH_TOKEN: token } = process.env;
  try {
    const verdict = await readCiVerdict({ repository, sha, token });
    if (verdict.pass) console.log(`ci.yml run ${verdict.run} passed every verify gate on main for ${sha}`);
    else { console.error(`::error::${verdict.reason}`); process.exitCode = 1; }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : 'the CI verdict could not be read'}`);
    process.exitCode = 1;
  }
}
