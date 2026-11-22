// A sandbox's needs (computer.needs): the programs its box must have on its PATH, which a definition states and the
// claim checks in the box. Here, the field as a definition and a stored body take it: a sandbox's list of program names,
// each once; another kind, an empty list, a path, a name with a space or a shell's metacharacter, a repeat or too many are
// refused in words. It never names an image. And the words a run ends with when its box lacks one: what is missing, and
// how to give the box an image that has it, by the provider's own setting.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerIssues, sameComputer } from "../dist/computer-setting.js";
import { definitionIssues } from "../dist/validate.js";
import { AgentBodyInvalid, bodyOf } from "../dist/store/agent-body.js";

const MEDIA = ["chrome", "ffmpeg", "ffprobe", "hyperframes"];
const issues = (computer) => computerIssues(computer, "definition.computer").map((issue) => [issue.field, issue.reason]);

test("a sandbox takes needs: a list of program names, each once", () => {
  assert.deepEqual(issues({ kind: "sandbox", provider: "docker", needs: MEDIA }), []);
  assert.deepEqual(issues({ kind: "sandbox", provider: "docker", needs: ["python3.12", "g++", "x_y-z"] }), [], "dots, plus signs, underscores and dashes");
  assert.deepEqual(definitionIssues({ name: "Film", instructions: "Render it.", computer: { kind: "sandbox", provider: "docker", needs: MEDIA } }), [], "a definition with it saves");
});

test("needs that are not a list of program names are refused at their field, in words", () => {
  for (const needs of [[], "ffmpeg", [3], new Array(33).fill(0).map((_, i) => `p${i}`)]) {
    assert.deepEqual(issues({ kind: "sandbox", provider: "docker", needs }), [["definition.computer.needs", "wrong_type"]], JSON.stringify(needs));
  }
  for (const name of ["/usr/bin/ffmpeg", "ff mpeg", "$(id)", "-rf", "", "a;b", "é"]) {
    assert.deepEqual(issues({ kind: "sandbox", provider: "docker", needs: [name] }), [["definition.computer.needs", "bad_format"]], JSON.stringify(name));
  }
  assert.deepEqual(issues({ kind: "sandbox", provider: "docker", needs: ["ffmpeg", "ffmpeg"] }), [["definition.computer.needs", "duplicate"]]);
  const [said] = computerIssues({ kind: "sandbox", provider: "docker", needs: [] }, "definition.computer");
  assert.match(said.message, /program names the box must have on its PATH/);
});

test("only a sandbox takes needs: a desktop, a phone, a browser and no computer refuse them", () => {
  for (const kind of ["desktop", "phone", "browser"]) {
    assert.deepEqual(issues({ kind, provider: "orgo", needs: ["ffmpeg"] }), [["definition.computer", "not_allowed"]], kind);
  }
  assert.deepEqual(issues({ kind: "none", needs: ["ffmpeg"] }), [["definition.computer", "not_allowed"]]);
});

test("needs are part of the setting: two settings that differ only in them are not one", () => {
  assert.equal(sameComputer({ kind: "sandbox", provider: "docker", needs: ["ffmpeg"] }, { kind: "sandbox", provider: "docker", needs: ["ffmpeg"] }), true);
  assert.equal(sameComputer({ kind: "sandbox", provider: "docker", needs: ["ffmpeg"] }, { kind: "sandbox", provider: "docker" }), false);
});

test("a stored body keeps a sandbox's needs as given, and one with none keeps none, so its body is as before", () => {
  assert.deepEqual(bodyOf({ kind: "agentic", instructions: "x", computer: { needs: MEDIA, provider: "docker", kind: "sandbox" } }).body.computer, { kind: "sandbox", provider: "docker", needs: MEDIA });
  assert.deepEqual(bodyOf({ kind: "agentic", instructions: "x", computer: { kind: "sandbox", provider: "docker" } }).body.computer, { kind: "sandbox", provider: "docker" });
  for (const needs of [[], ["a b"], ["ffmpeg", "ffmpeg"], "ffmpeg"]) {
    assert.throws(() => bodyOf({ kind: "agentic", instructions: "x", computer: { kind: "sandbox", provider: "docker", needs } }), (error) => error instanceof AgentBodyInvalid && /needs/.test(error.message), JSON.stringify(needs));
  }
});

test("the words name what the box lacks and the fix in the provider's own setting: Docker's image, a provider's image setting, else the Docker box", async () => {
  const { needsWords } = await import("../dist/computer-needs.js");
  const docker = needsWords({ missing: ["ffmpeg", "hyperframes"] }, MEDIA, { label: "Docker", local: true });
  assert.match(docker, /^This agent's sandbox on Docker lacks ffmpeg and hyperframes, which the agent needs \(computer\.needs\), so nothing ran\./);
  assert.match(docker, /Set AGENTRUN_DOCKER_IMAGE to an image that has them/);
  assert.match(docker, /docker build -t agentrun-media:<first 12 hex of its sha256> - < packages\/computer\/media\/Dockerfile/);
  const hosted = needsWords({ missing: ["chrome"] }, MEDIA, { label: "Daytona", imageEnv: "AGENTRUN_DAYTONA_SNAPSHOT" });
  assert.match(hosted, /^This agent's sandbox on Daytona lacks chrome,/);
  assert.match(hosted, /Set AGENTRUN_DAYTONA_SNAPSHOT to an image of Daytona's that has them/);
  const other = needsWords({ missing: ["ffprobe"] }, MEDIA, { label: "Modal" });
  assert.match(other, /on the Docker box, set AGENTRUN_DOCKER_IMAGE to such an image/);
  const unasked = needsWords({ unchecked: "the connection to c1 ended." }, MEDIA, { label: "Docker", local: true });
  assert.equal(unasked, "This agent's sandbox on Docker could not be checked for the programs it needs (chrome, ffmpeg, ffprobe, hyperframes): the connection to c1 ended. Nothing ran.");
});
