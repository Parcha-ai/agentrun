import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Declaration imports use package-local relative paths, so a consumer needs neither Vite aliases nor the source repo.
const app = dirname(fileURLToPath(import.meta.url));
const out = join(app, 'dist/library/types');
const consoleTypes = join(out, 'apps/console/src');
const dslTypes = join(out, 'packages/dsl/src');
const timelineTypes = join(out, 'packages/pi-durable-agent/src/timeline');
const browserTypes = join(out, 'packages/pi-browser/src/core');
function rewrite(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) rewrite(file);
    else if (file.endsWith('.d.ts')) {
      const text = readFileSync(file, 'utf8').replace(/^import ["']\.\/styles\.css["'];\r?\n/m, '').replace(/(["'])(@\/|@dsl\/|@timeline\/|@pi-browser\/)([^"']+)\1/g, (_match, quote, alias, suffix) => {
        const target = resolve(({ '@/': consoleTypes, '@dsl/': dslTypes, '@timeline/': timelineTypes, '@pi-browser/': browserTypes })[alias], suffix);
        let path = relative(dirname(file), target).replaceAll('\\', '/');
        if (!path.startsWith('.')) path = './' + path;
        return quote + path + quote;
      }).replace(/(["'])(\.{1,2}\/[^"']+)\1/g, (match, quote, specifier) => {
        const target = resolve(dirname(file), specifier);
        if (existsSync(target + '.d.ts')) return quote + specifier + '.js' + quote;
        if (existsSync(join(target, 'index.d.ts'))) return quote + specifier + '/index.js' + quote;
        return match;
      });
      writeFileSync(file, text);
    }
  }
}
rewrite(out);
