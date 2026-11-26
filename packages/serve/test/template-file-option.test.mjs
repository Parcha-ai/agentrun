// A package's per-tool `file` option (manifest `mcp[].file: {<tool>: {folder, show}}`): read beside `pin`, each tool one of
// its entry's, a folder of 1 to 3 plain segments and at most 8 show paths of at most 6 segments, else refused in words.
// Apply writes it as the agent's own tool setting on the tool's key, `{file: {folder, show}}`, which the agent's tool
// settings take on an MCP tool's own key alone; the owner may change it or take it out (the tool then answers the model
// as before). The template list shows it, and an export of the agent carries it back into its package.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { compiled, memoryFiles, PackageError, packageView, readPackage } from "../dist/templates.js";
import { canonicalToolSettings, settingsIssues } from "../dist/tool-plane.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { scratch, serve, whenFree } from "./support.mjs";

const FILE = { folder: "stripe", show: ["successful", "data.has_more", "data.data.-1.id"] };

/** A package of the fake MCP server's add and delete_thing (from `source`), its mcp entry ending in `entry` (YAML); its
 *  folder. It names its tools (none: the ticked MCP tools are its own), so its apply keeps the runner where this server
 *  has no Docker box, never refused for want of a place. */
function packageWith(dir, name, entry, source = "url") {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "agent.md"), `---\nname: ${name}\nversion: 1.0.0\ndescription: Uses the fake MCP server.\ntools: []\nharness: [pi]\nmcp:\n  - source: ${source}\n    toolkit: fake\n    tools: [add, delete_thing]\n    required: true\n    allow: [add]\n${entry}\napprovals: never\n---\nCall the tool you are asked to call.\n`);
  return join(dir, name);
}

/** The problems readPackage finds in the package, none when it reads. */
async function read(t, entry) {
  const dir = join(await scratch(t), "templates");
  try {
    return { p: readPackage(packageWith(dir, "filer", entry)), problems: [] };
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return { problems: error.problems };
  }
}

test("a package's file option is read beside its pin, and apply writes it as the agent's own setting on the tool's key", async (t) => {
  const { p, problems } = await read(t, `    pin: { delete_thing: { id: x1 } }\n    file: { add: { folder: stripe, show: [successful, data.has_more, data.data.-1.id] } }`);
  assert.deepEqual(problems, []);
  assert.deepEqual(p.mcp[0].file, { add: FILE });
  const served = p.mcp.map((need) => ({ ...need, server: "fake-saved" }));
  const made = compiled(p, {}, { mcp: served, defaultTools: [], grants: ["mcp:fake-saved/add"] });
  assert.deepEqual(made.agent.definition.tool_settings, { "mcp:fake-saved/add": { file: FILE }, "mcp:fake-saved/delete_thing": { pin: { id: "x1" } } });
  // The template list says it, by tool; a tool without one says nothing of it.
  assert.deepEqual(packageView(p).mcp[0].tools.map((tool) => [tool.name, tool.file]), [["add", FILE], ["delete_thing", undefined]]);
  // A package without it reads as before: no file on its need.
  const { p: plain } = await read(t, "    pin: { delete_thing: { id: x1 } }");
  assert.equal(plain.mcp[0].file, undefined);
});

test("a package's file option is refused in words: a tool not of its entry, a folder that leaves or hides, a show path too long, too many or not a path", async (t) => {
  const refused = async (file, pattern) => {
    const { problems } = await read(t, `    file: ${file}`);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${file} ${pattern}: ${JSON.stringify(problems)}`);
  };
  await refused("{ remove_thing: { folder: out, show: [] } }", /mcp\[0\]\.file\.remove_thing: remove_thing is not one of this entry's tools/);
  for (const folder of ["..", "../out", "/out", ".hidden", "a/.b", "a/b/c/d", "", "a//b", "a/b/", "a\\b", "a b"]) await refused(`{ add: { folder: ${JSON.stringify(folder)}, show: [] } }`, /mcp\[0\]\.file\.add\.folder is a folder in the run's files: 1 to 3 segments/);
  await refused(`{ add: { folder: out, show: [${Array.from({ length: 9 }, (_, i) => `k${i}`).join(", ")}] } }`, /mcp\[0\]\.file\.add\.show is a list of at most 8 paths/);
  for (const path of ["a.b.c.d.e.f.g", "a..b", "a.-2", ".a", "a.", "a b", "01", ""]) await refused(`{ add: { folder: out, show: [${JSON.stringify(path)}] } }`, /mcp\[0\]\.file\.add\.show\[0\] .* is a path of 1 to 6 segments/);
  await refused("{ add: { folder: out, show: [a, a] } }", /mcp\[0\]\.file\.add\.show names a twice/);
  await refused("{ add: { folder: out } }", /mcp\[0\]\.file\.add is \{folder, show\}/);
  await refused("{ add: { folder: out, show: [], reveal: [a] } }", /mcp\[0\]\.file\.add is \{folder, show\}/);
  await refused("[add]", /mcp\[0\]\.file is \{<tool>: \{folder, show\}\}/);
});

test("an agent's own tool settings take a file option on an MCP tool's own key alone, kept as given; the server's settings never", () => {
  assert.deepEqual(settingsIssues({ "mcp:stripe/STRIPE_LIST_BALANCE_TRANSACTIONS": { permission: "allow", file: FILE } }, "tool_settings", "agent"), []);
  assert.deepEqual(canonicalToolSettings({ "mcp:stripe/LIST": { file: FILE, permission: "allow" } }), { "mcp:stripe/LIST": { file: FILE, permission: "allow" } }, "kept, the show paths in their order");
  const reasons = (value, layer = "agent") => settingsIssues(value, "tool_settings", layer).map((issue) => [issue.field, issue.reason]);
  assert.deepEqual(reasons({ "mcp:stripe/*": { file: FILE } }), [["tool_settings.mcp:stripe/*.file", "not_allowed"]], "never a server's wildcard");
  assert.deepEqual(reasons({ bash: { file: FILE } }), [["tool_settings.bash.file", "not_allowed"]], "never a tool that is not an MCP tool");
  assert.deepEqual(reasons({ "mcp:stripe/LIST": { file: FILE } }, "server"), [["tool_settings.mcp:stripe/LIST.file", "not_allowed"]], "never the server's own settings");
  assert.deepEqual(reasons({ "mcp:stripe/LIST": { file: { folder: "../up", show: [] } } }), [["tool_settings.mcp:stripe/LIST.file.folder", "not_an_option"]]);
  assert.deepEqual(reasons({ "mcp:stripe/LIST": { file: { folder: "out", show: ["a..b"] } } }), [["tool_settings.mcp:stripe/LIST.file.show[0]", "not_an_option"]]);
});

test("through the API: apply writes the file setting on the agent; the owner may take it out; the export carries it back into the package", { timeout: 120_000 }, async (t) => {
  const dir = join(await scratch(t), "templates");
  // From Composio, so its export travels (a url server on this machine's loopback is blocked from an export).
  packageWith(dir, "filer", "    file: { add: { folder: stripe, show: [successful, data.has_more, data.data.-1.id] } }", "composio");
  const server = await serve(t, { templates: dir, mcpStandIns: true });
  const { api } = server;
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" }, source: "composio", toolkit: "fake" })).status, 200);
  const listed = (await api("GET", "/templates")).body;
  const view = (listed.templates ?? listed.data ?? listed).find((one) => one.name === "filer");
  assert.deepEqual(view.mcp[0].tools.find((tool) => tool.name === "add").file, FILE, "the list shows it");
  const applied = await whenFree(() => api("POST", "/templates/filer/apply", { grants: ["mcp:fake/add"] }));
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const id = applied.body.agent_id;
  const agent = (await api("GET", `/agents/${id}`)).body;
  assert.deepEqual(agent.definition.tool_settings, { "mcp:fake/add": { file: FILE } });

  const exported = await api("GET", `/agents/${id}/package`);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const bytesOf = (file) => Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
  const manifest = parseYaml(bytesOf(exported.body.files.find((file) => file.path === "agent.md")).toString("utf8").split("---\n")[1]);
  assert.deepEqual(exported.body.report.blocked, [], JSON.stringify(exported.body.report));
  assert.deepEqual(manifest.mcp?.[0]?.file, { add: FILE }, "the export carries it");
  assert.deepEqual(readPackage(memoryFiles(exported.body.name, "the export", new Map(exported.body.files.map((file) => [file.path, bytesOf(file)])))).mcp[0].file, { add: FILE });

  // The owner takes it out: the agent's tool answers the model as before.
  const { tool_settings: _gone, version: _version, ...rest } = agent.definition;
  const edited = await api("PUT", `/agents/${id}/definition`, { definition: rest });
  assert.ok(edited.status === 200 || edited.status === 201, JSON.stringify(edited.body));
  assert.equal((await api("GET", `/agents/${id}`)).body.definition.tool_settings, undefined);
});
