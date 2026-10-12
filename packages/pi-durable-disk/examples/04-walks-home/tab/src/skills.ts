// The skills a run brings home: one mlp-v1 policy per skill (home/skills/<skill>.json, each with its own getup network, trained for ONE body) and the manifest that names them (home/skills.json):
//   {"version": 1, "body_mjcf_sha256": "...", "default": "walk", "skills": {"walk": {"policy": "skills/walk.json", "command": 0.5, "label": "walk"}, "sprint": {...}}}
// The page picks a skill by name and feeds that skill's fixed `command` into the policy's command slot (a negative command is a skill that goes backwards: it is never clamped at 0 here; the
// policy's own command_range bounds it). Pure: no DOM, no file reads.

export interface SkillEntry { policy: string; command: number; label: string }
export interface SkillManifest { version: 1; body_mjcf_sha256: string; default: string; skills: Record<string, SkillEntry> }

export class SkillsRefused extends Error {}

export const MAX_SKILLS = 16;
const NAME = /^[a-z][a-z0-9-]{0,23}$/;
const POLICY_PATH = /^skills\/[a-z0-9][a-z0-9-]{0,23}\.json$/;
export const COMMAND_LIMIT = 2;

export const SKILLS_PATH = 'home/skills.json';
/** Where a skill's policy is on the run's disk: the manifest's relative path under home/. */
export const skillPolicyPath = (entry: SkillEntry): string => `home/${entry.policy}`;

export function parseSkills(text: string): SkillManifest {
  let m: any;
  try { m = JSON.parse(text); } catch { throw new SkillsRefused('skills.json is not JSON'); }
  if (!m || typeof m !== 'object' || m.version !== 1) throw new SkillsRefused('skills.json: version must be 1');
  if (typeof m.body_mjcf_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.body_mjcf_sha256)) throw new SkillsRefused('skills.json: body_mjcf_sha256 must be a sha256');
  const names = m.skills && typeof m.skills === 'object' && !Array.isArray(m.skills) ? Object.keys(m.skills) : [];
  if (names.length === 0 || names.length > MAX_SKILLS) throw new SkillsRefused(`skills.json: skills must name 1 to ${MAX_SKILLS} skills`);
  const skills: Record<string, SkillEntry> = {};
  for (const name of names) {
    const e = m.skills[name];
    if (!NAME.test(name)) throw new SkillsRefused(`skills.json: ${JSON.stringify(name)} is not a skill name`);
    if (!e || typeof e.policy !== 'string' || !POLICY_PATH.test(e.policy)) throw new SkillsRefused(`skills.json: ${name}: policy must be skills/<name>.json`);
    if (typeof e.command !== 'number' || !Number.isFinite(e.command) || Math.abs(e.command) > COMMAND_LIMIT) throw new SkillsRefused(`skills.json: ${name}: command must be a number within +-${COMMAND_LIMIT}`);
    const label = typeof e.label === 'string' && e.label.length > 0 && e.label.length <= 40 ? e.label : name;
    skills[name] = { policy: e.policy, command: e.command, label };
  }
  const def = typeof m.default === 'string' && skills[m.default] ? m.default : names[0]!;
  return { version: 1, body_mjcf_sha256: m.body_mjcf_sha256, default: def, skills };
}
