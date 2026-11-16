// Every relative link with a #fragment in a tracked Markdown file lands on a heading or anchor: a renamed heading once left
// 16 links in packages/computer/SCORECARD.md pointing at a fragment nothing made. A link's target is another tracked .md
// file (a path relative to the linking file, or to the repo root with a leading /) or, with `#fragment` alone, the same
// file. A fragment exists when a heading in the target makes it by GitHub's slug rule (the heading's text, lower case,
// with every character but letters, digits, `_`, `-` and spaces dropped, spaces turned to `-`; a repeated slug gets `-1`,
// `-2`, ...) or when the target has an `<a id>` or `<a name>` anchor of that name. A fragment link to a tracked-looking
// .md path that is not tracked fails too. Not read: external URLs, links without a fragment, links to files that are not
// Markdown, fenced code blocks, inline code and HTML comments.
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

/** Each line of `text` with fenced code blocks, HTML comments and inline code blanked, so line numbers stay true. */
function proseLines(text) {
  const lines = text.split('\n');
  let fence = null;
  let comment = false;
  return lines.map((line) => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(line)) fence = null;
      return '';
    }
    if (open) {
      fence = open[1];
      return '';
    }
    let out = '';
    let rest = line;
    while (rest) {
      if (comment) {
        const end = rest.indexOf('-->');
        if (end < 0) return out;
        comment = false;
        rest = rest.slice(end + 3);
      } else {
        const start = rest.indexOf('<!--');
        if (start < 0) {
          out += rest;
          break;
        }
        out += rest.slice(0, start);
        comment = true;
        rest = rest.slice(start + 4);
      }
    }
    return out.replace(/(`+)(?:(?!\1).)+?\1/g, '');
  });
}

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
    else if (line.trim() && /^ {0,3}(=+|-+)[ \t]*$/.test(prose[i + 1] ?? '') && !/^ {0,3}([-*+]|\d+[.)])[ \t]/.test(line) && (i === 0 || prose[i - 1].trim() === '')) {
      // A setext heading: one paragraph line over a row of = or -. A list item or a paragraph's later line over --- is not one.
      anchors.add(slug(headingText(raw[i].trim())));
    }
  });
  return anchors;
}

/** Every link in a Markdown text with no scheme (a path, a #fragment, or both): { line, link }. */
export function relativeLinksOf(text) {
  const links = [];
  proseLines(text).forEach((line, i) => {
    const targets = [
      ...[...line.matchAll(/\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)].map((m) => m[1] ?? m[2]),
      ...[...line.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/g)].map((m) => m[1] ?? m[2]),
    ];
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
