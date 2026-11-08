// Where a run's tools run (serve/src/workspace/place.ts): every row of the rules, both modes, both kinds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDERS, resolvePlace } from "../dist/workspace/index.js";

const all = { docker: true, keyed: new Set(["daytona", "modal", "e2b"]) };
const none = { docker: false, keyed: new Set() };
const runner = { mode: "runner" };
const box = (id) => ({ mode: "sandbox", box: id });

test("the provider ids are docker, daytona, modal and e2b", () => {
  assert.deepEqual([...PROVIDERS], ["docker", "daytona", "modal", "e2b"]);
});

test("an absent place: Mode 1 gets Docker where it answers, else the runner; Mode 2 gets the runner", () => {
  assert.deepEqual(resolvePlace(1, undefined, "agentic", all), { computer: "docker" });
  assert.deepEqual(resolvePlace(1, undefined, "agentic", none), { computer: null });
  assert.deepEqual(resolvePlace(2, undefined, "agentic", all), { computer: null });
  assert.deepEqual(resolvePlace(2, undefined, "agentic", none), { computer: null });
});

test("place runner is no computer, in either mode", () => {
  for (const mode of [1, 2]) for (const available of [all, none]) assert.deepEqual(resolvePlace(mode, runner, "agentic", available), { computer: null });
});

test("a workflow always gets the runner, whatever its place says", () => {
  for (const mode of [1, 2]) for (const place of [undefined, runner, box("docker"), box("daytona"), box("nope")]) {
    assert.deepEqual(resolvePlace(mode, place, "workflow", all), { computer: null }, `${mode} ${JSON.stringify(place)}`);
  }
});

test("Mode 1 takes docker where it answers, refuses it in words where it does not, and refuses every remote box", () => {
  assert.deepEqual(resolvePlace(1, box("docker"), "agentic", all), { computer: "docker" });
  assert.deepEqual(resolvePlace(1, box("docker"), "agentic", none), { refused: "place sandbox asks for Docker, and Docker is not answering on this machine: start Docker, or run this agent with place runner." });
  for (const id of ["daytona", "modal", "e2b"]) {
    assert.deepEqual(resolvePlace(1, box(id), "agentic", all), { refused: `place sandbox asks for ${id}, a remote computer, and Mode 1 runs only the local Docker computer: a remote computer cannot reach a folder on this machine. Use box docker, or place runner.` }, id);
  }
});

test("Mode 2 takes a remote box it holds a key for, and refuses one with no key in words", () => {
  for (const id of ["daytona", "modal", "e2b"]) {
    assert.deepEqual(resolvePlace(2, box(id), "agentic", all), { computer: id });
    assert.deepEqual(resolvePlace(2, box(id), "agentic", { docker: true, keyed: new Set(["daytona", "modal", "e2b"].filter((other) => other !== id)) }), { refused: `place sandbox asks for ${id}, and this server holds no key for it: add its key, or pick another place.` }, id);
  }
});

test("Mode 2 refuses docker in words, whether Docker answers or not: the run's folder is on the disk, never mounted here", () => {
  const words = "Mode 2 keeps workspaces on Archil; a local Docker computer can't mount them. Use a remote box or place runner.";
  assert.deepEqual(resolvePlace(2, box("docker"), "agentic", all), { refused: words });
  assert.deepEqual(resolvePlace(2, box("docker"), "agentic", none), { refused: words });
});

test("a box no provider has is refused in words, in either mode", () => {
  for (const mode of [1, 2]) for (const id of ["bwrap", "", "Docker"]) {
    assert.deepEqual(resolvePlace(mode, box(id), "agentic", all), { refused: `place sandbox names "${id}", which is not a computer this server knows (docker, daytona, modal, e2b).` });
  }
});
