// A run's process registers no host shell: the coding tools serve installs are pi's without `bash`, and no tool the
// table binds brings it back. (confine.test.mjs drives a model that calls bash anyway: it is not available, and no
// command runs.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchilCodingTools } from "@parcha/pi-durable-disk";
import { CodingTools } from "../dist/coding-tools.js";
import { BOUND_TOOLS, missingEnv, TOOLS } from "../dist/tools.js";

const names = (extension) => (extension.tools ?? []).map((tool) => tool.name);

test("the coding tools serve installs have no bash; read, write and edit are pi's own, and the rest of pi's extension is kept", () => {
  assert.ok(names(ArchilCodingTools).includes("bash"), "pi's coding tools carry bash, which serve leaves out");
  assert.ok(!names(CodingTools).includes("bash"));
  for (const name of ["read", "write", "edit"]) assert.ok(names(CodingTools).includes(name), name);
  const pis = ArchilCodingTools.tools.filter((tool) => tool.name !== "bash");
  assert.equal(CodingTools.tools.length, pis.length);
  CodingTools.tools.forEach((tool, index) => assert.equal(tool, pis[index], `${tool.name} is pi's tool, not a copy`));
  const { tools: _ours, ...ours } = CodingTools;
  const { tools: _theirs, ...theirs } = ArchilCodingTools;
  assert.deepEqual(ours, theirs, "everything but the tools is pi's extension's, its name included");
});

test("no tool the table binds registers bash: what each installs and each selects, the file tools' extension being serve's", async () => {
  const installed = [];
  const host = { where: { work: "/nonexistent", ref: { id: "run" } }, env: {}, install: (extension) => void installed.push(extension), onConversation() {}, beforeResume() {}, beforeRelease() {} };
  const bound = BOUND_TOOLS.filter((name) => missingEnv(TOOLS[name], {}).length === 0);
  assert.deepEqual(bound, ["read", "write", "edit", "ask_person", "fetch_page"]);
  for (const name of bound) {
    const binding = await TOOLS[name].bind(host);
    assert.deepEqual(binding.tools.map((tool) => tool.name), [name]);
    if (["read", "write", "edit"].includes(name)) assert.deepEqual(binding.extensions, [CodingTools], name);
    for (const extension of [...installed, ...binding.extensions]) assert.ok(!names(extension).includes("bash"), `${name}: ${extension.name}`);
  }
});
