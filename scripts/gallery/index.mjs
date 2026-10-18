#!/usr/bin/env node
// The gallery's search index (`agentrun.gallery/1`): one JSON the gallery's pages search in the browser, built from each
// example's demo.json that names a `category` and the manifest of the recording beside it. Each value has one source: what
// a demo's author wrote comes from its demo.json, what its run measured from its recording's manifest, and the landing row's
// order from examples/gallery.json, which the maintainers own. Cost, kills and every counter are left out: no card shows
// them. The same commit gives the same bytes: nothing in it is the time of the build.
//
// `node scripts/gallery/index.mjs [--out <dir>]`: checks every gallery demo and prints each problem, or writes
// <dir>/index.json (default: prints the index).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import { scanRecording } from '../../examples/reference/scan.ts';
import { validateRecording } from '../recording/validate.mjs';

export const FORMAT = 'agentrun.gallery/1';
export const REPOSITORY = 'https://github.com/Parcha-ai/agentrun';
/** The six categories (2026-10-18), with what each covers: the line a category's page opens with. */
export const CATEGORIES = [
  { id: 'vision', label: 'Vision', about: 'Agents that read pages, photographs, film and sound, each answer citing where it looked.' },
  { id: 'browsing', label: 'Browsing', about: 'Agents that work in a real browser and keep what they read as evidence.' },
  { id: 'workflows', label: 'Workflows', about: 'Procedures written as typed workflows: steps, judgments and checks that run the same way again.' },
  { id: 'agents-at-work', label: 'Agents at work', about: 'Agents doing a whole job, from the question to the delivered result.' },
  { id: 'places-and-machines', label: 'Places and machines', about: 'Where an agent runs: on this machine, in a box, on a disk, and moving between them.' },
  { id: 'learning', label: 'Learning', about: 'Agents that learn from a correction and keep what they learned.' },
];
/** The most a recording may publish, every file in it; past it a blob goes outside the recording. */
export const RECORDING_LIMIT = 10 * 1024 * 1024;
const PICTURE = /\.(png|jpe?g|webp)$/i;
const SCOPED = /^(npx @parcha\/|node examples\/|npm run )/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const filesOf = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesOf(join(dir, entry.name)) : [join(dir, entry.name)]));

/** The names a live run needs from demo.json's `keys`: a required key's `env`, and for a choice (`oneOf`) the names any one
 *  of which will do, a member that is a list being all of its names. Names only, never a value; a key for the scripted
 *  path only, or not required, is not a need. */
export function needsOf(keys) {
  const named = (entry) => (Array.isArray(entry) ? entry.flatMap(named) : isObject(entry) && typeof entry.env === 'string' ? [entry.env] : []);
  const live = (entry) => !isObject(entry) || entry.for === undefined || entry.for === 'live';
  return (Array.isArray(keys) ? keys : []).flatMap((entry) => {
    if (!live(entry)) return [];
    if (isObject(entry) && Array.isArray(entry.oneOf)) {
      const any = entry.oneOf.filter(live).map((member) => (Array.isArray(member) ? named(member) : named(member)[0])).filter((member) => member !== undefined && (!Array.isArray(member) || member.length > 0));
      return any.length ? [{ any }] : [];
    }
    if (Array.isArray(entry)) return entry.every((member) => !isObject(member) || member.required !== false) ? named(entry) : [];
    return isObject(entry) && typeof entry.env === 'string' && entry.required !== false ? [entry.env] : [];
  });
}

/** The models a run named: the manifest's lead, then the string values of its `models` when it has that object, once each. */
export const modelsOf = (manifest) => [...new Set([manifest.model, ...(isObject(manifest.models) ? Object.values(manifest.models) : [])].filter((model) => typeof model === 'string' && model !== ''))];

/** The index of the gallery at `root` (the repository), and every problem that keeps a demo out of it. */
export function galleryIndex(root, { commit = 'unknown', version = 'unknown' } = {}) {
  const problems = [];
  const add = (where, message) => problems.push(`${where}: ${message}`);
  const examples = join(root, 'examples');
  const spec = readJson(join(examples, 'demo-spec.schema.json'));
  const schema = new Ajv({ allErrors: true, strict: false }).addSchema(spec).compile(readJson(join(examples, 'demo.schema.json')));
  const workspace = new Set(readdirSync(join(root, 'packages')).flatMap((name) => { const path = join(root, 'packages', name, 'package.json'); return existsSync(path) ? [readJson(path).name] : []; }));
  const gallery = existsSync(join(examples, 'gallery.json')) ? readJson(join(examples, 'gallery.json')) : {};
  const featured = Array.isArray(gallery.featured) ? gallery.featured : [];
  const demos = [];
  for (const name of readdirSync(examples).sort()) {
    const path = join(examples, name, 'demo.json');
    if (!existsSync(path)) continue;
    const where = `examples/${name}/demo.json`;
    let demo;
    try { demo = readJson(path); } catch (error) { add(where, `is not JSON: ${error.message}`); continue; }
    if (!isObject(demo) || demo.category === undefined) continue;
    if (!schema(demo)) { for (const error of schema.errors) add(where, `${error.instancePath || '/'} ${error.message}`); continue; }
    if (demo.name !== name) { add(where, `name is ${JSON.stringify(demo.name)}, but the example's folder is ${name}`); continue; }
    for (const extension of demo.extensions) if (!workspace.has(extension)) add(where, `extension ${extension} is not a package of this repository's workspace`);
    const folder = join(examples, name);
    const dir = resolve(folder, demo.recording ?? 'recording');
    if (!dir.startsWith(`${resolve(folder)}${sep}`)) { add(where, `recording ${demo.recording} is outside the example's folder`); continue; }
    const at = `examples/${name}/${relative(folder, dir)}`;
    if (!existsSync(join(dir, 'manifest.json'))) { add(at, 'is not a recording: it has no manifest.json'); continue; }
    for (const problem of validateRecording(dir)) add(`${at}/${problem.where}${problem.line === undefined ? '' : `:${problem.line}`}`, problem.message);
    for (const found of scanRecording(dir)) add(`${at}/${found.file}`, `contains a ${found.found}`);
    const bytes = filesOf(dir).reduce((sum, file) => sum + statSync(file).size, 0);
    if (bytes > RECORDING_LIMIT) add(at, `is ${bytes} bytes, over the ${RECORDING_LIMIT} a recording may publish`);
    const manifest = readJson(join(dir, 'manifest.json'));
    if (manifest.store !== undefined) add(at, 'carries the run\'s store, which the gallery does not publish');
    const blobs = existsSync(join(dir, 'blobs')) ? readdirSync(join(dir, 'blobs')) : [];
    const poster = blobs.find((file) => file.split('.')[0] === demo.poster.blob);
    if (!poster) add(where, `poster ${demo.poster.blob} is not a blob of the recording`);
    else if (!PICTURE.test(poster)) add(where, `poster ${poster} is not a PNG, JPEG or WebP picture`);
    else if (createHash('sha256').update(readFileSync(join(dir, 'blobs', poster))).digest('hex') !== demo.poster.blob) add(where, `poster ${poster} does not hash to its name`);
    const started = Date.parse(manifest.recorded?.started);
    const ended = Date.parse(manifest.recorded?.ended);
    demos.push({
      id: name, title: demo.title, summary: demo.summary, category: demo.category, tags: demo.tags, extensions: demo.extensions, author: demo.author,
      featured: featured.includes(name) ? featured.indexOf(name) + 1 : null,
      poster: poster ? `replay/recordings/${name}/blobs/${poster}` : null,
      replay: `replay/?r=${name}&embed=1&hide=durability`,
      page: `demo/${name}/`,
      source: `examples/${name}`,
      run: demo.run.replaceAll('<version>', version),
      needs: needsOf(demo.keys),
      providers: manifest.providers === 'real' || manifest.providers === 'scripted' ? manifest.providers : null,
      models: modelsOf(manifest),
      date: Number.isFinite(started) ? new Date(started).toISOString().slice(0, 10) : null,
      duration_ms: Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null,
    });
  }
  for (const id of featured) if (!demos.some((demo) => demo.id === id)) add('examples/gallery.json', `featured ${JSON.stringify(id)} is no gallery demo`);
  const label = Object.fromEntries(CATEGORIES.map((category) => [category.id, category.label]));
  for (const demo of demos) {
    if (!SCOPED.test(demo.run)) add(`examples/${demo.id}/demo.json`, `run is not scoped: ${demo.run}`);
    demo.search = [demo.title, demo.summary, demo.category, label[demo.category], ...demo.tags, ...demo.extensions, ...demo.models, demo.author].join(' ').toLowerCase();
  }
  // Featured first, in the maintainers' order, then the newest, then by id.
  demos.sort((a, b) => (a.featured ?? Infinity) - (b.featured ?? Infinity) || (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id));
  const counted = (values) => [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    problems,
    index: {
      format: FORMAT, repository: REPOSITORY, commit, version,
      categories: CATEGORIES.map((category) => ({ ...category, count: demos.filter((demo) => demo.category === category.id).length })).filter((category) => category.count > 0),
      tags: counted(demos.flatMap((demo) => demo.tags)).map(([id, count]) => ({ id, count })),
      extensions: counted(demos.flatMap((demo) => demo.extensions)).map(([name, count]) => ({ name, count })),
      models: counted(demos.flatMap((demo) => demo.models)).map(([id, count]) => ({ id, count })),
      featured: featured.filter((id) => demos.some((demo) => demo.id === id)),
      demos,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const value = (flag) => { const at = process.argv.indexOf(flag); return at >= 0 ? process.argv[at + 1] : undefined; };
  const packageJson = readJson(join(root, 'package.json'));
  const { problems, index } = galleryIndex(root, { commit: value('--commit') ?? 'unknown', version: value('--version') ?? packageJson.version ?? 'unknown' });
  if (problems.length) { for (const problem of problems) console.error(problem); process.exitCode = 1; }
  else if (value('--out')) { writeFileSync(join(value('--out'), 'index.json'), `${JSON.stringify(index, null, 2)}\n`); console.log(`${value('--out')}/index.json: ${index.demos.length} demo(s)`); }
  else console.log(JSON.stringify(index, null, 2));
}
