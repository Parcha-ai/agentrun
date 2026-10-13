// The cloud app's extra can add a model provider (`models`, called with the app's own registry before the root agent is used) and instructions for the root agent (`instructions`).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import app from "../cloud-app.ts";
import { setExtraInstructions } from "../agent.ts";

test("an extra's models hook gets the app's registry once, before the root agent exists, and its instructions reach the root agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "app-extra-hooks-"));
  const saved = { ...process.env };
  try {
    const seen = join(dir, "seen.json");
    const module = join(dir, "extra.mjs");
    writeFileSync(
      module,
      `import { writeFileSync } from "node:fs";
export default () => ({
  models(models) { globalThis.__extraModels = (globalThis.__extraModels ?? []).concat([models]); },
  instructions: "EXTRA-PAGE-INSTRUCTIONS: you can use_model.",
});`,
    );
    Object.assign(process.env, { DEMO_MODEL: "gpt-test", DEMO_MODEL_URL: "http://127.0.0.1:9/v1", DEMO_ROBOT_CODE: "0", DEMO_APP_EXTRA: module });
    delete process.env.DEMO_LINK_PORT;
    setExtraInstructions("");
    const options = await app({ ref: { id: "r" } as never, root: dir, work: join(dir, "work"), store: join(dir, "store") });
    const given = (globalThis as unknown as { __extraModels?: unknown[] }).__extraModels ?? [];
    assert.equal(given.length, 1, "called once");
    assert.equal(given[0], options.models, "with the registry the app uses");
    const root = options.root!.agent as { instructions?: string };
    assert.match(String(root.instructions), /EXTRA-PAGE-INSTRUCTIONS: you can use_model\./, "the extra's instructions are in the root agent");
    void seen;
    void pathToFileURL;
  } finally {
    setExtraInstructions("");
    delete (globalThis as unknown as { __extraModels?: unknown }).__extraModels;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without an extra, nothing about the app changes: no hook, the instructions stay what they were", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { DEMO_MODEL: "gpt-test", DEMO_MODEL_URL: "http://127.0.0.1:9/v1", DEMO_ROBOT_CODE: "0" });
    delete process.env.DEMO_APP_EXTRA;
    delete process.env.DEMO_LINK_PORT;
    setExtraInstructions("KEPT-BY-THE-HOST");
    const options = await app({ ref: { id: "r" } as never, root: "/tmp/none", work: "/tmp/none/work", store: "/tmp/none/store" });
    const root = options.root!.agent as { instructions?: string };
    assert.match(String(root.instructions), /KEPT-BY-THE-HOST/, "an extra-less app leaves the instructions as the host set them");
  } finally {
    setExtraInstructions("");
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
