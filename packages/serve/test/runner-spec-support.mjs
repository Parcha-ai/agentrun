// Shared by the runner-spec tests: one claimed run's AdapterRunSpec, built through runner/adapter-run-spec.ts
// (adapterRunSpecFromLaunch) over a real store, a real claim (runs.claimMany) and a real Harness on the claim's journal,
// as the dispatch builds it for a pi run. A test gives the revision's body, the launch body and the server's stored tool
// settings; it reads back the spec's tools, its system prompt and its gate. A "runner" place needs no computer, so no
// Docker is reached.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { strictOptions } from "./strict-options.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { runFolder } = await import("../dist/workspace/paths.js");
const { Uploads } = await import("../dist/uploads.js");
const { putSealedKey } = await import("../dist/server-keys.js");

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
 *   uploads  [{ path, text, contentType? }] reserved and received as ready files, their ids put on launch.files
 *   env      the runner process's environment the claim's tools are handed (claim-secrets.ts scopes it); {} by default
 *   keys     server keys saved sealed in the one store (store.sealedKeys), as the settings API saves them
 *   ledger   the run's one ledger as the adapter loop hands it (run.ledger), or none: the learned_workflow tool's model
 *            nodes take the session's proxied models from it
 *   before   called with the server's store once the run is made, before the runner claims it (a test arranges the run there),
 *            then the seal key and the run's data dir (where a test lands what the claim reads, e.g. a learning seed)
 */
export async function specFor(t, options = {}) {
  strictOptions("specFor", options, ["body", "skills", "launch", "settings", "routeOf", "uploads", "env", "keys", "ledger", "before"]);
  const { body = {}, skills, launch = {}, settings, routeOf = stubRoute, uploads = [], env = {}, keys = {}, ledger, before } = options;
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
  // `skills`: the revision's skill files (path to text), kept on its row as the store keeps them; the body names each path.
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", ...(skills ? { skills: Object.fromEntries(Object.keys(skills).map((path) => [path, "0".repeat(64)])) } : {}), ...body }, ...(skills ? { skills } : {}) });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  if (settings !== undefined) await server.settings.put("tool-settings", settings);
  for (const [name, value] of Object.entries(keys)) await putSealedKey(server, SEAL_KEY, name, value);
  if (before) await before(server, SEAL_KEY, dir);
  await server.flush?.();
  // Ready uploads the run names: reserved and received into the data directory's files/, their ids onto launch.files.
  const fileIds = [];
  if (uploads.length) {
    const up = new Uploads(join(dir, "files"));
    for (const u of uploads) {
      const received = await up.take(new URLSearchParams({ path: u.path }), u.contentType ?? "text/plain", [Buffer.from(u.text)]);
      fileIds.push((await received.commit()).file.file_id);
    }
  }
  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  if (!claim) throw new Error("the run was not claimed");
  // The run's Workspace folder is the runner's to make at the claim (openRunWorkspace / adapterRunSpecFromLaunch), as the
  // server's start made it before: the test never makes it, so it pins that the runner does.
  const runRow = await store.runs.get("run-1");
  const workFolder = runFolder(dir, runRow.agentId, claim.runId);
  const registry = createRegistry();
  let models = createModels();
  harness = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  // The run's root conversation (ROOT_CONVERSATION_ID), as the adapter loop makes it when the session opens: a host tool's
  // paid mark commits there (paid-calls.ts), so a test that runs a tool needs it, as a claim on the loop has it.
  await harness.commit((tx) => tx.createRootConversation(), ctx);
  const run = { harness, registry, setModels: (given) => (models = given), ...(ledger ? { ledger } : {}) };
  // The one shared claim-time computer (none for a runner place); a test gives its own, as the runner would.
  const computerForClaim = async () => ({ release: async () => {} });
  const deps = { env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf, computerForClaim };
  const launchBody = { input: { content: "Do the thing." }, title: "t", place: { mode: "runner" }, model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, ...(fileIds.length ? { files: fileIds } : {}), ...launch };
  const spec = await adapterRunSpecFromLaunch(launchBody, run, deps, claim);
  return { spec, store, server, claim, dir, run, workFolder };
}

/** The names of a spec's session tools, in order. */
export const toolNames = (spec) => spec.session.tools.map((tool) => tool.name);
