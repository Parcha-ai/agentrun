// A Docker host's images over the computer package's fake docker (packages/computer/test/fake-docker.mjs), for the real
// Docker provider driven by serve: a `docker` program, first on PATH, that keeps which images the host has (none to begin
// with), answers `version` (amd64), `image inspect` (the image's labels), `build` (the tag and labels it is given, the
// recipe read from stdin) and `pull` (refused for the recipe's repository, agentrun-computer, which no registry has), and
// refuses a `run` of an image it lacks that no registry has, as Docker's own pull for run is refused. Every other call
// (run, inspect, exec with the daemon's hello, rm) is the fake's. No Docker is reached.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fakeDocker } from "../../computer/test/fake-docker.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** The host: `dir` (put it first on PATH), `calls()` (every docker call's argv, in order), `images()` (what the host has,
 *  by tag: its labels, and `pulledByRun` for one a run pulled), and the computer fake (`fake`: its daemonPath and cache). */
export function dockerHost() {
  const fake = fakeDocker();
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-docker-host-")));
  dirs.push(dir);
  const images = join(dir, "images.json");
  const log = join(dir, "calls.jsonl");
  writeFileSync(images, "{}");
  writeFileSync(log, "");
  writeFileSync(join(dir, "docker"), `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const load = () => JSON.parse(readFileSync(${JSON.stringify(images)}, "utf8"));
const save = (all) => writeFileSync(${JSON.stringify(images)}, JSON.stringify(all));
const unpullable = (image) => image.startsWith("agentrun-computer:");
const denied = (image) => { process.stderr.write("Error response from daemon: pull access denied for " + image.split(":")[0] + ", repository does not exist or may require 'docker login'\\n"); process.exit(1); };
if (args[0] === "version") { process.stdout.write("amd64\\n"); process.exit(0); }
if (args[0] === "image" && args[1] === "inspect") {
  const all = load(); const image = args.at(-1);
  if (!all[image]) { process.stderr.write("Error response from daemon: No such image: " + image + "\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(all[image].labels) + "\\n"); process.exit(0);
}
if (args[0] === "build") {
  readFileSync(0);
  const tag = args[args.indexOf("--tag") + 1];
  const labels = Object.fromEntries(args.flatMap((arg, i) => (args[i - 1] === "--label" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : [])));
  const all = load(); all[tag] = { labels }; save(all);
  process.stdout.write("sha256:" + "b".repeat(64) + "\\n"); process.exit(0);
}
if (args[0] === "pull") {
  const image = args.at(-1);
  if (unpullable(image)) denied(image);
  const all = load(); all[image] = { labels: {} }; save(all);
  process.stdout.write(image + "\\n"); process.exit(0);
}
if (args[0] === "run" && !args.includes("node")) {
  const all = load();
  const image = args.find((arg) => arg.startsWith("agentrun-computer:") || arg.includes("ubuntu:"));
  if (image !== undefined && !all[image]) {
    if (unpullable(image)) { process.stderr.write("Unable to find image '" + image + "' locally\\n"); denied(image); }
    all[image] = { labels: {}, pulledByRun: true }; save(all);
  }
}
const ran = spawnSync(${JSON.stringify(fake.program)}, args, { stdio: "inherit" });
process.exit(ran.status ?? 1);
`, { mode: 0o755 });
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { fake, dir, calls, images: () => JSON.parse(readFileSync(images, "utf8")) };
}
