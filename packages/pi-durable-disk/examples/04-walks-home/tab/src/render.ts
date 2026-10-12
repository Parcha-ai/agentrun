// Three.js view of a MuJoCo model: one mesh per geom, posed from data.geom_xpos / geom_xmat each frame.
// MuJoCo is z-up, so the camera is z-up too and no coordinate conversion happens.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Sim } from './sim.ts';
import { Trail } from './trail.ts';
import { legOfGeomBody, pairColors } from './colors.ts';
import { DEFAULT_LOOK, drawFace, sameLook, type FaceKind, type ViewLook } from './look.ts';

/** A drawn part of the creature, kept so a new look can recolour or reshape it without rebuilding the simulation. */
interface Part { mesh: THREE.Mesh; role: 'torso' | 'leg' | 'foot' | 'other'; pair: number; leg: 'thigh' | 'shin'; size: [number, number, number]; base: THREE.Color; geo: THREE.BufferGeometry; /** A code body's tags for this piece (body.json), or undefined on a preset body. */ tags?: string[]; type: number }

const GEOM = { plane: 0, hfield: 1, sphere: 2, capsule: 3, ellipsoid: 4, cylinder: 5, box: 6 } as const;

/** MuJoCo heightfield: x in [-sx, sx] along columns, y in [-sy, sy] along rows, z = data * sz, in the geom's frame. */
function heightfieldGeometry(model: any, id: number): THREE.BufferGeometry {
  const nrow = model.hfield_nrow[id], ncol = model.hfield_ncol[id], adr = model.hfield_adr[id];
  const [sx, sy, sz] = [model.hfield_size[4 * id], model.hfield_size[4 * id + 1], model.hfield_size[4 * id + 2]];
  const pos = new Float32Array(nrow * ncol * 3);
  for (let i = 0; i < nrow; i++) {
    for (let j = 0; j < ncol; j++) {
      const k = 3 * (i * ncol + j);
      pos[k] = -sx + (2 * sx * j) / (ncol - 1);
      pos[k + 1] = -sy + (2 * sy * i) / (nrow - 1);
      pos[k + 2] = model.hfield_data[adr + i * ncol + j] * sz;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nrow - 1; i++) {
    for (let j = 0; j < ncol - 1; j++) {
      const a = i * ncol + j, b = a + 1, c = a + ncol, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** One metre of floor: the floor colour with a dark 1 m line on two edges and faint 0.25 m lines inside, tiled 400 x 400 over the 400 m plane (so the lines sit on whole metres of the world). */
function groundTexture(anisotropy: number): THREE.CanvasTexture {
  const n = 512, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d8d4c6'; g.fillRect(0, 0, n, n);
  g.fillStyle = '#b7b3a3';
  for (let i = 1; i < 4; i++) { g.fillRect(i * n / 4 - 1, 0, 2, n); g.fillRect(0, i * n / 4 - 1, n, 2); }
  g.fillStyle = '#5f5b4d';
  g.fillRect(0, 0, 5, n); g.fillRect(0, 0, n, 5);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(400, 400);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

/** A quiet ground for the hero look: a dark floor with a very faint half-metre grid (so a robot that walks visibly crosses something) that the scene's fog takes to the page's own background. */
function heroGroundTexture(anisotropy: number): THREE.CanvasTexture {
  const n = 256, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1a1a1f'; g.fillRect(0, 0, n, n);
  g.fillStyle = '#212127';
  g.fillRect(0, 0, 2, n); g.fillRect(0, 0, n, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(800, 800); // 400 m of floor in half-metre cells
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private meshes: THREE.Mesh[] = [];
  private sim: Sim | null = null;
  /** Where this version started (a post and a ring on the ground) and the faint trail since: clean mode shows them, so motion reads in a still. */
  readonly trail = new Trail();
  private readonly start = new THREE.Group();
  private readonly dots: THREE.InstancedMesh;
  private markers = false;
  private readonly m4 = new THREE.Matrix4();

  private readonly canvas: HTMLCanvasElement;
  private readonly ray = new THREE.Raycaster();
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private floor!: THREE.Mesh;
  private hero = false;
  /** A code body's piece names to tags (robot/body.json): set before setSim; null on a preset body. */
  private tagMap: Record<string, string[]> | null = null;
  private faceTag = 'head';
  /** Where the face plane sits on its piece (the piece's own frame), from the body file; undefined: at the nose. */
  private faceAt: number[] | undefined;
  /** A soft contact shadow under the robot (hero look): the directional shadow alone is faint on a dark floor. */
  private blob: THREE.Mesh | null = null;
  /** The robot's size as a radius in metres, and the camera's direction from it: what the framing keeps the whole robot inside the pane with. */
  private frameRadius = 0.6;
  private framedAspect = 0;
  private bodyMeshes: THREE.Mesh[] = [];
  private parts: Part[] = [];
  private look: ViewLook = DEFAULT_LOOK;
  private face: { kind: FaceKind; mesh: THREE.Mesh } | null = null;

  private readonly lite: boolean;

  /** `lite` is for machines that rasterise in software: cheaper materials and no multisampling (page option ?lite=1). */
  constructor(canvas: HTMLCanvasElement, opts: { lite?: boolean } = {}) {
    this.canvas = canvas;
    this.lite = !!opts.lite;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.lite });
    this.renderer.shadowMap.enabled = true;
    this.scene.background = new THREE.Color(0xf4f2ea);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.02, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1.1, -1.3, 0.8);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0.2);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.6);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, -1, 4);
    sun.castShadow = true;
    // The shadow only has to cover the creature and its surroundings, and the sun follows it (see draw): a 4 m frustum on a
    // 1024 map is as sharp as 8 m on 2048 (3.9 mm per texel) at a quarter of the pixels, which is what keeps a software
    // rasteriser above 50 fps under 4x CPU throttling (42 fps with the 2048 map, measured by scripts/perf.mjs).
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 10 });
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);
    // The floor: a big shaded plane (receives the shadow) with a 1 m grid painted on it, so the ground has a scale and a creature
    // that walks visibly crosses lines. It is a texture in the floor's own material, not line geometry: it stays crisp at the
    // grazing angle of the camera and cannot z-fight with the floor.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.material({ color: 0xffffff, roughness: 1, map: groundTexture(this.renderer.capabilities.getMaxAnisotropy()) }));
    floor.receiveShadow = true;
    this.floor = floor;
    this.scene.add(floor);
    const mark = new THREE.MeshBasicMaterial({ color: 0x1d4f91 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.15, 40), mark);
    ring.position.z = 0.004;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.5, 8), mark);
    post.rotation.x = Math.PI / 2;
    post.position.z = 0.25;
    // the word "start" on a sprite at the top of the post (a sprite always faces the camera, so the word is never mirrored)
    const tag = document.createElement('canvas');
    tag.width = 256; tag.height = 96;
    const g = tag.getContext('2d')!;
    g.fillStyle = '#1d4f91'; g.fillRect(0, 0, 256, 96);
    g.fillStyle = '#ffffff'; g.font = '700 64px ui-sans-serif, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('start', 128, 52);
    const tagTex = new THREE.CanvasTexture(tag);
    tagTex.colorSpace = THREE.SRGBColorSpace;
    const flag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, depthTest: true }));
    flag.scale.set(0.3, 0.1125, 1);
    flag.position.set(0, 0, 0.5);
    this.start.add(ring, post, flag);
    this.start.visible = false;
    this.scene.add(this.start);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x4a4638, transparent: true, opacity: 0.5, depthWrite: false });
    this.dots = new THREE.InstancedMesh(new THREE.CircleGeometry(0.03, 12), dotMat, 240);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.scene.add(this.dots);
  }

  private material(p: { color: THREE.ColorRepresentation; roughness: number; metalness?: number; map?: THREE.Texture }): THREE.Material {
    return this.lite ? new THREE.MeshLambertMaterial({ color: p.color, map: p.map }) : new THREE.MeshStandardMaterial(p);
  }

  /** The tags of a body written as code, by piece name (null for a preset body), and the tag its face is drawn on. Takes effect at the next setSim. */
  setTags(tags: Record<string, string[]> | null, faceTag = 'head', faceAt?: number[]): void {
    this.tagMap = tags;
    this.faceTag = faceTag;
    this.faceAt = faceAt && faceAt.length === 3 ? faceAt : undefined;
  }

  /** Rebuild the meshes for a (new) sim. */
  setSim(sim: Sim): void {
    // a part whose looks swapped its geometry (round torso, boxy legs) still owns the original: both are released
    for (const p of this.parts) if (p.geo !== p.mesh.geometry) p.geo.dispose();
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.meshes = [];
    this.bodyMeshes = [];
    this.parts = [];
    this.dropFace();
    this.sim = sim;
    const model = sim.model;
    for (let g = 0; g < model.ngeom; g++) {
      const type = model.geom_type[g];
      if (type === GEOM.plane) { this.meshes.push(new THREE.Mesh()); continue; } // the grid draws the floor
      const s = [model.geom_size[3 * g], model.geom_size[3 * g + 1], model.geom_size[3 * g + 2]];
      let geo: THREE.BufferGeometry;
      if (type === GEOM.box) geo = new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
      else if (type === GEOM.sphere) geo = new THREE.SphereGeometry(s[0], 24, 16);
      else if (type === GEOM.capsule) { geo = new THREE.CapsuleGeometry(s[0], 2 * s[1], 8, 16); geo.rotateX(Math.PI / 2); }
      else if (type === GEOM.cylinder) { geo = new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 24); geo.rotateX(Math.PI / 2); }
      else if (type === GEOM.hfield) geo = heightfieldGeometry(model, model.geom_dataid[g]);
      else if (type === GEOM.ellipsoid) { geo = new THREE.SphereGeometry(1, 24, 16); geo.scale(s[0], s[1], s[2]); }
      else { this.meshes.push(new THREE.Mesh()); continue; }
      const c = [0, 1, 2, 3].map((k) => model.geom_rgba[4 * g + k]);
      // a leg's capsules take their pair's colours (the same table the sketch draws with); feet, the torso and the terrain keep the MJCF's own
      const geomName = this.tagMap ? (sim.mj.mj_id2name(model, sim.mj.mjtObj.mjOBJ_GEOM.value, g) ?? '') : '';
      const leg = !this.tagMap && type === GEOM.capsule ? legOfGeomBody(sim.mj, model, model.geom_bodyid[g]) : null;
      const bodyName = model.geom_bodyid[g] > 0 ? (sim.mj.mj_id2name(model, sim.mj.mjtObj.mjOBJ_BODY.value, model.geom_bodyid[g]) ?? '') : '';
      const color = leg ? new THREE.Color(pairColors(leg.pair)[leg.part]) : new THREE.Color(c[0], c[1], c[2]);
      const mat = this.material({ color, roughness: 0.6, metalness: 0.05 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.meshes.push(mesh);
      if (model.geom_bodyid[g] > 0) this.bodyMeshes.push(mesh); // the creature, not the terrain
      this.parts.push({ mesh, role: leg ? 'leg' : type === GEOM.box && bodyName === 'torso' ? 'torso' : type === GEOM.sphere && model.geom_bodyid[g] > 0 ? 'foot' : 'other', pair: leg?.pair ?? 0, leg: leg?.part ?? 'thigh', size: [s[0], s[1], s[2]], base: color.clone(), geo , type, ...(this.tagMap ? { tags: this.tagMap[geomName] ?? ['decoration'] } : {}) });
    }
    this.applyLook();
    this.draw(true);
  }

  /** What the creature looks like from now on (colours, round or boxy parts, a face): drawn on the current body and on every body after it. The physics is never touched. */
  setLook(look: ViewLook): void {
    if (sameLook(look, this.look)) return;
    this.look = look;
    this.applyLook();
  }

  /** What is drawn now, for the page's checks: the torso's and each leg pair's colour as drawn, the geometry kinds, the face. */
  describeLook(): { torso: string | null; legs: string[]; torsoGeometry: string | null; legGeometry: string | null; face: FaceKind } {
    const hex = (p: Part) => '#' + (p.mesh.material as THREE.MeshStandardMaterial).color.getHexString();
    const torso = this.parts.find((p) => p.role === 'torso');
    const legs = this.parts.filter((p) => p.role === 'leg' && p.leg === 'thigh');
    const pairs = new Map<number, string>();
    for (const p of legs) if (!pairs.has(p.pair)) pairs.set(p.pair, hex(p));
    return { torso: torso ? hex(torso) : null, legs: [...pairs.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => c), torsoGeometry: torso?.mesh.geometry.type ?? null, legGeometry: legs[0]?.mesh.geometry.type ?? null, face: this.face?.kind ?? 'none' };
  }

  private dropFace(): void {
    if (!this.face) return;
    this.face.mesh.parent?.remove(this.face.mesh);
    this.face.mesh.geometry.dispose();
    ((this.face.mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture | null)?.dispose();
    (this.face.mesh.material as THREE.Material).dispose();
    this.face = null;
  }

  /** A piece of a body written as code: colour and shape by its tags (the last tag with an entry wins, then `all`), the MJCF's own colour where nothing was asked. */
  private applyTagLook(p: Part, look: ViewLook): void {
    const mat = p.mesh.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial;
    const pick = <T,>(table: Record<string, T> | undefined): T | undefined => {
      if (!table) return undefined;
      for (let i = p.tags!.length - 1; i >= 0; i--) { const v = table[p.tags![i]!]; if (v !== undefined) return v; }
      return table.all;
    };
    const color = pick(look.byTag);
    mat.color.copy(color ? new THREE.Color(color) : p.base);
    const shape = pick(look.shapeByTag);
    const [a, b, c] = p.size;
    let want: THREE.BufferGeometry = p.geo;
    if (shape === 'round' && p.type !== GEOM.sphere && p.type !== GEOM.ellipsoid) {
      const half = p.type === GEOM.box ? [a, b, c] : p.type === GEOM.capsule || p.type === GEOM.cylinder ? [a, a, b + (p.type === GEOM.capsule ? a : 0)] : [a, b, c];
      want = new THREE.SphereGeometry(1, 24, 16).scale(half[0]! * 1.12, half[1]! * 1.12, half[2]! * 1.12);
    } else if (shape === 'boxy' && p.type !== GEOM.box) {
      const half = p.type === GEOM.capsule || p.type === GEOM.cylinder ? [a, a, b + (p.type === GEOM.capsule ? a : 0)] : p.type === GEOM.ellipsoid ? [a, b, c] : [a, a, a];
      want = new THREE.BoxGeometry(2 * half[0]!, 2 * half[1]!, 2 * half[2]!);
    }
    if (p.mesh.geometry !== want) {
      if (p.mesh.geometry !== p.geo) p.mesh.geometry.dispose();
      p.mesh.geometry = want;
    }
  }

  private applyLook(): void {
    const look = this.look;
    for (const p of this.parts) {
      if (p.tags) { this.applyTagLook(p, look); continue; }
      const mat = p.mesh.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial;
      if (p.role === 'torso') {
        mat.color.copy(look.torso ? new THREE.Color(look.torso) : p.base);
        const want = look.shape.torso === 'round' ? new THREE.SphereGeometry(1, 28, 20).scale(p.size[0] * 1.12, p.size[1] * 1.12, p.size[2] * 1.45) : p.geo;
        if (p.mesh.geometry !== want) { if (p.mesh.geometry !== p.geo) p.mesh.geometry.dispose(); p.mesh.geometry = want; }
      } else if (p.role === 'leg') {
        const own = look.legs[p.pair];
        mat.color.copy(own ? new THREE.Color(own) : new THREE.Color(pairColors(p.pair)[p.leg]));
        const want = look.shape.legs === 'boxy' ? new THREE.BoxGeometry(2 * p.size[0], 2 * p.size[0], 2 * (p.size[1] + p.size[0])) : p.geo;
        if (p.mesh.geometry !== want) { if (p.mesh.geometry !== p.geo) p.mesh.geometry.dispose(); p.mesh.geometry = want; }
      }
    }
    // the face: a drawing on a plane at the torso's nose
    const torso = this.parts.find((p) => p.tags ? p.tags.includes(this.faceTag) : p.role === 'torso') ?? this.parts.find((p) => p.tags?.includes('torso')); // a code body's face goes on its head piece, else its torso
    if (look.face === 'none' || !torso) { this.dropFace(); return; }
    const noseX = torso.size[0] * (torso.tags ? 1.02 : look.shape.torso === 'round' ? 1.14 : 1) + 0.002; // the torso's nose moves when its shape does, so the face follows even when it stays the same face
    if (this.face?.kind === look.face && this.face.mesh.parent === torso.mesh) { const at = torso.tags ? this.faceAt : undefined; this.face.mesh.position.set(at ? at[0]! + 0.002 : noseX, at ? at[1]! : 0, at ? at[2]! : 0); return; }
    this.dropFace();
    const size = 128, c = document.createElement('canvas');
    c.width = c.height = size;
    drawFace(c.getContext('2d')!, size, look.face);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const h = Math.min(torso.size[1] * 1.7, torso.size[2] * 1.7);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(h * 1.4, h * 1.4), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    plane.rotation.set(Math.PI / 2, Math.PI / 2, 0, 'YXZ'); // facing the nose (+x), upright
    const at = torso.tags ? this.faceAt : undefined; // a code body's face goes where its file says
    plane.position.set(at ? at[0]! + 0.002 : noseX, at ? at[1]! : 0, at ? at[2]! : 0);
    torso.mesh.add(plane);
    this.face = { kind: look.face, mesh: plane };
  }

  /** True when the pointer at (clientX, clientY) is over a part of the creature. */
  pickCreature(clientX: number, clientY: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.ray.intersectObjects(this.bodyMeshes, false).length > 0;
  }

  /** A screen-space drag (pixels, y down) as a unit direction on the ground plane, as seen from the camera. */
  groundDir(dx: number, dy: number): [number, number] {
    const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    const f = new THREE.Vector3(fwd.x, fwd.y, 0).normalize();
    const x = right.x * dx + f.x * -dy, y = right.y * dx + f.y * -dy;
    const n = Math.hypot(x, y) || 1;
    return [x / n, y / n];
  }

  /**
   * The robot as the hero (the creature page embedded in the agent's page): a quiet dark ground that fades into the page's own background, soft light that keeps the user's colours true, a soft shadow, no start post or trail.
   * `bg` is the page's background colour, so the pane has no edge.
   */
  setHero(on: boolean, bg = 0x080809): void {
    this.hero = on;
    if (!on) return;
    this.scene.background = new THREE.Color(bg);
    this.scene.fog = new THREE.Fog(bg, 2.6, 7.5); // the grid and the ground fade out before the horizon: a pool of floor under the robot
    this.hemi.color.set(0xffffff); this.hemi.groundColor.set(0x3a3a40); this.hemi.intensity = 1.45;
    this.sun.intensity = 2.15; // calibrated so a top face renders within a few percent of the colour the user asked for
    this.sun.shadow.radius = 5; // soft edge
    this.sun.shadow.bias = -0.0004;
    this.renderer.shadowMap.type = this.lite ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    const mat = this.floor.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial;
    mat.color.set(0xffffff);
    mat.map?.dispose();
    mat.map = heroGroundTexture(this.renderer.capabilities.getMaxAnisotropy());
    mat.needsUpdate = true;
    this.setMarkers(false);
    if (!this.blob) {
      const n = 128, c = document.createElement('canvas');
      c.width = c.height = n;
      const g = c.getContext('2d')!;
      const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      grad.addColorStop(0, 'rgba(0,0,0,0.62)'); grad.addColorStop(0.55, 'rgba(0,0,0,0.28)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.fillRect(0, 0, n, n);
      const tex = new THREE.CanvasTexture(c);
      this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      this.blob.position.z = 0.002;
      this.blob.renderOrder = 1;
      this.scene.add(this.blob);
    }
  }

  /** Keep the whole robot in the pane: the camera's distance from it is set so a sphere of `radius` metres fits the narrower side of the view, whatever the pane's shape. */
  frameRobot(radius: number, centerZ = 0.2): void {
    this.frameRadius = Math.max(0.15, radius);
    this.blob?.scale.set(radius * 2.6, radius * 2.0, 1);
    this.controls.target.z = centerZ;
    this.framedAspect = 0;
    this.applyFrame();
  }

  private applyFrame(): void {
    if (!this.hero) return;
    const t = this.controls.target;
    const dir = this.camera.position.clone().sub(t);
    if (dir.lengthSq() < 1e-6) dir.set(0.6, -0.72, 0.5);
    dir.normalize();
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const half = Math.min(vHalf, hHalf);
    const dist = (this.frameRadius * 1.1) / Math.sin(half); // the robot fills the narrower side of the pane with a little air
    this.camera.position.copy(t).addScaledVector(dir, dist);
    this.framedAspect = this.camera.aspect;
    this.controls.update();
  }

  /** Camera presets, as an offset from the creature: three-quarter (default) or side-on at body height (a gait reads best here). */
  setPreset(name: 'three-quarter' | 'side' | 'close'): void {
    const t = this.controls.target;
    if (name === 'side') { t.z = 0.2; this.camera.position.set(t.x, t.y - 1.9, 0.3); }
    else if (name === 'close') { t.z = 0.2; this.camera.position.set(t.x + 0.8, t.y - 0.95, 0.6); } // the creature large in the pane (clean mode)
    else { t.z = 0.2; this.camera.position.set(t.x + 1.1, t.y - 1.3, 0.8); }
    this.controls.update();
  }

  setOrbitEnabled(on: boolean): void { this.controls.enabled = on; }

  /** Show or hide the start post and the trail. */
  setMarkers(on: boolean): void {
    this.markers = on;
    this.start.visible = on;
    this.dots.visible = on;
  }

  /** A new version begins here: the post stands where the creature is, the trail is cleared, the distance counts from this spot. */
  markOrigin(x: number, y: number): void {
    this.trail.reset(x, y);
    this.start.position.set(x, y, 0);
    this.dots.count = 0;
  }

  private writeTrail(): void {
    const m = new THREE.Matrix4(), pts = this.trail.points;
    for (let i = 0; i < pts.length; i++) { m.makeTranslation(pts[i].x, pts[i].y, 0.003); this.dots.setMatrixAt(i, m); }
    this.dots.count = pts.length;
    this.dots.instanceMatrix.needsUpdate = true;
  }

  resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== w * devicePixelRatio || this.canvas.height !== h * devicePixelRatio) {
      this.renderer.setPixelRatio(devicePixelRatio);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.hero && h > 0) this.applyFrame();
    }
  }

  /** Pose the meshes from the sim and render. The camera keeps its offset and follows the torso. */
  draw(snapCamera = false): void {
    const sim = this.sim;
    if (!sim) return;
    this.resize();
    const { geom_xpos: p, geom_xmat: r } = sim.data;
    for (let g = 0; g < this.meshes.length; g++) {
      const mesh = this.meshes[g];
      if (!mesh.geometry.attributes.position) continue;
      this.m4.set(
        r[9 * g], r[9 * g + 1], r[9 * g + 2], p[3 * g],
        r[9 * g + 3], r[9 * g + 4], r[9 * g + 5], p[3 * g + 1],
        r[9 * g + 6], r[9 * g + 7], r[9 * g + 8], p[3 * g + 2],
        0, 0, 0, 1,
      );
      mesh.matrix.copy(this.m4);
    }
    const [x, y] = sim.torsoPos();
    const t = this.controls.target;
    const dx = x - t.x, dy = y - t.y;
    if (snapCamera || Math.abs(dx) + Math.abs(dy) > 0) {
      t.x += dx; t.y += dy;
      this.camera.position.x += dx; this.camera.position.y += dy;
    }
    this.sun.target.position.set(x, y, 0);
    this.blob?.position.set(x, y, 0.002);
    this.sun.position.set(x + 2, y - 1, 4);
    if (this.markers && this.trail.add(x, y)) this.writeTrail();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
