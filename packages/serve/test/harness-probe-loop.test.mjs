// A harness's pinned binary is checked (its sha256, then the version it reports) without holding the server's event loop:
// every request, timer and store answer of the process goes on while it is read and run. Here the first check of the
// installed OpenCode in this process, as GET /v2/capabilities makes it (harnessOffers), with the loop measured meanwhile.
//
// Skips without the pinned OpenCode installed; with AGENTRUN_OPENCODE_REQUIRE_BINARY=1 (CI) it fails.
import assert from "node:assert/strict";
import { env } from "node:process";
import { test } from "node:test";
import { findOpenCode } from "../dist/harness-opencode/binary.js";
import { harnessOffers } from "../dist/harness.js";

/** The longest the event loop is held in a check: a look every 10 ms, and well under a hashed binary or a run CLI. */
const HELD_MS = 200;

const found = findOpenCode();
const skip = !found && env.AGENTRUN_OPENCODE_REQUIRE_BINARY !== "1" ? "the pinned OpenCode is not installed here" : false;

test("the server checks a harness's pinned binary without holding its event loop: no gap over 200 ms while OpenCode is hashed and asked its version", { skip, timeout: 120_000 }, async () => {
  // Everything the offers load on their first use is loaded first, by offers whose OpenCode is not there (its check finds
  // no file, reads nothing and keeps nothing), so the loop measured below is the check's alone: a module's first
  // evaluation holds the loop wherever it runs.
  const before = env.OPENCODE_BIN;
  env.OPENCODE_BIN = "/nonexistent/agentrun-probe-loop/opencode";
  try {
    assert.equal((await harnessOffers({ OPENAI_API_KEY: "fake-test-key" })).find((offer) => offer.id === "opencode")?.available, false);
  } finally {
    if (before === undefined) delete env.OPENCODE_BIN;
    else env.OPENCODE_BIN = before;
  }
  let last = performance.now();
  let worst = 0;
  // A look's gap past its 10 ms; the last look is taken at the end too, so a loop held to the end is counted.
  const look = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  };
  const looks = setInterval(look, 10);
  try {
    const offers = await harnessOffers({ OPENAI_API_KEY: "fake-test-key" });
    look();
    const opencode = offers.find((offer) => offer.id === "opencode");
    assert.equal(opencode?.available, true, `the pinned OpenCode was checked and offered: ${JSON.stringify(opencode)}`);
  } finally {
    clearInterval(looks);
  }
  assert.ok(worst < HELD_MS, `the event loop was held ${Math.round(worst)} ms while the binary was checked`);
});
