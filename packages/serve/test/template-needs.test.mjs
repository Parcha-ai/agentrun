// A template states the programs its agent's sandbox must have (`needs` beside `computer` in agent.md), never which
// image gives them: the image stays the server's (AGENTRUN_DOCKER_IMAGE for the Docker box). It is read only beside
// `computer: [shell]`, so a template that needs them never falls back to no computer. Apply writes them onto the sandbox
// it picks (`computer.needs`), which each run checks in its box before its first model request (computer-needs.ts);
// a template with needs asks for a sandbox alone (a pick of the computer's kind, never of an image), never Archil's
// serverless exec; where no sandbox answers (Mode 2's Docker box can't mount Archil's workspaces, so none does there),
// apply refuses in words naming the programs, why, and the image fix, and makes nothing. No Docker command runs here: a fake `docker` first on PATH answers the probe.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compiled, PackageError, pickComputer, readPackage } from "../dist/templates.js";
import { schemaProblems } from "./schema-support.mjs";
import { scratch, SECRET_WRITE_PATHS, serve, withEnv } from "./support.mjs";

SECRET_WRITE_PATHS.push({ methods: ["PUT"], path: /^\/workspace\/archil$/ });
const ARCHIL = { region: "aws-us-east-1", s3Url: "https://s3.archil.example", keys: { ARCHIL_API_KEY: "fake-test-key" } };
/** A package that renders video: a shell in a sandbox that has hyperframes and ffmpeg, or nothing. */
const FILM = "---\nname: film\nversion: 1.0.0\ndescription: Renders a video.\ntools: [read, bash]\ncomputer: [shell]\nneeds: [hyperframes, ffmpeg]\n---\nRender.\n";
/** The same package with no needs: it takes the shell here as before. */
const PLAIN = "---\nname: plain\nversion: 1.0.0\ndescription: Runs a command.\ntools: [read, bash]\ncomputer: [shell]\n---\nRun.\n";
const NEEDS = ["hyperframes", "ffmpeg"];
const DOCKER = { computer: { kind: "sandbox", provider: "docker" }, tools: ["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"], words: "the docker sandbox" };
const EXEC = { computer: { kind: "none" }, tools: ["bash"], words: "Archil's serverless exec" };
const NONE = { none: "this server has no shell to give an agent now: no box" };
/** The refusal's words where the shell here is no sandbox: the programs by name, and the image that gives them. */
/** Why no sandbox answers in Mode 2, as the refusal says it: Archil's exec is none, and the docker box can't mount its workspaces. */
const MODE2_WHY = /no sandbox answers here: Archil's serverless exec is no sandbox, and the docker box is unavailable here \(Mode 2 keeps workspaces on Archil; a local Docker computer can't mount them/;
const NO_SANDBOX = /^The film template needs a sandbox that has hyperframes and ffmpeg, and .+\. Nothing was created\. .*AGENTRUN_DOCKER_IMAGE/;

/** A folder holding `name`'s agent.md, `text`. */
async function packageDir(t, name, text) {
  const dir = join(await scratch(t), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), text);
  return dir;
}

/** The problems readPackage finds in FILM with `from` replaced by `to`. */
async function problemsOf(t, from, to) {
  try {
    readPackage(await packageDir(t, "film", FILM.replace(from, to)));
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return error.problems;
  }
  return [];
}

/** A server alone on FILM, with a fake `docker` that answers when `docker`, in Mode 2 when `archil`. */
async function filmServer(t, { docker = false, archil = false } = {}) {
  const templates = join(await scratch(t), "templates");
  mkdirSync(join(templates, "film"), { recursive: true });
  writeFileSync(join(templates, "film", "agent.md"), FILM);
  mkdirSync(join(templates, "plain"), { recursive: true });
  writeFileSync(join(templates, "plain", "agent.md"), PLAIN);
  const bin = join(await scratch(t), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nif [ "$1" = version ]; then ${docker ? "echo 27.0.0-fake; exit 0" : "echo 'Cannot connect to the Docker daemon' >&2; exit 1"}; fi\nexit 0\n`);
  chmodSync(join(bin, "docker"), 0o755);
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), PATH: `${bin}:${process.env.PATH}` }, ["AGENTRUN_BOXES", "ARCHIL_API_KEY", "AGENTRUN_DOCKER_IMAGE"]);
  const { api, baseUrl } = await serve(t, { faux: undefined, runner: false, accounts: true, openSetup: true, templates });
  if (archil) {
    const saved = await api("PUT", "/workspace/archil", ARCHIL);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const meets = (path, method, code, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[code].content["application/json"].schema, value), [], `${method} ${path} ${code}: ${JSON.stringify(value)}`);
  return { api, meets };
}

test("a template's needs read beside computer: [shell] alone, as a list of program names; anything else is refused in words", async (t) => {
  assert.deepEqual(readPackage(await packageDir(t, "film", FILM)).needs, NEEDS);
  assert.equal(readPackage(await packageDir(t, "film", FILM.replace("needs: [hyperframes, ffmpeg]\n", ""))).needs, undefined, "none named: none");
  const beside = /^agent\.md: needs: the programs a sandbox must have, so computer is \[shell\]: a template that needs them never falls back to no computer, nor runs where a new agent does$/;
  for (const computer of ["computer: [shell, none]\n", "computer: [none]\n", "computer: default\n", ""]) {
    const problems = await problemsOf(t, "computer: [shell]\n", computer);
    assert.ok(problems.some((p) => beside.test(p)), `${JSON.stringify(computer)}: ${JSON.stringify(problems)}`);
  }
  // As a sandbox's computer.needs is checked (computer-needs.ts needsIssues), at the field `needs`.
  for (const [value, words] of [["ffmpeg", /needs is a list of 1 to 32 program names/], ["[]", /needs is a list of 1 to 32 program names/], ["[/usr/bin/ffmpeg]", /needs holds "\/usr\/bin\/ffmpeg", not a program's name/], ["[ffmpeg, ffmpeg]", /needs names one program twice/]]) {
    const problems = await problemsOf(t, "[hyperframes, ffmpeg]", value);
    assert.ok(problems.some((p) => words.test(p)), `${value}: ${JSON.stringify(problems)}`);
  }
});

test("pickComputer writes a template's needs onto the sandbox it picks, and refuses where the shell here is no sandbox, naming the programs and AGENTRUN_DOCKER_IMAGE", async (t) => {
  const film = readPackage(await packageDir(t, "film", FILM));
  const picked = pickComputer(film, DOCKER);
  assert.deepEqual(picked, { entry: "shell", computer: { kind: "sandbox", provider: "docker", needs: NEEDS }, shell: "the docker sandbox", dropped: [], defaults: DOCKER.tools, note: null });
  // The definition apply makes carries them: each run checks them in its box (computer-for-claim.ts).
  assert.deepEqual(compiled(film, {}, { mcp: [], defaultTools: [], grants: [], computer: picked }).agent.definition.computer, { kind: "sandbox", provider: "docker", needs: NEEDS });
  for (const here of [EXEC, NONE]) {
    const refused = pickComputer(film, here);
    assert.match(refused.refused ?? "", NO_SANDBOX, JSON.stringify(refused));
    assert.match(refused.fix ?? "", /AGENTRUN_DOCKER_IMAGE/, JSON.stringify(refused));
  }
  assert.match(pickComputer(film, EXEC).refused, /the shell here is Archil's serverless exec, which is no sandbox/);
  // A template with no needs picks as before: the setting carries none.
  assert.deepEqual(pickComputer({ ...film, needs: undefined }, DOCKER).computer, { kind: "sandbox", provider: "docker" });
});

test("Docker: GET /v2/templates shows a template's needs and the sandbox an apply would save them on; apply writes them as the agent's computer.needs", async (t) => {
  const { api, meets } = await filmServer(t, { docker: true });
  const listed = await api("GET", "/templates");
  meets("/templates", "get", "200", listed.body);
  const film = listed.body.templates.find((one) => one.name === "film");
  assert.deepEqual([film.computer, film.needs], [["shell"], NEEDS]);
  assert.deepEqual(film.computer_here, { entry: "shell", computer: { kind: "sandbox", provider: "docker", needs: NEEDS }, shell: "the docker sandbox", dropped: [], note: null });
  const applied = await api("POST", "/templates/film/apply", {});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const made = (await api("GET", `/agents/${applied.body.agent_id}`)).body.definition;
  assert.deepEqual([made.computer, made.tools], [{ kind: "sandbox", provider: "docker", needs: NEEDS }, ["read", "bash"]]);
});

test("Mode 2 with Docker answering: a template with needs is refused, 409, saying Archil's exec is no sandbox and why the docker box can't be one in Mode 2; one without needs still takes the exec", async (t) => {
  const { api, meets } = await filmServer(t, { docker: true, archil: true });
  const listed = await api("GET", "/templates");
  meets("/templates", "get", "200", listed.body);
  const film = listed.body.templates.find((one) => one.name === "film");
  assert.equal(film.computer_here.computer, null);
  assert.match(film.computer_here.note, NO_SANDBOX);
  assert.match(film.computer_here.note, MODE2_WHY);
  const plain = listed.body.templates.find((one) => one.name === "plain");
  assert.deepEqual([plain.computer_here.computer, plain.computer_here.shell], [{ kind: "none" }, "Archil's serverless exec"]);
  const before = (await api("GET", "/agents")).body.agents.length;
  const refused = await api("POST", "/templates/film/apply", {});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, NO_SANDBOX);
  assert.match(refused.body.error.message, MODE2_WHY);
  assert.match(refused.body.error.fields[0].fix, /with Archil off .*AGENTRUN_DOCKER_IMAGE/);
  assert.equal((await api("GET", "/agents")).body.agents.length, before, "nothing made");
  const other = await api("POST", "/templates/plain/apply", {});
  assert.equal(other.status, 201, JSON.stringify(other.body));
  assert.deepEqual((await api("GET", `/agents/${other.body.agent_id}`)).body.definition.computer, { kind: "none" });
});

test("Mode 2 without Docker: Archil's exec is no sandbox and none answers, so a template with needs is refused, 409, in words naming the programs, both shells and AGENTRUN_DOCKER_IMAGE, and nothing is made", async (t) => {
  const { api, meets } = await filmServer(t, { archil: true });
  const listed = await api("GET", "/templates");
  meets("/templates", "get", "200", listed.body);
  const film = listed.body.templates.find((one) => one.name === "film");
  assert.deepEqual({ ...film.computer_here, note: undefined }, { entry: null, computer: null, shell: null, dropped: [], note: undefined });
  assert.match(film.computer_here.note, NO_SANDBOX);
  const before = (await api("GET", "/agents")).body.agents.length;
  const refused = await api("POST", "/templates/film/apply", {});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, NO_SANDBOX);
  assert.match(refused.body.error.message, /Archil's serverless exec is no sandbox, and the docker box is unavailable here/);
  assert.deepEqual(refused.body.error.fields.map((f) => [f.field, f.reason]), [["computer", "not_set_up_here"]]);
  assert.match(refused.body.error.fields[0].fix, /AGENTRUN_DOCKER_IMAGE/);
  assert.equal((await api("GET", "/agents")).body.agents.length, before, "nothing made");
});

test("Mode 1 without Docker: no shell at all, so a template with needs is refused the same way", async (t) => {
  const { api } = await filmServer(t);
  const refused = await api("POST", "/templates/film/apply", {});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, NO_SANDBOX);
  assert.match(refused.body.error.message, /docker box is unavailable here/);
});
