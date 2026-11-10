// Every refusal and reason about places, boxes and the home names the next step. A place's 422 carries the place to copy
// as its `fix`, and applying that fix saves. A box this server does not enable names the setting that enables it, in
// capabilities, a save's warning and a run's 409. Docker's probe says what to do, in one sentence that ends in one full
// stop. bash in capabilities is unavailable, saying why, when no box can run it. The start's banner says which boxes are
// ready, in words. The home's learning/ refusal names a route only when this server has it. A fake `docker` first on PATH
// stands in for Docker: no Docker command runs here.
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BOX_IDS, boxRegistry, VM_PROVIDER } from "../dist/boxes.js";
import { boxesLine } from "../dist/place.js";
import { hostOwnedRefusal } from "../dist/home-path.js";
import { banner } from "../dist/print.js";
import { ROUTES } from "../dist/server.js";
import { agent, flowAgent, scratch, serve, withEnv } from "./support.mjs";

const VM = VM_PROVIDER.id;
const BOXES = BOX_IDS.join(", ");
const DOCKER_PLACE = '"place": {"mode": "sandbox", "box": "docker"}';
const ENABLE_DOCKER = "not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker";
const DAEMON = "Docker isn't running on this machine, or this user may not use it (docker version failed: exit 1): start Docker, or add this user to the docker group, then restart AgentRun";
// Runs execute in docker, the VM box and daytona: a server with none names each, with its setting.
const ENABLE_DAYTONA = "not enabled on this server: start AgentRun with AGENTRUN_BOXES=daytona";
const ENABLE_VM = `not enabled on this server: start AgentRun with AGENTRUN_BOXES=${VM}`;
const NO_BOX = `no box is set up on this server: docker is unavailable (${ENABLE_DOCKER}); ${VM} is unavailable (${ENABLE_VM}); daytona is unavailable (${ENABLE_DAYTONA})`;

/** A fake `docker` first on PATH whose every call fails, as a CLI with no daemon answering does. */
async function failingDocker(t) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n");
  await chmod(join(bin, "docker"), 0o755);
  return `${bin}:${process.env.PATH}`;
}

/** `definition` with `fix` applied: a place to set (`"place": {...}`), or a field to remove (`Remove definition.x.y.`). */
function fixed(definition, fix) {
  if (fix.startsWith('"place": ')) return { ...definition, ...JSON.parse(`{${fix}}`) };
  const removed = /^Remove definition\.([a-z_]+)(?:\.([a-z_]+))?\.$/.exec(fix) ?? /^Remove "([a-z_]+)" from definition\.tools\.$/.exec(fix);
  assert.ok(removed, `a fix this test can apply: ${fix}`);
  if (fix.endsWith("from definition.tools.")) return { ...definition, tools: definition.tools.filter((tool) => tool !== removed[1]) };
  const copy = structuredClone(definition);
  if (removed[2]) delete copy[removed[1]][removed[2]];
  else delete copy[removed[1]];
  return copy;
}

const issueAt = (body, field) => body.error?.fields?.find((issue) => issue.field === field);

test("a place of the wrong shape is a 422 whose fix is the place to copy, and the definition with that fix applied saves", async (t) => {
  const { api } = await serve(t);
  const cases = [
    ["docker", "wrong_type", "definition.place is an object: {mode}, or {mode, box}", DOCKER_PLACE],
    ["sandbox", "wrong_type", "definition.place is an object: {mode}, or {mode, box}", DOCKER_PLACE],
    ["runner", "wrong_type", "definition.place is an object: {mode}, or {mode, box}", '"place": {"mode": "runner"}'],
    [null, "wrong_type", "definition.place is an object: {mode}, or {mode, box}", DOCKER_PLACE],
    [{ mode: "docker" }, "not_an_option", "definition.place.mode is one of runner, sandbox", DOCKER_PLACE],
    [{ mode: "Sandbox", box: VM }, "not_an_option", "definition.place.mode is one of runner, sandbox", `"place": {"mode": "sandbox", "box": "${VM}"}`],
    [{ box: "docker" }, "missing", "definition.place.mode is one of runner, sandbox", DOCKER_PLACE],
    [{ mode: "sandbox" }, "missing", `a sandbox place names its box: one of ${BOXES}`, DOCKER_PLACE],
    [{ mode: "sandbox", box: "Docker" }, "not_an_option", `definition.place.box is one of ${BOXES}`, DOCKER_PLACE],
    [{ mode: "sandbox", box: "podman" }, "not_an_option", `definition.place.box is one of ${BOXES}`, DOCKER_PLACE],
    [{ mode: "runner", box: "docker" }, "not_allowed", "a runner place uses no box", "Remove definition.place.box."],
    [{ mode: "sandbox", box: "docker", network: "open" }, "not_allowed", "definition.place keeps only mode and box, not network", "Remove definition.place.network."],
  ];
  for (const [index, [place, reason, message, fix]] of cases.entries()) {
    const definition = agent(`guess-${index}`, { place }).definition;
    const refused = await api("POST", "/agents", { definition });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.deepEqual(issueAt(refused.body, "definition.place"), { field: "definition.place", reason, message, fix }, JSON.stringify(place));
    const saved = await api("POST", "/agents", { definition: fixed(definition, fix) });
    assert.equal(saved.status, 201, `${JSON.stringify(place)} with "${fix}": ${JSON.stringify(saved.body)}`);
  }
});

test("bash on a runner, the browser in a sandbox and a workflow in one are 422s that say what to do, each with a fix that saves", async (t) => {
  const { api } = await serve(t);
  const cases = [
    [agent("shell", { tools: ["read", "bash"] }).definition, "definition.tools[1]", "bash runs only in a box, and this agent names no place, so it runs on the runner, which has no shell, and new agents run on the runner, because the docker box is unavailable here: not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker. Do that, or keep this agent on the runner: name \"place\": {\"mode\": \"runner\"} and remove \"bash\" from definition.tools.", 'Remove "bash" from definition.tools.'],
    [agent("shell-runner", { tools: ["read", "bash"], place: { mode: "runner" } }).definition, "definition.tools[1]", "bash runs only in a box, and this agent's place is the runner, which has no shell, and new agents run on the runner, because the docker box is unavailable here: not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker. Do that, or keep this agent on the runner: name \"place\": {\"mode\": \"runner\"} and remove \"bash\" from definition.tools.", 'Remove "bash" from definition.tools.'],
    [agent("browsing", { tools: ["bash", "browser"], place: { mode: "sandbox", box: "docker" } }).definition, "definition.tools[1]", "browser does not run in a sandbox place yet: it saves files into the run's work/ from this server, outside the box, and a command in the box could point those writes elsewhere on this server. Give it to an agent whose place is the runner.", 'Remove "browser" from definition.tools.'],
    [flowAgent("flow", undefined, { place: { mode: "sandbox", box: "docker" } }).definition, "definition.place", "A workflow runs on the runner here: its place is runner (or none), not sandbox on docker.", '"place": {"mode": "runner"}'],
  ];
  for (const [definition, field, message, fix] of cases) {
    const refused = await api("POST", "/agents", { definition });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.deepEqual(refused.body.error.fields, [{ field, reason: "not_an_option", message, fix }], definition.id);
    const saved = await api("POST", "/agents", { definition: fixed(definition, fix) });
    assert.equal(saved.status, 201, `${definition.id} with "${fix}": ${JSON.stringify(saved.body)}`);
  }
});

test("a sandbox agent edited into a workflow with no place keeps its sandbox place, so the 422's fix is the runner place, and the edit with it applied saves", async (t) => {
  const { api } = await serve(t);
  const made = await api("POST", "/agents", agent("boxed", { place: { mode: "sandbox", box: "docker" } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const definition = { workflow: flowAgent("x").definition.workflow };
  const edit = (body) => api("PUT", "/agents/boxed/definition", { definition: body }, { "if-match": `"${made.body.revision}"` });
  const refused = await edit(definition);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  const issue = issueAt(refused.body, "definition.place");
  assert.equal(issue.fix, '"place": {"mode": "runner"}', "removing a field the edit never named would change nothing");
  const saved = await edit(fixed(definition, issue.fix));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.definition.place, { mode: "runner" });
});

test("a box this server does not enable names the setting that enables it: in capabilities, the save's warning and the run's 409, each ending in one full stop", async (t) => {
  const { api } = await serve(t);
  const { places, tools } = (await api("GET", "/capabilities")).body;
  assert.deepEqual(places.boxes, [
    { id: "bwrap", available: false, state: "unavailable", reason: "the bwrap box is not in this release yet: use the docker box" },
    { id: "docker", available: false, state: "unavailable", reason: ENABLE_DOCKER },
    { id: VM, available: false, state: "unavailable", reason: `not enabled on this server: start AgentRun with AGENTRUN_BOXES=${VM}` },
    { id: "daytona", available: false, state: "unavailable", reason: "not enabled on this server: start AgentRun with AGENTRUN_BOXES=daytona" },
  ]);
  const bash = tools.find((tool) => tool.name === "bash");
  assert.deepEqual([bash.available, bash.reason, bash.sandbox_only], [false, NO_BOX, true], JSON.stringify(bash));
  assert.equal(bash.summary, "Run a bash command in the run's box, from its work/, never on this server itself: only an agent whose place is a sandbox names it. Its output's tail; 120 s unless the call names a timeout, at most 600 s (longer work: bash_background).");
  assert.deepEqual(tools.filter((tool) => tool.reason?.startsWith("no box")).map((tool) => tool.name), ["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"], "only the sandbox-only tools (bash and the background tools) are unavailable for want of a box");
  // The web tools keep how they resolve, and why, on a server with no box.
  const web = tools.filter((tool) => tool.resolves);
  assert.deepEqual(web.map((tool) => [tool.name, tool.available, Object.keys(tool.why ?? {}).sort()]), [["web_fetch", true, ["claude-agent", "codex", "opencode", "pi"]], ["web_search", true, ["claude-agent", "codex", "opencode", "pi"]], ["browser", false, ["claude-agent", "codex", "opencode", "pi"]]], JSON.stringify(web));
  assert.ok(web.every((tool) => Object.values(tool.why).every((why) => typeof why === "string" && why.length > 0)), "each harness's why is words");

  const made = await api("POST", "/agents", agent("docked", { place: { mode: "sandbox", box: "docker" } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // A place is its computer setting's view: a Docker sandbox is refused in the Docker box's own reason, its fix.
  const said = `This agent's computer is a Docker sandbox, and this server cannot run it: ${ENABLE_DOCKER}.`;
  assert.deepEqual(made.body.warnings, [{ field: "definition.computer", reason: "not_set_up_here", message: said }]);
  const run = await api("POST", "/agents/docked/runs", { input: { content: "hi" } });
  assert.deepEqual([run.status, run.body.error.code, run.body.error.message, run.body.error.details.box], [409, "agent_not_runnable", said, "docker"]);
});

test("the setting a box names keeps the boxes AGENTRUN_BOXES already lists", async () => {
  const registry = await boxRegistry({ AGENTRUN_BOXES: "daytona" });
  assert.equal(registry.offers().find((offer) => offer.id === "docker").reason, "not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker,daytona");
  assert.equal(registry.offers().find((offer) => offer.id === VM).reason, `not enabled on this server: start AgentRun with AGENTRUN_BOXES=${VM},daytona`);
});

test("docker enabled with no daemon answering: its reason says to start Docker or join the docker group, the 409 ends in one full stop, and the banner says no box is ready", async (t) => {
  withEnv(t, { PATH: await failingDocker(t), AGENTRUN_BOXES: "docker" });
  const server = await serve(t);
  const { api } = server;
  const { places, tools } = (await api("GET", "/capabilities")).body;
  assert.deepEqual(places.boxes.find((box) => box.id === "docker"), { id: "docker", available: false, state: "unavailable", reason: DAEMON });
  const DAYTONA_TOO = "not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker,daytona";
  const VM_TOO = `not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker,${VM}`;
  assert.equal(tools.find((tool) => tool.name === "bash").reason, `no box is set up on this server: docker is unavailable (${DAEMON}); ${VM} is unavailable (${VM_TOO}); daytona is unavailable (${DAYTONA_TOO})`);

  const made = await api("POST", "/agents", agent("docked", { place: { mode: "sandbox", box: "docker" } }));
  const said = `This agent's computer is a Docker sandbox, and this server cannot run it: ${DAEMON}.`;
  assert.equal(made.body.warnings[0].message, said);
  const run = await api("POST", "/agents/docked/runs", { input: { content: "hi" } });
  assert.equal(run.body.error.message, said);
  assert.ok(!/[?.!]\.$/.test(run.body.error.message) && !run.body.error.message.includes("?"), run.body.error.message);

  assert.equal(server.boxesLine, `Boxes: none is ready, so sandbox agents do not run here. docker: ${DAEMON}. ${VM}: ${VM_TOO}. daytona: ${DAYTONA_TOO}.`);
  const lines = banner({ url: server.url, baseUrl: server.baseUrl, data: server.data, token: server.token, source: "file", boxes: server.boxesLine });
  assert.equal(lines.at(-1), server.boxesLine, "the banner's last line");
});

test("the banner says in words which boxes are ready: none with nothing enabled, naming the setting; docker when the faux box stands in for it", async (t) => {
  const none = await serve(t);
  assert.equal(none.boxesLine, `Boxes: none is ready, so sandbox agents do not run here. docker: ${ENABLE_DOCKER}. ${VM}: ${ENABLE_VM}. daytona: ${ENABLE_DAYTONA}.`);
  const faux = await serve(t, { faux: new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname, fauxBox: new URL("./fixtures/faux-box.mjs", import.meta.url).pathname });
  assert.equal(faux.boxesLine, "Boxes: docker is ready, so sandbox agents run their tools there. docker boxes have no network: a faux box (tests).");
  const bash = (await faux.api("GET", "/capabilities")).body.tools.find((tool) => tool.name === "bash");
  assert.deepEqual([bash.available, bash.reason], [true, undefined], "a box can run it");
});

test("the banner's words for each mix of boxes: ready, preparing (a box whose image is still pulled), listed and not ready", () => {
  const off = (id, reason) => ({ id, available: false, reason });
  const docker = { id: "docker", available: true };
  const rest = [off("bwrap", "the bwrap box is not in this release yet: use the docker box"), off(VM, `not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker,${VM}`), off("daytona", "needs DAYTONA_API_KEY")];
  assert.equal(boxesLine([docker, ...rest], new Set(["docker"])), "Boxes: docker is ready, so sandbox agents run their tools there.");
  assert.equal(boxesLine([docker, ...rest], new Set(["docker", "daytona"])), "Boxes: docker is ready, so sandbox agents run their tools there. daytona: needs DAYTONA_API_KEY.", "a listed box that is not ready says why");
  assert.equal(boxesLine([{ ...docker, state: "preparing", reason: "pulling debian:bookworm-slim" }, ...rest], new Set(["docker"])), "Boxes: docker is preparing (pulling debian:bookworm-slim).");
  assert.equal(boxesLine([off("docker", "Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun"), ...rest], new Set(["docker"])), `Boxes: none is ready, so sandbox agents do not run here. docker: Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun. ${VM}: not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker,${VM}. daytona: needs DAYTONA_API_KEY.`);
  // AGENTRUN_BOXES not set at all: docker alone, said to be on by default, or why new agents run on the runner.
  const ON = "Boxes: docker (on by default; set AGENTRUN_BOXES to change).";
  assert.equal(boxesLine([docker, ...rest], new Set(["docker"]), "none", true), ON);
  assert.equal(boxesLine([{ ...docker, state: "preparing", reason: "pulling debian:bookworm-slim" }, ...rest], new Set(["docker"]), "none", true), `${ON} docker is preparing (pulling debian:bookworm-slim).`);
  assert.equal(boxesLine([{ ...docker, network: "none", network_reason: "a Docker in a VM" }, ...rest], new Set(["docker"]), "none", true), `${ON} docker boxes have no network: a Docker in a VM.`);
  const NO_DOCKER = "Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun";
  assert.equal(boxesLine([off("docker", NO_DOCKER), ...rest], new Set(["docker"]), "none", true), `Boxes: none, so new agents run on the runner. ${NO_DOCKER}.`);
});

test("a read under learning/ names the learning route only where this server has it, and never one that answers 404", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("keeper"))).status, 201);
  const hasRoute = ROUTES.some((route) => route.method === "GET" && route.pattern.test("/agents/keeper/learning"));
  // The route joined from its parts, as home.test.mjs builds it.
  const read = await api("GET", ["/agents/keeper", "home", "files", "learning/notes.md"].join("/"));
  assert.deepEqual([read.status, read.body.error.code, read.body.error.details], [403, "system_file_forbidden", { reason: "host_owned" }]);
  assert.equal(read.body.error.message, hasRoute ? "the server keeps learning/ for itself: read it through /v2/agents/keeper/learning" : "the server keeps learning/ for itself; this server has no learning API yet");
  const named = /\/v2(\/agents\/[^\s]+)/.exec(read.body.error.message)?.[1];
  if (named) assert.notEqual((await api("GET", named)).status, 404, `${named} is a route here`);
});

test("the learning/ refusal on a server whose routes include the learning API names that route; a write's says the server writes it", () => {
  const at = (owned) => `/v2/agents/keeper/${owned}`;
  assert.equal(hostOwnedRefusal("learning", "keeper", false, at).message, "the server keeps learning/ for itself: read it through /v2/agents/keeper/learning");
  assert.equal(hostOwnedRefusal("learning", "keeper", false, () => undefined).message, "the server keeps learning/ for itself; this server has no learning API yet");
  assert.equal(hostOwnedRefusal("learning", "keeper", true, at).message, "learning/ is written by the server, not through the API");
  assert.deepEqual(hostOwnedRefusal("learning", "keeper", false, at).extra, { details: { reason: "host_owned" } });
});
