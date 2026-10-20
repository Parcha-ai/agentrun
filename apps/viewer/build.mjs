// node build.mjs [outDir] [--files]: the viewer as static files, with no install. Each module's types are stripped,
// the modules are joined in import order into one classic script (a page opened from file:// may not load module scripts
// or fetch), PDF.js's release files are copied beside it (vendor/pdfjs, loaded only to draw a PDF page), and the bundled
// recordings are embedded in gallery.js and copied beside the page. With --files (off by
// default), the recordings are shipped as files only: recordings/index.json lists each one's manifest and blob paths,
// and the page fetches a recording when it is opened, so the page stays small; that needs a static host, not file://.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inertName, MIME } from './src/blobs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? join(here, 'dist');
const src = join(here, 'src');

/** The modules the viewer takes from outside its own: the DSL's, which a reader calls rather than reimplements: the map
 *  item rebuild (RECORDING.md draft 26) and the workflow graph with what a run did at each node. Each is read from the
 *  DSL's source at every build, never copied here; each must import nothing, and each is inlined in a scope of its own, so
 *  only its exports join the viewer's. */
export const DSL_ITEM_STATE = '../../../packages/dsl/src/recovery/item-state.ts';
export const DSL_GRAPH = '../../../packages/dsl/src/graph.ts';
const DSL_MODULES = new Set([DSL_ITEM_STATE, DSL_GRAPH]);
const DSL_SOURCE = String.raw`\.\.\/\.\.\/\.\.\/packages\/dsl\/src\/(?:recovery\/item-state|graph)\.ts`;
const pathOf = (name) => (DSL_MODULES.has(name) ? join(here, '..', '..', 'packages', 'dsl', 'src', ...name.slice('../../../packages/dsl/src/'.length).split('/')) : join(src, name));
const IMPORT = new RegExp(String.raw`^import (?!type )[^;]*? from '(\.\/[\w-]+\.ts|${DSL_SOURCE})';$`, 'gm');

/** The modules in an order where each comes after those it imports (a type-only import puts no order on them). */
function ordered(entry) {
  const seen = [];
  const visiting = [];
  const visit = (name) => {
    if (seen.includes(name)) return;
    if (visiting.includes(name)) throw new Error(`import cycle: ${[...visiting.slice(visiting.indexOf(name)), name].join(' -> ')}`);
    visiting.push(name);
    const code = readFileSync(pathOf(name), 'utf8');
    for (const [, dep] of code.matchAll(IMPORT)) visit(dep.startsWith('./') ? dep.slice(2) : dep);
    visiting.pop();
    seen.push(name);
  };
  visit(entry);
  return seen;
}

/** What a module may import: only names from the viewer's own modules. A package would need an install; a bare
 *  `import './x.ts'` is neither followed nor removed, so x would be left out and the import left in a classic script. */
export function checkModule(file, code) {
  if (DSL_MODULES.has(file)) {
    if (/^\s*(?:import\b|export\s[^;]*\sfrom\s)/m.test(code) || /\bimport\s*\(|\brequire\s*\(/.test(code)) throw new Error(`${file} imports something; the viewer inlines it only while it imports nothing`);
    return;
  }
  if (new RegExp(String.raw`^\s*import\s[^;]*from\s+'(?!\.\/|${DSL_SOURCE}')`, 'm').test(code)) throw new Error(`${file} imports a package; the viewer imports none (PDF.js is loaded beside the page, vendor/pdfjs)`);
  const bare = /^\s*import\s+'([^']+)';?\s*$/m.exec(code);
  if (bare) throw new Error(`${file} imports ${bare[1]} for its side effect alone; import a name from it, so the build includes it in order`);
}

/** After one of these (or at the start), a `/` begins a regular expression; after anything else it divides. */
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** `code` with its block comments and its whole-line `//` comments dropped; its strings, template literals and regular
 *  expressions as written, and every other character too. A DSL module is inlined as code: its docs stay in its source. */
export function withoutComments(code) {
  let out = '';
  let last = '';
  let lineHasCode = false;
  // The brace depth at which each open template literal's `${` expression closes.
  const templates = [];
  let depth = 0;
  const literal = (from, close) => {
    let at = from + 1;
    while (at < code.length && code[at] !== close) at += code[at] === '\\' ? 2 : 1;
    return at + 1;
  };
  // A template literal's text from `from` up to its end, or up to a `${`, which opens an expression (code again).
  const template = (from) => {
    let at = from;
    while (at < code.length && code[at] !== '`' && !(code[at] === '$' && code[at + 1] === '{')) at += code[at] === '\\' ? 2 : 1;
    if (code[at] === '`') return { end: at + 1, open: false };
    return { end: at + 2, open: true };
  };
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '\n') { out += c; lineHasCode = false; i += 1; continue; }
    if (/\s/.test(c)) { out += c; i += 1; continue; }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const comment = code.slice(i, end < 0 ? code.length : end + 2);
      const lines = comment.split('\n').length - 1;
      out += lines ? '\n'.repeat(lines) : ' ';
      if (lines) lineHasCode = false;
      i += comment.length;
      continue;
    }
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? code.length : end;
      if (lineHasCode) out += code.slice(i, stop);
      i = stop;
      continue;
    }
    lineHasCode = true;
    if (c === "'" || c === '"') { const end = literal(i, c); out += code.slice(i, end); i = end; last = 'x'; continue; }
    if (c === '`' || (c === '}' && templates.at(-1) === depth)) {
      if (c === '}') templates.pop();
      const { end, open } = template(i + 1);
      out += code.slice(i, end);
      i = end;
      if (open) templates.push(depth);
      last = open ? '{' : 'x';
      continue;
    }
    if (c === '/' && (REGEX_AFTER.has(last) || REGEX_AFTER_WORDS.has(last))) {
      let at = i + 1;
      let inClass = false;
      while (at < code.length && (inClass || code[at] !== '/')) {
        if (code[at] === '\\') at += 1;
        else if (code[at] === '[') inClass = true;
        else if (code[at] === ']') inClass = false;
        at += 1;
      }
      at += 1;
      while (/[A-Za-z]/.test(code[at] ?? '')) at += 1;
      out += code.slice(i, at);
      i = at;
      last = 'x';
      continue;
    }
    const word = /^[A-Za-z_$0-9][\w$]*/.exec(code.slice(i, i + 64));
    if (word) { out += word[0]; i += word[0].length; last = word[0]; continue; }
    if (c === '{') depth += 1;
    if (c === '}') depth -= 1;
    out += c;
    last = c === ')' || c === ']' ? 'x' : c;
    i += 1;
  }
  return out;
}

/** One page's script: the modules `entry` needs, types stripped and joined in import order into one body for a classic
 *  script, and their names in that order. A DSL module's comments are dropped (`withoutComments`). */
export function bundle(entry = 'app.ts') {
  const names = new Map();
  const modules = ordered(entry);
  const parts = modules.map((file) => {
    const stripped = stripTypeScriptTypes(readFileSync(pathOf(file), 'utf8'));
    const code = DSL_MODULES.has(file) ? withoutComments(stripped) : stripped;
    checkModule(file, code);
    if (DSL_MODULES.has(file)) {
      // Its own names stay in its scope; only what it exports joins the viewer's.
      const exported = [...code.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)].map(([, name]) => name);
      for (const name of exported) {
        if (names.has(name)) throw new Error(`${file} and ${names.get(name)} both declare ${name} at the top level`);
        names.set(name, file);
      }
      return `// ${file} (the DSL's, read at build time)\nconst { ${exported.join(', ')} } = (() => {\n${code.replace(/^export (?=(?:async )?function |const |let |class )/gm, '')}\nreturn { ${exported.join(', ')} };\n})();`;
    }
    const body = code.replace(/^import [^;]*? from '\.\/[\w-]+\.ts';$/gm, '').replace(new RegExp(String.raw`^import [^;]*? from '${DSL_SOURCE}';$`, 'gm'), '').replace(/^export (?=(?:async )?function |const |let |class )/gm, '');
    for (const [, name] of body.matchAll(/^(?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)) {
      if (names.has(name)) throw new Error(`${file} and ${names.get(name)} both declare ${name} at the top level`);
      names.set(name, file);
    }
    return `// ${file}\n${body}`;
  });
  return { body: parts.join('\n'), modules };
}

/** `recordingsDir`: the recordings bundled into the gallery (a test passes its fixture's directory). `files`: ship them as
 *  files with `recordings/index.json` instead of embedding them in gallery.js. */
export function build(target = out, recordingsDir = join(here, 'recordings'), { files = false } = {}) {
  const { body, modules } = bundle('app.ts');
  // The chat + report page (chat.html): a second script over the same loader, beside the viewer.
  const chat = bundle('chat.ts');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'viewer.js'), `(() => {\n'use strict';\n${body}\n})();\n`);
  writeFileSync(join(target, 'index.html'), readFileSync(join(here, 'index.html')));
  writeFileSync(join(target, 'viewer.css'), readFileSync(join(here, 'viewer.css')));
  writeFileSync(join(target, 'chat.js'), `(() => {\n'use strict';\n${chat.body}\n})();\n`);
  writeFileSync(join(target, 'chat.html'), readFileSync(join(here, 'chat.html')));
  // A `.js` name: every static host serves it as JavaScript, which a module script must be.
  mkdirSync(join(target, 'pdfjs'));
  for (const [from, to] of [['pdf.min.mjs', 'pdf.min.js'], ['pdf.worker.min.mjs', 'pdf.worker.min.js'], ['LICENSE.txt', 'LICENSE.txt']]) cpSync(join(here, 'vendor', 'pdfjs', from), join(target, 'pdfjs', to));
  cpSync(join(here, 'vendor', 'pdfjs', 'wasm'), join(target, 'pdfjs', 'wasm'), { recursive: true });

  // A recorder writes a blob as `.<sha>.<ext>.tmp-<pid>` and renames it once whole, so a copy of a recording taken while
  // it goes may hold such a name: it is not a blob yet, and is neither listed nor shipped.
  const unfinished = (name) => /^\..*\.tmp-\d+$/.test(name);
  const gallery = [];
  for (const id of existsSync(recordingsDir) ? readdirSync(recordingsDir).sort() : []) {
    const dir = join(recordingsDir, id);
    if (!existsSync(join(dir, 'manifest.json'))) continue;
    const blobs = {};
    for (const file of existsSync(join(dir, 'blobs')) ? readdirSync(join(dir, 'blobs')).filter((name) => !unfinished(name)) : []) {
      const ext = extname(file).slice(1);
      // Embedded, a blob is a data: URL; shipped as files, its path in the recording's directory, under its inert name.
      blobs[file.slice(0, -ext.length - 1)] = files ? `blobs/${inertName(file)}` : `data:${MIME[ext] ?? 'application/octet-stream'};base64,${readFileSync(join(dir, 'blobs', file)).toString('base64')}`;
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    gallery.push(files ? { id, manifest, blobs } : { id, manifest, events: readFileSync(join(dir, 'events.jsonl'), 'utf8'), blobs });
    // Beside the page, every blob is published under its inert name: a page, an SVG or a script in a recording (an agent's
    // report, draft 41) is plain text when opened straight, and the viewer reads it into its sandboxed frame.
    const copy = join(target, 'recordings', id);
    cpSync(dir, copy, { recursive: true, filter: (source) => !unfinished(basename(source)) && dirname(source) !== join(dir, 'blobs') });
    // Anything else in blobs/ (a directory) is copied as it is, for the gate to refuse.
    for (const entry of existsSync(join(dir, 'blobs')) ? readdirSync(join(dir, 'blobs'), { withFileTypes: true }).filter((each) => !unfinished(each.name)) : []) {
      if (entry.isFile()) copyFileSync(join(dir, 'blobs', entry.name), join(copy, 'blobs', inertName(entry.name)));
      else cpSync(join(dir, 'blobs', entry.name), join(copy, 'blobs', entry.name), { recursive: true });
    }
  }
  if (files) {
    mkdirSync(join(target, 'recordings'), { recursive: true });
    writeFileSync(join(target, 'recordings', 'index.json'), `${JSON.stringify(gallery)}\n`);
    writeFileSync(join(target, 'gallery.js'), `window.AGENTRUN_GALLERY_INDEX = 'recordings/index.json';\n`);
  } else writeFileSync(join(target, 'gallery.js'), `window.AGENTRUN_GALLERY = ${JSON.stringify(gallery)};\n`);
  return { target, modules: modules.length, chatModules: chat.modules.length, recordings: gallery.map((entry) => entry.id) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(build(out, undefined, { files: process.argv.includes('--files') })));
