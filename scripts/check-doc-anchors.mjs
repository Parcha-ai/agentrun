// Every relative link with a #fragment in a tracked Markdown file lands on a heading or anchor: a renamed heading once left
// 16 links in packages/computer/SCORECARD.md pointing at a fragment nothing made. A link's target is another tracked .md
// file (a path relative to the linking file, or to the repo root with a leading /) or, with `#fragment` alone, the same
// file. A fragment exists when a heading in the target makes it by GitHub's slug rule (the heading's text, lower case,
// with every character but letters, digits, `_`, `-` and spaces dropped, spaces turned to `-`; a repeated slug gets `-1`,
// `-2`, ...) or when the target has an `<a id>` or `<a name>` anchor of that name. A fragment link to a tracked-looking
// .md path that is not tracked fails too. Not read: external URLs, links without a fragment, links to files that are not
// Markdown, front matter, fenced code blocks (in a block quote or list item too), inline code and HTML comments.
// `node scripts/check-doc-anchors.mjs` exits non-zero with one line per broken link; check-doc-anchors.test.mjs runs it on
// this tree and on planted breaks.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A slugger with GitHub's rule: each call returns the slug for one heading, counting repeats as GitHub does. */
export function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    let slug = base;
    while (seen.has(slug)) {
      seen.set(base, seen.get(base) + 1);
      slug = `${base}-${seen.get(base)}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

/** A heading's text as GitHub renders it: code spans keep their content, links and images their text, tags go. */
export function headingText(raw) {
  return raw
    .split(/(`+[^`]*?`+)/)
    .map((part, i) => {
      if (i % 2 === 1) return part.replace(/^`+|`+$/g, '');
      return part
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/\\([!-/:-@[-`{-~])/g, '$1')
        .replace(/&(#?\w+);/g, (_, name) => ENTITIES[name] ?? '')
        .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '');
    })
    .join('')
    .trim();
}

/**
 * Each line of `text` with front matter, fenced code blocks (in a block quote or list item too), HTML comments and
 * inline code blanked, so line numbers stay true.
 */
function proseLines(text) {
  let front = text.startsWith('---\n');
  let fence = null;
  let comment = false;
  return text.split('\n').map((line, i) => {
    if (front) {
      if (i > 0 && line.trimEnd() === '---') front = false;
      return '';
    }
    const bare = line.replace(/^(?:[ \t]*>)*[ \t]*/, '');
    const marker = /^(`{3,}|~{3,})/.exec(bare)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^[`~]+[ \t]*$/.test(bare)) fence = null;
      return '';
    }
    if (marker) {
      fence = marker;
      return '';
    }
    // Left to right, so the text of a code span never opens a comment, nor a comment's a code span.
    let out = '';
    for (let at = 0; at < line.length; ) {
      if (comment) {
        const end = line.indexOf('-->', at);
        if (end < 0) break;
        comment = false;
        at = end + 3;
        continue;
      }
      const next = /`+|<!--/g;
      next.lastIndex = at;
      const open = next.exec(line);
      if (!open) {
        out += line.slice(at);
        break;
      }
      out += line.slice(at, open.index);
      at = open.index + open[0].length;
      if (open[0] === '<!--') comment = true;
      else {
        // A code span closes on a run of as many backticks; a run with no match is literal text.
        const close = new RegExp(`(?<!\`)${open[0]}(?!\`)`, 'g');
        close.lastIndex = at;
        const end = close.exec(line);
        if (end) at = end.index + open[0].length;
        else out += open[0];
      }
    }
    return out;
  });
}

/** The destinations of a line's inline links and images, `](dest "title")`, with balanced parentheses in a dest. */
function inlineDestinations(line) {
  const found = [];
  for (let at = line.indexOf(']('); at >= 0; at = line.indexOf('](', at + 2)) {
    let start = at + 2;
    while (line[start] === ' ' || line[start] === '\t') start += 1;
    if (line[start] === '<') {
      const end = line.indexOf('>', start);
      if (end > start) found.push(line.slice(start + 1, end));
      continue;
    }
    let depth = 0;
    let end = start;
    for (; end < line.length && !/\s/.test(line[end]); end += 1) {
      if (line[end] === '\\') end += 1;
      else if (line[end] === '(') depth += 1;
      else if (line[end] === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (end > start && end < line.length) found.push(line.slice(start, end));
  }
  return found;
}

const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/** Every fragment a Markdown text makes: its headings' slugs (ATX and setext) and its `<a id>`/`<a name>` anchors. */
export function anchorsOf(text) {
  const slug = slugger();
  const anchors = new Set();
  const raw = text.split('\n');
  const prose = proseLines(text);
  prose.forEach((line, i) => {
    for (const m of line.matchAll(/<a\s[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(m[1]);
    // Headings are read from the raw line, so a code span in one keeps its text.
    const atx = line && /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(raw[i]);
    if (atx) anchors.add(slug(headingText(atx[1] ?? '')));
    else if (line.trim() && !UNDERLINE.test(line) && UNDERLINE.test(prose[i + 1] ?? '')) {
      // A setext heading: a paragraph, of one line or more, over a row of = or -. A list item over --- is not one.
      let start = i;
      while (start > 0 && prose[start - 1].trim() && !UNDERLINE.test(prose[start - 1]) && !/^ {0,3}#/.test(prose[start - 1])) start -= 1;
      if (!/^ {0,3}([-*+]|\d+[.)])[ \t]/.test(prose[start])) anchors.add(slug(headingText(raw.slice(start, i + 1).map((one) => one.trim()).join(' '))));
    }
  });
  return anchors;
}

/** Every link in a Markdown text with no scheme (a path, a #fragment, or both): { line, link }. */
export function relativeLinksOf(text) {
  const links = [];
  proseLines(text).forEach((line, i) => {
    const targets = [...inlineDestinations(line), ...[...line.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/g)].map((m) => m[1] ?? m[2])];
    for (const link of targets) if (link && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(link)) links.push({ line: i + 1, link });
  });
  return links;
}

/**
 * One line per broken link in the Markdown files among `tracked` (every tracked path, repo-relative, under `root`),
 * naming the file, line, link and target: a path that is no tracked file or directory, or a #fragment that nothing in
 * its Markdown target makes.
 */
export function brokenLinks(root, tracked) {
  const paths = new Set(tracked);
  for (const file of tracked) for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) paths.add(dir);
  const cache = new Map();
  const anchors = (file) => {
    if (!cache.has(file)) cache.set(file, anchorsOf(readFileSync(join(root, file), 'utf8')));
    return cache.get(file);
  };
  const problems = [];
  for (const file of tracked.filter((path) => path.endsWith('.md') && !path.split('/').includes('node_modules'))) {
    for (const { line, link } of relativeLinksOf(readFileSync(join(root, file), 'utf8'))) {
      const [rest, fragment = null] = link.split(/#(.*)/s);
      const path = decodeURIComponent(rest.replace(/\?.*$/, ''));
      const target = path ? posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(file), path)).replace(/(.)\/$/, '$1') : file;
      const where = `${file}:${line}: link ${link}`;
      if (target !== '.' && !paths.has(target)) problems.push(`${where}: ${target} is not a tracked file or directory`);
      else if (fragment !== null && target.endsWith('.md') && !anchors(target).has(decodeURIComponent(fragment))) {
        problems.push(`${where}: no heading or anchor in ${target} makes #${decodeURIComponent(fragment)}`);
      }
    }
  }
  return problems;
}

/** Every tracked path in the repo. */
export function trackedFiles(root = ROOT) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

if (isMain(import.meta)) {
  const problems = brokenLinks(ROOT, trackedFiles());
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`${problems.length} broken link${problems.length === 1 ? '' : 's'}`);
    process.exit(1);
  }
}
