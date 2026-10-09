// Which body a policy runs on, for the command-line checks: DESIGN=<design.json> names it (a body that is not a preset, e.g. one
// the trainer built), otherwise it is the preset whose mjcf_sha256 the policy names, otherwise the default creature.
import { readFileSync } from 'node:fs';
import { presetForSha } from '../src/bodies.ts';
import { defaultDesign, type Design } from '../src/design.ts';

export async function resolveBody(policyText: string): Promise<{ name: string; design: Design }> {
  if (process.env.DESIGN) {
    const design = JSON.parse(readFileSync(process.env.DESIGN, 'utf8')) as Design;
    return { name: `${design.name} (${process.env.DESIGN.split('/').slice(-2, -1)[0] ?? 'design'})`, design };
  }
  return (await presetForSha(JSON.parse(policyText).mjcf_sha256)) ?? { name: 'default (no preset matches this policy)', design: defaultDesign() };
}
