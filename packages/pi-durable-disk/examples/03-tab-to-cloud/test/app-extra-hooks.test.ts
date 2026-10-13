// The cloud app's extra can add a model provider (`models`, called with the app's own registry before the root agent is used) and instructions for the root agent (`instructions`).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import app from "../cloud-app.ts";
import { replaceInstructions, setExtraInstructions } from "../agent.ts";
import type { AppOptions } from "@parcha/pi-durable-disk";

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
  instructions: { mode: "replace", text: "EXTRA-PAGE-INSTRUCTIONS: you can use_model." },
});`,
    );
    Object.assign(process.env, { DEMO_MODEL: "gpt-test", DEMO_MODEL_URL: "http://127.0.0.1:9/v1", DEMO_ROBOT_CODE: "0", DEMO_APP_EXTRA: module });
    delete process.env.DEMO_LINK_PORT;
    setExtraInstructions("");
    replaceInstructions(undefined);
    const options = await app({ ref: { id: "r" } as never, root: dir, work: join(dir, "work"), store: join(dir, "store") });
    const given = (globalThis as unknown as { __extraModels?: unknown[] }).__extraModels ?? [];
    assert.equal(given.length, 1, "called once");
    assert.equal(given[0], options.models, "with the registry the app uses");
    const root = options.root!.agent as { instructions?: string };
    assert.equal(root.instructions, "EXTRA-PAGE-INSTRUCTIONS: you can use_model.", "the root agent gets exactly the extra's text: nothing of the robot page's base instructions");
    void seen;
    void pathToFileURL;
  } finally {
    setExtraInstructions("");
    replaceInstructions(undefined);
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
    assert.match(String(root.instructions), /creature|walk|teach/i, "and they are still the robot page's base ones");
  } finally {
    setExtraInstructions("");
    replaceInstructions(undefined);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

/** Run the app with an extra whose module body is `extraBody` (an object literal), the way a box does: env names the module. Returns the app's options and what the host logged to stderr. */
async function appWith(extraBody: string): Promise<{ options: AppOptions; logs: Record<string, unknown>[] }> {
  const dir = mkdtempSync(join(tmpdir(), "app-extra-decl-"));
  const saved = { ...process.env };
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  try {
    const module = join(dir, "extra.mjs");
    writeFileSync(module, `export default () => (${extraBody});`);
    Object.assign(process.env, { DEMO_MODEL: "gpt-test", DEMO_MODEL_URL: "http://127.0.0.1:9/v1", DEMO_ROBOT_CODE: "0", DEMO_APP_EXTRA: module });
    delete process.env.DEMO_LINK_PORT;
    setExtraInstructions("HOST-EXTRA");
    replaceInstructions(undefined);
    process.stderr.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    const options = await app({ ref: { id: "r" } as never, root: dir, work: join(dir, "work"), store: join(dir, "store") });
    process.stderr.write = realWrite;
    return { options, logs: written.flatMap((l) => l.split("\n")).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>) };
  } finally {
    process.stderr.write = realWrite;
    setExtraInstructions("");
    replaceInstructions(undefined);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
}
const toolNames = (options: AppOptions) => options.registry!.snapshot().tools().map((t) => t.tool.name);

test("instructions in mode append follow the base, the model line and the host's extra; replace keeps none of them", async () => {
  const appended = String(((await appWith(`{ instructions: { mode: "append", text: "APPENDED-LINE" } }`)).options.root!.agent as { instructions?: string }).instructions);
  assert.match(appended, /creature|walk|teach/i, "the base is kept");
  assert.match(appended, /gpt-test/, "and the model line");
  assert.ok(appended.includes("HOST-EXTRA"), "the host's extra is kept");
  assert.ok(appended.indexOf("HOST-EXTRA") < appended.indexOf("APPENDED-LINE"), "the host's extra comes before the extra's text");
  assert.ok(appended.endsWith("APPENDED-LINE"));
  const replaced = String(((await appWith(`{ instructions: { mode: "replace", text: "ONLY-THIS" } }`)).options.root!.agent as { instructions?: string }).instructions);
  assert.equal(replaced, "ONLY-THIS");
});

test("instructions without a valid mode are refused: there is no default to fall back on", async () => {
  await assert.rejects(appWith(`{ instructions: { text: "x" } }`), /mode undefined is not "replace" or "append"/);
  await assert.rejects(appWith(`{ instructions: { mode: "prepend", text: "x" } }`), /mode "prepend"/);
  await assert.rejects(appWith(`{ instructions: "a bare string" }`), /must be \{ mode, text \}/);
});

test("withoutExtensions removes the named extensions and their tools from the agent's registry, and the host logs which", async () => {
  const baseline = toolNames((await appWith(`{}`)).options);
  assert.ok(baseline.includes("set_color") && baseline.includes("switch_environment"), "the shared tools are there without it");
  const { options, logs } = await appWith(`{ withoutExtensions: ["robot-tools", "switch-environment"] }`);
  const names = toolNames(options);
  for (const gone of ["set_color", "set_shape", "switch_environment"]) assert.ok(!names.includes(gone), `${gone} is not in the tool list`);
  assert.ok(!options.registry!.snapshot().installed().some((e) => e.name === "robot-tools" || e.name === "switch-environment"));
  assert.ok(names.includes("bash"), "the others stay");
  const log = logs.find((l) => l.event === "app-extra.without-extensions");
  assert.deepEqual(log?.extensions, ["robot-tools", "switch-environment"]);
  assert.ok((log?.tools as string[]).includes("set_color"), "the log names the tools that went");
});

test("withoutExtensions naming an extension that is not installed is an error that lists what is", async () => {
  await assert.rejects(appWith(`{ withoutExtensions: ["robot-tool"] }`), /robot-tool is not installed \(installed: .*robot-tools/);
  await assert.rejects(appWith(`{ withoutExtensions: "robot-tools" }`), /array of extension names/);
});
