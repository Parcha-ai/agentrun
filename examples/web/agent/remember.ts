// "What I remember": a small page the host writes beside the agent's report when the run lets go, so the person sees
// what the agent keeps for next time: the sites it is signed in to and since when, and its preferences. Never a
// profile's ref. Script-free, like the report, and nothing loaded from the network: sites are written as text.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PREFERENCES_FILE } from './preferences.ts';

export const REMEMBER_PAGE = 'remember.html';

const escape = (text: string) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);
const hostOf = (origin: string) => URL.parse(origin)?.host ?? null;

/** The page's HTML: `signIns` as `{ sites: origins[], verifiedAt? }`, `preferences` the workspace file's text or null. */
export type SignIn = { sites?: string[]; verifiedAt?: string | null };

export function rememberHtml({ signIns, preferences }: { signIns: SignIn[]; preferences: string | null }): string {
  const sites = signIns.flatMap((signIn) => (signIn.sites ?? []).map(hostOf).filter((host): host is string => Boolean(host)).map((host) => ({ host, verifiedAt: signIn.verifiedAt ?? null })));
  const lines = (preferences ?? '').split('\n').map((line) => line.replace(/^\s*[-*]\s+/, '').trim()).filter((line) => line && !line.startsWith('#'));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What I remember</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}li{margin:.25rem 0}.none{opacity:.7}</style>
</head>
<body>
<h1>What I remember</h1>
<h2>Signed in</h2>
${sites.length ? `<ul>\n${sites.map((site) => `<li>${escape(site.host)}${site.verifiedAt ? `, checked ${escape(site.verifiedAt)}` : ''}</li>`).join('\n')}\n</ul>` : '<p class="none">No site.</p>'}
<h2>Your preferences</h2>
${lines.length ? `<ul>\n${lines.map((line) => `<li>${escape(line)}</li>`).join('\n')}\n</ul>` : '<p class="none">None yet.</p>'}
<p><a href="index.html">Back to the report</a></p>
</body>
</html>
`;
}

/** Beside the agent's report, when there is one: `work/report/remember.html`. Returns whether it wrote. */
export async function writeRememberPage(workDir: string, { signIns }: { signIns: SignIn[] }): Promise<boolean> {
  const report = join(workDir, 'report');
  if (!existsSync(join(report, 'index.html'))) return false;
  const preferences = await readFile(join(workDir, PREFERENCES_FILE), 'utf8').catch(() => null);
  await writeFile(join(report, REMEMBER_PAGE), rememberHtml({ signIns, preferences }));
  return true;
}
