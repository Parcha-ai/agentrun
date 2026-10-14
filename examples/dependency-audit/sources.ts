// The public sources the audit reads, as plain fetches: the npm registry, the OSV database, and GitHub's public REST API. The
// live tools call them as the run goes, and `capture.ts` calls them once to keep what a scripted run replays. No key is
// needed; a GITHUB_TOKEN raises GitHub's hourly limit from 60 requests.

export type RegistryFacts = {
  name: string; version: string;
  /** The https URL of the source repository, or an empty string. */
  repository: string;
  /** The registry's deprecation message for this version, or an empty string. */
  deprecated: string;
  /** The install-time scripts the version declares. */
  scripts: Record<string, string>;
  license: string;
};
export type AdvisoryFacts = { ids: string[]; summaries: Record<string, string>; /** The day each advisory was published. */ published: Record<string, string> };
export type RepoFacts = { url: string; archived: boolean; archived_on: string; pushed_at: string; last_release: string; last_release_tag: string };

const json = async (url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; text: string }> => {
  const response = await fetch(url, { ...init, headers: { 'user-agent': 'agentrun-dependency-audit', accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body, text };
};

export type BadgeFacts = { url: string; alt: string; label: 'build' | 'coverage' | 'version' | 'other'; svg: string };

const labelOf = (text: string): BadgeFacts['label'] => (/coverage|codecov|coveralls/i.test(text) ? 'coverage' : /build|\bci\b|workflow|actions|travis|circle|test/i.test(text) ? 'build' : /npm|version|release|\bv\d/i.test(text) ? 'version' : 'other');

/** Up to `limit` README badges of a public GitHub repository: the images its README shows by https that are SVGs (shields.io, GitHub
 *  Actions, codecov and the like), each fetched whole. A repository with no README, or none of these, has none. */
export async function badgeFacts(url: string, limit = 3): Promise<BadgeFacts[]> {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(url);
  if (!match) return [];
  const headers: Record<string, string> = { 'user-agent': 'agentrun-dependency-audit', accept: 'application/vnd.github.raw+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const readme = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/readme`, { headers, signal: AbortSignal.timeout(30_000) });
  if (readme.status !== 200) return [];
  const text = await readme.text();
  const found: Array<{ url: string; alt: string }> = [];
  for (const image of text.matchAll(/!\[([^\]]*)\]\((https:\/\/[^)\s]+)[^)]*\)|<img[^>]*?src=["'](https:\/\/[^"']+)["'][^>]*?(?:alt=["']([^"']*)["'])?[^>]*>/g)) {
    const href = image[2] ?? image[3];
    if (href && /shields\.io|badge|\.svg(?:$|\?)|codecov|coveralls/i.test(href) && !found.some((other) => other.url === href)) found.push({ url: href, alt: image[1] ?? image[4] ?? '' });
  }
  const out: BadgeFacts[] = [];
  for (const { url: href, alt } of found) {
    if (out.length >= limit) break;
    try {
      const response = await fetch(href, { headers: { 'user-agent': 'agentrun-dependency-audit' }, signal: AbortSignal.timeout(20_000), redirect: 'follow' });
      const svg = await response.text();
      if (response.status === 200 && svg.length <= 256 * 1024 && /<svg[\s>]/.test(svg)) out.push({ url: href, alt, label: labelOf(`${alt} ${href}`), svg });
    } catch { /* an unreachable badge is not one */ }
  }
  return out;
}

/** `git+https://github.com/o/r.git`, `github:o/r`, `git://…` and `https://…` forms as one https URL; empty when it is none. */
export function repositoryUrl(field: unknown): string {
  const raw = typeof field === 'string' ? field : (field as { url?: unknown } | null | undefined)?.url;
  if (typeof raw !== 'string') return '';
  const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
  if (short) return `https://github.com/${short[1]!.replace(/\.git$/, '')}`;
  const match = /(?:github\.com|gitlab\.com|bitbucket\.org)[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[#/].*)?$/.exec(raw);
  const host = /github\.com/.test(raw) ? 'github.com' : /gitlab\.com/.test(raw) ? 'gitlab.com' : 'bitbucket.org';
  return match ? `https://${host}/${match[1]}` : '';
}

export async function registryFacts(name: string, version: string): Promise<{ facts: RegistryFacts; raw: string }> {
  const { status, body, text } = await json(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`);
  if (status !== 200 || !body || typeof body !== 'object') throw Object.assign(new Error(`registry answered ${status} for ${name}@${version}`), { code: status >= 500 ? 'http_5xx' : 'not_found' });
  const doc = body as { repository?: unknown; deprecated?: unknown; scripts?: Record<string, string>; license?: unknown };
  const scripts = Object.fromEntries(['preinstall', 'install', 'postinstall'].flatMap((key) => (doc.scripts?.[key] ? [[key, doc.scripts[key]!]] : [])));
  return { facts: { name, version, repository: repositoryUrl(doc.repository), deprecated: typeof doc.deprecated === 'string' ? doc.deprecated : '', scripts, license: typeof doc.license === 'string' ? doc.license : '' }, raw: text };
}

export async function advisoryFacts(name: string, version: string): Promise<{ facts: AdvisoryFacts; raw: string }> {
  const { status, body, text } = await json('https://api.osv.dev/v1/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ package: { name, ecosystem: 'npm' }, version }) });
  if (status !== 200) throw Object.assign(new Error(`OSV answered ${status} for ${name}@${version}`), { code: status >= 500 ? 'http_5xx' : 'bad_query' });
  const vulns = ((body as { vulns?: Array<{ id: string; summary?: string; withdrawn?: string; published?: string }> } | null)?.vulns ?? []).filter((vuln) => !vuln.withdrawn);
  return { facts: { ids: vulns.map((vuln) => vuln.id).sort(), summaries: Object.fromEntries(vulns.map((vuln) => [vuln.id, vuln.summary ?? ''])), published: Object.fromEntries(vulns.map((vuln) => [vuln.id, (vuln.published ?? '').slice(0, 10)])) }, raw: text };
}

export async function repoFacts(url: string): Promise<{ facts: RepoFacts; raw: string } | null> {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(url);
  if (!match) return null;
  const headers: Record<string, string> = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const repo = await json(`https://api.github.com/repos/${match[1]}/${match[2]}`, { headers });
  if (repo.status !== 200) return null;
  const meta = repo.body as { archived?: boolean; pushed_at?: string };
  const release = await json(`https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`, { headers });
  const latest = release.status === 200 ? release.body as { published_at?: string; tag_name?: string } : {};
  return {
    facts: { url, archived: meta.archived === true, archived_on: '', pushed_at: meta.pushed_at ?? '', last_release: latest.published_at ?? '', last_release_tag: latest.tag_name ?? '' },
    raw: repo.text,
  };
}

/** The highest version a range allows, from the versions the registry lists. Exact pins pass through. Handles `^`, `~`, `>=`, `x`
 *  ranges and bare majors, which is what a package.json holds; anything else is left unresolved (null). */
export function resolveRange(spec: string, versions: string[]): string | null {
  const stable = versions.filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  const parse = (version: string) => version.split('.').map(Number) as [number, number, number];
  const cmp = (a: string, b: string) => { const [x, y] = [parse(a), parse(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  const pick = (ok: (version: string) => boolean) => stable.filter(ok).sort(cmp).at(-1) ?? null;
  const text = spec.trim();
  if (/^\d+\.\d+\.\d+$/.test(text)) return stable.includes(text) ? text : null;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (caret) {
    const [major, minor, patch] = caret.slice(1).map(Number) as [number, number, number];
    return pick((version) => { const v = parse(version); return cmp(version, `${major}.${minor}.${patch}`) >= 0 && (major > 0 ? v[0] === major : minor > 0 ? v[0] === 0 && v[1] === minor : v[0] === 0 && v[1] === 0 && v[2] === patch); });
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tilde) { const [major, minor, patch] = tilde.slice(1).map(Number) as [number, number, number]; return pick((version) => { const v = parse(version); return v[0] === major && v[1] === minor && cmp(version, `${major}.${minor}.${patch}`) >= 0; }); }
  const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (floor) return pick((version) => cmp(version, `${floor[1]}.${floor[2]}.${floor[3]}`) >= 0);
  const wild = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(?:x|\*))?$/.exec(text);
  if (wild) { const [major, minor] = [Number(wild[1]), wild[2] !== undefined && /^\d+$/.test(wild[2]) ? Number(wild[2]) : undefined]; return pick((version) => { const v = parse(version); return v[0] === major && (minor === undefined || v[1] === minor); }); }
  if (text === '*' || text === 'latest' || text === '') return pick(() => true);
  return null;
}

export async function versionsOf(name: string): Promise<string[]> {
  const { status, body } = await json(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
  if (status !== 200) throw Object.assign(new Error(`registry answered ${status} for ${name}`), { code: 'not_found' });
  return Object.keys((body as { versions?: Record<string, unknown> }).versions ?? {});
}

/** The dependencies of a package.json with the version each resolves to: the lockfile's when one is given, else the range's highest. */
export async function resolveDependencies(pkg: { dependencies?: Record<string, string> }, lock?: { packages?: Record<string, { version?: string }> }, limit = Infinity): Promise<Array<{ name: string; version: string; spec: string }>> {
  const out: Array<{ name: string; version: string; spec: string }> = [];
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (out.length >= limit) break;
    if (/^(?:file|link|git|github|https?):|\//.test(spec) && !spec.startsWith('@')) continue;
    const locked = lock?.packages?.[`node_modules/${name}`]?.version;
    const version = locked ?? resolveRange(spec, await versionsOf(name));
    if (version) out.push({ name, version, spec });
  }
  return out;
}
