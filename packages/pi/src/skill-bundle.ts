import { readFileSync, readdirSync } from 'node:fs';

/** Shipped with the extension, including hosts without filesystem-reading tools. */
export function loadPiJevGuide(): string {
  return readFileSync(new URL('../skills/author/references/jev-decisions.md', import.meta.url), 'utf8');
}

/** The same core contract for skill-enabled and tool-only Pi hosts. */
export function loadPiWorkflowGuide(): string {
  return readFileSync(new URL('../skills/author/references/workflow-format.md', import.meta.url), 'utf8');
}

export function loadPiAuthorSkillBundle(): string {
  const root = new URL('../skills/author/', import.meta.url);
  const files = ['SKILL.md', 'references/workflow-format.md', 'references/jev-decisions.md', ...readdirSync(new URL('examples/', root))
    .filter(name => name.endsWith('.json')).sort().map(name => `examples/${name}`)];
  return files.map(path => `\n--- ${path} ---\n${readFileSync(new URL(path, root), 'utf8')}`).join('\n');
}
