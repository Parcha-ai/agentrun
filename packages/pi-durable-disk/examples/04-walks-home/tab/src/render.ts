// Three.js view of a MuJoCo model: one mesh per geom, posed from data.geom_xpos / geom_xmat each frame.
// MuJoCo is z-up, so the camera is z-up too and no coordinate conversion happens.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Sim } from './sim.ts';

const GEOM = { plane: 0, sphere: 2, capsule: 3, ellipsoid: 4, cylinder: 5, box: 6 } as const;

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private meshes: THREE.Mesh[] = [];
  private sim: Sim | null = null;
  private readonly grid: THREE.GridHelper;
  private readonly m4 = new THREE.Matrix4();

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 12 });
    this.scene.add(sun);
    // The floor: a big shaded plane (receives the shadow) with a 1 m grid on it that follows the creature.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xd8d4c6, roughness: 1 }));
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.grid = new THREE.GridHelper(100, 100, 0x9d9a8c, 0xbdb9aa);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = 0.002;
    this.scene.add(this.grid);
  }

  /** Rebuild the meshes for a (new) sim. */
  setSim(sim: Sim): void {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.meshes = [];
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
      else if (type === GEOM.ellipsoid) { geo = new THREE.SphereGeometry(1, 24, 16); geo.scale(s[0], s[1], s[2]); }
      else { this.meshes.push(new THREE.Mesh()); continue; }
      const c = [0, 1, 2, 3].map((k) => model.geom_rgba[4 * g + k]);
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), roughness: 0.6, metalness: 0.05 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.meshes.push(mesh);
    }
    this.draw(true);
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
    // The grid is finite but huge; keep it under the creature so the floor never runs out.
    this.grid.position.x = Math.round(x);
    this.grid.position.y = Math.round(y);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
