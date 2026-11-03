import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  const path = id.replace(/^\0+/, '').split('?')[0].replaceAll('\\', '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const parts = path.slice(at + '/node_modules/'.length).split('/');
  return path.slice(0, at + '/node_modules/'.length) + parts.slice(0, parts[0]?.startsWith('@') ? 2 : 1).join('/');
}

function licenseEntry(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = readdirSync(root).filter((name) => /^(?:licen[cs]e|copying|ofl)(?:[.-].*)?$/i.test(name)).sort();
  if (!files.length) throw new Error(`Bundled package has no license file: ${pkg.name}`);
  return {
    name: pkg.name, version: pkg.version, license: pkg.license ?? 'UNKNOWN',
    text: files.map((name) => readFileSync(join(root, name), 'utf8').trim()).join('\n\n'),
  };
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
        if (item.type === 'chunk') {
          assertBrowserText(item.code, item.fileName);
          for (const id of item.moduleIds) {
            const root = packageRoot(id);
            if (root && existsSync(join(root, 'package.json'))) roots.add(root);
          }
        } else if (/\.(?:html|css|js|json)$/.test(item.fileName)) {
          assertBrowserText(String(item.source), item.fileName);
        }
      }
      // Font assets come from CSS, so Rollup's JavaScript module inventory can omit their package roots.
      for (const name of RUNTIME_DEPENDENCIES) {
        if (name.startsWith('@fontsource/')) roots.add(join(app, 'node_modules', name));
      }
      const entries = [...roots].map(licenseEntry).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) assertBundledPackage(entry.name);
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source:
        'Third-party software distributed with the AgentRun console\n\n' + entries.map((entry) => `${entry.name} ${entry.version} (${entry.license})\n\n${entry.text}\n`).join('\n-----\n\n') });
      const files = Object.keys(bundle).filter((name) => !name.endsWith('.map')).sort();
      this.emitFile({ type: 'asset', fileName: 'asset-manifest.json', source: JSON.stringify({ files }, null, 2) + '\n' });
    },
  };
}
