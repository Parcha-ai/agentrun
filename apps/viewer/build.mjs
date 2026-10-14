// node build.mjs [outDir]: the viewer as static files, with no dependency. Each module's types are stripped, the
// modules are joined in import order into one classic script (a page opened from file:// may not load module scripts
// or fetch), and the bundled recordings are embedded in gallery.js and copied beside the page.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] ?? join(here, 'dist');
const src = join(here, 'src');
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', webm: 'video/webm', json: 'application/json', html: 'text/html', md: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf' };

/** The modules in an order where each comes after those it imports. */
function ordered(entry) {
  const seen = [];
  const visit = (name) => {
    if (seen.includes(name)) return;
    const code = readFileSync(join(src, name), 'utf8');
    for (const [, dep] of code.matchAll(/^import [^;]*? from '\.\/([\w-]+\.ts)';$/gm)) visit(dep);
    seen.push(name);
  };
  visit(entry);
  return seen;
}

export function build(target = out) {
  const names = new Map();
  const parts = ordered('app.ts').map((file) => {
    const code = stripTypeScriptTypes(readFileSync(join(src, file), 'utf8'));
    if (/^\s*import\s[^;]*from\s+'(?!\.\/)/m.test(code)) throw new Error(`${file} imports a package; the viewer has no dependencies`);
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

  const recordings = join(here, 'recordings');
  const gallery = [];
  for (const id of existsSync(recordings) ? readdirSync(recordings).sort() : []) {
    const dir = join(recordings, id);
    if (!existsSync(join(dir, 'manifest.json'))) continue;
    const blobs = {};
    for (const file of existsSync(join(dir, 'blobs')) ? readdirSync(join(dir, 'blobs')) : []) {
      const ext = extname(file).slice(1);
      blobs[file.slice(0, -ext.length - 1)] = `data:${MIME[ext] ?? 'application/octet-stream'};base64,${readFileSync(join(dir, 'blobs', file)).toString('base64')}`;
    }
    gallery.push({ id, manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), events: readFileSync(join(dir, 'events.jsonl'), 'utf8'), blobs });
    cpSync(dir, join(target, 'recordings', id), { recursive: true });
  }
  writeFileSync(join(target, 'gallery.js'), `window.AGENTRUN_GALLERY = ${JSON.stringify(gallery)};\n`);
  return { target, modules: parts.length, recordings: gallery.map((entry) => entry.id) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(build()));
