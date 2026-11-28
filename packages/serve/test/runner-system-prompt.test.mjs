// A pi run's system prompt through the dispatch: the environment line first (environment.ts environmentLine), then the revision's instructions with its skills and what the agent
// learned folded in (skills.ts promptOf over learning.ts withLearned), then the effort guidance (effort-guidance.ts), each
// non-empty part in that order. The runner builds it from the launch and the revision, never from this process's
// environment: the effort is the launch's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { specFor } from "./runner-spec-support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const { environmentLine } = await import("../dist/environment.js");
const { effortGuidance } = await import("../dist/effort-guidance.js");

test("the system prompt is the environment line, the revision's instructions, then the effort guidance (the launch's)", async (t) => {
  const { spec } = await specFor(t, { body: { instructions: "Follow the plan.", tools: ["web_search"] }, launch: { effort: "high" } });
  assert.deepEqual(spec.session.system, [environmentLine(), "Follow the plan.", effortGuidance("high")]);
});

test("a run on a computer is told its folder by its absolute name, since the computer's home is not the folder; a local run is not", async (t) => {
  // A sandbox that binds the run's folder of this machine (Mode 1), as a claim's computer does: the folder is /workspace in it.
  const sandbox = () => ({ computerForClaim: async (_launch, _store, deps) => {
    const mount = await deps.workspace.mountSpec();
    return { computer: { kind: "sandbox", computer: fakeComputer(mount.path), check: { readBackOf } }, release: async () => {} };
  } });
  const { spec } = await specFor(t, { body: { instructions: "Do it.", tools: ["bash"], computer: { kind: "sandbox", provider: "docker" } }, computer: sandbox });
  assert.equal(spec.session.system[0], environmentLine(undefined, undefined, "/workspace"));
  assert.match(spec.session.system[0], /your working directory, \/workspace, .*save what the run keeps there, not in your home directory\./);
  const local = await specFor(t, { body: { instructions: "Do it.", tools: ["bash"] } });
  assert.equal(local.spec.session.system[0], environmentLine(), "a local folder is the shell's home: no path named");
});

test("with no effort the system prompt is the environment line and the instructions alone", async (t) => {
  const { spec } = await specFor(t, { body: { instructions: "Do it." } });
  assert.deepEqual(spec.session.system, [environmentLine(), "Do it."]);
});

test("the revision's own skills are laid in the run's .agents/skills/ at the claim and named in the prompt from there", async (t) => {
  const skills = { "cite/SKILL.md": "---\nname: cite\ndescription: Cite every claim to its source.\n---\nCite.\n", "cite/ref.md": "Primary first.\n" };
  // With read granted, a skill is a line naming its SKILL.md, read from the run's folder: no folder, no prompt.
  const { spec } = await specFor(t, { body: { instructions: "Follow the plan.", tools: ["read"] }, skills });
  const prompt = spec.session.system.join("\n");
  assert.match(prompt, /- cite: Cite every claim to its source\. \(\.agents\/skills\/cite\/SKILL\.md\)/);
});

