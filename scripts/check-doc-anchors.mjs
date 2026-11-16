// Every relative link in a tracked Markdown file lands: a renamed heading once left 16 links in
// packages/computer/SCORECARD.md pointing at a fragment nothing made. Each file is read by marked's lexer (GitHub-flavoured
// Markdown), so code, comments and escapes are what Markdown says they are. A link's path,
// relative to the linking file or, with a leading /, to the repo root, must be a tracked file or directory. Its #fragment,
// in a Markdown target or the same file, must be made by a heading there, by GitHub's slug rule (the heading's text, lower
// case, with every character but letters, digits, `_`, `-` and spaces dropped, spaces turned to `-`; a repeated slug gets
// `-1`, `-2`, ...), or by an `<a id>` or `<a name>` anchor outside an HTML comment. Not read: links with a scheme, and front matter.
// `node scripts/check-doc-anchors.mjs` exits non-zero with one line per broken link; check-doc-anchors.test.mjs runs it on
// this tree and on planted breaks.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lexer } from 'marked';
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

// Numeric references and the named ones docs write; another named reference is left as written.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== '#') return NAMED[name] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

/**
 * The text a heading's inline tokens render: code spans keep their content as written (a reference in code shows
 * literally), links and emphasis their text, tags go.
 */
function plain(tokens = []) {
  return tokens
    .map((token) => {
      if (token.type === 'codespan') return token.text;
      if (token.type === 'html') return '';
      if (token.type === 'br') return ' ';
      if (token.type === 'image') return token.text;
      return token.tokens ? plain(token.tokens) : decode(token.text ?? '');
    })
    .join('');
}

/** A token's child tokens, in document order: inline tokens, list items, table cells. */
const childrenOf = (token) => [token.tokens, token.items, token.header, token.rows?.flat()].filter(Array.isArray).flat();

/** Each token of a Markdown text, depth first in document order, with the 1-based line it starts on. */
function* tokensOf(text) {
  // Front matter is blanked (its newlines kept), as GitHub shows it as a table and not as Markdown.
  const front = /^---\n[\s\S]*?\n---\n/.exec(text);
  const source = front ? front[0].replace(/[^\n]/g, '') + text.slice(front[0].length) : text;
  const starts = [0];
  for (let at = source.indexOf('\n'); at >= 0; at = source.indexOf('\n', at + 1)) starts.push(at + 1);
  const lineAt = (at) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= at) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  // A child's text as written (a table cell has no raw, only its text) is searched for from where its last sibling
  // ended; one not found as written (in a block quote, whose markers its children's raw drops) takes that place's line.
  function* walk(tokens, from) {
    let cursor = from;
    for (const token of tokens) {
      const written = token.raw ?? token.text;
      const found = written ? source.indexOf(written, cursor) : -1;
      const at = found < 0 ? cursor : found;
      yield { token, line: lineAt(at) };
      yield* walk(childrenOf(token), at);
      if (found >= 0) cursor = found + written.length;
    }
  }
  yield* walk(Lexer.lex(source, { gfm: true }), 0);
}

// An HTML attribute: a name, then maybe `=` and a double-quoted, single-quoted or unquoted value (HTML's syntax).
const ATTRIBUTE = String.raw`\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?`;
const A_TAG = new RegExp(String.raw`<a((?:${ATTRIBUTE})*)\s*/?>`, 'gi');

/** The id and name values of each `<a>` tag in some HTML, read attribute by attribute. */
function* aAnchors(html) {
  for (const [, attributes] of html.matchAll(A_TAG)) {
    for (const [, name, ...values] of attributes.matchAll(new RegExp(ATTRIBUTE, 'g'))) {
      const value = values.find((v) => v !== undefined);
      if (value && /^(?:id|name)$/i.test(name)) yield decode(value);
    }
  }
}

/** Every fragment a Markdown text makes: its headings' slugs and its `<a id>`/`<a name>` anchors. */
export function anchorsOf(text) {
  const slug = slugger();
  const anchors = new Set();
  for (const { token } of tokensOf(text)) {
    // A setext heading's line breaks render as spaces.
    if (token.type === 'heading') anchors.add(slug(plain(token.tokens).trim().replace(/[ \t]*\n[ \t]*/g, ' ')));
    // An anchor inside an HTML comment renders nothing; a comment with no end runs to the end of its HTML.
    else if (token.type === 'html') {
      for (const anchor of aAnchors(token.raw.replace(/<!--[\s\S]*?(?:-->|$)/g, ''))) anchors.add(anchor);
    }
  }
  return anchors;
}

/** Every link and image in a Markdown text with no scheme (a path, a #fragment, or both): { line, link }. */
export function relativeLinksOf(text) {
  const links = [];
  for (const { token, line } of tokensOf(text)) {
    if ((token.type === 'link' || token.type === 'image') && token.href && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(token.href)) links.push({ line, link: token.href });
  }
  return links;
}

/** A URL's percent escapes decoded; one that isn't a valid escape is kept as written. */
const unescapeUrl = (text) => text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
  try {
    return decodeURIComponent(run);
  } catch {
    return run;
  }
});

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
      const [rest, hash = null] = link.split(/#(.*)/s);
      const path = unescapeUrl(rest.replace(/\?.*$/, ''));
      const fragment = hash === null ? null : unescapeUrl(hash);
      const target = path ? posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(file), path)).replace(/(.)\/$/, '$1') : file;
      const where = `${file}:${line}: link ${link}`;
      if (target !== '.' && !paths.has(target)) problems.push(`${where}: ${target} is not a tracked file or directory`);
      // An empty fragment (`#`) goes to the top of the page and needs no anchor.
      else if (fragment && target.endsWith('.md') && !anchors(target).has(fragment)) problems.push(`${where}: no heading or anchor in ${target} makes #${fragment}`);
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
