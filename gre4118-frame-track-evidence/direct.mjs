import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, label] = process.argv.slice(2);
mkdirSync(join(root, "direct"), { recursive: true });
const files = ["big.jpg", "third.jpg", "big.jpg", "third.jpg"];
const base = files.map((file) => `file 'input/${file}'\nduration 1.000`).join("\n") + "\n";
const cases = [];
for (const tail of [true, false]) {
  const name = tail ? "with-tail" : "without-tail";
  const list = join(root, `direct-list-${name}.txt`);
  writeFileSync(list, base + (tail ? `file 'input/third.jpg'\n` : ""));
  const output = join(root, "direct", `${label}-${name}.webm`);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=10,format=yuv420p", "-fps_mode", "cfr", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-row-mt", "1", "-deadline", "good", "-cpu-used", "5", "-an", output];
  execFileSync("ffmpeg", args);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,r_frame_rate:format=duration", "-of", "json", output], { encoding: "utf8" }));
  cases.push({ name, list: readFileSync(list, "utf8"), probe });
}
const result = { label, ffmpeg: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0], cases };
writeFileSync(join(root, "direct", `${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
