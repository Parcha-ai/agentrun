// What this server offers of opencode, as GET /v2/capabilities answers it (harnessOffers): available only when the
// installed OpenCode is the pinned build (the OpenCode adapter's verifyOpenCode, src/harness-opencode: the platform package's
// version, the binary's sha256 and the version it reports) and a model key or gateway is set. One that is missing or not
// the pinned build is unavailable as that, with serve's install line. No network: nothing here reaches a provider.
//
// The offer on the pinned build skips without it; with AGENTRUN_OPENCODE_REQUIRE_BINARY=1 (CI) it fails.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { test } from "node:test";
import { findOpenCode } from "../dist/harness-opencode/binary.js";
import { verifyOpenCodeBinary } from "../dist/harness-opencode/verify.js";
import { harnessOffers } from "../dist/harness.js";

const pinned = verifyOpenCodeBinary(findOpenCode());
const skip = pinned instanceof Error && env.AGENTRUN_OPENCODE_REQUIRE_BINARY !== "1" ? pinned.message : false;
const opencodeOf = async (given) => (await harnessOffers(given)).find((h) => h.id === "opencode");
const INSTALL = "npm install @parcha/agentrun-serve opencode-ai@1.19.5";

/** `run` with OPENCODE_BIN set to `bin`, which verifyOpenCode finds before the platform package. */
async function withBin(t, bin, run) {
  const before = env.OPENCODE_BIN;
  env.OPENCODE_BIN = bin;
  t.after(() => {
    if (before === undefined) delete env.OPENCODE_BIN;
    else env.OPENCODE_BIN = before;
  });
  return run();
}

test("opencode is offered on the pinned build: available with a model key, unavailable for the key it names without one", { skip }, async () => {
  assert.deepEqual(await opencodeOf({ OPENAI_API_KEY: "fake-test-key" }), { id: "opencode", available: true, steer: false, default_model: null }, "no default model here");
  const keyless = await opencodeOf({});
  assert.equal(keyless.available, false);
  assert.match(keyless.reason, /^opencode needs OPENAI_API_KEY, or a gateway in AGENT_MODEL_BASE_URL\.$/);
});

test("an OpenCode that is not installed is unavailable as that, with serve's install line, even with a model key", async (t) => {
  const offer = await withBin(t, join(tmpdir(), "agentrun-opencode-offer-none", "opencode"), () => opencodeOf({ OPENAI_API_KEY: "fake-test-key" }));
  assert.equal(offer.available, false, JSON.stringify(offer));
  assert.match(offer.reason, /OpenCode 1\.19\.5 is not installed/);
  assert.ok(offer.reason.endsWith(INSTALL), offer.reason);
});

test("an OpenCode that is not the pinned build is unavailable as that, with serve's install line, even with a model key", { skip: !findOpenCode()?.pkg && "no pinned OpenCode platform package here" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agentrun-opencode-offer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "opencode");
  await writeFile(bin, "#!/bin/sh\necho 1.19.5\n");
  await chmod(bin, 0o755);
  const offer = await withBin(t, bin, () => opencodeOf({ OPENAI_API_KEY: "fake-test-key" }));
  assert.equal(offer.available, false, JSON.stringify(offer));
  assert.match(offer.reason, /is not the pinned build: its binary sha256 is [0-9a-f]{64}, not [0-9a-f]{64}/);
  assert.ok(offer.reason.endsWith(`(${INSTALL})`), offer.reason);
});
