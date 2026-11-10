// The browser on a Mode 2 run files what it reads where the run's own read finds it: the run's Workspace, its folder on
// the run's Archil disk (tools.ts: evidenceIn over host.workspace; browser_downloads filed there by downloadsInto;
// browser_upload's files read through it), never this machine's local folder at the same path. A pi run through the
// runner, its dispatch and the spec builder, on the faux browser (with a downloaded file) and a scripted model origin,
// over the Archil fake; nothing leaves this machine.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { runFolder, runKey } = await import("../dist/workspace/paths.js");
const { saveArchilSettings } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 9);
const RUN = "run-1";
const AGENT = "agent-1";
const KEY = runKey(AGENT, RUN);
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
/** Test keys, no real ones. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const LAUNCH = { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, plane: { browser: "browserbase" } };
/** The file every faux session has downloaded. */
const REPORT = "the quarterly report, downloaded";
const until = async (done, what, ms = 60_000) => {
  for (const end = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 25))) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
  }
};
/** The text of each tool result the model was sent back, in order. */
const toolResults = (requests) => {
  const last = requests.at(-1)?.messages ?? [];
  return last.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result").map((block) => (typeof block.content === "string" ? block.content : (block.content ?? []).map((part) => part.text ?? "").join("")));
};

test("a Mode 2 run's browser files its evidence and its downloads on the run's disk, under the run's key, where the run's read opens them; no evidence in this machine's local folder", { timeout: 120_000 }, async (t) => {
  const saved = process.env.FAUX_BROWSER_DOWNLOADS;
  process.env.FAUX_BROWSER_DOWNLOADS = JSON.stringify({ "report.txt": REPORT });
  t.after(() => (saved === undefined ? delete process.env.FAUX_BROWSER_DOWNLOADS : (process.env.FAUX_BROWSER_DOWNLOADS = saved)));
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-browser-mode2-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(BROWSERBASE)) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Browse.", tools: ["read", "browser"] } });
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: LAUNCH });
  // Mode 2: the server's Archil settings and its account key, sealed under the runner's seal key, as the server saves them.
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await server.flush?.();
  const disk = new FakeArchilDisk();
  const control = archilControlFetch();

  // The browser reads the page (filed as evidence), copies the session's downloads, and the run's own read opens each.
  const script = [
    { call: "browser_read" },
    { call: "browser_downloads" },
    { call: "read", args: { path: "evidence/0001-browser_read.md" } },
    { call: "read", args: { path: "downloads/report.txt" } },
    { say: "done" },
  ];
  const requests = [];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests) };
  const deps = {
    env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route,
    computerForClaim: async () => ({ release: async () => {} }), makeArchilDisk: () => disk, mountControl: { baseUrl: control.baseUrl, fetch: control.fetch },
  };
  const runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  t.after(closeOpenSessions);
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run is released");
  assert.equal(row.state, "ended", JSON.stringify(row));

  // On the run's disk, under its key: the read's evidence, the downloaded file and its manifest.
  const onDisk = [...disk.files.keys()].filter((key) => key.startsWith(`${KEY}/`)).map((key) => key.slice(KEY.length + 1)).sort();
  assert.ok(onDisk.includes("evidence/0001-browser_read.md"), `the read's evidence is on the run's disk: ${onDisk.join(", ")}`);
  assert.match(Buffer.from(disk.files.get(`${KEY}/evidence/0001-browser_read.md`)).toString("utf8"), /forty-two/, "the page as it was read");
  assert.equal(Buffer.from(disk.files.get(`${KEY}/downloads/report.txt`) ?? "").toString("utf8"), REPORT, "the downloaded file, whole, on the run's disk");
  assert.match(Buffer.from(disk.files.get(`${KEY}/downloads/manifest.json`) ?? "").toString("utf8"), /"path": "downloads\/report\.txt"/, "with the manifest that lists it");
  // None of it in this machine's folder at the run's path, where the run's read never looks.
  const local = runFolder(dir, AGENT, RUN);
  assert.equal(existsSync(join(local, "evidence")), false, "no evidence/ in the run's local folder");

  // The run's own read opened both: the model was sent their text.
  const results = toolResults(requests);
  assert.ok(results.some((text) => /forty-two/.test(text) && !/no file|not found|ENOENT/i.test(text)), `the run's read opened the evidence: ${JSON.stringify(results.slice(-2)).slice(0, 600)}`);
  assert.ok(results.some((text) => text.includes(REPORT)), `the run's read opened the download: ${JSON.stringify(results.slice(-2)).slice(0, 600)}`);
});
