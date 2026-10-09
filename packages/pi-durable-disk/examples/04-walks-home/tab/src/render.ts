// Three.js view of a MuJoCo model: one mesh per geom, posed from data.geom_xpos / geom_xmat each frame.
// MuJoCo is z-up, so the camera is z-up too and no coordinate conversion happens.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Sim } from './sim.ts';
import { Trail } from './trail.ts';

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
  private bodyMeshes: THREE.Mesh[] = [];

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
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.6));
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

  /** Rebuild the meshes for a (new) sim. */
  setSim(sim: Sim): void {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.meshes = [];
    this.bodyMeshes = [];
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
      const mat = this.material({ color: new THREE.Color(c[0], c[1], c[2]), roughness: 0.6, metalness: 0.05 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.meshes.push(mesh);
      if (model.geom_bodyid[g] > 0) this.bodyMeshes.push(mesh); // the creature, not the terrain
    }
    this.draw(true);
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
    this.sun.position.set(x + 2, y - 1, 4);
    if (this.markers && this.trail.add(x, y)) this.writeTrail();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
