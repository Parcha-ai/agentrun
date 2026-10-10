import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const MAX_SOP_BYTES = 512 * 1024;

export interface SopText { text: string; sha256: string }

export const sopDigest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The SOP text of a regular file inside `cwd`; a path that resolves outside it, or a file over the bound, is refused. */
export async function readSopFile(cwd: string, file: string): Promise<SopText & { file: string }> {
  if (!file.trim() || file.includes('\0')) throw new Error('Use /agentrun sop <file>, a path inside this project.');
  const root = await realpath(cwd);
  const target = await realpath(resolve(cwd, file)).catch(() => { throw new Error(`SOP file not found: ${file}`); });
  const inside = relative(root, target);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('The SOP file must be inside this project.');
  const info = await lstat(target);
  if (!info.isFile()) throw new Error('The SOP must be a regular file.');
  if (info.size > MAX_SOP_BYTES) throw new Error(`The SOP file is larger than ${MAX_SOP_BYTES / 1024} KiB.`);
  const text = (await readFile(target, 'utf8')).replace(/^﻿/, '');
  if (!text.trim()) throw new Error('The SOP file is empty.');
  return { file: inside.split(sep).join('/'), text, sha256: sopDigest(text) };
}

/** The sections a workflow names that the SOP has no `## <section>` heading line for. */
export function missingSopSections(text: string, sections: readonly string[]): string[] {
  const headings = new Set(text.split(/\r?\n/).filter(line => line.startsWith('## ')).map(line => line.trimEnd().slice(3)));
  return sections.filter(section => !headings.has(section));
}
