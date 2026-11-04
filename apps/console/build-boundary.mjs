import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { NOTICES_FILE, noticesFor, packageDirOf } from './third-party-notices.mjs';

/** Browser runtime dependencies are deliberately reviewed separately from development/build tooling. */
export const RUNTIME_DEPENDENCIES = new Set([
  '@fontsource/jetbrains-mono', '@fontsource/schibsted-grotesk', 'clsx', 'dompurify',
  'lucide-react', 'marked', 'react', 'react-dom',
]);

export function assertConsoleDependencies(manifest) {
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!RUNTIME_DEPENDENCIES.has(name)) throw new Error(`Console runtime dependency is unreviewed: ${name}`);
  }
}

export function assertBundledPackage(name) {
  if (!RUNTIME_DEPENDENCIES.has(name) && name !== 'scheduler') throw new Error(`Console bundled dependency is unreviewed: ${name}`);
}

const PRIVATE_BROWSER = /(?:\b(?:descope|posthog)\b|(?:grep\.ai|parcha\.dev|code\.run|northflank\.com)\b|\/grep\/agentrun\b|\/api\/v2\/control\b)/i;
export function assertBrowserText(text, name) {
  if (PRIVATE_BROWSER.test(text)) throw new Error(`Console private integration in ${name}`);
}

/** An installed package containing a bundled module, including a scoped package. */
export function packageRoot(id) {
  return packageDirOf(id.replaceAll('\\', '/')) ?? null;
}

function assertProductionModule(id, app) {
  const source = `${join(app, 'src').replaceAll('\\', '/')}/`;
  const resolved = id.replaceAll('\\', '/').replace(/^\0/, '').split(/[?#]/)[0];
  if (!resolved.startsWith(source)) return;
  const file = resolved.slice(source.length);
  if (/(?:^|\/)(?:__)?(?:fixtures?|samples?|mocks?|stories|story|tests?)(?:__)?(?:\/|\.|$)/i.test(file)
    || /\.(?:fixtures?|samples?|mocks?|stories|story|tests?|spec)\.[^/]+$/i.test(file)) {
    throw new Error(`Nonproduction console module in browser bundle: src/${file}`);
  }
}

function assertBundledLicense(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assertBundledPackage(pkg.name);
  const files = readdirSync(root).filter((name) => /^(?:licen[cs]e|copying|ofl)(?:[.-].*)?$/i.test(name)).sort();
  if (!files.length) throw new Error(`Bundled package has no license file: ${pkg.name}`);
}

/** Fail closed on private browser integrations and distribute the licenses of bundled code and fonts. */
export function consoleBoundary() {
  let app;
  return {
    name: 'agentrun-console-boundary',
    apply: 'build',
    configResolved(config) {
      app = config.root;
      assertConsoleDependencies(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')));
    },
    generateBundle(_options, bundle) {
      const roots = new Set();
      for (const item of Object.values(bundle)) {
        const ids = item.type === 'chunk' ? item.moduleIds : (item.originalFileNames ?? []).map((name) => isAbsolute(name) ? name : join(app, name));
        for (const id of ids) {
          assertProductionModule(id, app);
          const root = packageRoot(id);
          if (root && existsSync(join(root, 'package.json'))) roots.add(root);
        }
        if (item.type === 'chunk') {
          assertBrowserText(item.code, item.fileName);
        } else if (/\.(?:html|css|js|json)$/.test(item.fileName)) {
          assertBrowserText(String(item.source), item.fileName);
        }
      }
      // Font assets come from CSS, so Rollup's JavaScript module inventory can omit their package roots.
      for (const name of RUNTIME_DEPENDENCIES) {
        if (name.startsWith('@fontsource/')) roots.add(join(app, 'node_modules', name));
      }
      for (const root of roots) assertBundledLicense(root);
      this.emitFile({ type: 'asset', fileName: NOTICES_FILE, source: noticesFor([...roots]).text });
      const files = [...new Set([...Object.keys(bundle), NOTICES_FILE])].filter((name) => !name.endsWith('.map')).sort();
      this.emitFile({ type: 'asset', fileName: 'asset-manifest.json', source: JSON.stringify({ files }, null, 2) + '\n' });
    },
  };
}
