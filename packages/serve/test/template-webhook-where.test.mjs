// A template's webhook trigger filters its deliveries by a parameter, as a github trigger does: a placeholder may go in
// the `in` values of its accept rules' where conditions (the one place in its source), the parameter is required or has
// a default so the filter never fills empty, and apply fills it. A provider that sends every trigger of a project to one
// URL (Composio) then starts a run only for the owner's own repository.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PackageError, readPackage } from "../dist/templates.js";
import { asOwner, scratch, serve, withEnv } from "./support.mjs";
import { firings } from "./trigger-support.mjs";

const { Webhook } = createRequire(import.meta.url)("standardwebhooks");

const MANIFEST = (repo) => `---
name: issues
version: 0.1.0
description: Triages each new issue in one repository.
parameters:
  owner: { type: string, required: true, description: The repository's owner. }
  repo: ${repo}
budget: { per_run_usd: 0.5 }
triggers:
  - name: new-issue
    source:
      kind: webhook
      accept:
        - event: GITHUB_ISSUE_CREATED_TRIGGER
          where:
            - { pointer: /data/repository_owner, in: ["\${parameters.owner}"] }
            - { pointer: /data/repository_name, in: ["\${parameters.repo}"] }
    target: { kind: start_run, input: { content: "Triage the new issue." } }
---
Triage the issue in \${parameters.owner}/\${parameters.repo}.
`;

async function templates(t, repo = "{ type: string, required: true, description: The repository's name. }") {
  const root = join(await scratch(t), "templates");
  mkdirSync(join(root, "issues"), { recursive: true });
  writeFileSync(join(root, "issues", "agent.md"), MANIFEST(repo));
  return root;
}

test("a webhook trigger's where in values may hold a placeholder whose parameter is required or has a default", async (t) => {
  const root = await templates(t);
  assert.equal(readPackage(join(root, "issues")).triggers.length, 1);
  const defaulted = await templates(t, "{ type: string, default: widgets, description: The repository's name. }");
  assert.equal(readPackage(join(defaulted, "issues")).triggers.length, 1);
});

test("an optional parameter with no default in a webhook trigger's where is refused: the filter would fill empty and take nothing", async (t) => {
  const root = await templates(t, "{ type: string, description: The repository's name. }");
  assert.throws(() => readPackage(join(root, "issues")), (error) => error instanceof PackageError && error.problems.some((one) => /parameters\.repo is used in triggers\[0\]\.source\.accept, so it is required or has a default/.test(one)));
});

test("apply fills a webhook trigger's where, and a delivery for another repository takes no run while one for the owner's starts one", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { templates: await templates(t) });
  const applied = await asOwner(server)("POST", "/templates/issues/apply", { parameters: { owner: "acme", repo: "widgets" } }, { "idempotency-key": "issues-1" });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const [id] = applied.body.trigger_ids;
  const stored = (await server.api("GET", `/triggers/${id}`)).body.source;
  assert.deepEqual(stored.accept[0].where, [{ pointer: "/data/repository_owner", in: ["acme"] }, { pointer: "/data/repository_name", in: ["widgets"] }]);
  const secret = applied.body.webhook_secrets.find((one) => one.trigger_id === id).signing_secret;
  const deliver = async (owner, repo) => {
    const body = JSON.stringify({ type: "GITHUB_ISSUE_CREATED_TRIGGER", data: { repository_owner: owner, repository_name: repo, issue_number: 7 } });
    const msg = `msg_${randomBytes(8).toString("hex")}`;
    const at = new Date();
    const res = await fetch(`${server.baseUrl}/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": msg, "webhook-timestamp": String(Math.floor(at.getTime() / 1000)), "webhook-signature": new Webhook(secret).sign(msg, at, body) }, body });
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual(await deliver("acme", "gadgets"), { status: 200, body: { ok: "ignored" } }, "another repository of the same owner");
  assert.deepEqual(await deliver("other", "widgets"), { status: 200, body: { ok: "ignored" } }, "the same name under another owner");
  const taken = await deliver("acme", "widgets");
  assert.equal(taken.status, 202, JSON.stringify(taken.body));
  const fired = await firings(server.api, id, 1);
  assert.equal(fired.length, 1);
  assert.ok(fired[0].run_id, "the owner's own repository starts a run");
});
