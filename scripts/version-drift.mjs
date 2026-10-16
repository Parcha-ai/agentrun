// The README version-drift check: a user-facing install line that names a version other than the current release, a Pi range
// other than the packages' own, or a bare `npx agentrun`.
//
// It reads only the lines that ARE install or version statements, by this structural rule (STRUCTURE), and nothing else. A grep
// over prose would hit what is right as it stands: recorded fixtures (apps/viewer/recordings, test fixtures), history
// (CHANGELOG.md, changes/ fragments, comments), and minimums ("needs Pi 1.1.0 or later", a Since column). So the rule is about
// the shape of a line, not about a version number appearing in it:
export const STRUCTURE = [
  'a command line inside a fenced code block of a shell kind (sh, bash, shell, zsh, console) or of no kind: `npm install|i|add`, `pnpm add`, `yarn add`, `bun add`, `pi install`, `npx`, `pnpm dlx`, `bunx`',
  'an inline code span, anywhere in a doc, whose whole content is such a command',
  'a release statement: a line beginning "This release is `<version>`" or "Beta: `<version>`"',
  'a dependency of an example package.json that names a @parcha/ or @earendil-works/ package',
  'the Pi range statement, "<low> to below <high>" (the one form the docs state the supported Pi range in)',
  'EXPECTED: the two statement shapes above are prose, so a rephrased sentence would stop being seen and the check would pass without it; EXPECTED lists the files that must carry each and how many, and a file with fewer fails the check',
];
/** The files that must carry a release statement and the Pi range statement, with how many each holds today. A file with fewer fails:
 *  the sentence was rephrased (so the shape no longer matches and the check cannot see it) or removed; update STRUCTURE when that is meant. */
export const EXPECTED = {
  'release-statement': { 'README.md': 1, 'packages/dsl/README.md': 1, 'packages/jev/README.md': 1 },
  'pi-statement': { 'README.md': 2, 'docs/guide.md': 1, 'packages/pi/README.md': 4 },
};
const LABEL = { 'release-statement': 'release statement', 'pi-statement': 'Pi range statement' };
// And only in the user-facing docs: DOC_FILES. The rules on those lines:
export const RULES = {
  release: 'a @parcha/ package named with a version names the current release (the workspace version in package.json)',
  'pi-range': 'an @earendil-works/ package named with an exact version is inside the Pi range @parcha/agentrun-pi accepts, one named with a range names that range exactly, and a Pi range statement says that range (from its peer range of pi-durable)',
  'bare-npx': '`npx agentrun` names no package: the command is `npx @parcha/agentrun-dsl@<release> <command>`',
  'release-statement': 'a release statement names the current release',
  'expected-statement': 'every file EXPECTED lists holds at least as many release and Pi range statements as it lists',
};

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { accepts } from './pi-leg.mjs';

const SHELL_FENCES = new Set(['', 'sh', 'bash', 'shell', 'zsh', 'console']);
const INSTALLERS = [/^npm (?:install|i|add)\b/, /^pnpm add\b/, /^yarn add\b/, /^bun add\b/, /^pi install\b/, /^npx\b/, /^pnpm dlx\b/, /^bunx\b/];
const isCommand = (text) => INSTALLERS.some((pattern) => pattern.test(text));
const VERSION = /^[\^~]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const RANGE = /[<>=|*x ]|\|\|/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const entries = (directory) => (existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : []);

/** The user-facing docs the rule reads: the root README, docs/*.md, each package's README (and its examples/README.md), and each
 *  example's README, with the examples' package.json. Not the changelogs, the change fragments, the viewer, the recordings, the
 *  test fixtures or the skills. */
export function docFiles(root) {
  const markdown = ['README.md'];
  for (const entry of entries(join(root, 'docs'))) if (entry.isFile() && entry.name.endsWith('.md')) markdown.push(`docs/${entry.name}`);
  for (const entry of entries(join(root, 'packages'))) {
    if (!entry.isDirectory()) continue;
    markdown.push(`packages/${entry.name}/README.md`, `packages/${entry.name}/examples/README.md`);
  }
  const manifests = [];
  for (const entry of entries(join(root, 'examples'))) {
    if (!entry.isDirectory()) continue;
    markdown.push(`examples/${entry.name}/README.md`);
    manifests.push(`examples/${entry.name}/package.json`);
  }
  return { markdown: markdown.filter((file) => existsSync(join(root, file))), manifests: manifests.filter((file) => existsSync(join(root, file))) };
}

/** The install and version statements of a markdown file, with their line numbers, by STRUCTURE. */
export function statementsOf(text) {
  const found = [];
  let fence = null; // the open fence's marker and whether its lines are shell
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const opening = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/.exec(raw);
    if (opening) {
      if (fence && opening[1][0] === fence.marker[0] && opening[1].length >= fence.marker.length && !opening[2]) fence = null;
      else if (!fence) fence = { marker: opening[1], shell: SHELL_FENCES.has(opening[2].toLowerCase()) };
      return;
    }
    if (fence) {
      if (!fence.shell) return;
      for (const part of raw.replace(/^\s*[$>]\s*/, '').split(/\s*(?:&&|;)\s*/)) {
        const command = part.trim();
        if (command && !command.startsWith('#') && isCommand(command)) found.push({ line, kind: 'command', text: command });
      }
      return;
    }
    for (const span of raw.matchAll(/`([^`]+)`/g)) {
      const content = span[1].trim();
      if (isCommand(content)) found.push({ line, kind: 'command', text: content });
    }
    const release = /^(?:This release is|Beta:) `([^`]+)`/.exec(raw);
    if (release) found.push({ line, kind: 'release-statement', text: raw.trim(), version: release[1] });
    for (const range of raw.matchAll(/(\d+\.\d+\.\d+) to below (\d+\.\d+)(?!\.\d)/g)) found.push({ line, kind: 'pi-statement', text: raw.trim(), low: range[1], high: range[2] });
  });
  return found;
}

/** A command's tokens as a shell reads them: split on spaces outside quotes, quotes removed (`pkg@">=1.0.4 <1.4.0"` is one token). */
export function tokensOf(command) {
  const tokens = [];
  for (const match of command.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)) tokens.push(match[0].replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single));
  return tokens;
}

/** The package specs a command names: the tokens after the installer verb that are not flags (the first only, for npx, whose later
 *  tokens are the command's own). `npm:` is a protocol, not part of the name. */
export function specsOf(command) {
  const tokens = tokensOf(command);
  const npx = /^(?:npx|bunx|pnpm dlx)$/.test(tokens[0] === 'pnpm' ? `${tokens[0]} ${tokens[1]}` : tokens[0]);
  const rest = tokens.slice(tokens[0] === 'pnpm' || tokens[0] === 'npm' || tokens[0] === 'yarn' || tokens[0] === 'bun' || tokens[0] === 'pi' ? 2 : 1);
  const names = rest.filter((token) => !token.startsWith('-'));
  return (npx ? names.slice(0, 1) : names).map((token) => {
    const bare = token.replace(/^npm:/, '');
    const at = bare.lastIndexOf('@');
    return at > 0 ? { name: bare.slice(0, at), spec: bare.slice(at + 1), token: bare } : { name: bare, spec: undefined, token: bare };
  });
}

/** What drifts in `root`: `[{ file, line, rule, text, message }]`, empty when nothing does. */
export function driftOf(root, { expected: listed = EXPECTED } = {}) {
  const release = readJson(join(root, 'package.json')).version;
  const piRange = readJson(join(root, 'packages/pi/package.json')).peerDependencies['@earendil-works/pi-durable'];
  const shape = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+)\.0$/.exec(piRange.trim());
  /** The Pi range as the docs state it ("1.0.4 to below 1.4"), when the peer range has the shape `>=low <high.0`. */
  const expected = shape ? { low: shape[1], high: shape[2] } : undefined;
  const problems = [];
  const report = (file, line, rule, text, message) => problems.push({ file, line, rule, text, message });

  const check = (file, line, { name, spec, token }, text) => {
    if (name.startsWith('@parcha/') && spec !== undefined) {
      const match = VERSION.exec(spec);
      if (match && match[1] !== release) report(file, line, 'release', text, `${name} is named at ${spec}, and the release is ${release}`);
    }
    if (name.startsWith('@earendil-works/') && spec !== undefined) {
      const exact = VERSION.exec(spec);
      if (exact && !spec.startsWith('^') && !spec.startsWith('~')) {
        let inside = false;
        try { inside = accepts(piRange, exact[1], '@earendil-works/pi-durable'); } catch { inside = false; }
        if (!inside) report(file, line, 'pi-range', text, `${token} is outside the Pi range ${piRange} that @parcha/agentrun-pi accepts`);
      } else if (RANGE.test(spec) || exact) {
        if (spec.replace(/\s+/g, ' ').trim() !== piRange) report(file, line, 'pi-range', text, `${token} names the Pi range "${spec}", and the packages' own is "${piRange}"`);
      }
    }
  };

  const { markdown, manifests } = docFiles(root);
  const counts = {};
  for (const file of markdown) {
    for (const statement of statementsOf(readFileSync(join(root, file), 'utf8'))) {
      if (statement.kind !== 'command') ((counts[statement.kind] ??= {})[file] ??= []).push(statement.line);
      if (statement.kind === 'pi-statement') {
        if (expected && (statement.low !== expected.low || statement.high !== expected.high)) {
          report(file, statement.line, 'pi-range', statement.text, `the Pi range is stated as ${statement.low} to below ${statement.high}, and the packages' own is ${expected.low} to below ${expected.high}`);
        }
        continue;
      }
      if (statement.kind === 'release-statement') {
        if (statement.version !== release) report(file, statement.line, 'release-statement', statement.text, `the release statement names ${statement.version}, and the release is ${release}`);
        continue;
      }
      const tokens = tokensOf(statement.text);
      if (/^npx\b/.test(statement.text) && tokens.find((token, index) => index > 0 && !token.startsWith('-')) === 'agentrun') {
        report(file, statement.line, 'bare-npx', statement.text, 'a bare `npx agentrun` names no package (use npx @parcha/agentrun-dsl@' + release + ')');
      }
      for (const spec of specsOf(statement.text)) check(file, statement.line, spec, statement.text);
    }
  }
  for (const [kind, files] of Object.entries(listed)) {
    for (const [file, count] of Object.entries(files)) {
      const found = counts[kind]?.[file]?.length ?? 0;
      if (found < count) report(file, 0, 'expected-statement', '', `${file}: expected ${count} ${LABEL[kind]}${count === 1 ? '' : 's'}, found ${found}: a rephrase? update STRUCTURE`);
    }
  }
  for (const file of manifests) {
    const manifest = readJson(join(root, file));
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(manifest[group] ?? {})) {
        if (name.startsWith('@parcha/') || name.startsWith('@earendil-works/')) check(file, 0, { name, spec, token: `${name}@${spec}` }, `"${name}": "${spec}" (${group})`);
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(import.meta.dirname, '..');
  const problems = driftOf(root);
  for (const problem of problems) console.log(`${problem.file}${problem.line ? `:${problem.line}` : ''}: ${problem.rule}: ${problem.message}\n    ${problem.text}`);
  if (problems.length) process.exit(1);
  console.log('No install line names a stale version.');
}
