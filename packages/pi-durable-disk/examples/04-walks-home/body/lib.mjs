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
//     geoms: [ ...extra pieces on the same body with the same fields (shape, size, pos, color, tags) ],
//     children: [ ...nodes ] }
// A joint with `passive: true` has a spring (stiffness) and damping and no motor: a tail or a neck that swings; every other joint gets a position motor and is one of the robot's trainable joints, in the order the tree is walked.
// Tags say what a piece is (torso, head, legs, front_legs, back_legs, neck, tail, eyes, plates, ...): the look tools (set_color part, set_shape, set_face) work on a tag, so they work on any body.

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
  const flipJoint = (j) => {
    if (!j || !j.axis || j.axis[0] === 0) return j;
    return { ...j, stand: -(j.stand ?? 0), range: j.range ? [-j.range[1], -j.range[0]] : j.range };
  };
  const walk = (n) => ({ ...n, name: n.name ? n.name + suffix : n.name, pos: flip(n.pos), from: flip(n.from), to: flip(n.to), joint: flipJoint(n.joint), geoms: n.geoms?.map((g) => ({ ...g, pos: flip(g.pos), from: flip(g.from), to: flip(g.to) })), children: n.children?.map(walk) });
  return walk(node);
}

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
  let counter = 0;
  const unique = (base) => { let n = base, i = 2; while (names.has(n)) n = `${base}_${i++}`; names.add(n); return n; };
  const walk = (node, depth, isRoot) => {
    const ind = "    ".repeat(depth + 1);
    const bname = unique(node.name ?? (isRoot ? "torso" : `part${counter++}`));
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
    const pieces = [{ ...node }, ...(node.geoms ?? [])].filter((g) => g.shape);
    pieces.forEach((g, i) => {
      const gname = unique(`${bname}${i === 0 ? "" : `_g${i}`}_geom`);
      const t = g.tags ?? (i === 0 ? node.tags : node.tags) ?? [];
      tags[gname] = [...new Set([...(isRoot ? ["torso"] : []), ...t])];
      colors[gname] = g.color ?? "gray";
      const size = g.size ?? [0.03];
      const mass = g.mass ?? Math.max(0.02, (VOLUME[g.shape ?? "box"]?.(g.from && g.to ? [size[0], Math.hypot(...g.to.map((x, k) => x - g.from[k])) / 2] : size) ?? 0.001) * 400);
      xml += geomXml(i === 0 ? { ...g, pos: isRoot ? g.pos : g.pos } : g, gname, tags[gname], mass, `${ind}  `) + "\n";
    });
    for (const c of node.children ?? []) xml += walk(c, depth + 1, false);
    xml += `${ind}</body>\n`;
    return xml;
  };
  const body = walk(spec.root, 1, true);
  const startZ = spec.startHeight ?? 1.0; // dropped onto the floor and settled by whoever simulates it: the standing height is measured, not declared
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
  </keyframe>
</mujoco>
`;
  return { xml, joints, motors, tags, colors, name };
}

/** The robot: a name and the torso node (the root of the tree). */
export const robot = (name, root, opts = {}) => ({ name, root, ...opts });
