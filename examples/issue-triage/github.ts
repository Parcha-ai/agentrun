// The live run's GitHub tools: read-only REST calls (GET only) for the five things the workflow asks. `GITHUB_TOKEN` is optional (without it GitHub allows 60 requests an hour,
// which twenty issues overrun); it is read from the environment, sent only to api.github.com and never written anywhere. The tools take a fetch so a test can stand in for GitHub.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

const API = 'https://api.github.com';
const BODY_CAP = 4_000;
const FILE_CAP = 40_000;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const PATHS = /\b(?:[\w.-]+\/)+[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|html|css|yml|yaml)\b/g;

/** An error the entry may send again: a server failure or a rate limit. */
export class GithubError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) { super(message); this.name = 'GithubError'; this.status = status; this.retryable = retryable; }
}

type Fetch = typeof fetch;
export type Place = { root: string; work: string };

export function githubTools(env: NodeJS.ProcessEnv, fetcher: Fetch = fetch) {
  const token = env.GITHUB_TOKEN?.trim();
  /** One GET. The failure names the status and the path, never a header. */
  const get = async (path: string): Promise<any> => {
    const response = await fetcher(`${API}${path}`, { method: 'GET', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agentrun-issue-triage-demo', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!response.ok) throw new GithubError(`GitHub answered ${response.status} for GET ${path.split('?')[0]}`, response.status, response.status >= 500 || response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'));
    return response.json();
  };
  const repoOf = (value: unknown) => { if (typeof value !== 'string' || !REPO.test(value) || value.split('/').some((part) => part === '.' || part === '..')) throw new Error('repo is owner/name'); return value; };
  const numberOf = (value: unknown) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new Error('number is a positive integer'); return n; };
  const issueOf = (args: Record<string, unknown>) => get(`/repos/${repoOf(args.repo)}/issues/${numberOf(args.number)}`);
  /** The pull requests that mention an issue (cross-references in its timeline), at most three, each with the paths it changes. */
  const linked = async (args: Record<string, unknown>) => {
    const repo = repoOf(args.repo), number = numberOf(args.number);
    const events = await get(`/repos/${repo}/issues/${number}/timeline?per_page=100`) as Array<{ event?: string; source?: { issue?: { number: number; pull_request?: unknown; repository_url?: string } } }>;
    const numbers = [...new Set(events.flatMap((event) => (event.event === 'cross-referenced' && event.source?.issue?.pull_request && event.source.issue.repository_url?.endsWith(`/repos/${repo}`) ? [event.source.issue.number] : [])))].slice(0, 3);
    const prs = [];
    for (const n of numbers) {
      const pr = await get(`/repos/${repo}/pulls/${n}`);
      const files = await get(`/repos/${repo}/pulls/${n}/files?per_page=30`) as Array<{ filename: string }>;
      prs.push({ number: n, title: String(pr.title), state: pr.merged_at ? 'merged' : String(pr.state), paths: files.slice(0, 10).map((file) => file.filename) });
    }
    return { prs };
  };
  return {
    /** The issue as the classifier may see it: no labels. */
    github_issue: async (args: Record<string, unknown>) => {
      const issue = await issueOf(args);
      return { number: issue.number, title: String(issue.title), body: String(issue.body ?? '').slice(0, BODY_CAP), url: String(issue.html_url) };
    },
    /** The maintainers' labels, a call of its own: the workflow asks for it after both judgments. */
    github_labels: async (args: Record<string, unknown>) => ({ labels: ((await issueOf(args)).labels as Array<string | { name?: string }>).map((label) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean) }),
    github_linked_prs: linked,
    /** The files the issue or its pull requests name, written under `work/repo/` for the agent's read-only tools. A path that is not in the repository is skipped, one that escapes is refused. */
    github_code: async (args: Record<string, unknown>, context?: { place?: Place }) => {
      if (!context?.place) throw new Error('github_code needs the run place');
      const repo = repoOf(args.repo);
      const issue = await issueOf(args);
      const named = [...new Set([...(String(issue.body ?? '').match(PATHS) ?? []), ...(await linked(args)).prs.flatMap((pr) => pr.paths)])].slice(0, 8);
      const written: string[] = [];
      for (const path of named) {
        const clean = normalize(path);
        if (clean.startsWith('..') || clean.startsWith(sep) || clean.split(sep).includes('..')) throw new Error(`a named path escapes the repository: ${path}`);
        let file: { content?: string; size?: number; type?: string };
        try { file = await get(`/repos/${repo}/contents/${clean.split(sep).map(encodeURIComponent).join('/')}`); } catch (error) { if ((error as GithubError).status === 404) continue; throw error; }
        if (file.type !== 'file' || typeof file.content !== 'string' || (file.size ?? 0) > FILE_CAP) continue;
        const at = join(context.place.work, 'repo', clean);
        await mkdir(dirname(at), { recursive: true });
        await writeFile(at, Buffer.from(file.content, 'base64'));
        written.push(clean);
      }
      return { paths: written };
    },
  };
}
