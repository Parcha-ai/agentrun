// The live run's GitHub tools: read-only GETs for the four things the workflow asks. The run needs no token: it makes two API requests per issue (the issue, memoized, and its timeline, memoized)
// and reads everything else from github.com and raw.githubusercontent.com, which the API's 60-requests-an-hour limit does not count: a linked pull request's title and state come from the
// timeline's own cross-reference event, its paths from `github.com/<repo>/pull/<n>.diff` (the first ten; GitHub cuts a very large diff short, and a pull request whose diff it will not give has no paths), and
// a file from `raw.githubusercontent.com/<repo>/<sha>/<path>` at the one commit the run was picked at. `GITHUB_TOKEN` is optional, read from the environment, sent only to api.github.com and never written anywhere.
// A rate limit (429, or 403 with none left) stops the run with that reason: it is not retried. The tools take a fetch so a test can stand in for GitHub.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const WEB = 'https://github.com';
const SHA = /^[0-9a-f]{40}$/;
const DIFF_PATHS = 10;
const BODY_CAP = 4_000;
const FILE_CAP = 40_000;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const PATHS = /\b(?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|html|css|yml|yaml)\b/g;

/** An error the entry may send again: a server failure or a rate limit. */
export class GithubError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) { super(message); this.name = 'GithubError'; this.status = status; this.retryable = retryable; }
}

type Fetch = typeof fetch;
export type Place = { root: string; work: string };

/** The two file operations a write is made of, so a test can see their order. */
export type Files = { writeFile: typeof writeFile; rename: typeof rename };

export function githubTools(env: NodeJS.ProcessEnv, fetcher: Fetch = fetch, files: Files = { writeFile, rename }) {
  const token = env.GITHUB_TOKEN?.trim();
  const cache = new Map<string, Promise<any>>();
  /** A failure names the status and the path, never a header. A rate limit is not retryable: a retry loop would spend the hour and leave a messy run. */
  const failure = (response: Response, path: string) => {
    const limited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    return new GithubError(limited ? `GitHub's rate limit stopped the run at GET ${path.split('?')[0]} (without a token it allows 60 API requests an hour)` : `GitHub answered ${response.status} for GET ${path.split('?')[0]}`, response.status, !limited && response.status >= 500);
  };
  const send = async (url: string, path: string, headers: Record<string, string>): Promise<Response> => {
    // A dropped connection is a failure the entry may send again, like a 5xx; the message names the path and nothing of the request.
    try { return await fetcher(url, { method: 'GET', headers: { 'User-Agent': 'agentrun-issue-triage-demo', ...headers } }); }
    catch { throw new GithubError(`GitHub could not be reached for GET ${path.split('?')[0]}`, 0, true); }
  };
  /** One API GET, once per path for the life of the process (the issue and its timeline are asked for by three calls each). A failed GET is not kept. */
  const get = (path: string): Promise<any> => {
    const kept = cache.get(path);
    if (kept) return kept;
    const request = (async () => {
      const response = await send(`${API}${path}`, path, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
      if (!response.ok) throw failure(response, path);
      return response.json();
    })();
    cache.set(path, request);
    request.catch(() => { if (cache.get(path) === request) cache.delete(path); });
    return request;
  };
  /** One GET of github.com or raw.githubusercontent.com: not an API request, and never sent a token. Undefined where the host says no (404, or a diff it will not give). */
  const getRaw = async (url: string, path: string, skip: number[]): Promise<Buffer | undefined> => {
    const response = await send(url, path, {});
    if (skip.includes(response.status)) return undefined;
    if (!response.ok) throw failure(response, path);
    return Buffer.from(await response.arrayBuffer());
  };
  const repoOf = (value: unknown) => { if (typeof value !== 'string' || !REPO.test(value) || value.split('/').some((part) => part === '.' || part === '..')) throw new Error('repo is owner/name'); return value; };
  const numberOf = (value: unknown) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new Error('number is a positive integer'); return n; };
  const shaOf = (value: unknown) => { if (typeof value !== 'string' || !SHA.test(value)) throw new Error('sha is a 40-character commit id'); return value; };
  const issueOf = (args: Record<string, unknown>) => get(`/repos/${repoOf(args.repo)}/issues/${numberOf(args.number)}`);
  type Event = { event?: string; source?: { issue?: { number: number; title?: string; state?: string; pull_request?: { merged_at?: string | null }; repository_url?: string } } };
  /** The pull requests that mention an issue (cross-references in its timeline), at most three: title, state and merge from the event itself, the paths changed from the pull request's diff. */
  const linked = async (args: Record<string, unknown>) => {
    const repo = repoOf(args.repo), number = numberOf(args.number);
    const events = await get(`/repos/${repo}/issues/${number}/timeline?per_page=100`) as Event[];
    const mentions = new Map<number, NonNullable<Event['source']>['issue']>();
    for (const event of events) {
      const issue = event.event === 'cross-referenced' ? event.source?.issue : undefined;
      if (issue?.pull_request && issue.repository_url?.endsWith(`/repos/${repo}`) && !mentions.has(issue.number)) mentions.set(issue.number, issue);
    }
    const prs = [];
    for (const [n, pr] of [...mentions].slice(0, 3)) {
      const diff = await getRaw(`${WEB}/${repo}/pull/${n}.diff`, `/${repo}/pull/${n}.diff`, [404, 406, 422]);
      const paths = [...new Set([...(diff?.toString('utf8').matchAll(/^diff --git a\/.+? b\/(.+)$/gm) ?? [])].map((match) => match[1]!))].slice(0, DIFF_PATHS);
      prs.push({ number: n, title: String(pr!.title ?? ''), state: pr!.pull_request!.merged_at ? 'merged' : String(pr!.state), paths });
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
    /** The files the issue or its pull requests name, at the run's one commit, written under `work/repo/` for the agent's read-only tools. A path that is not in the repository is skipped, one that escapes is refused. */
    github_code: async (args: Record<string, unknown>, context?: { place?: Place }) => {
      if (!context?.place) throw new Error('github_code needs the run place');
      const repo = repoOf(args.repo), sha = shaOf(args.sha);
      const issue = await issueOf(args);
      const named = [...new Set([...(String(issue.body ?? '').match(PATHS) ?? []), ...(await linked(args)).prs.flatMap((pr) => pr.paths)])].slice(0, 8);
      const written: string[] = [];
      for (const path of named) {
        const clean = normalize(path);
        if (clean.startsWith('..') || clean.startsWith(sep) || clean.split(sep).includes('..')) throw new Error(`a named path escapes the repository: ${path}`);
        const bytes = await getRaw(`${RAW}/${repo}/${sha}/${clean.split(sep).map(encodeURIComponent).join('/')}`, `/${repo}/${sha}/${clean}`, [404]);
        if (!bytes || bytes.length > FILE_CAP) continue;
        const at = join(context.place.work, 'repo', clean);
        await mkdir(dirname(at), { recursive: true });
        // Whole or not there: four issues run at once, and another's agent may read this path while it is written.
        const part = `${at}.${randomUUID()}.part`;
        await files.writeFile(part, bytes);
        await files.rename(part, at);
        written.push(clean);
      }
      return { paths: written };
    },
  };
}
