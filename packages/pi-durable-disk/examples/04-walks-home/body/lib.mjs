// The robot as code: the helper a robot's body file imports. The agent writes `robot/body.mjs` (any shape, any number of limbs, segments, necks, tails, heads, decorations); this file turns the tree it returns
// into MJCF for MuJoCo plus the facts the creature page, the trainer and the look tools need. Plain ESM with no dependency: it runs in the tab's computer, in node and in the trainer, and gives the same bytes.
//
// Units are metres and radians; +x is forward, +y is the robot's left, +z is up. A node is one MuJoCo body:
//   { name?, pos: [x, y, z],          where its origin sits in its parent
//     shape: "box" | "sphere" | "capsule" | "cylinder" | "ellipsoid",   its (one) visible, colliding piece
//     size: ...,                      box [hx, hy, hz] half extents; sphere [r]; capsule/cylinder [r, halfLength] along the node's z; ellipsoid [rx, ry, rz]
//     from/to: [x,y,z] x2             a capsule or cylinder between two points instead of size (a limb: from [0,0,0] to [0,0,-0.2])
//     color: "green" | "#3a7d44",     tags: ["legs", "front_legs"],   mass: kg (default from the volume),
//     joint: { axis: [0,1,0], range: [-1, 1], stand: 0, passive: false, strength: 12, stiffness: 0, damping: 0.3 },
//     (names the trainer and the tab look for, written for you: the root body is "torso"; the foot of each limb is a piece named "<body>_foot", by default the last piece at the tip of a limb tagged legs, or any piece you mark foot: true;
//      the keyframe is "stand" (and "home"). Motors must come before springs along a limb, and limbs with motors are walked first, so a tail or a neck listed before the legs still comes after them.)
//     geoms: [ ...extra pieces on the same body with the same fields (shape, size, pos, color, tags) ],
//     children: [ ...nodes ] }
// A joint with `passive: true` has a spring (stiffness) and damping and no motor: a tail or a neck that swings; every other joint gets a position motor and is one of the robot's trainable joints, in the order the tree is walked.
// Tags say what a piece is (torso, head, legs, front_legs, back_legs, neck, tail, eyes, plates, ...): the look tools (set_color part, set_shape, set_face) work on a tag, so they work on any body.

/** The tags the look tools address (and the offline model's prompt names): a fixed list, so what a lock or a prompt offers does not depend on the body. A tag outside it still renders and simulates; only part "all" reaches it. */
export const TAG_VOCABULARY = ["torso", "head", "neck", "tail", "legs", "front_legs", "back_legs", "arms", "wings", "eyes", "jaw", "belly", "plates", "horns", "spikes", "decoration"];

const NAMED = { red: "#d9423b", orange: "#f08a24", yellow: "#f2cf3a", green: "#4caf62", blue: "#3b78d9", purple: "#8a56c8", pink: "#ee8fbe", white: "#f4f4f0", black: "#1f1f22", gray: "#8a8a90", brown: "#8a5a3a" };
const f = (n) => String(Math.round(n * 1e6) / 1e6);
const v3 = (a, d = [0, 0, 0]) => (a ?? d).map(f).join(" ");

/** A colour name or #rrggbb as MJCF rgba. */
export function rgba(color, alpha = 1) {
  const hex = NAMED[color] ?? color ?? "#9aa0a6";
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`color ${JSON.stringify(color)} is neither a name (${Object.keys(NAMED).join(", ")}) nor #rrggbb`);
  const n = parseInt(m[1], 16);
  return `${f(((n >> 16) & 255) / 255)} ${f(((n >> 8) & 255) / 255)} ${f((n & 255) / 255)} ${f(alpha)}`;
}

/** Repeat a segment `count` times, each one hanging off the last (a tail, a neck, a spine): `make(i)` returns the node of segment i and the next ones go in its `children`. */
export function chain(count, make) {
  let node;
  for (let i = count - 1; i >= 0; i--) { const n = make(i); n.children = [...(n.children ?? []), ...(node ? [node] : [])]; node = n; }
  return node;
}

/** The same node on the other side (y mirrored), named with `suffix`: a left leg made from a right one. A joint about x (a leg swinging out sideways) is mirrored too: its stand angle and range change sign. */
export function mirror(node, suffix = "_r") {
  const flip = (p) => (p ? [p[0], -p[1], p[2]] : p);
  // A rotation axis is an axial vector: reflecting y turns (ax, ay, az) into (-ax, ay, -az) with the same angle. An axis with no y part is kept as it was and the angle negated instead (the same rotation, and the stand angle of a left/right pair reads +a / -a);
  // an axis with a y part (a mixed one) becomes the reflected axis with its angle and range unchanged.
  const flipJoint = (j) => {
    if (!j) return j;
    const [ax, ay, az] = j.axis ?? [0, 1, 0];
    if (ay !== 0) return { ...j, axis: [-ax || 0, ay, -az || 0] };
    if (ax === 0 && az === 0) return j;
    return { ...j, stand: -(j.stand ?? 0), range: j.range ? [-j.range[1], -j.range[0]] : j.range };
  };
  const walk = (n) => ({ ...n, name: n.name ? n.name + suffix : n.name, pos: flip(n.pos), from: flip(n.from), to: flip(n.to), joint: flipJoint(n.joint), geoms: n.geoms?.map((g) => ({ ...g, pos: flip(g.pos), from: flip(g.from), to: flip(g.to) })), children: n.children?.map(walk) });
  return walk(node);
}


// ---- the lowest point of the body at its standing pose, by forward kinematics, so the keyframe puts the feet on the floor without a physics run (the trainer and the tab get the same height) ----
const mul = (a, b) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));
const apply = (R, v) => [0, 1, 2].map((i) => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]);
const axisAngle = (axis, a) => {
  const n = Math.hypot(...axis) || 1, [x, y, z] = axis.map((c) => c / n), c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
};
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function lowestZ(root) {
  let low = Infinity;
  const visit = (node, R, origin, isRoot) => {
    const here = isRoot ? origin : origin.map((o, i) => o + apply(R, node.pos ?? [0, 0, 0])[i]);
    const Rj = node.joint && !isRoot ? mul(R, axisAngle(node.joint.axis ?? [0, 1, 0], node.joint.stand ?? 0)) : R;
    for (const g of pieces(node)) {
      const shape = g.shape;
      if ((shape === "capsule" || shape === "cylinder") && g.from && g.to) {
        const r = g.size?.[0] ?? g.r ?? 0.02;
        const axis = apply(Rj, g.to.map((x, k) => x - g.from[k]));
        const uz = Math.abs(axis[2]) / (Math.hypot(...axis) || 1);
        const reach = shape === "capsule" ? r : r * Math.sqrt(Math.max(0, 1 - uz * uz)); // a capsule's ends are spheres (r); a cylinder's are flat discs, whose lowest point is r * sin of the axis's tilt below the end's centre
        for (const p of [g.from, g.to]) low = Math.min(low, here[2] + apply(Rj, p)[2] - reach);
        continue;
      }
      const c = here[2] + apply(Rj, g.pos ?? [0, 0, 0])[2];
      const sz = g.size ?? [0.03];
      if (shape === "sphere") low = Math.min(low, c - sz[0]);
      else if (shape === "box") { const Rg = Rj; low = Math.min(low, c - (Math.abs(Rg[2][0]) * sz[0] + Math.abs(Rg[2][1]) * sz[1] + Math.abs(Rg[2][2]) * sz[2])); }
      else if (shape === "ellipsoid") low = Math.min(low, c - Math.hypot(Rj[2][0] * sz[0], Rj[2][1] * sz[1], Rj[2][2] * sz[2]));
      else if (shape === "cylinder") { const uz = Math.abs(Rj[2][2]); low = Math.min(low, c - (uz * (sz[1] ?? sz[0]) + sz[0] * Math.sqrt(Math.max(0, 1 - uz * uz)))); } // flat ends
      else { const hl = sz[1] ?? sz[0]; low = Math.min(low, c - (Math.abs(Rj[2][2]) * hl + sz[0])); } // a capsule along the node's z: round ends
    }
    for (const ch of node.children ?? []) visit(ch, Rj, here, false);
  };
  visit(root, I3, [0, 0, 0], true);
  return low;
}

/** The pieces of a node: its own shape at the body's origin (`pos` places the body in its parent, not the shape in the body), then the extra geoms at their own positions. */
const pieces = (n) => [{ ...n, pos: undefined }, ...(n.geoms ?? [])].filter((g) => g.shape);
const hasMotor = (n) => (n.joint && n.joint.passive !== true) || (n.children ?? []).some(hasMotor);
/** The tree with the limbs that have motors first at every level: the trainer and the tab read the motors as the first joints of the body, so every spring joint (a tail, a neck) must come after them. */
const motorsFirst = (n) => ({ ...n, children: (n.children ?? []).map(motorsFirst).sort((a, b) => Number(hasMotor(b)) - Number(hasMotor(a))) });
const VOLUME = { sphere: (s) => (4 / 3) * Math.PI * s[0] ** 3, box: (s) => 8 * s[0] * s[1] * s[2], capsule: (s) => Math.PI * s[0] ** 2 * (2 * s[1] + (4 / 3) * s[0]), cylinder: (s) => Math.PI * s[0] ** 2 * 2 * s[1], ellipsoid: (s) => (4 / 3) * Math.PI * s[0] * s[1] * s[2] };

function geomXml(g, name, tags, mass, indent) {
  const shape = g.shape ?? "box";
  const common = `name="${name}" contype="0" conaffinity="1" rgba="${rgba(g.color)}" mass="${f(mass)}"${g.friction ? ` friction="${g.friction}"` : ""}`;
  if ((shape === "capsule" || shape === "cylinder") && g.from && g.to) return `${indent}<geom type="${shape}" fromto="${v3(g.from)} ${v3(g.to)}" size="${f(g.size?.[0] ?? g.r ?? 0.02)}" ${common}/>`;
  if (!g.size || !Array.isArray(g.size)) throw new Error(`${name}: a ${shape} needs size [..] (or from/to for a capsule)`);
  return `${indent}<geom type="${shape}" pos="${v3(g.pos)}" size="${g.size.map(f).join(" ")}" ${common}/>`;
}

/**
 * Build a body spec: { name, root: node }, the root being the torso (a body with a free joint). Returns { xml, joints, motors, tags, colors, stand } where `joints` lists every joint in walk order, `motors` the trainable
 * ones in the order a policy drives them, `tags` maps each piece's name to its tags and `colors` to its colour name or hex.
 */
export function build(spec) {
  if (!spec || typeof spec !== "object" || !spec.root) throw new Error("the body file must export robot(name, rootNode): the root node is the torso");
  const joints = [], motors = [], tags = {}, colors = {}, actuators = [], names = new Set();
  let counter = 0, totalMass = 0;
  const unique = (base) => { let n = base, i = 2; while (names.has(n)) n = `${base}_${i++}`; names.add(n); return n; };
  const walk = (node, depth, isRoot) => {
    const ind = "    ".repeat(depth + 1);
    const bname = unique(isRoot ? "torso" : node.name ?? `part${counter++}`);
    let xml = `${ind}<body name="${bname}" pos="${v3(isRoot ? undefined : node.pos)}">\n`;
    if (isRoot) xml += `${ind}  <freejoint name="root"/>\n${ind}  <site name="imu" pos="0 0 0"/>\n`;
    if (node.joint && !isRoot) {
      const j = node.joint, jname = unique(`${bname}_j`);
      const range = j.range ?? [-1, 1];
      const stand = j.stand ?? 0;
      joints.push({ name: jname, body: bname, axis: j.axis ?? [0, 1, 0], range, stand, passive: j.passive === true });
      if (j.passive) xml += `${ind}  <joint name="${jname}" type="hinge" axis="${v3(j.axis, [0, 1, 0])}" range="${range.map(f).join(" ")}" stiffness="${f(j.stiffness ?? 2)}" damping="${f(j.damping ?? 0.3)}" armature="0.005"/>\n`;
      else {
        motors.push(jname);
        xml += `${ind}  <joint name="${jname}" type="hinge" axis="${v3(j.axis, [0, 1, 0])}" range="${range.map(f).join(" ")}" damping="${f(j.damping ?? 0.3)}" armature="0.01"/>\n`;
        actuators.push(`    <position name="${jname}_a" joint="${jname}" kp="40" kv="1.2" ctrlrange="${range.map(f).join(" ")}" forcerange="-${f(j.strength ?? 12)} ${f(j.strength ?? 12)}"/>`);
      }
    }
    const pieceList = pieces(node);
    pieceList.forEach((g, i) => {
      const flagged = pieceList.some((p) => p.foot === true);
      const isLeafLeg = !isRoot && (flagged ? g.foot === true : !(node.children?.length) && i === pieceList.length - 1 && (g.tags ?? node.tags ?? []).includes("legs"));
      const gname = unique(isLeafLeg ? `${bname}_foot` : `${bname}${i === 0 ? "" : `_g${i}`}_geom`);
      const t = g.tags ?? node.tags ?? (isRoot ? [] : ["decoration"]);
      tags[gname] = [...new Set([...(isRoot && i === 0 ? ["torso"] : []), ...(t.length ? t : isRoot ? ["torso"] : ["decoration"])])];
      colors[gname] = g.color ?? "gray";
      const size = g.size ?? [0.03];
      const mass = g.mass ?? Math.max(0.02, (VOLUME[g.shape ?? "box"]?.(g.from && g.to ? [size[0], Math.hypot(...g.to.map((x, k) => x - g.from[k])) / 2] : size) ?? 0.001) * 400);
      totalMass += mass;
      xml += geomXml(g, gname, tags[gname], mass, `${ind}  `) + "\n";
    });
    for (const c of node.children ?? []) xml += walk(c, depth + 1, false);
    xml += `${ind}</body>\n`;
    return xml;
  };
  const body = walk(motorsFirst(spec.root), 1, true);
  const firstSpring = joints.findIndex((j) => j.passive);
  const lateMotor = firstSpring < 0 ? undefined : joints.slice(firstSpring).find((j) => !j.passive);
  if (lateMotor) throw new Error(`the spring joint ${joints[firstSpring].name} sits above the motor ${lateMotor.name}: along a limb the motors must come before the springs (put the spring segments of a neck or a tail after the legs, or make ${joints[firstSpring].name} a motor)`);
  const startZ = Math.round((spec.startHeight ?? Math.max(0.02, -lowestZ(spec.root) + 0.004)) * 1e4) / 1e4; // the torso's height with the lowest point of the body just above the floor at the standing pose (spec.startHeight overrides)
  const name = String(spec.name ?? "robot").replace(/[^\w-]/g, "_");
  const standList = joints.map((j) => j.stand);
  const xml = `<mujoco model="${name}">
  <compiler angle="radian"/>
  <option timestep="0.004" integrator="implicitfast"/>
  <visual><global offwidth="1280" offheight="720"/></visual>
  <worldbody>
    <geom name="floor" type="plane" size="0 0 0.05" contype="1" conaffinity="1" friction="1 0.05 0.01" rgba="0.9 0.9 0.86 1"/>
${body}  </worldbody>
  <actuator>
${actuators.join("\n")}
  </actuator>
  <keyframe>
    <key name="home" qpos="0 0 ${f(startZ)} 1 0 0 0 ${standList.map(f).join(" ")}" ctrl="${joints.filter((j) => !j.passive).map((j) => f(j.stand)).join(" ")}"/>
    <key name="stand" qpos="0 0 ${f(startZ)} 1 0 0 0 ${standList.map(f).join(" ")}" ctrl="${joints.filter((j) => !j.passive).map((j) => f(j.stand)).join(" ")}"/>
  </keyframe>
</mujoco>
`;
  const present = new Set(Object.values(tags).flat());
  const tagList = [...TAG_VOCABULARY.filter((t) => present.has(t)), ...[...present].filter((t) => !TAG_VOCABULARY.includes(t))];
  const limbs = (spec.root.children ?? []).filter((c) => pieces(c).some((p) => (p.tags ?? c.tags ?? []).includes("legs"))).length;
  const faceTag = spec.face?.tag ?? (present.has("head") ? "head" : "torso");
  const warnings = [];
  if (motors.length === 0) warnings.push("it has no trainable joints, so it cannot walk");
  if (motors.length > 24) warnings.push(`${motors.length} trainable joints: training will be slow`);
  if (totalMass < 0.3) warnings.push(`it weighs ${f(totalMass)} kg, very light for a robot`);
  if (totalMass > 60) warnings.push(`it weighs ${f(totalMass)} kg, very heavy for a robot`);
  for (const j of joints) if (Math.max(Math.abs(j.range[0]), Math.abs(j.range[1])) > 3.2) warnings.push(`joint ${j.name} turns more than 3.2 rad each way`);
  for (const [g, t] of Object.entries(tags)) if (t.length === 1 && t[0] === "decoration" && !names.has(g)) warnings.push(`${g} has no tag`);
  return {
    xml, joints, motors, tags, colors, name, warnings,
    json: { name, joints, motors, tags, colors, warnings, face: { tag: faceTag, ...(spec.face?.at ? { at: spec.face.at } : {}) }, legs: limbs, tag_list: tagList, pieces: Object.keys(tags).length, mass_kg: Math.round(totalMass * 100) / 100, stand_height_m: startZ },
  };
}

/** The robot: a name and the torso node (the root of the tree). */
export const robot = (name, root, opts = {}) => ({ name, root, ...opts });
