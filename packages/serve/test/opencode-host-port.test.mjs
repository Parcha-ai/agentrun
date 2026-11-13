// An opencode session's host port (AdapterSession.port) is the session's own listener: an open that fails leaves none.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { openCodeAdapter } from "../dist/harness-opencode/index.js";

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const FAKE = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
/** The TCP listeners this process holds (a host port is one). */
const servers = () => process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;

test("an opencode open that fails once its host port is up (the session's records cannot be read) leaves no listener behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-opencode-host-"));
  const adapter = openCodeAdapter({ model: "gpt-test", provider: { origin: "https://provider.invalid", credential: () => "provider-secret" }, sessionsDir: join(dir, "sessions"), standIn: { command: process.execPath, args: [FAKE] } });
  const spec = { key: "run:r", label: "r", system: [], tools: [], context: "fresh" };
  const writer = await memorySessionStore().open(spec.key);
  const refusing = { key: writer.key, read: async () => { throw new Error("the store refused the read"); }, append: (records) => writer.append(records) };
  const before = servers();
  await assert.rejects(adapter.open(spec, { writer: refusing, models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: new AbortController().signal, onEvent: () => {} }), /the store refused the read/);
  for (let i = 0; i < 50 && servers() > before; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(servers(), before, "no listener outlives an open that failed");
});
