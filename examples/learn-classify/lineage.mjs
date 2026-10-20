// Which workflows a run gave main (CLASSIFY-CONTRACT.md v3): each one curate admitted at the run is born when main did not
// hold its name at the run's seed, and rewritten when it did, with the digest main's `latest` names right after the run.
import { execFileSync } from 'node:child_process';

const WORKFLOWS = '.pi/agentrun/workflows';

/** `admitted` are the names curate admitted at the run; `read(path, sha)` and `list(prefix, sha)` read the agent
 *  repository (a pi-git-remote Repo has both, and so does `bareRepoReader`). */
export async function lineageOf({ admitted = [], seedSha, afterSha, read, list }) {
  const born = [];
  const rewritten = [];
  for (const name of admitted) {
    const held = (await list(`${WORKFLOWS}/${name}`, seedSha)).length > 0;
    const revision = (await read(`${WORKFLOWS}/${name}/latest`, afterSha))?.trim() || null;
    (held ? rewritten : born).push({ name, revision });
  }
  return { born, rewritten };
}

/** The agent repository's bare remote, read with plain git and never written: what a finished pass keeps. */
export function bareRepoReader(gitDir) {
  const git = (args) => execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  return {
    read: async (path, sha) => { try { return git(['show', `${sha}:${path}`]); } catch { return undefined; } },
    list: async (prefix, sha) => { try { return git(['ls-tree', '-r', '--name-only', sha, '--', prefix]).split('\n').filter(Boolean).map((path) => ({ path, type: 'blob' })); } catch { return []; } },
  };
}
