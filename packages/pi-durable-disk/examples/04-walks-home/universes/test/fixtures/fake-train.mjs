// A stand-in for ../train/train.py with the same file contract and no physics, for tests (run with node in place of
// python). Per checkpoint, in order: the checkpoint directory, policy.json (by rename), one progress.jsonl line
// (fsynced), then state.json by rename, exactly once. A run on a work directory that has a state.json resumes:
// generation + 1, from its steps. SIGTERM stops at once and writes state.json with status paused.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: { mjcf: { type: "string" }, body: { type: "string" }, universe: { type: "string" }, work: { type: "string" }, minutes: { type: "string" }, world: { type: "string" }, course: { type: "string" }, "compile-cache": { type: "string" } },
});
const host = process.env.TRAIN_HOST_LABEL || hostname();
const work = a.work;
mkdirSync(work, { recursive: true });
const statePath = join(work, "state.json");
const prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const generation = (prior.generation ?? 0) + 1;
let steps = prior.steps_done ?? 0;
const total = 60_000;
const segments = [...(prior.segments ?? []), { generation, base: steps, host }];
const universe = JSON.parse(readFileSync(a.universe, "utf8"));

function writeJson(path, value) {
  const fd = openSync(`${path}.tmp`, "w");
  writeFileSync(fd, JSON.stringify(value));
  fsyncSync(fd);
  closeSync(fd);
  renameSync(`${path}.tmp`, path);
}
const state = (status) => writeJson(statePath, { universe: universe.name, status, generation, steps_done: steps, steps_total: total, segments });

process.on("SIGTERM", () => {
  state("paused");
  process.exit(0);
});
state("training");
const timer = setInterval(() => {
  steps += 1000;
  if (steps % 3000 === 0) {
    const ck = join(work, "ckpt", `seg${generation}`, String(steps).padStart(12, "0"));
    mkdirSync(ck, { recursive: true });
    writeJson(join(ck, "config.json"), { steps });
    writeJson(join(work, "policy.json"), { steps });
    appendFileSync(join(work, "progress.jsonl"), `${JSON.stringify({ steps, score: Math.round((steps / total) * 3.2 * 1e4) / 1e4, host })}\n`);
    state("training");
  }
  if (steps >= total) {
    clearInterval(timer);
    state("done");
  }
}, 50);
