// @ts-check
// A harness module: one file that adds a harness to an AgentRun server without changing serve (HARNESS.md). This one
// adds an ACP agent, Goose, under an id of its own, "goose-module", on its own copy of the Goose binary. It is the
// shape a module for any ACP agent takes: its facts, its recipe for a run, and the model proxy its process calls.
//
// serve loads it with require, so it has no top-level await. It is handed the built-in entries and the kit; the kit's
// builders are the ones the built-in harnesses are made with, so this harness's models, key rows and refusals come out
// the way theirs do.
import {
  acpPlatform,
  GOOSE_PIN,
  gooseFacts,
  gooseProxy,
  gooseRecipe,
  verifyPinnedBinaryAsync,
} from "@parcha/agentrun-harness-acp";

/** The harness's id: a new one, never a built-in's (serve refuses a module that names one). */
export const ID = "goose-module";

/** Where its owner puts this harness's Goose binary: an absolute path. `agentrun harness install goose` (Goose's
 *  `install` fact) puts the pinned one at `<data>/harnesses/goose/goose`. */
export const BINARY_SETTING = "EXAMPLE_GOOSE_BINARY";

/** What the harness is, as serve's table reads it: Goose's own facts under this module's id. */
/** @type {import("@parcha/agentrun-kernel").AdapterFacts} */
export const facts = Object.freeze({ ...gooseFacts, id: ID, label: "Goose (module)" });

/** The sha256 the binary must have on this machine: the pin @parcha/agentrun-harness-acp ships. */
function pinnedSha256() {
  const platform = acpPlatform();
  const sha256 = platform ? GOOSE_PIN.archives[platform]?.binarySha256 : undefined;
  if (!sha256) throw new Error(`${facts.label}: no Goose binary is pinned for this platform`);
  return sha256;
}

/** Why this harness cannot run on `env` whatever model key is saved: no binary named, or one that is not the pinned
 *  Goose. serve asks this before the model key, so the harness's offer says it and names no key. */
async function missing(/** @type {NodeJS.ProcessEnv} */ env) {
  const binary = env[BINARY_SETTING];
  if (!binary) return `${facts.label} needs a Goose binary: set ${BINARY_SETTING} to its absolute path, then restart AgentRun.`;
  try {
    await verifyPinnedBinaryAsync(binary, pinnedSha256());
  } catch (error) {
    return `${facts.label} cannot run ${binary}: ${/** @type {Error} */ (error).message}. Point ${BINARY_SETTING} at the pinned Goose, then restart AgentRun.`;
  }
  return undefined;
}

/** @type {import("@parcha/agentrun-serve/harness").HarnessTableModule["entries"]} */
export const entries = (_builtins, kit) => ({
  [ID]: kit.acpEntry({
    facts,
    // Goose's recipe declares session/load, so a crashed run resumes its own session (else the default, "restart").
    resume: "load",
    missing,
    // The run's recipe: Goose's file, the binary `missing` checked and the model serve chose for the run, under this
    // harness's id.
    recipe: (launch) => ({ ...gooseRecipe({ command: String(launch.env[BINARY_SETTING]), model: launch.model }), id: ID, label: facts.label }),
    // Its model requests go to a loopback proxy on the session's booking, then on to the provider serve chose with this
    // server's key. The agent never holds the key.
    proxy: (launch) => gooseProxy({ model: launch.model, provider: launch.provider, price: launch.price, log: launch.log }),
    // Checked again before each Goose process starts, a restart included.
    beforeStart: (command) => verifyPinnedBinaryAsync(command, pinnedSha256()),
  }),
});
