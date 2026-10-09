// The recorder in --v2 mode, on the scripted v2 rehearsal at 4x: it must read the captions the v2 page shows (#vcaption), and --until must stop the
// take (matched against those captions and the chat) instead of running to --max. Writes nothing outside a temp directory.
//   CDP_URL=http://127.0.0.1:9444 [TAB_DIR=<tab dist>] node scripts/record-v2-check.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, waitForStage } from "./cdp.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const dir = mkdtempSync(join(tmpdir(), "d5-record-v2-"));
const port = await freePort();
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "v2", SHOW_SPEED: "4" }, stdio: "ignore" });
try {
  await waitForStage(port, stage);
  const out = join(dir, "take.webm");
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(show, "scripts/record.mjs"), "--v2", "--url", `http://127.0.0.1:${port}/`, "--out", out, "--until", "even offline", "--tail", "2", "--max", "75", "--fps", "8"], { cwd: show, encoding: "utf8", timeout: 120_000 });
  const seconds = (Date.now() - started) / 1000;
  expect("the recorder exits cleanly", run.status === 0, (run.stdout + run.stderr).split("\n").slice(-6));
  expect("--until stopped the take at the closing line, well before --max", seconds < 60, seconds);
  const log = JSON.parse(readFileSync(`${out}.captions.json`, "utf8"));
  const texts = log.captions.map((c) => c.text);
  expect("the captions the v2 page showed are in the log", log.captions.length >= 2, texts);
  expect("each carries its tag and the second it appeared", log.captions.every((c) => (c.tag === null || typeof c.tag === "string") && typeof c.second === "number"), log.captions);
  expect("the tags are in the log although the clean view draws no pill: the rehearsal's numbers are scripted", log.captions.some((c) => c.tag === "scripted"), log.captions.map((c) => [c.tag, c.text]));
  expect("and a caption that says nothing countable has no tag", log.captions.some((c) => c.tag === null), log.captions.map((c) => [c.tag, c.text]));
  expect("the placements the clean view did not show (a stand-in's) are kept in the record, not lost", Array.isArray(log.decisions) && log.decisions.length >= 1 && log.decisions.every((d) => d.model === "scripted" && typeof d.latency_ms === "number"), log.decisions);
  expect("the move to the GPU is one of them", texts.some((t) => /Moved to the H100 GPU/.test(t)), texts);
  expect("the recorder refuses v1-only beats in --v2 instead of silently doing nothing", (() => {
    const bad = spawnSync(process.execPath, [join(show, "scripts/record.mjs"), "--v2", "--kill-after", "5", "--url", `http://127.0.0.1:${port}/`, "--out", join(dir, "x.webm"), "--max", "5"], { cwd: show, encoding: "utf8", timeout: 30_000 });
    return bad.status !== 0 && /v1 beats|--v2/.test(bad.stdout + bad.stderr);
  })());
} finally {
  stage.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nall v2 recorder checks passed" : `\n${failed} v2 recorder check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
