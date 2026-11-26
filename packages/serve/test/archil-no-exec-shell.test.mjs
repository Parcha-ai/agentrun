// Archil has serverless exec only in some of its regions (https://docs.archil.com/reference/regions): its AWS ones. In
// gcp-us-central1 every exec answers "Exec is not enabled". So on a Mode 2 server there, a run with no computer that
// mounts its folder has no shell ("none", as in Mode 1), and Docker's box, which can't mount Archil, is never a new
// agent's default either: a new agent with bash and no place is refused, told to name a sandbox computer. A region with
// exec, and one serve doesn't know, keep the runner's shell on Archil's exec, word for word as before. Pure functions
// here; the server's own answers are in archil-no-exec-mode2.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import * as credential from "../dist/workspace/archil-mount-credential.js";
import * as settings from "../dist/archil-settings.js";
import * as place from "../dist/place.js";
import * as resolve from "../dist/workspace/resolve-computer.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { runHands } from "../dist/workspace/run-tools.js";
import { blockersOf } from "../dist/runnable.js";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const GCP = "gcp-us-central1";
const AWS = "aws-us-east-1";
const flags = (tool) => ({ bash: { sandboxOnly: true }, bash_background: { sandboxOnly: true }, browser: { runnerOnly: true } })[tool];
const docker = [{ id: "docker", available: true }];
const noDocker = [{ id: "docker", available: false, reason: "Docker isn't running on this machine" }];

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const scratch = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archil-no-exec-")));
  roots.push(root);
  return root;
};

test("one table says which Archil regions have serverless exec: the AWS ones do, gcp-us-central1 doesn't, and a region serve doesn't know is taken to", () => {
  assert.deepEqual(Object.keys(credential.ARCHIL_EXEC_REGIONS ?? {}).sort(), Object.keys(credential.ARCHIL_CONTROL_URLS).sort(), "every region serve knows, and no other");
  assert.equal(typeof credential.archilHasExec, "function");
  for (const region of ["aws-us-east-1", "aws-us-west-2", "aws-eu-west-1"]) assert.equal(credential.archilHasExec(region), true, region);
  assert.equal(credential.archilHasExec(GCP), false);
  assert.equal(credential.archilHasExec("byoc-somewhere-1"), true, "an unknown region keeps today's behaviour");
  // A Mode 2 server's settings give the region without exec; Mode 1 (none) and a region with exec give none.
  assert.equal(settings.noExecRegionOf?.({ region: GCP, s3Url: "https://s3.example" }), GCP);
  assert.equal(settings.noExecRegionOf?.({ region: AWS, s3Url: "https://s3.example" }), undefined);
  assert.equal(settings.noExecRegionOf?.({ region: "byoc-somewhere-1", s3Url: "https://s3.example" }), undefined);
  assert.equal(settings.noExecRegionOf?.(undefined), undefined);
});

test("shellPlaceOf and runShellOf: with no computer, Mode 2 has Archil's exec where the region has it, and no shell where it hasn't", () => {
  assert.equal(resolve.shellPlaceOf(false, 2, undefined), "local");
  assert.equal(resolve.shellPlaceOf(false, 2, GCP), "none");
  assert.equal(resolve.shellPlaceOf(true, 2, GCP), "computer", "a computer that mounts the folder is the shell, exec or not");
  assert.equal(resolve.shellPlaceOf(false, 1, undefined), "none");
  assert.equal(resolve.runShellOf({ kind: "none" }, 2, KINDS, undefined), "local", "aws: as today");
  assert.equal(resolve.runShellOf({ kind: "none" }, 2, KINDS, GCP), "none");
  // A computer that doesn't mount the folder (a phone, a browser) had Archil's exec beside it: not there either.
  assert.equal(resolve.runShellOf({ kind: "phone", provider: "phone-harness" }, 2, KINDS, GCP), "none");
  assert.equal(resolve.runShellOf({ kind: "browser", provider: "browserbase" }, 2, KINDS, GCP), "none");
  assert.equal(resolve.runShellOf({ kind: "sandbox", provider: "modal" }, 2, KINDS, GCP), "computer", "a sandbox that mounts Archil keeps its shell");
});

test("the no-computer choice says why it has no shell, naming the region and the fix; with exec it reads as before", () => {
  const aws = resolve.shellChoiceOf({ kind: "none" }, 2, KINDS, undefined);
  assert.deepEqual(aws, { shell: "local", host_tools: ["read", "write", "edit", "bash"], shell_note: resolve.SHELL_NOTES.local });
  const gcp = resolve.shellChoiceOf({ kind: "none" }, 2, KINDS, GCP);
  assert.deepEqual([gcp.shell, gcp.host_tools], ["none", ["read", "write", "edit"]]);
  assert.match(gcp.shell_note, /gcp-us-central1/);
  assert.match(gcp.shell_note, /no serverless exec/);
  assert.match(gcp.shell_note, /sandbox computer/);
});

test("the claim's runHands gives a Mode 2 run with no computer no bash where the region has no exec, and Archil's exec where it has", async () => {
  for (const [noExec, shell] of [[undefined, "local"], [GCP, "none"]]) {
    const root = scratch();
    const run = await runHands(localWorkspace(root), undefined, { mode: 2, noExec, context: ctx });
    assert.equal(run.shell, shell, `region ${noExec ?? AWS}`);
    assert.equal(run.executors.bash === undefined, shell === "none", `a bash executor only with a shell: ${noExec ?? AWS}`);
  }
});

test("placesOf, defaultPlaceOf and noBoxRefusal in Mode 2 with no exec: never Docker's box, answering or not; a new agent with bash names a sandbox computer", () => {
  const noExec = { noExec: GCP };
  for (const boxes of [docker, noDocker]) {
    const label = boxes[0].available ? "Docker answering" : "no Docker";
    const places = place.placesOf(boxes, "none", noExec);
    assert.equal(places.default_place, null, `${label}: ${JSON.stringify(places)}`);
    assert.match(places.default_reason ?? "", /sandbox computer/, label);
    assert.match(places.default_reason ?? "", /gcp-us-central1 has no serverless exec/, label);
    for (const tools of [["bash"], ["read", "write", "bash"], ["read", "bash", "bash_background"]]) {
      assert.deepEqual(place.defaultPlaceOf("agentic", tools, boxes, flags, noExec), { mode: "runner" }, `${label}: never Docker's box for ${JSON.stringify(tools)}`);
      const refused = place.noBoxRefusal(tools, boxes, flags, noExec);
      assert.ok(refused, `${label}: ${JSON.stringify(tools)} is refused`);
      assert.equal(refused.field, "definition.computer");
      assert.equal(refused.message, places.default_reason, "the refusal is default_reason's words");
    }
    // An agent with no shell tool runs on the runner, refused nothing.
    assert.equal(place.noBoxRefusal(["read", "write"], boxes, flags, noExec), undefined);
    assert.deepEqual(place.defaultPlaceOf("agentic", ["read", "write"], boxes, flags, noExec), { mode: "runner" });
    // No tools named: Mode 2 saves it on the runner with none (server.ts defaultToolsAt), so it has no bash to refuse.
    assert.equal(place.noBoxRefusal(undefined, boxes, flags, noExec), undefined, `${label}: no tools named`);
  }
  // Mode 1 with no Docker (no runner shell): no tools named would be given bash in Docker's box, refused as before.
  assert.equal(place.noBoxRefusal(undefined, noDocker, flags, false)?.field, "definition.place");
  // A region with exec: the runner, as before, Docker answering or not.
  for (const boxes of [docker, noDocker]) {
    assert.deepEqual(place.placesOf(boxes, "none", true).default_place, { mode: "runner" });
    assert.equal(place.noBoxRefusal(["read", "write", "bash"], boxes, flags, true), undefined);
    assert.deepEqual(place.defaultPlaceOf("agentic", ["bash"], boxes, flags, true), { mode: "runner" });
  }
});

test("the start's Boxes line says a new agent with bash names a sandbox computer where the region has no exec, naming it; with exec, word for word as before", () => {
  const noExec = { noExec: GCP };
  for (const boxes of [docker, noDocker]) {
    for (const byDefault of [true, false]) {
      const line = place.boxesLine(boxes, new Set(["docker"]), "none", byDefault, noExec);
      assert.match(line, /gcp-us-central1 has no serverless exec/, line);
      assert.match(line, /sandbox computer \(a box\)/, line);
      assert.doesNotMatch(line, /New agents run on the runner/, line);
    }
  }
  assert.equal(place.boxesLine(docker, new Set(), "none", true, true), "Boxes: docker (on by default; set AGENTRUN_BOXES to change). New agents run on the runner: Mode 2 keeps workspaces on Archil, which the docker box can't mount.");
  assert.equal(place.boxesLine(noDocker, new Set(), "none", true, true), "Boxes: none, so new agents run on the runner. Docker isn't running on this machine.");
});

test("a run's check on a no-exec region: an agent saved with several shell tools and no place or computer is refused once at definition.computer, not once per tool", async () => {
  // As a run of it resolves (server.ts runnable): no place named, so the runner (defaultPlaceOf), `unnamed`.
  const shape = { kind: "agentic", instructions: "Answer.", tools: ["read", "bash", "bash_background", "bash_output"], place: { mode: "runner" }, unnamed: true };
  for (const boxes of [docker, noDocker]) {
    const blockers = await blockersOf({}, shape, {}, { boxes, offers: [{ id: "pi", available: true }], shellOf: async () => "none", noExec: GCP });
    const computer = blockers.filter((one) => one.field === "definition.computer");
    assert.equal(computer.length, 1, JSON.stringify(computer));
    assert.match(computer[0].message, /gcp-us-central1 has no serverless exec/);
    assert.deepEqual(blockers.filter((one) => one.field.startsWith("definition.tools")), [], "no tool refused on its own beside it");
  }
});
