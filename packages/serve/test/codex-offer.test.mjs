// What this server offers of codex, as GET /v2/capabilities answers it (harnessOffers): available only when the Codex
// installed in the data (harness-install.ts) is the pinned build (@parcha/agentrun-harness-codex's verifyCodex: the
// platform package's version, the binary's sha256 and the version it reports) and a model key or gateway is set. A binary
// that is not the pinned build is unavailable as that, with the line that installs it, even with a key. No network:
// nothing here reaches a provider.
//
// Without the pinned binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) it fails.
import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "node:process";
import { test } from "node:test";
import { findCodex } from "../../run-adapters-codex/dist/binary.js";
import { verifyCodexBinary } from "../../run-adapters-codex/dist/verify.js";
import { harnessOffers } from "../dist/harness.js";
import { HARNESS_INSTALLS, installLine } from "../dist/harness-install.js";
import { linkHarnesses, scratch } from "./support.mjs";

const pinned = verifyCodexBinary(findCodex());
const skip = pinned instanceof Error && env.AGENTRUN_CODEX_REQUIRE_BINARY !== "1" ? pinned.message : false;
const codexOf = async (given) => (await harnessOffers(given)).find((h) => h.id === "codex");

test("codex is offered on the pinned build: available with a model key, unavailable for the key it names without one", { skip }, async (t) => {
  const data = await scratch(t);
  await linkHarnesses(data);
  assert.deepEqual(await codexOf({ AGENTRUN_SERVE_DATA: data, OPENAI_API_KEY: "fake-test-key" }), { id: "codex", available: true, steer: false, keys: ["OPENAI_API_KEY", "OPENROUTER_API_KEY"], default_model: "openai/gpt-6.1-sol", run_memory_mib: 192 }, "on the key's default model (model.ts MODEL_KEYS)");
  const keyless = await codexOf({ AGENTRUN_SERVE_DATA: data });
  assert.equal(keyless.available, false);
  assert.match(keyless.reason, /^codex needs OPENAI_API_KEY, OPENROUTER_API_KEY \(OpenAI's models through OpenRouter\), or a gateway in AGENT_MODEL_BASE_URL\.$/);
});

// A script in the platform package's place stands in for an installed Codex that is not the pinned build.
test("a Codex that is not the pinned build is unavailable as that, with the install line, even with a model key", { skip }, async (t) => {
  const dir = await scratch(t);
  const bin = join(dir, "codex");
  await writeFile(bin, "#!/bin/sh\necho codex-cli 0.164.0\n");
  await chmod(bin, 0o755);
  const data = join(dir, "data");
  await linkHarnesses(data, { codexBin: bin });
  const offer = await codexOf({ AGENTRUN_SERVE_DATA: data, OPENAI_API_KEY: "fake-test-key" });
  assert.equal(offer.available, false, JSON.stringify(offer));
  assert.match(offer.reason, /is not the pinned build: its binary sha256 is [0-9a-f]{64}, not [0-9a-f]{64}/);
  // The offers are the start's, so the reason ends saying to restart AgentRun once the pinned build is installed.
  const line = installLine(join(data, "harnesses", "codex"), HARNESS_INSTALLS.codex.lock);
  assert.ok(offer.reason.endsWith(`. Install @openai/codex@0.164.0 again with: ${line}; once the pinned build is installed, restart AgentRun.`), offer.reason);
});
