// A package's trigger may be on or off by a parameter: `enabled: "${parameters.<name>}"`, one placeholder alone naming a
// boolean parameter with a default. Apply fills it and makes the trigger enabled or disabled; the owner can switch it
// later as any trigger. An inbox assistant's Monday brief, a second schedule the owner opts into with `weekly`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PackageError, readPackage } from "../dist/templates.js";
import { scratch, serve } from "./support.mjs";

/** The inbox package, its `weekly` parameter `weekly`, its monday-brief's enabled `enabled`. */
const manifest = ({ weekly = "{ type: boolean, required: false, default: false, description: Also write a brief each Monday morning. }", enabled = '"${parameters.weekly}"' } = {}) => `---
name: inbox
version: 1.0.0
description: Sorts an inbox and writes a digest.
tools: []
parameters:
  weekly: ${weekly}
  timezone: { type: string, format: timezone, required: false, default: UTC }
budget: { per_run_usd: 0.5 }
triggers:
  - name: evening-digest
    source: { kind: schedule, cron: "0 18 * * *", timezone: "\${parameters.timezone}" }
    target: { kind: start_run, input: { content: "Scheduled run: write today's digest." } }
  - name: monday-brief
    enabled: ${enabled}
    source: { kind: schedule, cron: "0 8 * * 1", timezone: "\${parameters.timezone}" }
    target: { kind: start_run, input: { content: "Scheduled run: write the week's brief." } }
---
Sort the inbox.
`;

async function packageDir(t, text) {
  const root = join(await scratch(t), "templates");
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "agent.md"), text);
  return root;
}

async function problemsOf(t, text) {
  try {
    readPackage(join(await packageDir(t, text), "inbox"));
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return error.problems;
  }
  return [];
}

test("a trigger's enabled may be one placeholder alone naming a boolean parameter with a default; anything else there is refused in words", async (t) => {
  assert.deepEqual(await problemsOf(t, manifest()), [], "a boolean parameter with a default");
  assert.deepEqual(await problemsOf(t, manifest({ enabled: "false" })), [], "true or false as written, as before");
  const rule = 'agent.md: triggers[1].enabled is true, false, or one placeholder alone, "${parameters.<name>}", naming a boolean parameter with a default';
  assert.deepEqual(await problemsOf(t, manifest({ weekly: "{ type: string, required: false, default: \"no\", description: Weekly. }" })), [`${rule}: parameters.weekly is a string`]);
  assert.deepEqual(await problemsOf(t, manifest({ weekly: "{ type: boolean, description: Weekly. }" })), [`${rule}: parameters.weekly has no default, and the trigger is on or off even when the apply leaves it out`]);
  assert.deepEqual(await problemsOf(t, manifest({ weekly: "{ type: boolean, required: false, description: Weekly. }" })), [`${rule}: parameters.weekly has no default, and the trigger is on or off even when the apply leaves it out`]);
  assert.deepEqual(await problemsOf(t, manifest({ enabled: '"weekly: ${parameters.weekly}"' })), [rule]);
  assert.deepEqual(await problemsOf(t, manifest({ enabled: '"yes"' })), [rule]);
});

test("apply makes a trigger whose enabled is a parameter on or off by its value: weekly false (or left out) off, weekly true on; the owner can switch it later", async (t) => {
  const { api } = await serve(t, { templates: await packageDir(t, manifest()) });
  const made = async (parameters) => {
    const applied = await api("POST", "/templates/inbox/apply", { parameters });
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const triggers = await Promise.all(applied.body.triggers.map(async ({ trigger_id: id }) => (await api("GET", `/triggers/${id}`)).body));
    return Object.fromEntries(triggers.map((one) => [one.name, one]));
  };
  const off = await made({ weekly: false });
  assert.deepEqual([off["evening-digest"].enabled, off["monday-brief"].enabled], [true, false], "weekly false: the brief is off, the digest on");
  assert.equal(off["monday-brief"].next_at ?? null, null, "an off schedule has no next time");
  const on = await made({ weekly: true });
  assert.deepEqual([on["evening-digest"].enabled, on["monday-brief"].enabled], [true, true], "weekly true: both on");
  const left = await made({});
  assert.equal(left["monday-brief"].enabled, false, "left out: its default, false");

  const switched = await api("PATCH", `/triggers/${off["monday-brief"].id}`, { enabled: true });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal((await api("GET", `/triggers/${off["monday-brief"].id}`)).body.enabled, true, "the owner switches it on as any trigger");
});
