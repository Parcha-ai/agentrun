// An apply's answer names every trigger it made or kept, of every kind, in the package's order: its id, its name, its
// source's kind and whether it is on. An inbox assistant's package makes an email trigger beside two schedules (one off
// by default), and the answer lists all three, as an Update of the agent does.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { scratch, serve, withEnv } from "./support.mjs";
import { mailbox, saved } from "./email-support.mjs";

const MANIFEST = `---
name: inbox
version: 1.0.0
description: Sorts an inbox and writes a digest.
budget: { per_run_usd: 0.5 }
triggers:
  - name: new-mail
    source: { kind: email, every_s: 60 }
    target: { kind: start_run, input: { content: "Sort the new mail." } }
  - name: evening-digest
    source: { kind: schedule, cron: "0 18 * * *", timezone: UTC }
    target: { kind: start_run, input: { content: "Scheduled run: write today's digest." } }
  - name: monday-brief
    enabled: false
    source: { kind: schedule, cron: "0 8 * * 1", timezone: UTC }
    target: { kind: start_run, input: { content: "Scheduled run: write the week's brief." } }
---
Sort the inbox.
`;

test("apply and update answer every trigger they made or kept, by name, kind and on or off: the email trigger beside the schedules", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const root = join(await scratch(t), "templates");
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "agent.md"), MANIFEST);
  const { api } = await serve(t, { templates: root, runner: false });
  await saved(api, await mailbox(t));
  const doc = (await api("GET", "/openapi.json")).body;
  const meets = (code, value) => assert.deepEqual(schemaProblems(doc, doc.paths["/templates/{template}/apply"].post.responses[code].content["application/json"].schema, value), [], `${code}: ${JSON.stringify(value)}`);

  const applied = await api("POST", "/templates/inbox/apply", { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  meets("201", applied.body);
  const wanted = [["new-mail", "email", true], ["evening-digest", "schedule", true], ["monday-brief", "schedule", false]];
  assert.deepEqual(applied.body.triggers.map((one) => [one.name, one.kind, one.enabled]), wanted);
  assert.deepEqual(applied.body.triggers.map((one) => one.trigger_id), applied.body.trigger_ids, "the same triggers, in the same order");
  for (const one of applied.body.triggers) {
    const read = (await api("GET", `/triggers/${one.trigger_id}`)).body;
    assert.deepEqual([read.name, read.source.kind, read.enabled], [one.name, one.kind, one.enabled], one.name);
  }

  // The owner turns the brief on; an Update keeps each trigger in place, and says so, on as the owner left it.
  assert.equal((await api("PATCH", `/triggers/${applied.body.trigger_ids[2]}`, { enabled: true })).status, 200);
  const updated = await api("POST", "/templates/inbox/apply", { parameters: {}, agent_id: applied.body.agent_id });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  meets("200", updated.body);
  assert.deepEqual(updated.body.triggers, applied.body.triggers.map((one, i) => (i === 2 ? { ...one, enabled: true } : one)));
});
