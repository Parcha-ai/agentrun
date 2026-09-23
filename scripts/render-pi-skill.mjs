// The Pi package registers the author skill rendered for its own host: the dsl package's host-neutral skill,
// with the Pi addendum in SKILL.md and in the language reference. Pi's package loader reads it from dist,
// so a session sees the host rules without calling describe.
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { authorContract, authorSkillDirectory, renderAuthorHostAddendum } from '@parcha/agentrun-dsl';
import { PI_HOST_ADDENDUM } from '../packages/pi/dist/host-addendum.js';

const target = new URL('../packages/pi/dist/skills/author/', import.meta.url);
await rm(target, { recursive: true, force: true });
await cp(authorSkillDirectory(), target, { recursive: true });
const skill = await readFile(new URL('SKILL.md', target), 'utf8');
await writeFile(new URL('SKILL.md', target), `${skill.trimEnd()}\n\n${renderAuthorHostAddendum(PI_HOST_ADDENDUM)}\n`);
await writeFile(new URL('references/language.md', target), `<!-- Rendered for the Pi extension from @parcha/agentrun-dsl by scripts/render-pi-skill.mjs. -->\n\n# AgentRun workflow language\n\n${authorContract({ host: PI_HOST_ADDENDUM })}\n`);
console.log('Rendered the Pi author skill into packages/pi/dist/skills/author');
