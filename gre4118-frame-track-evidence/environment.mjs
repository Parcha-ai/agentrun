import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [checkout, root, label] = process.argv.slice(2);
const files = ["packages/pi-browser/src/recorder/track.ts", "packages/pi-browser/dist/recorder/track.js", "packages/pi-browser/test/frame_track.test.mjs"];
const result = {
  label, node: process.version, arch: process.arch,
  os: /^PRETTY_NAME="([^"]+)"/m.exec(readFileSync("/etc/os-release", "utf8"))[1],
  ffmpeg: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }),
  ffprobe: execFileSync("ffprobe", ["-version"], { encoding: "utf8" }).split("\n")[0],
  packages: execFileSync("dpkg-query", ["-W", "-f=${Package} ${Version}\n", "ffmpeg", "libvpx9"], { encoding: "utf8" }).trim().split("\n"),
  sha256: Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(join(checkout, file))).digest("hex")])),
};
writeFileSync(join(root, `${label}-environment.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
