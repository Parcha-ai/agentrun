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

/** The modules in an order where each comes after those it imports (a type-only import puts no order on them). */
function ordered(entry) {
  const seen = [];
  const visiting = [];
  const visit = (name) => {
    if (seen.includes(name)) return;
    if (visiting.includes(name)) throw new Error(`import cycle: ${[...visiting.slice(visiting.indexOf(name)), name].join(' -> ')}`);
    visiting.push(name);
    const code = readFileSync(join(src, name), 'utf8');
    for (const [, dep] of code.matchAll(/^import (?!type )[^;]*? from '\.\/([\w-]+\.ts)';$/gm)) visit(dep);
    visiting.pop();
    seen.push(name);
  };
  visit(entry);
  return seen;
}

/** What a module may import: only names from the viewer's own modules. A package would need an install; a bare
 *  `import './x.ts'` is neither followed nor removed, so x would be left out and the import left in a classic script. */
export function checkModule(file, code) {
  if (/^\s*import\s[^;]*from\s+'(?!\.\/)/m.test(code)) throw new Error(`${file} imports a package; the viewer imports none (PDF.js is loaded beside the page, vendor/pdfjs)`);
  const bare = /^\s*import\s+'([^']+)';?\s*$/m.exec(code);
  if (bare) throw new Error(`${file} imports ${bare[1]} for its side effect alone; import a name from it, so the build includes it in order`);
}

/** `recordingsDir`: the recordings bundled into the gallery (a test passes its fixture's directory). `files`: ship them as
 *  files with `recordings/index.json` instead of embedding them in gallery.js. */
export function build(target = out, recordingsDir = join(here, 'recordings'), { files = false } = {}) {
  const names = new Map();
  const parts = ordered('app.ts').map((file) => {
    const code = stripTypeScriptTypes(readFileSync(join(src, file), 'utf8'));
    checkModule(file, code);
    const body = code.replace(/^import [^;]*? from '\.\/[\w-]+\.ts';$/gm, '').replace(/^export (?=(?:async )?function |const |let |class )/gm, '');
    for (const [, name] of body.matchAll(/^(?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)) {
      if (names.has(name)) throw new Error(`${file} and ${names.get(name)} both declare ${name} at the top level`);
      names.set(name, file);
    }
    return `// ${file}\n${body}`;
  });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'viewer.js'), `(() => {\n'use strict';\n${parts.join('\n')}\n})();\n`);
  writeFileSync(join(target, 'index.html'), readFileSync(join(here, 'index.html')));
  writeFileSync(join(target, 'viewer.css'), readFileSync(join(here, 'viewer.css')));
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
    for (const file of existsSync(join(dir, 'blobs')) ? readdirSync(join(dir, 'blobs')).filter((name) => !unfinished(name)) : []) copyFileSync(join(dir, 'blobs', file), join(copy, 'blobs', inertName(file)));
  }
  if (files) {
    mkdirSync(join(target, 'recordings'), { recursive: true });
    writeFileSync(join(target, 'recordings', 'index.json'), `${JSON.stringify(gallery)}\n`);
    writeFileSync(join(target, 'gallery.js'), `window.AGENTRUN_GALLERY_INDEX = 'recordings/index.json';\n`);
  } else writeFileSync(join(target, 'gallery.js'), `window.AGENTRUN_GALLERY = ${JSON.stringify(gallery)};\n`);
  return { target, modules: parts.length, recordings: gallery.map((entry) => entry.id) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(build(out, undefined, { files: process.argv.includes('--files') })));
