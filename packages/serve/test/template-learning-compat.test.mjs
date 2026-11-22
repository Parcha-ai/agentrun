// A marketplace package's learning settings survive import, review and apply without turning them into a boolean.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { importedPackage } from "../dist/template-import.js";
import { applyBodyOf, compiled, folderFiles, packageView, TEMPLATES_DIR } from "../dist/templates.js";
import { asOwner, serve, withEnv } from "./support.mjs";

const LEARNING = { agree_on: ["next_step.action"] };
const PARAMETERS = { icp: "B2B companies with 50 to 500 employees", post_to: "none" };

/** The real package's files at the boundary where the GitHub reader hands them to import. No network is involved. */
function inboundFiles() {
  const folder = folderFiles(join(TEMPLATES_DIR, "inbound-lead"));
  const files = new Map();
  const walk = (dir) => {
    for (const entry of folder.entries(dir)) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else files.set(path, Buffer.from(folder.text(path)));
    }
  };
  walk("");
  return files;
}

test("the real Inbound Lead package imports with its decision fields intact in the review and apply definition", () => {
  const id = "github:acme/agents/templates/inbound-lead";
  const sha = "a".repeat(40);
  const pkg = importedPackage(id, { source: `${id}@${sha}`, sha, publisher: "acme" }, inboundFiles());
  assert.deepEqual(pkg.learning, LEARNING);
  const view = packageView(pkg);
  assert.deepEqual(view.learning, LEARNING, "the install review must show the same settings that apply will use");
  assert.equal(view.source, `${id}@${sha}`);
  assert.equal(view.bundled, false);
  const { parameters } = applyBodyOf(pkg, { parameters: PARAMETERS });
  const made = compiled(pkg, parameters, { mcp: [], defaultTools: [], grants: [] });
  assert.deepEqual(made.agent.definition.learning, LEARNING);
  assert.equal(made.agent.definition.output_schema.properties.next_step.type, "object");
  assert.ok(made.agent.definition.output_schema.properties.next_step.required.includes("action"));
});

test("applying Inbound Lead saves agree_on, and an unrelated definition edit preserves it", { timeout: 30_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { runner: false });
  const owner = asOwner(server);
  const listed = await server.api("GET", "/templates");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.templates.find((pkg) => pkg.id === "inbound-lead").learning, LEARNING);
  const applied = await owner("POST", "/templates/inbound-lead/apply", { parameters: PARAMETERS });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const path = `/agents/${applied.body.agent_id}`;
  const stored = await server.api("GET", path);
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.deepEqual(stored.body.definition.learning, LEARNING);
  const { learning: _learning, ...definition } = stored.body.definition;
  const edited = await server.api("PUT", `${path}/definition`, {
    definition: { ...definition, version: stored.body.revisions + 1, instructions: `${definition.instructions}\nKeep the brief concise.` },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.definition.learning, LEARNING, "omitting learning from an edit must keep its declared comparison fields");
  assert.deepEqual((await server.api("GET", path)).body.definition.learning, LEARNING);
});
