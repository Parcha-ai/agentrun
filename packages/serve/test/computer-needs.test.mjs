// A sandbox's needs (computer.needs): the programs its box must have on its PATH, which a definition states and the
// claim checks in the box. Here, the field as a definition and a stored body take it: a sandbox's list of program names,
// each once; another kind, an empty list, a path, a name with a space or a shell's metacharacter, a repeat or too many are
// refused in words. It never names an image. And the words a run ends with when its box lacks one: what is missing, and
// how to give the box an image that has it, by the provider's own setting.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.match(said.message, /program names the box must have on its PATH \(or libraries its python3 or node loads, by their pip or npm names\)/);
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

test("a stored body keeps a sandbox's needs as given (up to 32, the API's cap), and one with none keeps none, so its body is as before", () => {
  assert.deepEqual(bodyOf({ kind: "agentic", instructions: "x", computer: { needs: MEDIA, provider: "docker", kind: "sandbox" } }).body.computer, { kind: "sandbox", provider: "docker", needs: MEDIA });
  assert.deepEqual(bodyOf({ kind: "agentic", instructions: "x", computer: { kind: "sandbox", provider: "docker" } }).body.computer, { kind: "sandbox", provider: "docker" });
  for (const needs of [[], ["a b"], ["ffmpeg", "ffmpeg"], "ffmpeg", Array.from({ length: 33 }, (_, i) => `p${i}`)]) {
    assert.throws(() => bodyOf({ kind: "agentic", instructions: "x", computer: { kind: "sandbox", provider: "docker", needs } }), (error) => error instanceof AgentBodyInvalid && /needs/.test(error.message), JSON.stringify(needs));
  }
  const most = Array.from({ length: 32 }, (_, i) => `p${i}`);
  assert.deepEqual(bodyOf({ kind: "agentic", instructions: "x", computer: { kind: "sandbox", provider: "docker", needs: most } }).body.computer.needs, most);
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

// The check as the box runs it: the claim's one `sh`, run here by a stand-in client whose exec.run starts it on this
// machine under the env the claim hands it, in a folder of the test's. A need is a program on the agent's PATH, or a
// library the agent's python3 has installed (by the name pip installs it by) or a script of its node requires.
function hostClient(t, { python = true, node = true } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "needs-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A Python distribution, as pip leaves one in site-packages: its .dist-info folder.
  mkdirSync(join(dir, "site", "python_pptx-1.0.2.dist-info"), { recursive: true });
  writeFileSync(join(dir, "site", "python_pptx-1.0.2.dist-info", "METADATA"), "Metadata-Version: 2.1\nName: python-pptx\nVersion: 1.0.2\n");
  // A Node package in a node_modules of a folder above the one the check runs in, as /node_modules is above every folder.
  mkdirSync(join(dir, "node_modules", "pptxgenjs"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pptxgenjs", "package.json"), JSON.stringify({ name: "pptxgenjs", version: "4.0.1", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", "pptxgenjs", "index.js"), "module.exports = {};\n");
  mkdirSync(join(dir, "work"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // The box's python3 and node, or none.
  // The interpreter itself, not a launcher on this machine's PATH (pyenv's is a bash script, and the box's PATH has no bash).
  if (python) symlinkSync(execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim(), join(bin, "python3"));
  if (node) symlinkSync(process.execPath, join(bin, "node"));
  return {
    async call(method, params) {
      assert.equal(method, "exec.run");
      const [command, ...args] = params.argv;
      const ran = spawnSync(command === "sh" ? "/bin/sh" : command, args, { cwd: join(dir, "work"), env: { ...params.env, PATH: bin, PYTHONPATH: join(dir, "site") }, encoding: "buffer" });
      return { ok: true, value: { exitCode: ran.status, signal: ran.signal ?? undefined, stdout: ran.stdout.toString("base64"), stderr: ran.stderr.toString("base64"), timedOut: false, truncated: false } };
    },
  };
}

test("the check finds a need as a program on the PATH, a library the box's python3 has installed or a package its node requires, and lacks the rest", async (t) => {
  const { missingNeeds } = await import("../dist/computer-needs.js");
  assert.deepEqual(await missingNeeds(hostClient(t), ["node", "python-pptx", "pptxgenjs", "agentrun-no-such-lib", "ffmpeg-not-here"]), { missing: ["agentrun-no-such-lib", "ffmpeg-not-here"] });
  assert.deepEqual(await missingNeeds(hostClient(t), ["Python_PPTX"]), { missing: [] }, "pip's names are read as pip reads them");
});

test("a box with no python3 or no node lacks the libraries that would need it, and is still checked: the answer names them, it is no failed check", async (t) => {
  const { missingNeeds } = await import("../dist/computer-needs.js");
  assert.deepEqual(await missingNeeds(hostClient(t, { python: false }), ["python-pptx", "pptxgenjs"]), { missing: ["python-pptx"] });
  assert.deepEqual(await missingNeeds(hostClient(t, { node: false }), ["python-pptx", "pptxgenjs"]), { missing: ["pptxgenjs"] });
});

test("a box that lacks only what the documents image has is told to build that image: Docker's command, or Daytona's documents snapshot", async () => {
  const { needsWords } = await import("../dist/computer-needs.js");
  const DOCS = ["python-pptx", "pptxgenjs"];
  const docker = needsWords({ missing: DOCS }, DOCS, { label: "Docker", local: true });
  assert.match(docker, /^This agent's sandbox on Docker lacks python-pptx and pptxgenjs, which the agent needs \(computer\.needs\), so nothing ran\./);
  assert.match(docker, /so nothing ran\. Build the documents image: docker build -t agentrun-documents:<first 12 hex of the sha256 of its Dockerfile and documents\.sh> packages\/computer\/documents, name that tag in AGENTRUN_DOCKER_IMAGE and restart the server\.$/);
  assert.doesNotMatch(docker, /media/, "only the image that has them");
  const daytona = needsWords({ missing: ["openpyxl"] }, DOCS, { label: "Daytona", imageEnv: "AGENTRUN_DAYTONA_SNAPSHOT" });
  assert.match(daytona, /python3 packages\/computer\/box\/build-daytona\.py --documents/);
  assert.match(daytona, /set AGENTRUN_DAYTONA_SNAPSHOT to the agentrun-documents-<hash> snapshot it prints/);
  // Programs of both images, or of neither, keep the general words.
  const mixed = needsWords({ missing: ["ffmpeg", "python-pptx"] }, ["ffmpeg", "python-pptx"], { label: "Docker", local: true });
  assert.match(mixed, /Set AGENTRUN_DOCKER_IMAGE to an image that has them/);
});
