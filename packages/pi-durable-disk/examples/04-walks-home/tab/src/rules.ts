// What the sketcher tells the user about a body, from what was measured on trained bodies. Two kinds of rule:
//  - a CLAMP keeps the sketch inside the range of bodies the trainer has walked in minutes: leg reach (thigh + shin of the longest
//    pair) at most MAX_REACH_RATIO times the torso length;
//  - NOTES label a body honestly: what was measured for a body we trained, a plain "not trained" for any other, and a caution for
//    a shape close to one that could not get up. Nothing here claims a getup the numbers do not show.
// The measurements are scripts/kick-sweep.ts, getup-time.ts and walk-check.ts on the trainer's policy for each body (policy
// files from the trainer's v3 runs, 5 minutes of H100 per network), run by the tab's own code; see MEASURED below.

import { canonicalDesign, LIMITS, PRESETS, type Design } from './design.ts';

/** Longest leg reach over torso length that has been trained: long legs (1.43x) walked at 0.45 and 0.72 m/s at commands 0.5 and 0.8. */
export const MAX_REACH_RATIO = 1.5;
/** Shorter than this and the only such body trained (stubby, 0.40x) could not get up from its back; hexapod (0.51x) can. */
export const SHORT_REACH_RATIO = 0.45;

export const reach = (d: Design): number => Math.max(...d.legs.map((l) => l.thigh + l.shin));
export const reachRatio = (d: Design): number => reach(d) / d.torso.length;

/** Legs longer than MAX_REACH_RATIO x the torso are shortened, thigh and shin by the same factor. Returns what it did, in words. */
export function clampDesign(d: Design): { design: Design; messages: string[] } {
  const design = structuredClone(d);
  const messages: string[] = [];
  const maxReach = MAX_REACH_RATIO * design.torso.length;
  design.legs.forEach((l, i) => {
    const r = l.thigh + l.shin;
    if (r <= maxReach + 1e-9) return;
    const f = maxReach / r;
    const thigh = Math.max(LIMITS.thigh[0], Math.round(l.thigh * f * 1000) / 1000);
    const shin = Math.max(LIMITS.shin[0], Math.round(l.shin * f * 1000) / 1000);
    messages.push(`Leg pair ${i + 1} shortened from ${r.toFixed(2)} m to ${(thigh + shin).toFixed(2)} m: legs longer than ${MAX_REACH_RATIO}x the torso were not trained (the stilts body, 4x, walked at only 0.2 m/s along its heading whatever the speed setting).`);
    l.thigh = thigh;
    l.shin = shin;
  });
  return { design, messages };
}

export interface BodyNote {
  level: 'ok' | 'warn' | 'info';
  text: string;
}

interface Known {
  design: Design;
  notes: BodyNote[];
}

/** Measured on the trainer's walk+getup policy for the body (command 0.5 unless stated; kick = 12-step horizontal push). */
const stilts: Design = { version: 1, name: 'stilts', legDof: 3, torso: { length: 0.2, width: 0.1, height: 0.05 }, legs: [{ x: 1.0, thigh: 0.4, shin: 0.4, radius: 0.015 }, { x: -1.0, thigh: 0.4, shin: 0.4, radius: 0.015 }] };
const asym: Design = { version: 1, name: 'asym', legDof: 3, torso: { length: 0.5, width: 0.18, height: 0.08 }, legs: [{ x: 0.95, thigh: 0.1, shin: 0.1, radius: 0.02 }, { x: -0.4, thigh: 0.3, shin: 0.32, radius: 0.025 }] };

export const MEASURED: Known[] = [
  {
    design: PRESETS.quadruped,
    notes: [{ level: 'ok', text: 'Trained. Walks 0.50 m/s at speed 0.5; stays up through 200 N pushes from every side; after harder pushes (400 N) it gets up from every side within about 1 s.' }],
  },
  {
    design: PRESETS['long legs'],
    notes: [{ level: 'ok', text: 'Trained. Walks 0.45 m/s at speed 0.5 and 0.72 at 0.8; stays up through 200 N from every side; gets up from its left side in 0.3 s, right side in 0.5 s and back in 0.7 to 0.9 s.' }],
  },
  {
    design: PRESETS.hexapod,
    notes: [{ level: 'ok', text: 'Trained. Walks 0.47 m/s at speed 0.5; stays up through 200 N from every side; gets up from its sides in 0.3 s and its back in 0.4 s.' }],
  },
  {
    design: PRESETS.stubby,
    notes: [
      { level: 'warn', text: 'Trained, but it cannot get up from its back: lying on its back it stays there. It gets up from its sides in 0.3 to 0.4 s.' },
      { level: 'warn', text: 'It walks 0.46 m/s at speed 0.5 and takes 200 N from every side, but some harder pushes knock it down for good: sideways at 300 N, from the front and the back at 400 N, from the left at 600 N.' },
    ],
  },
  {
    design: asym,
    notes: [
      { level: 'warn', text: 'Trained, but it gets up unreliably: from lying on its side it often stays down, and from its back it needs 3 to 7 s or does not manage it.' },
      { level: 'warn', text: 'It walks 0.43 m/s at speed 0.5 and takes 150 N from every side, but a 200 N push from the front knocks it down for good.' },
    ],
  },
  {
    design: stilts,
    notes: [{ level: 'warn', text: 'Trained, but it barely walks: at most about 0.2 m/s along its heading whatever the speed setting (it curves away; at speed 0.8 it hardly goes forward). It does get up from every side in under 1 s.' }],
  },
  {
    design: PRESETS['quadruped 2-DOF'],
    notes: [{ level: 'warn', text: 'The first body, without hip abduction: a still creature of this kind flips sideways at 80 N, so it cannot meet the 100 N side-kick bar. Its policy (walk only, no getup network) is a fallback.' }],
  },
];

const sameBody = (a: Design, b: Design) => canonicalDesign(a) === canonicalDesign(b);

/** What to tell the user about this body. Never claims a getup that was not measured. */
export function bodyNotes(d: Design): BodyNote[] {
  const known = MEASURED.find((k) => sameBody(k.design, d));
  if (known) return known.notes;
  const notes: BodyNote[] = [{ level: 'info', text: 'Not one of the bodies we trained: there is no policy for this exact body yet, so it runs the stand-in trot until one is trained for it (about 5 minutes of GPU for walking, and a separate network for getting up).' }];
  if (reachRatio(d) < SHORT_REACH_RATIO) {
    notes.push({ level: 'warn', text: `Short legs for this body (${reachRatio(d).toFixed(2)}x the torso length). The only trained body this short (stubby, 0.40x) could not get up from its back, so expect the same here: this is a prediction from that one body, not a measurement of yours.` });
  }
  if (d.legDof !== 3) {
    notes.push({ level: 'warn', text: 'Legs without the hip abduction joint cannot resist a sideways push (a still creature flips at 80 N). Tick the 3-joint option for the show body.' });
  }
  return notes;
}
