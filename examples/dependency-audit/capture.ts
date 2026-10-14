// node examples/dependency-audit/capture.ts <owner/repo> <commit> [--limit 24] [--out fixtures/<name>.json]
// Reads a public project's package.json (and its lockfile, if it keeps one) at a commit, then the registry, the advisory
// database and GitHub for each dependency it resolves, and keeps the facts for a scripted run to replay. It reads public pages
// only and changes nothing. The file says where every fact came from; a scripted run labels itself as a replay of it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { advisoryFacts, registryFacts, repoFacts, resolveDependencies, type AdvisoryFacts, type RegistryFacts, type RepoFacts } from './sources.ts';

export type Fixture = {
  format: 'agentrun.dependency-audit.fixture/1';
  project: string;
  source: { repo: string; commit: string; commit_date: string; package_json_sha256: string; captured: string };
  dependencies: Array<{ name: string; version: string }>;
  registry: Record<string, RegistryFacts>;
  advisories: Record<string, AdvisoryFacts>;
  repos: Record<string, RepoFacts | null>;
};

export const keyOf = (name: string, version: string) => `${name}@${version}`;

const raw = async (repo: string, commit: string, path: string): Promise<string | null> => {
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`, { signal: AbortSignal.timeout(30_000) });
  return response.status === 200 ? response.text() : null;
};

/** The day of a commit, from GitHub's public API; empty when it cannot be read. */
async function commitDate(repo: string, commit: string): Promise<string> {
  const headers: Record<string, string> = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const response = await fetch(`https://api.github.com/repos/${repo}/commits/${commit}`, { headers: { 'user-agent': 'agentrun-dependency-audit', ...headers }, signal: AbortSignal.timeout(30_000) });
  return response.status === 200 ? String(((await response.json()) as { commit?: { committer?: { date?: string } } }).commit?.committer?.date ?? '').slice(0, 10) : '';
}

export async function capture(repo: string, commit: string, limit = Infinity): Promise<Fixture> {
  const packageText = await raw(repo, commit, 'package.json');
  if (packageText === null) throw new Error(`${repo}@${commit} has no package.json`);
  const lockText = await raw(repo, commit, 'package-lock.json');
  const dependencies = await resolveDependencies(JSON.parse(packageText), lockText ? JSON.parse(lockText) : undefined, limit);
  const fixture: Fixture = {
    format: 'agentrun.dependency-audit.fixture/1', project: repo,
    source: { repo, commit, commit_date: await commitDate(repo, commit), package_json_sha256: createHash('sha256').update(packageText).digest('hex'), captured: new Date().toISOString() },
    dependencies: dependencies.map(({ name, version }) => ({ name, version })), registry: {}, advisories: {}, repos: {},
  };
  for (const { name, version } of dependencies) {
    const registry = await registryFacts(name, version);
    fixture.registry[keyOf(name, version)] = registry.facts;
    fixture.advisories[keyOf(name, version)] = (await advisoryFacts(name, version)).facts;
    const url = registry.facts.repository;
    if (url && !(url in fixture.repos)) fixture.repos[url] = (await repoFacts(url))?.facts ?? null;
  }
  return fixture;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { limit: { type: 'string' }, out: { type: 'string' } } });
  const [repo, commit] = positionals;
  if (!repo || !commit) throw new Error('usage: capture.ts <owner/repo> <commit> [--limit N] [--out file]');
  const fixture = await capture(repo, commit, values.limit ? Number(values.limit) : Infinity);
  const out = values.out ?? join(import.meta.dirname, 'fixtures', `${repo.replace('/', '__')}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${out}: ${fixture.dependencies.length} dependencies, ${Object.values(fixture.advisories).filter((a) => a.ids.length).length} with advisories, ${Object.values(fixture.registry).filter((r) => r.deprecated).length} deprecated, ${Object.values(fixture.registry).filter((r) => Object.keys(r.scripts).length).length} with install scripts, ${Object.values(fixture.repos).filter((r) => r?.archived).length} archived repositories`);
}
