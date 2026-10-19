// "What I remember": a small page the host writes beside the agent's report when the run lets go, so the person sees
// what the agent keeps for next time: the sites it is signed in to and when that was last checked, its memory files with
// their text, and its runs. Never a profile's ref. Script-free, like the report, and nothing loaded from the network:
// sites are written as text.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_DIR, MEMORY_NAME, type MemoryFile } from './memory.ts';

export const REMEMBER_PAGE = 'remember.html';

const escape = (text: string) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);
const hostOf = (origin: string) => URL.parse(origin)?.host ?? null;

/** A saved sign-in as the page shows it: its sites (origins) and when it last worked. */
export type SignIn = { sites?: string[]; verifiedAt?: string | null };
/** A run as the page lists it: when it started, and how it ended (absent while it runs). */
export type RunLine = { startedAt: string; outcome?: string | null };

/** The page's HTML. A memory file's text is shown as it is, in a `<pre>`. */
export function rememberHtml({ signIns, memory, runs }: { signIns: SignIn[]; memory: MemoryFile[]; runs: RunLine[] }): string {
  const sites = signIns.flatMap((signIn) => (signIn.sites ?? []).map(hostOf).filter((host): host is string => Boolean(host)).map((host) => ({ host, verifiedAt: signIn.verifiedAt ?? null })));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What I remember</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}li{margin:.25rem 0}pre{white-space:pre-wrap;padding:.5rem .75rem;border-left:3px solid #8888}.none{opacity:.7}</style>
</head>
<body>
<h1>What I remember</h1>
<h2>Signed in</h2>
${sites.length ? `<ul>\n${sites.map((site) => `<li>${escape(site.host)}${site.verifiedAt ? `, checked ${escape(site.verifiedAt)}` : ''}</li>`).join('\n')}\n</ul>` : '<p class="none">No site.</p>'}
<h2>My memory</h2>
${memory.length ? memory.map((file) => `<h3>${escape(file.name)}</h3>\n<pre>${escape(file.text.trimEnd())}</pre>`).join('\n') : '<p class="none">Nothing yet.</p>'}
<h2>Runs</h2>
${runs.length ? `<ul>\n${runs.map((run) => `<li>${escape(run.startedAt)}${run.outcome ? `, ${escape(run.outcome)}` : ', this run'}</li>`).join('\n')}\n</ul>` : '<p class="none">None.</p>'}
<p><a href="index.html">Back to the report</a></p>
</body>
</html>
`;
}

/** Beside the agent's report, when there is one: `work/report/remember.html`, with the run's `work/memory/` files.
 *  Returns whether it wrote. */
export async function writeRememberPage(workDir: string, { signIns, runs }: { signIns: SignIn[]; runs: RunLine[] }): Promise<boolean> {
  const report = join(workDir, 'report');
  if (!existsSync(join(report, 'index.html'))) return false;
  const dir = join(workDir, MEMORY_DIR);
  const names = existsSync(dir) ? (await readdir(dir)).filter((name) => MEMORY_NAME.test(name)).sort() : [];
  const memory = await Promise.all(names.map(async (name) => ({ name, text: await readFile(join(dir, name), 'utf8') })));
  await writeFile(join(report, REMEMBER_PAGE), rememberHtml({ signIns, memory, runs }));
  return true;
}
