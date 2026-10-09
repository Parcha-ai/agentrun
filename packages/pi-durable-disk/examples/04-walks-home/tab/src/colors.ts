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

/**
 * The leg pair and part a MuJoCo body id belongs to. The MJCF puts the legs in document order, which is also MuJoCo's depth-first body order:
 * the world is 0, the torso 1, then per pair left thigh, left shin, right thigh, right shin. Null for the world and the torso.
 */
export function legPairOfBody(id: number): { pair: number; part: 'thigh' | 'shin' } | null {
  if (id < 2) return null;
  const k = id - 2;
  return { pair: Math.floor(k / 4), part: k % 2 === 0 ? 'thigh' : 'shin' };
}
