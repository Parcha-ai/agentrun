// `node robot/build.mjs`: runs robot/body.mjs (the robot the agent wrote) and writes robot/body.xml (MJCF) and robot/body.json (its joints, tags, colours, face anchor). Prints one summary line and any warnings; an error in
// body.mjs exits with its message, so the agent reads it and fixes its own code. The creature page then compiles the body in MuJoCo, settles it and writes robot/build.json (the build_robot tool reads that back).
import { writeFileSync } from "node:fs";
import { build } from "./lib.mjs";

let body;
try {
  body = (await import("./body.mjs")).default;
} catch (e) {
  console.error(`body.mjs: ${e && e.message ? e.message : e}`);
  process.exit(1);
}
let out;
try {
  out = build(body);
} catch (e) {
  console.error(`body.mjs: ${e && e.message ? e.message : e}`);
  process.exit(1);
}
writeFileSync(new URL("./body.xml", import.meta.url), out.xml);
writeFileSync(new URL("./body.json", import.meta.url), JSON.stringify(out.json, null, 1) + "\n");
console.log(`wrote robot/body.xml and robot/body.json: ${out.json.pieces} pieces, ${out.motors.length} motors, ${out.joints.length - out.motors.length} spring joints, ${out.json.mass_kg} kg, standing height ${out.json.stand_height_m} m. Tags: ${out.json.tag_list.join(", ")}.`);
for (const w of out.warnings) console.log(`warning: ${w}`);
