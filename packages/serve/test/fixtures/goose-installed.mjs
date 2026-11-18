// Goose installed and verified in a data directory, for the tests that check a list names it only then: the real Goose
// 1.59.2 binary, which AGENTRUN_TEST_GOOSE names, linked to `<data>/harnesses/goose/goose`, where `agentrun harness install
// goose` puts it. Its sha256 is the pin's, so the server lists Goose (harness-goose.ts) exactly as after an install. No
// stand-in can be: the server checks the binary's digest against the pin. Without the variable those tests skip, saying why.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const GOOSE = process.env.AGENTRUN_TEST_GOOSE;

/** A test's `skip`: false with the binary, else why it is skipped. */
export const needsGoose = GOOSE ? false : "AGENTRUN_TEST_GOOSE is not set: it names the Goose 1.59.2 binary this case installs";

/** Links the Goose binary into `data`'s harnesses directory, as an install puts it there; returns `data`. */
export function installGoose(data) {
  if (!GOOSE) throw new Error(needsGoose);
  mkdirSync(join(data, "harnesses", "goose"), { recursive: true });
  symlinkSync(GOOSE, join(data, "harnesses", "goose", "goose"));
  return data;
}
