// The result as the recording keeps it: the agent's report (its page under report/ and every picture and clip it shows)
// kept as blobs, and a cited record whose one row is the answer, citing every look the report cites, by its key, at
// the file's own fragment, labelled as the report labels it.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DemoOptions } from '@parcha/agentrun-harness';

type Cite = { look?: string; blob?: string; fragment?: string; note?: string };

/** Every file under a folder, as paths relative to it. A link is not followed: the report is the files under it. */
const walk = (root: string, at = root): string[] => readdirSync(at).flatMap((name) => {
  const path = join(at, name);
  const entry = lstatSync(path);
  return entry.isDirectory() ? walk(root, path) : entry.isFile() ? [relative(root, path)] : [];
});

/** Whether `path` names something inside `folder`, by its parts alone: no `..` takes it out. */
const inside = (folder: string, path: string) => { const rel = relative(folder, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export const result: NonNullable<DemoOptions['result']> = (record, { dir, keep }) => {
  const answer = record as { answer: string; report: string };
  const work = join(dir, 'work');
  const folder = join(work, 'report');
  const html = resolve(work, answer.report);
  const none = (note?: string) => ({ json: { format: 'agentrun.cited/1', title: answer.answer, rows: [{ label: 'Answer', value: answer.answer, ...(note ? { note } : {}), cites: [] }], report: null }, title: answer.answer });
  // The page is read only from under report/, and only where the files kept with it are: a path that leaves report/ by
  // its parts, or that passes through a link (report/ itself, a folder in it, or the page), is no report, and nothing it
  // names is read.
  const refused = () => none(`No report was kept: ${JSON.stringify(answer.report)} is not a file under report/.`);
  if (!inside(folder, html)) return refused();
  if (!existsSync(html)) return none();
  const unlinked = lstatSync(folder).isDirectory() && join(realpathSync(dirname(html)), basename(html)) === join(realpathSync(folder), relative(folder, html));
  if (!unlinked || !lstatSync(html).isFile()) return refused();
  const files = Object.fromEntries(walk(folder).map((name) => [name, keep(new Uint8Array(readFileSync(join(folder, name))), extname(name).slice(1) || 'bin')]));
  const page = readFileSync(html, 'utf8');
  // The report's cites, as the report skill writes them: a link to the file's own fragment with the look's key.
  const cites: Cite[] = [...page.matchAll(/<a\b[^>]*\bclass="cite"[^>]*>[\s\S]*?<\/a>/g)].flatMap(([tag]) => {
    const href = (/\bhref="([^"]*)"/.exec(tag)?.[1] ?? '').replaceAll('&amp;', '&');
    const look = /\bdata-look="([0-9a-f]{64})"/.exec(tag)?.[1];
    const label = tag.replace(/<[^>]*>/g, '').trim();
    return look ? [{ look, fragment: href.includes('#') ? href.slice(href.indexOf('#')) : '', note: label }] : [];
  });
  return {
    json: { format: 'agentrun.cited/1', title: answer.answer, rows: [{ label: 'Answer', value: answer.answer, cites }], report: { page: answer.report, files } },
    title: answer.answer,
  };
};
