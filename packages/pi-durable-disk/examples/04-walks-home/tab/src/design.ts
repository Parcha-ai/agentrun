// A creature design: what the sketcher saves and what the MJCF generator reads. Plain JSON, no behavior.
// Invariants: legs come in left/right mirrored pairs; all lengths are metres; the document round-trips
// through JSON.stringify unchanged, so its hash identifies the body a policy was trained for.

export interface Torso {
  length: number; // x, nose to tail
  width: number; // y, between the hip lines
  height: number; // z
}

export interface LegPair {
  x: number; // hip position along the torso, -1 (tail) .. 1 (nose), as a fraction of half the torso length
  thigh: number;
  shin: number;
  radius: number;
}

export interface Design {
  version: 1;
  name: string;
  torso: Torso;
  legs: LegPair[]; // each entry is mirrored left and right: 2 entries = quadruped
  /** Joints per leg: 2 = hip pitch + knee (the first policies' body); 3 adds a hip abduction joint (roll about x) between torso and thigh. */
  legDof?: 2 | 3;
}

export const LIMITS = {
  torso: { length: [0.2, 0.9], width: [0.1, 0.5], height: [0.05, 0.3] },
  pairs: [2, 3], // one pair cannot balance in pitch,
  thigh: [0.08, 0.4],
  shin: [0.08, 0.4],
  radius: [0.012, 0.04],
} as const;

/** The default creature. `legDof` 3 (hip abduction, the show's body) unless 2 is asked for (the first policies' body). */
export function defaultDesign(legDof: 2 | 3 = 3): Design {
  return {
    version: 1,
    name: 'quadruped',
    ...(legDof === 3 ? { legDof: 3 as const } : {}),
    torso: { length: 0.5, width: 0.22, height: 0.1 },
    legs: [
      { x: 0.8, thigh: 0.2, shin: 0.2, radius: 0.02 },
      { x: -0.8, thigh: 0.2, shin: 0.2, radius: 0.02 },
    ],
  };
}

/** Starting points for the sketcher. Each is valid and stands unaided (tested). */
export const PRESETS: Record<string, Design> = {
  quadruped: defaultDesign(),
  'long legs': { version: 1, name: 'long-legs', legDof: 3, torso: { length: 0.42, width: 0.2, height: 0.09 }, legs: [{ x: 0.75, thigh: 0.3, shin: 0.3, radius: 0.018 }, { x: -0.75, thigh: 0.3, shin: 0.3, radius: 0.018 }] },
  stubby: { version: 1, name: 'stubby', legDof: 3, torso: { length: 0.6, width: 0.3, height: 0.14 }, legs: [{ x: 0.7, thigh: 0.12, shin: 0.12, radius: 0.03 }, { x: -0.7, thigh: 0.12, shin: 0.12, radius: 0.03 }] },
  hexapod: { version: 1, name: 'hexapod', legDof: 3, torso: { length: 0.75, width: 0.2, height: 0.09 }, legs: [{ x: 0.8, thigh: 0.18, shin: 0.2, radius: 0.018 }, { x: 0, thigh: 0.18, shin: 0.2, radius: 0.018 }, { x: -0.8, thigh: 0.18, shin: 0.2, radius: 0.018 }] },
  // The first trained policies' body (no abduction joint). Kept so those policies stay loadable.
  'quadruped 2-DOF': defaultDesign(2),
};

const inRange = (v: number, [lo, hi]: readonly [number, number] | readonly number[]) =>
  Number.isFinite(v) && v >= lo && v <= hi;

/** Returns the list of problems; empty means the design is buildable. */
export function validateDesign(d: Design): string[] {
  const errs: string[] = [];
  if (d.version !== 1) errs.push(`version must be 1, got ${d.version}`);
  if (d.legDof !== undefined && d.legDof !== 2 && d.legDof !== 3) errs.push(`legDof must be 2 or 3, got ${d.legDof}`);
  for (const k of ['length', 'width', 'height'] as const) {
    if (!inRange(d.torso[k], LIMITS.torso[k])) errs.push(`torso.${k} ${d.torso[k]} outside ${LIMITS.torso[k]}`);
  }
  if (!Array.isArray(d.legs) || d.legs.length < LIMITS.pairs[0] || d.legs.length > LIMITS.pairs[1]) {
    errs.push(`legs must hold ${LIMITS.pairs[0]}..${LIMITS.pairs[1]} pairs`);
    return errs;
  }
  d.legs.forEach((l, i) => {
    if (!inRange(l.x, [-1, 1])) errs.push(`legs[${i}].x ${l.x} outside -1..1`);
    for (const k of ['thigh', 'shin', 'radius'] as const) {
      if (!inRange(l[k], LIMITS[k])) errs.push(`legs[${i}].${k} ${l[k]} outside ${LIMITS[k]}`);
    }
  });
  return errs;
}

export function assertDesign(d: Design): Design {
  const errs = validateDesign(d);
  if (errs.length) throw new Error(`invalid design: ${errs.join('; ')}`);
  return d;
}

/** Stable text for hashing: keys in a fixed order, numbers as written by JSON. */
export function canonicalDesign(d: Design): string {
  // legDof is written only when it is 3, so every 2-DOF design keeps the hash it had before the field existed.
  return JSON.stringify({
    version: d.version,
    name: d.name,
    ...(d.legDof === 3 ? { legDof: 3 } : {}),
    torso: { length: d.torso.length, width: d.torso.width, height: d.torso.height },
    legs: d.legs.map((l) => ({ x: l.x, thigh: l.thigh, shin: l.shin, radius: l.radius })),
  });
}
