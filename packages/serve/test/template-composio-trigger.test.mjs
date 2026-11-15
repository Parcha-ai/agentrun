// A template's composio trigger: what makes it on Composio (its instance, the project's route here, a move of the project's
// subscription) is this server's to set, at the create the console sends. A package carrying any of them is refused when
// it is read, in words saying to make the trigger from the console on this server, before an apply could make a trigger
// that runs on someone else's instance or moves the project's subscription unasked.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PackageError, readPackage } from "../dist/templates.js";
import { scratch } from "./support.mjs";

const MANIFEST = (extra) => `---
name: issues
version: 0.1.0
description: Triages each new issue in one repository.
budget: { per_run_usd: 0.5 }
triggers:
  - name: new-issue
    source:
      kind: composio
      server: gh
      event: GITHUB_ISSUE_ADDED_EVENT
      config: { owner: many-drop, repo: agentrun-scratch }
${extra.map((line) => `      ${line}`).join("\n")}
    target: { kind: start_run, input: { content: "Triage the new issue." } }
---
Triage the issue.
`;

async function packageWith(t, extra) {
  const root = join(await scratch(t), "templates", "issues");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "agent.md"), MANIFEST(extra));
  return root;
}

for (const [what, extra] of [
  ["an instance and a route made on another server", ["instance_id: ti_someone_else", "hook: cph_0123456789abcdef01234567"]],
  ["a move of the project's subscription", ["move_subscription: true"]],
]) {
  test(`a template's composio trigger carrying ${what} is refused: the trigger is made from the console on this server`, async (t) => {
    const root = await packageWith(t, extra);
    assert.throws(() => readPackage(root), (error) => {
      assert.ok(error instanceof PackageError, String(error));
      assert.ok(error.problems.some((one) => /^agent\.md: triggers\[0\]\.source/.test(one) && /make (it|the trigger) from the console on this server/i.test(one)), JSON.stringify(error.problems));
      return true;
    });
  });
}
