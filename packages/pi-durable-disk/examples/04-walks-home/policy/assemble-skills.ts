// Homecoming for the cluster beat, on a session host with node and no python: the TypeScript twin of
// train/assemble_skills.py (same inputs, same files, same rules; a parity check holds the outputs equal as JSON).
//
//   node assemble-skills.ts work/skills --home home [--default walk] [--getup GETUP.json] [--without-getup]
//
// For every work/skills/<dir>/ whose skill.json says done, home/skills/<skill>.json is that skill's policy.json with the
// get-up network inside (the `combine` rule of train/export.py, so a fall is caught in every skill), and home/skills.json is
//   {"version": 1, "body_mjcf_sha256", "default", "skills": {"<skill>": {"policy": "skills/<skill>.json", "command", "label"}}}
// The get-up skill itself is the walk at command 0 with the get-up network. It reads only skill.json and policy.json per
// skill. The get-up network is the get-up skill's policy (or --getup); with neither it refuses, unless --without-getup
// (a dry run without a get-up thread: the skills come home without the get-up network). Every file is checked by the
// policy runtime the page uses and written by rename, the manifest last, so a reader never sees a half-written home.
// After it, SKILLS_DIR/round.json summarizes the round for the stage (roundSummary).
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_POLICY_BYTES, Policy, type PolicyFile } from './policy.ts';

/** train/export.py: the hand-over between the two networks, and the std that pins an input the network never saw vary. */
export const SWITCH = { below_up: 0.3, above_up: 0.9 };
export const PINNED_STD = 1e9;
const PIN_FLOOR = 1e-5;

export interface SkillMeta {
  skill: string; status?: string; command?: number; label?: string; mjcf_sha256?: string; body_name?: string | null;
  passed_at?: { t?: number; steps?: number } | null; wall_s?: number; cpu_estimate_s?: number | null; cpu_estimate?: unknown; started_at?: number;
}
export interface SkillDir { meta: SkillMeta; policy: PolicyFile }
export interface Manifest {
  version: 1;
  body_mjcf_sha256: string;
  default: string | null;
  skills: Record<string, { policy: string; command: number; label: string }>;
}
export type Assembled =
  | { refused: string }
  | { files: Record<string, string>; manifest: Manifest; leftOut: Record<string, string>; withGetup: boolean };

function f32(b64: string): Float32Array {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
}

/** Everything non-finite: every number anywhere (JSON.parse reads 1e999 as Infinity), and the float32 weights of every layer. */
export function nonFinite(policy: unknown, where = 'policy'): string[] {
  const found: string[] = [];
  const walk = (o: unknown, path: string): void => {
    if (typeof o === 'number') {
      if (!Number.isFinite(o)) found.push(`${where}.${path} = ${o}`);
    } else if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(policy, '');
  const p = policy as { layers?: { w: string; b: string }[]; getup?: { layers?: { w: string; b: string }[] } };
  for (const [block, layers] of [['layers', p.layers], ['getup.layers', p.getup?.layers]] as const) {
    for (const [i, l] of (layers ?? []).entries()) {
      for (const k of ['w', 'b'] as const) {
        const bad = f32(l[k]).filter((v) => !Number.isFinite(v)).length;
        if (bad) found.push(`${where}.${block}[${i}].${k}: ${bad} values are not finite`);
      }
    }
  }
  return found;
}

function assertFinite(policy: unknown, where: string): void {
  const found = nonFinite(policy, where);
  if (found.length) throw new Error(`${where} is not finite: ${found.slice(0, 6).join('; ')}`);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** One file from a walking and a get-up policy of the same body (train/export.py `combine`). */
export function combine(walk: PolicyFile, getup: PolicyFile): PolicyFile {
  assertFinite(walk, 'walk policy');
  assertFinite(getup, 'getup policy');
  if (walk.mjcf_sha256 !== getup.mjcf_sha256) throw new Error('the two policies were trained for different bodies');
  if (!same(walk.clock, getup.clock)) throw new Error('the getup network runs on the walking network\'s phase clock; train both at the same gait_hz');
  const obs = { ...getup.obs, std: getup.obs.std.map((s) => (s <= PIN_FLOOR ? PINNED_STD : s)) };
  const out = {
    ...walk,
    getup: { layers: getup.layers, obs, act: getup.act, switch: { ...SWITCH } },
    provenance: { walk: (walk as { provenance?: unknown }).provenance ?? null, getup: (getup as { provenance?: unknown }).provenance ?? null },
  } as PolicyFile;
  assertFinite(out, 'combined policy');
  const size = new TextEncoder().encode(JSON.stringify(out)).length;
  if (size > MAX_POLICY_BYTES) throw new Error(`policy.json is ${size} bytes, over the tab's ${MAX_POLICY_BYTES}`);
  return out;
}

/** The page's own check: the file loads in the policy runtime for its body (the joint count is the walk head's width). */
async function check(p: PolicyFile): Promise<string | null> {
  try {
    await Policy.load(JSON.stringify(p), { mjcfSha256: p.mjcf_sha256, nj: p.layers[p.layers.length - 1]!.out, mujocoVersion: p.mujoco_version });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** The home files for the done skills, in the order given (assemble-skills reads the skill directories sorted by name). */
export async function assemble(dirs: SkillDir[], opts: { default?: string; getup?: PolicyFile; withoutGetup?: boolean } = {}): Promise<Assembled> {
  const done = new Map<string, SkillDir>();
  for (const d of dirs) if (d.meta.status === 'done') done.set(d.meta.skill, d);
  const getup = opts.getup ?? done.get('get-up')?.policy;
  if (!getup && !opts.withoutGetup) return { refused: 'no get-up network to combine with' };
  const body = getup?.mjcf_sha256 ?? (done.get('walk') ?? [...done.values()][0])?.policy.mjcf_sha256;
  if (!body) return { refused: 'no skill is done' };
  const files: Record<string, string> = {};
  const skills: Manifest['skills'] = {};
  const leftOut: Record<string, string> = {};
  for (const [name, { meta, policy }] of done) {
    if (policy.mjcf_sha256 !== body) { leftOut[name] = 'trained for another body'; continue; }
    let pol = policy;
    let command = meta.command ?? 0;
    if (name === 'get-up') {
      const walk = done.get('walk')?.policy;
      if (!getup) { leftOut[name] = 'no get-up network'; continue; }
      if (!walk) { leftOut[name] = 'needs the walk skill to stand on'; continue; }
      pol = walk;
      command = 0;
    }
    let out: PolicyFile;
    try {
      out = getup ? combine(pol, getup) : pol;
    } catch (e) {
      leftOut[name] = (e as Error).message;
      continue;
    }
    const refused = await check(out);
    if (refused) { leftOut[name] = `refused by the policy runtime: ${refused}`; continue; }
    files[`skills/${name}.json`] = JSON.stringify(out);
    skills[name] = { policy: `skills/${name}.json`, command, label: meta.label ?? name };
  }
  const want = opts.default ?? 'walk';
  const def = want in skills ? want : (Object.keys(skills)[0] ?? null);
  return { files, manifest: { version: 1, body_mjcf_sha256: body, default: def, skills }, leftOut, withGetup: Boolean(getup) };
}

/** The round, for the stage (train/assemble_skills.py round_summary): one entry per thread that trained this body, the
 * measured seconds, the CPU estimate train-skill wrote, and whether the home it replaces was another body's. */
/** Which threads made this round (train/assemble_skills.py round_key): how many, the latest start to the second, and
 * their skills. Assembling the same round again (a retry after a restart) gives the same key; a new round another. */
export function roundKey(metas: SkillMeta[], body: string): string {
  const mine = metas.filter((m) => m.mjcf_sha256 === body);
  const starts = mine.map((m) => m.started_at).filter((t): t is number => typeof t === 'number');
  return `${mine.length}:${starts.length ? Math.floor(Math.max(...starts)) : 0}:${mine.map((m) => String(m.skill)).sort().join(',')}`;
}

export function roundSummary(metas: SkillMeta[], body: string, previous: string | null) {
  const mine = metas.filter((m) => m.mjcf_sha256 === body);
  const skills: Record<string, { status: string | null; first_pass_s: number | null; steps_at_first_pass: number | null; wall_s: number | null; cpu_estimate_s: number | null }> = {};
  for (const m of mine) {
    skills[m.skill] = { status: m.status ?? null, first_pass_s: m.passed_at?.t ?? null, steps_at_first_pass: m.passed_at?.steps ?? null, wall_s: m.wall_s ?? null, cpu_estimate_s: m.cpu_estimate_s ?? null };
  }
  const rows = Object.values(skills);
  const every = rows.length > 0 && rows.every((r) => r.status === 'done');
  const settled = rows.length > 0 && rows.every((r) => r.status === 'done' || r.status === 'failed');
  const all = (xs: (number | null)[]) => (every && xs.every((x) => x !== null) ? (xs as number[]) : null);
  const firsts = all(rows.map((r) => r.first_pass_s)), cpus = all(rows.map((r) => r.cpu_estimate_s));
  const walls = settled && rows.every((r) => r.wall_s !== null) ? rows.map((r) => r.wall_s as number) : null;
  return {
    version: 1, body_mjcf_sha256: body, body_name: mine.find((m) => m.body_name)?.body_name ?? null,
    previous_body_mjcf_sha256: previous, relearn: previous !== null && previous !== body, gpus: mine.length, skills,
    all_passed_s: firsts ? Math.max(...firsts) : null, all_done_s: walls ? Math.max(...walls) : null,
    cpu_estimate_s: cpus ? cpus.reduce((a, b) => a + b, 0) : null, cpu_estimate: mine.find((m) => m.cpu_estimate)?.cpu_estimate ?? null,
    round_key: roundKey(metas, body),
    measured: ['all_passed_s', 'all_done_s', 'skills.*.first_pass_s', 'skills.*.wall_s'],
    estimated: ['cpu_estimate_s', 'skills.*.cpu_estimate_s'],
  };
}

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** Read SKILLS_DIR, write HOME: the command line's whole job. Returns the exit code (0 skills home, 2 refused, 3 none). */
export async function assembleHome(skillsDir: string, home: string, opts: { default?: string; getup?: string; withoutGetup?: boolean } = {}): Promise<number> {
  const dirs: SkillDir[] = [];
  const metas: SkillMeta[] = [];
  for (const name of readdirSync(skillsDir).sort()) {
    let meta: SkillMeta;
    try {
      meta = JSON.parse(readFileSync(join(skillsDir, name, 'skill.json'), 'utf8'));
    } catch {
      continue; // not a skill directory
    }
    metas.push(meta);
    try {
      dirs.push({ meta, policy: JSON.parse(readFileSync(join(skillsDir, name, 'policy.json'), 'utf8')) });
    } catch {
      // a skill still training, or one that never published a policy
    }
  }
  const getup = opts.getup ? (JSON.parse(readFileSync(opts.getup, 'utf8')) as PolicyFile) : undefined;
  const r = await assemble(dirs, { default: opts.default, getup, withoutGetup: opts.withoutGetup });
  if ('refused' in r) {
    console.log(JSON.stringify({ event: 'skills.refused', why: r.refused }));
    return 2;
  }
  mkdirSync(join(home, 'skills'), { recursive: true });
  for (const [rel, text] of Object.entries(r.files)) writeAtomic(join(home, rel), text);
  let previous: string | null = null;
  try {
    previous = JSON.parse(readFileSync(join(home, 'skills.json'), 'utf8')).body_mjcf_sha256 ?? null;
  } catch {
    // no home yet
  }
  try {
    // the same round assembled again (a retry): the home it replaced is the one the first assembly saw
    const before = JSON.parse(readFileSync(join(skillsDir, 'round.json'), 'utf8'));
    if (before.body_mjcf_sha256 === r.manifest.body_mjcf_sha256 && before.round_key === roundKey(metas, r.manifest.body_mjcf_sha256)) previous = before.previous_body_mjcf_sha256 ?? null;
  } catch {
    // no earlier round here
  }
  writeAtomic(join(home, 'skills.json'), JSON.stringify(r.manifest, null, 1));
  writeAtomic(join(skillsDir, 'round.json'), JSON.stringify(roundSummary(metas, r.manifest.body_mjcf_sha256, previous), null, 1));
  console.log(JSON.stringify({ event: 'skills.home', skills: Object.keys(r.manifest.skills).sort(), default: r.manifest.default, left_out: r.leftOut, getup: r.withGetup }));
  return Object.keys(r.manifest.skills).length ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const withoutGetup = args.includes('--without-getup');
  if (withoutGetup) args.splice(args.indexOf('--without-getup'), 1);
  const home = flag('--home'), def = flag('--default'), getup = flag('--getup');
  if (!home || args.length !== 1) {
    console.error('usage: node assemble-skills.ts SKILLS_DIR --home HOME [--default walk] [--getup GETUP.json] [--without-getup]');
    process.exit(64);
  }
  process.exit(await assembleHome(args[0]!, home, { default: def, getup, withoutGetup }));
}
