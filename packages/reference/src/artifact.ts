// The run's artifact (draft 41): the page the agent wrote at `report/index.html` and the files it reaches, recorded as blobs with `manifest.artifact`.
// One module for every reader of a page: the recorder (it takes the entry's closure), the repository's validator and the gallery's gate (scripts/recording/)
// import these same functions, so what the recorder takes and what the checks refuse are one reading of the page, by an HTML parser and never by patterns.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { Parser } from 'htmlparser2';

/** `manifest.artifact`: `files` maps each path under `report/` to the SHA-256 of its blob (`blobs/<sha>.<the path's extension>`). */
export type Artifact = { title: string; entry: string; files: Record<string, string> };

/** What one file of the page says about the files it reaches. A path is resolved against the file's own, inside the artifact. */
export type Reading = {
  /** Files the page loads (src, srcset, poster, stylesheet href, CSS url()), as paths of the artifact. */
  loads: string[];
  /** Relative pages and files the page links to (`<a href>`) that lie inside the artifact, as its paths: a link may go out to a site, and then loads nothing. */
  links: string[];
  /** Every relative `<a href>`/`<area href>` to a file: `target` is the path as written (no query or fragment), `inside` its path in the artifact when it has one, `look` the link's `data-look`. A link whose file the report does not hold is a document link: it is kept as written when it cites the look that read the file. */
  documents: { target: string; inside?: string; look?: string }[];
  /** The `data-look` and `data-node` values. */
  looks: string[];
  nodes: string[];
  title?: string;
  problems: string[];
};

const PAGE = /\.(?:html?|svg)$/i;
const SHEET = /\.css$/i;
/** The files read for what they reach; the others (images, clips, documents) are kept whole. */
export const readsAs = (path: string): 'page' | 'sheet' | undefined => (PAGE.test(path) ? 'page' : SHEET.test(path) ? 'sheet' : undefined);

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base']);
/** The attributes whose value a browser fetches: each goes through the one check, whatever the element. */
const LOADING = new Set(['src', 'poster', 'background', 'dynsrc', 'lowsrc', 'manifest', 'icon', 'codebase', 'archive', 'longdesc', 'action', 'formaction']);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Why a path of the artifact is not allowed, or undefined: relative POSIX, nothing leading `/`, no `..`, no `\`, no scheme, no empty or `.` part. */
export function pathProblem(path: string): string | undefined {
  if (typeof path !== 'string' || path === '') return 'is empty';
  if (path.includes('\\')) return 'has a backslash';
  if (path.startsWith('/')) return 'is absolute';
  if (SCHEME.test(path)) return 'has a scheme';
  if (path.includes('\0')) return 'has a NUL';
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return 'has an empty, "." or ".." part';
  return undefined;
}

/** A reference from `from` to a path of the artifact. `external` is a site or another scheme, `undefined` a reference that is the page's own (a fragment), `problem` one that cannot be a file of the artifact. */
/** A URL as a browser reads it before it looks at the scheme: leading and trailing control characters and spaces go, tabs and newlines inside go (`java&#9;script:` is `javascript:`), and a backslash is a slash. */
const normalized = (reference: string): string => reference.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '').replace(/\\/g, '/');

function resolve(from: string, reference: string): { path: string } | { external: string } | { problem: string } | undefined {
  const text = normalized(reference);
  if (text === '' || text.startsWith('#')) return undefined;
  if (/^(?:javascript|vbscript):/i.test(text)) return { problem: `a ${text.slice(0, text.indexOf(':'))}: URL` };
  if (/^data:/i.test(text)) return { problem: 'a data: URL' };
  if (SCHEME.test(text) || text.startsWith('//')) return { external: text };
  if (text.startsWith('/')) return { problem: `the absolute path ${text.slice(0, 60)}` };
  let target = text.replace(/[?#].*$/s, '');
  try { target = decodeURIComponent(target); } catch { /* kept as written */ }
  const joined = posix.normalize(posix.join(posix.dirname(from), target));
  if (joined === '.' || joined === '..' || joined.startsWith('../')) return { problem: `${text.slice(0, 60)}, which leaves the artifact` };
  return { path: joined };
}

/** CSS text with its comments out and its escapes read (`u\72l(` is `url(`, a backslash before a newline joins the lines), as a stylesheet's parser reads it. */
const cssText = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\\(?:\r\n|[\n\r\f])/g, '')
  .replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|\\([\s\S])/g, (_match, hex: string | undefined, character: string | undefined) => {
    if (character !== undefined) return character;
    const code = Number.parseInt(hex!, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code);
  });

/** The url(), @import and image-set() targets of a stylesheet's text, after its comments and escapes are read. */
const cssTargets = (css: string): string[] => {
  const text = cssText(css);
  const out: string[] = [];
  for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi)) out.push(match[1] ?? match[2] ?? match[3] ?? '');
  for (const match of text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) out.push(match[1] ?? match[2] ?? '');
  for (const match of text.matchAll(/image-set\(([^)]*)\)/gi)) for (const inner of match[1]!.matchAll(/"([^"]*)"|'([^']*)'/g)) out.push(inner[1] ?? inner[2] ?? '');
  return out;
};

const srcsetTargets = (value: string): string[] => value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '').filter(Boolean);

/** Reads one file of the artifact for what it reaches and what it may not do. A stylesheet is read for url() and @import; a page (HTML or SVG) with an HTML parser. */
export function readFile(path: string, text: string): Reading {
  const reading: Reading = { loads: [], links: [], documents: [], looks: [], nodes: [], problems: [] };
  const problem = (message: string) => { if (!reading.problems.includes(message)) reading.problems.push(message); };
  const load = (reference: string, what: string) => {
    const found = resolve(path, reference);
    if (!found) return;
    if ('problem' in found) problem(`${what} is ${found.problem}`);
    else if ('external' in found) problem(`${what} loads ${found.external.slice(0, 80)} from outside the artifact`);
    else if (!reading.loads.includes(found.path)) reading.loads.push(found.path);
  };
  const link = (reference: string, look: string | undefined) => {
    const text = normalized(reference);
    const found = resolve(path, reference);
    if (!found || 'external' in found) return;
    if ('problem' in found && !/leaves the artifact/.test(found.problem)) { problem(`a link is ${found.problem}`); return; }
    let target = text.replace(/[?#].*$/s, '');
    try { target = decodeURIComponent(target); } catch { /* kept as written */ }
    const inside = 'path' in found ? found.path : undefined;
    reading.documents.push({ target, ...(inside ? { inside } : {}), ...(look !== undefined ? { look } : {}) });
    if (inside && !reading.links.includes(inside)) reading.links.push(inside);
  };
  const sheet = (css: string, what: string) => { for (const target of cssTargets(css)) load(target, what); };
  if (readsAs(path) === 'sheet') { sheet(text, `${path}: a url()`); return reading; }
  let titled = false;
  let title = '';
  const parser = new Parser({
    onopentag(name, attribs) {
      if (FORBIDDEN_TAGS.has(name)) problem(`has a <${name}>`);
      if (name === 'meta' && /^\s*refresh\s*$/i.test(attribs['http-equiv'] ?? '')) problem('has a meta refresh');
      if (name === 'title') titled = true;
      for (const [attribute, value] of Object.entries(attribs)) {
        if (attribute.startsWith('on')) problem(`has the ${attribute} attribute`);
        else if (attribute === 'data-look') reading.looks.push(value);
        else if (attribute === 'data-node') reading.nodes.push(value);
        else if (attribute === 'style') sheet(value, `a style attribute`);
        else if (attribute === 'srcset' || attribute === 'imagesrcset') for (const target of srcsetTargets(value)) load(target, `a ${attribute}`);
        else if (attribute === 'ping') for (const target of value.split(/\s+/).filter(Boolean)) load(target, 'a ping');
        else if (LOADING.has(attribute)) load(value, `${name} ${attribute}`);
        else if (attribute === 'href' || attribute === 'xlink:href') {
          if (name === 'a' || name === 'area') link(value, attribs['data-look']);
          else load(value, `${name} ${attribute}`);
        } else if (/^(?:javascript|vbscript|data):/i.test(normalized(value))) problem(`has a ${normalized(value).slice(0, normalized(value).indexOf(':'))}: value in ${attribute}`);
      }
    },
    ontext(data) { if (titled) title += data; },
    onclosetag(name) { if (name === 'title') titled = false; },
  }, { decodeEntities: true, recognizeSelfClosing: true, xmlMode: false });
  parser.write(text);
  parser.end();
  // <style> blocks hold CSS: a second pass keeps their raw text.
  const styles: string[] = [];
  const blocks = new Parser({
    onopentag(name) { if (name === 'style') styles.push(''); },
    ontext(data) { if (styles.length) styles[styles.length - 1] += data; },
    onclosetag(name) { if (name === 'style') { sheet(styles.pop() ?? '', 'a <style> block'); } },
  }, { decodeEntities: false });
  blocks.write(text);
  blocks.end();
  if (title.trim()) reading.title = title.trim().slice(0, 200);
  return reading;
}

/** The first problem with an artifact's shape (not its files): the entry, the paths, the hashes. Empty when it is whole. */
export function artifactProblems(artifact: unknown): string[] {
  const out: string[] = [];
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject(artifact)) return ['artifact is not an object'];
  if (typeof artifact.title !== 'string' || artifact.title === '') out.push('artifact.title is not a non-empty string');
  const files = isObject(artifact.files) ? artifact.files : undefined;
  if (!files) return [...out, 'artifact.files is not a map of path to SHA-256'];
  if (typeof artifact.entry !== 'string' || !/\.html?$/i.test(artifact.entry)) out.push('artifact.entry is not a path ending in .html');
  else if (!(artifact.entry in files)) out.push(`artifact.entry ${artifact.entry} is not in files`);
  const seen = new Map<string, string>();
  for (const [path, hash] of Object.entries(files)) {
    const why = pathProblem(path);
    if (why) out.push(`artifact path ${JSON.stringify(path.slice(0, 80))} ${why}`);
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) out.push(`artifact file ${path} has no 64-hex SHA-256`);
    if (!/\.[A-Za-z0-9]+$/.test(path)) out.push(`artifact path ${path} has no extension for its blob`);
    const folded = path.toLowerCase();
    if (seen.has(folded)) out.push(`artifact paths ${seen.get(folded)} and ${path} are one path ignoring case`);
    seen.set(folded, path);
  }
  return out;
}

/** Takes the entry's closure from `report` (the agent's `report/` directory): the entry, and every file it reaches through the references `readFile` finds, transitively, links to relative pages included. A file the final page no longer reaches
 *  (a killed attempt's leftover) is not taken. Each file is kept through `keep(bytes, extension)`, which returns its SHA-256. It throws, naming the files, when the page breaks a rule or reaches a file that is not there, and returns undefined when there is no `index.html`. */
export function takeArtifact(report: string, keep: (bytes: Buffer, extension: string) => string, fallbackTitle: string): Artifact | undefined {
  const entry = 'index.html';
  if (!existsSync(join(report, entry))) return undefined;
  const root = realpathSync(report);
  const files: Record<string, string> = {};
  const problems: string[] = [];
  // A load must be there; a link that points at a file the report does not hold (a film or a document beside it) is a link that goes nowhere in the artifact, and is left out.
  const queue: { path: string; link: boolean }[] = [{ path: entry, link: false }];
  const folded = new Map<string, string>();
  let title: string | undefined;
  while (queue.length) {
    const { path, link } = queue.shift()!;
    if (path in files) continue;
    const why = pathProblem(path);
    if (why) { problems.push(`${path} ${why}`); continue; }
    if (folded.has(path.toLowerCase()) && folded.get(path.toLowerCase()) !== path) { problems.push(`${path} and ${folded.get(path.toLowerCase())} are one path ignoring case`); continue; }
    folded.set(path.toLowerCase(), path);
    const at = join(report, ...path.split('/'));
    if (!existsSync(at)) { if (!link) problems.push(`${path} is reached by the page and is not in report/`); continue; }
    const real = realpathSync(at);
    if (!(real === root || real.startsWith(root + sep)) || !lstatSync(real).isFile()) { problems.push(`${path} is not a file inside report/`); continue; }
    if (!/\.[A-Za-z0-9]+$/.test(path)) { problems.push(`${path} has no extension for its blob`); continue; }
    const bytes = readFileSync(real);
    const kind = readsAs(path);
    if (kind) {
      const reading = readFile(path, bytes.toString('utf8'));
      for (const message of reading.problems) problems.push(`${path} ${message}`);
      if (path === entry) title = reading.title;
      for (const next of reading.loads) queue.push({ path: next, link: false });
      for (const next of reading.links) queue.push({ path: next, link: true });
    }
    files[path] = keep(bytes, path.slice(path.lastIndexOf('.') + 1).toLowerCase());
  }
  if (problems.length) throw new Error(`the report is refused: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? ` (and ${problems.length - 8} more)` : ''}`);
  return { title: title ?? fallbackTitle, entry, files };
}
