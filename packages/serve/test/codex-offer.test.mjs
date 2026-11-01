// What this server offers of codex, as GET /v2/capabilities answers it (harnessOffers): available only when the
// installed Codex is the pinned build (@parcha/agentrun-codex's verifyCodex: the platform package's version, the
// binary's sha256 and the version it reports) and a model key or gateway is set. A binary that is not the pinned build
// is unavailable as that, with the install line, even with a key. No network: nothing here reaches a provider.
//
// Without the pinned binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) it fails.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { test } from "node:test";
import { findCodex } from "../../run-adapters-codex/dist/binary.js";
import { verifyCodexBinary } from "../../run-adapters-codex/dist/verify.js";
import { harnessOffers } from "../dist/harness.js";

const pinned = verifyCodexBinary(findCodex());
const skip = pinned instanceof Error && env.AGENTRUN_CODEX_REQUIRE_BINARY !== "1" ? pinned.message : false;
const codexOf = async (given) => (await harnessOffers(given)).find((h) => h.id === "codex");

test("codex is offered on the pinned build: available with a model key, unavailable for the key it names without one", { skip }, async () => {
  assert.deepEqual(await codexOf({ OPENAI_API_KEY: "fake-test-key" }), { id: "codex", available: true, steer: false });
  const keyless = await codexOf({});
  assert.equal(keyless.available, false);
  assert.match(keyless.reason, /^codex needs OPENAI_API_KEY, or a gateway in AGENT_MODEL_BASE_URL\.$/);
});

// verifyCodex finds the binary through CODEX_BIN before the platform package, so a script there stands in for an
// installed Codex that is not the pinned build.
test("a Codex that is not the pinned build is unavailable as that, with the install line, even with a model key", { skip }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agentrun-codex-offer-"));
  const bin = join(dir, "codex");
  await writeFile(bin, "#!/bin/sh\necho codex-cli 0.164.0\n");
  await chmod(bin, 0o755);
  const before = env.CODEX_BIN;
  env.CODEX_BIN = bin;
  t.after(async () => {
    if (before === undefined) delete env.CODEX_BIN;
    else env.CODEX_BIN = before;
    await rm(dir, { recursive: true, force: true });
  });
  const offer = await codexOf({ OPENAI_API_KEY: "fake-test-key" });
  assert.equal(offer.available, false, JSON.stringify(offer));
  assert.match(offer.reason, /is not the pinned build: its binary sha256 is [0-9a-f]{64}, not [0-9a-f]{64}/);
  assert.match(offer.reason, /\(npm install @parcha\/agentrun-codex @openai\/codex@0\.164\.0\)$/);
});
