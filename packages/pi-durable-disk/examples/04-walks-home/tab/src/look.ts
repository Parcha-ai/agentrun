// What the robot looks like, as the 3D view draws it: colours, shapes and a face. It comes from the agent's robot state (creature/robot.json, the 03 example's robot-model.ts) and only ever changes
// how the creature is DRAWN: the MJCF, and so the body's identity (mjcf_sha256) a policy is checked against, is untouched. Pure: no DOM except `drawFace`, which takes a canvas context.

export type ShapeKind = 'boxy' | 'round';
export type FaceKind = 'happy' | 'sleepy' | 'surprised' | 'angry' | 'cool' | 'none';

export interface ViewLook {
  /** CSS colour of the torso; null keeps the MJCF's own. */
  torso: string | null;
  /** CSS colour per leg pair (front to back); null keeps the pair's own (colors.ts). */
  legs: (string | null)[];
  shape: { torso: ShapeKind; legs: ShapeKind };
  face: FaceKind;
}

export const DEFAULT_LOOK: ViewLook = { torso: null, legs: [null, null, null], shape: { torso: 'boxy', legs: 'round' }, face: 'none' };

/** The look a robot state asks for: the named colours become CSS, everything else is copied. `names` is robot-model.ts's COLOR_HEX. */
export function viewLook(state: { look: { torso: string | null; legs: (string | null)[]; shape: { torso: ShapeKind; legs: ShapeKind }; face: FaceKind } }, names: Readonly<Record<string, string>>): ViewLook {
  const hex = (c: string | null) => (c === null ? null : names[c] ?? null);
  return { torso: hex(state.look.torso), legs: state.look.legs.map(hex), shape: { ...state.look.shape }, face: state.look.face };
}

export const sameLook = (a: ViewLook, b: ViewLook): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Draw a face into a square canvas context: simple shapes only (no emoji font), dark on a transparent ground, so it reads on any torso colour. */
export function drawFace(g: CanvasRenderingContext2D, size: number, face: FaceKind): void {
  g.clearRect(0, 0, size, size);
  if (face === 'none') return;
  const u = size / 100;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = '#1c1c1e';
  g.fillStyle = '#1c1c1e';
  g.lineWidth = 6 * u;
  const eye = (x: number) => { g.beginPath(); g.arc(x * u, 40 * u, 7 * u, 0, Math.PI * 2); g.fill(); };
  const mouth = (path: () => void) => { g.beginPath(); path(); g.stroke(); };
  if (face === 'happy') {
    eye(32); eye(68);
    mouth(() => g.arc(50 * u, 56 * u, 22 * u, 0.15 * Math.PI, 0.85 * Math.PI));
  } else if (face === 'sleepy') {
    for (const x of [32, 68]) mouth(() => { g.moveTo((x - 9) * u, 42 * u); g.quadraticCurveTo(x * u, 50 * u, (x + 9) * u, 42 * u); });
    mouth(() => { g.moveTo(40 * u, 70 * u); g.lineTo(60 * u, 70 * u); });
  } else if (face === 'surprised') {
    for (const x of [32, 68]) { g.beginPath(); g.arc(x * u, 38 * u, 9 * u, 0, Math.PI * 2); g.lineWidth = 5 * u; g.stroke(); eye(x); }
    g.lineWidth = 6 * u;
    mouth(() => g.arc(50 * u, 68 * u, 9 * u, 0, Math.PI * 2));
  } else if (face === 'angry') {
    eye(32); eye(68);
    mouth(() => { g.moveTo(20 * u, 24 * u); g.lineTo(42 * u, 33 * u); });
    mouth(() => { g.moveTo(80 * u, 24 * u); g.lineTo(58 * u, 33 * u); });
    mouth(() => { g.moveTo(36 * u, 72 * u); g.quadraticCurveTo(50 * u, 62 * u, 64 * u, 72 * u); });
  } else if (face === 'cool') {
    g.fillRect(18 * u, 32 * u, 28 * u, 16 * u);
    g.fillRect(54 * u, 32 * u, 28 * u, 16 * u);
    mouth(() => { g.moveTo(46 * u, 40 * u); g.lineTo(54 * u, 40 * u); });
    mouth(() => { g.moveTo(38 * u, 66 * u); g.quadraticCurveTo(50 * u, 74 * u, 62 * u, 66 * u); });
  }
}
