// Bundle the page into dist/. MuJoCo and sql.js ship wasm next to their loaders, so both are copied as-is and
// imported at runtime by relative URL (same origin, no CDN), and so is wllama's (episode 2); everything else is one esbuild bundle.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
mkdirSync(join(dist, 'vendor'), { recursive: true });

for (const f of ['mujoco.js', 'mujoco.wasm']) cpSync(join(here, 'node_modules/@mujoco/mujoco', f), join(dist, 'vendor', f));
cpSync(join(here, 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm'), join(dist, 'vendor', 'wllama.wasm'));
for (const f of ['sql-wasm.js', 'sql-wasm.wasm']) cpSync(join(here, 'node_modules/sql.js/dist', f), join(dist, 'vendor', f));

await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(dist, 'main.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
});

// The pinned MuJoCo version, read from the package so a policy's mujoco_version check has one source.
const mjVersion = JSON.parse(readFileSync(join(here, 'node_modules/@mujoco/mujoco/package.json'), 'utf8')).version;
writeFileSync(join(dist, 'versions.json'), JSON.stringify({ mujoco: mjVersion }) + '\n');
cpSync(join(here, 'index.html'), join(dist, 'index.html'));
