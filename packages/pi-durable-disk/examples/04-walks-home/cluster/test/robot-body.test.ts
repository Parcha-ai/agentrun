// What robot.md asks of a body so it can learn to walk, as the body helper warns about it: built with the repo's own
// lib.mjs and build.mjs (04-walks-home/body), from D3's dinosaur and variants of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const body = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "body");
const dino = readFileSync(join(body, "dino.example.mjs"), "utf8");

/** The build's printed warnings for this body file. */
function warnings(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "robot-body-"));
  try {
    mkdirSync(join(dir, "robot"));
    for (const f of ["lib.mjs", "build.mjs"]) copyFileSync(join(body, f), join(dir, "robot", f));
    writeFileSync(join(dir, "robot", "body.mjs"), source);
    const r = spawnSync(process.execPath, ["robot/build.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split("\n").filter((l) => l.startsWith("warning: "));
  } finally {
    rmSync(dir, { recursive: true, force: true }); // this call's own directory, whatever happened
  }
}

test("a body built the way robot.md asks (flat box feet, leg motors of strength 14) gets no foot or motor warning", () => {
  assert.deepEqual(warnings(dino).filter((w) => /ball|too weak/.test(w)), []);
});

test("ball feet and weak leg motors are warned about, once each, with what to do (a warning, not a refusal)", () => {
  const balls = warnings(dino.replace('shape: "box", size: [0.05, 0.035, 0.015]', 'shape: "sphere", size: [0.03]'));
  assert.equal(balls.filter((w) => / are balls: ball feet roll and barely walk; make each a flat box with friction "1\.4 0\.05 0\.01"$/.test(w)).length, 1, balls.join("\n"));
  const weak = warnings(dino.replaceAll("strength: 14", "strength: 10"));
  assert.equal(weak.filter((w) => /^warning: leg motors .*\(10\).* too weak to carry the body: give leg motors strength 14 or more$/.test(w)).length, 1, weak.join("\n"));
});

test("the starter dog is built the way robot.md asks: flat box feet, leg motors of strength 14, the torso the heaviest part", () => {
  const dog = readFileSync(join(body, "dog.example.mjs"), "utf8");
  assert.deepEqual(warnings(dog).filter((w) => /ball|too weak/.test(w)), []);
  assert.match(dog, /shape: "box", size: \[0\.05, 0\.035, 0\.015\].*friction: "1\.4 0\.05 0\.01"/);
  assert.equal((dog.match(/strength: 14/g) ?? []).length, 2, "hip and knee");
  assert.match(dog, /tags: \["torso"\], mass: 6,/);
});
