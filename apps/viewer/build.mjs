// node build.mjs [outDir]: the viewer as static files, with no dependency. Each module's types are stripped, the
// modules are joined in import order into one classic script (a page opened from file:// may not load module scripts
// or fetch), and the bundled recordings are embedded in gallery.js and copied beside the page.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIME } from './src/blobs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] ?? join(here, 'dist');
const src = join(here, 'src');

/** The one module the viewer takes from outside its own: the DSL's map-item rebuild (RECORDING.md draft 26), which a reader
 *  calls rather than reimplements. It is read from the DSL's source at every build, never copied here; it must import
 *  nothing, and it is inlined in a scope of its own, so only its exports join the viewer's. */
export const DSL_ITEM_STATE = '../../../packages/dsl/src/recovery/item-state.ts';
const pathOf = (name) => (name === DSL_ITEM_STATE ? join(here, '..', '..', 'packages', 'dsl', 'src', 'recovery', 'item-state.ts') : join(src, name));
const IMPORT = /^import (?!type )[^;]*? from '(\.\/[\w-]+\.ts|\.\.\/\.\.\/\.\.\/packages\/dsl\/src\/recovery\/item-state\.ts)';$/gm;

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

/** What a module may import: only names from the viewer's own modules. A package would be a dependency; a bare
 *  `import './x.ts'` is neither followed nor removed, so x would be left out and the import left in a classic script. */
export function checkModule(file, code) {
  if (file === DSL_ITEM_STATE) {
    if (/^\s*(?:import\b|export\s[^;]*\sfrom\s)/m.test(code) || /\bimport\s*\(|\brequire\s*\(/.test(code)) throw new Error(`${file} imports something; the viewer inlines it only while it imports nothing`);
    return;
  }
  if (/^\s*import\s[^;]*from\s+'(?!\.\/|\.\.\/\.\.\/\.\.\/packages\/dsl\/src\/recovery\/item-state\.ts')/m.test(code)) throw new Error(`${file} imports a package; the viewer has no dependencies`);
  const bare = /^\s*import\s+'([^']+)';?\s*$/m.exec(code);
  if (bare) throw new Error(`${file} imports ${bare[1]} for its side effect alone; import a name from it, so the build includes it in order`);
}

/** The modules `entry` needs, types stripped and joined in import order into one body for a classic script, and their
 *  names in that order. */
export function bundle(entry = 'app.ts') {
  const names = new Map();
  const modules = ordered(entry);
  const parts = modules.map((file) => {
    const code = stripTypeScriptTypes(readFileSync(pathOf(file), 'utf8'));
    checkModule(file, code);
    if (file === DSL_ITEM_STATE) {
      // Its own names stay in its scope; only what it exports joins the viewer's.
      const exported = [...code.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)].map(([, name]) => name);
      for (const name of exported) {
        if (names.has(name)) throw new Error(`${file} and ${names.get(name)} both declare ${name} at the top level`);
        names.set(name, file);
      }
      return `// ${file} (the DSL's, read at build time)\nconst { ${exported.join(', ')} } = (() => {\n${code.replace(/^export (?=(?:async )?function |const |let |class )/gm, '')}\nreturn { ${exported.join(', ')} };\n})();`;
    }
    const body = code.replace(/^import [^;]*? from '\.\/[\w-]+\.ts';$/gm, '').replace(/^import [^;]*? from '\.\.\/\.\.\/\.\.\/packages\/dsl\/src\/recovery\/item-state\.ts';$/gm, '').replace(/^export (?=(?:async )?function |const |let |class )/gm, '');
    for (const [, name] of body.matchAll(/^(?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)) {
      if (names.has(name)) throw new Error(`${file} and ${names.get(name)} both declare ${name} at the top level`);
      names.set(name, file);
    }
    return `// ${file}\n${body}`;
  });
  return { body: parts.join('\n'), modules };
}

/** `recordingsDir`: the recordings bundled into the gallery (a test passes its fixture's directory). */
export function build(target = out, recordingsDir = join(here, 'recordings')) {
  const { body, modules } = bundle('app.ts');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'viewer.js'), `(() => {\n'use strict';\n${body}\n})();\n`);
  writeFileSync(join(target, 'index.html'), readFileSync(join(here, 'index.html')));

  const gallery = [];
  for (const id of existsSync(recordingsDir) ? readdirSync(recordingsDir).sort() : []) {
    const dir = join(recordingsDir, id);
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
  return { target, modules: modules.length, recordings: gallery.map((entry) => entry.id) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(build()));
