// The result as the recording keeps it: the agent's report (its page under report/ and every picture and clip it shows)
// kept as blobs, and a cited record whose one row is the answer, citing every look the report cites, by its key, at
// the file's own fragment, labelled as the report labels it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { DemoOptions } from '@parcha/agentrun-reference';

type Cite = { look?: string; blob?: string; fragment?: string; note?: string };

/** Every file under a folder, as paths relative to it. */
const walk = (root: string, at = root): string[] => readdirSync(at).flatMap((name) => {
  const path = join(at, name);
  return statSync(path).isDirectory() ? walk(root, path) : [relative(root, path)];
});

export const result: NonNullable<DemoOptions['result']> = (record, { dir, keep }) => {
  const answer = record as { answer: string; report: string };
  const work = join(dir, 'work');
  const html = join(work, answer.report);
  if (!existsSync(html)) return { json: { format: 'agentrun.cited/1', title: answer.answer, rows: [{ label: 'Answer', value: answer.answer, cites: [] }], report: null }, title: answer.answer };
  const folder = join(work, 'report');
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
