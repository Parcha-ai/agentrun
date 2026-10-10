// One colour per leg pair, used by the sketch and by the 3D body, so a pair in the top-view drawing is visibly the same pair on the creature.
// Pair 0 keeps the MJCF's own leg colours; the others are tints applied at render time only (the MJCF is unchanged, because its bytes are the
// body's identity: mjcf_sha256).

export interface PairColors { thigh: string; shin: string }

/** CSS hex, thigh lighter than shin. Index = the pair's place in the design (0 is the first leg pair). */
export const PAIR_COLORS: readonly PairColors[] = [
  { thigh: '#8cc79e', shin: '#66a880' }, // green: the MJCF's own leg colours
  { thigh: '#8cade6', shin: '#6185cc' }, // blue
  { thigh: '#c799e0', shin: '#9e70c2' }, // violet
];

export const pairColors = (i: number): PairColors => PAIR_COLORS[((i % PAIR_COLORS.length) + PAIR_COLORS.length) % PAIR_COLORS.length];

/** The leg pair and part a body name says: `l0_thigh`, `r1_shin` (the names mjcf.ts gives). Null for anything else. */
export function legOfBodyName(name: string): { pair: number; part: 'thigh' | 'shin' } | null {
  const m = /^[lr](\d+)_(thigh|shin)$/.exec(name);
  return m ? { pair: Number(m[1]), part: m[2] as 'thigh' | 'shin' } : null;
}

/** The leg a MuJoCo body belongs to, read from the body's NAME in the compiled model (never from id arithmetic). */
export function legOfGeomBody(mj: { mj_id2name(m: any, type: number, id: number): string; mjtObj: { mjOBJ_BODY: { value: number } } }, model: unknown, bodyId: number) {
  return legOfBodyName(mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, bodyId) ?? '');
}
