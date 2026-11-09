// Shared by the runner-spec tests: one claimed run's AdapterRunSpec, built through runner/adapter-run-spec.ts
// (adapterRunSpecFromLaunch) over a real store, a real claim (runs.claimMany) and a real Harness on the claim's journal,
// as the dispatch builds it for a pi run. A test gives the revision's body, the launch body and the server's stored tool
// settings; it reads back the spec's tools, its system prompt and its gate. A "runner" place needs no computer, so no
// Docker is reached.
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { runFolder } = await import("../dist/workspace/paths.js");

/** A test seal key, no real one: the live-viewer tokens are sealed under it. */
const SEAL_KEY = Buffer.alloc(32, 7);

/** The route the spec reads for an uncapped run: Anthropic Messages at a dead origin, no cost and no ceiling needed. */
const stubRoute = async () => ({ model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" } });

/**
 * Build a run's AdapterRunSpec through the dispatch's spec builder.
 *   body     the pinned revision's body (tools, approvals, instructions, toolSettings, harness)
 *   launch   the launch body (merged over sane defaults: a runner place, a person's first message)
 *   settings the server's tool settings saved in the one store (store.settings), or none
 *   routeOf  the model route (a stub by default)
 */
export async function specFor(t, { body = {}, launch = {}, settings, routeOf = stubRoute } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-spec-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let harness;
  t.after(async () => {
    await harness?.close(ctx).catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", ...body } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  if (settings !== undefined) await server.settings.put("tool-settings", settings);
  await server.flush?.();
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  if (!claim) throw new Error("the run was not claimed");
  // The run's Workspace folder, as the server makes it at start before the runner opens it (openRunWorkspace does not make it).
  const runRow = await store.runs.get("run-1");
  await mkdir(runFolder(dir, runRow.agentId, claim.runId), { recursive: true });
  const registry = createRegistry();
  let models = createModels();
  harness = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const run = { harness, registry, setModels: (given) => (models = given) };
  const deps = { env: {}, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf };
  const launchBody = { input: { content: "Do the thing." }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, ...launch };
  const spec = await adapterRunSpecFromLaunch(launchBody, run, deps, claim);
  return { spec, store, server, claim, dir, run };
}

/** The names of a spec's session tools, in order. */
export const toolNames = (spec) => spec.session.tools.map((tool) => tool.name);
