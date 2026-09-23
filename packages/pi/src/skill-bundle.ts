import { readFileSync, readdirSync } from 'node:fs';

// The grammar and the Jev decision guide are the dsl package's authoring assets; the skill carries
// generated copies (scripts/generate-author-references.mjs) so a host without file tools reads the
// same text the SDK author does. workflow-format.md is the Pi host's own addendum.

/** Shipped with the extension, including hosts without filesystem-reading tools. */
export function loadPiJevGuide(): string {
  return readFileSync(new URL('../skills/author/references/jev-decisions.md', import.meta.url), 'utf8');
}

/** The two texts the workflow guide is made of: the shared contract (a generated copy of the dsl asset) and the Pi host's addendum. */
export function loadPiWorkflowGuideParts(): { contract: string; host: string } {
  return {
    contract: readFileSync(new URL('../skills/author/references/dsl-contract.md', import.meta.url), 'utf8'),
    host: readFileSync(new URL('../skills/author/references/workflow-format.md', import.meta.url), 'utf8'),
  };
}

/** The shared author contract followed by the Pi host's addendum: one text for skill-enabled and tool-only hosts. */
export function loadPiWorkflowGuide(): string {
  const { contract, host } = loadPiWorkflowGuideParts();
  return `${contract.trim()}\n\n${host}`;
}

export function loadPiAuthorSkillBundle(): string {
  const root = new URL('../skills/author/', import.meta.url);
  const files = ['SKILL.md', 'references/dsl-contract.md', 'references/workflow-format.md', 'references/jev-decisions.md', ...readdirSync(new URL('examples/', root))
    .filter(name => name.endsWith('.json')).sort().map(name => `examples/${name}`)];
  return files.map(path => `\n--- ${path} ---\n${readFileSync(new URL(path, root), 'utf8')}`).join('\n');
}
