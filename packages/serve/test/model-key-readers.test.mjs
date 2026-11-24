// Who reads the server's own model keys. A run that brings its own key (model_key, run-model-key.ts) spends on it alone:
// its model routes get it through claim-secrets.ts claimModelEnv, which leaves out every key of the server's. That holds
// only while no other module reaches for the server's model keys by name on its own. This test pins the modules that do
// (the static, server-key path) and fails when another one starts to, so a new reader is a choice someone makes and
// routes through claimModelEnv, never a run that quietly spends the server's key after its caller handed one.
//
// What counts as a read: AGENT_MODEL_API_KEY or ANTHROPIC_API_KEY by name off an env object (`env.NAME`, `env["NAME"]`,
// or the constants that hold those names), or a call of the saved-key readers (savedModelKeys, tierModelKeys,
// subagentTierKeys). Comments
// are not reads.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url).pathname;

/** The modules allowed to read the server's model keys, and why. */
const ALLOWED = {
  "model.ts": "pi's providers and the gateway's auth resolve: the static route, which reads whatever env it is given (a run's own key there, when claimModelEnv made it)",
  "provider.ts": "each wire's route (providerFor): reads the env it is given, as model.ts does",
  "runner/model-route.ts": "an Anthropic model's route credential: reads the env it is given",
  "decisions.ts": "Jev's OpenRouter route on an openrouter.ai gateway's key: a decision key, never a run's model route",
  "run-model-key.ts": "whether the server holds a key for a run's route (serverKeyMissing, noServerKeyFor)",
  "runner/claim-secrets.ts": "defines savedModelKeys, tierModelKeys and subagentTierKeys (which reads through the first two), and claimSpendOff's check of the server's key",
  "runner/harness-loops.ts": "an SDK run's compile turn: asked after its backend reported it complete, with no caller's key, on the server's key or skipped",
  // These two read the saved keys only where the run holds no key of its own: checked line by line below.
  "runner/adapter-run-spec.ts": "the subagent tiers' and learned tiers' keys, read only for a run with no key of its own",
  "runner/cli-run-spec.ts": "the learned tiers' keys, read only for a run with no key of its own",
  // A run's own process holds no seal key: it asks its runner for these (held.ts), and the runner answers for the claim.
  "runner/held.ts": "the seam's declarations of what a run's process asks its runner for (savedModelKeys, tierModelKeys): no read",
  "runner/run-child-host.ts": "the runner's answers to a run's process (heldFor), read only for a run with no key of its own",
};
/** The modules whose every read must sit behind the run's own key: `keyed ? {} : <read>` (claim-secrets.ts keyedAtClaim). */
const GUARDED = new Set(["runner/adapter-run-spec.ts", "runner/cli-run-spec.ts", "runner/run-child-host.ts"]);

const READ = /\.(AGENT_MODEL_API_KEY|ANTHROPIC_API_KEY)\b|\[\s*["'](AGENT_MODEL_API_KEY|ANTHROPIC_API_KEY)["']\s*\]|\[\s*(GATEWAY_KEY_ENV|JEV_GATEWAY_KEY_ENV|ANTHROPIC_GATEWAY_KEY)\s*\]|\b(savedModelKeys|tierModelKeys|subagentTierKeys)\s*\(/;
const COMMENT = /^\s*(\/\/|\*|\/\*\*?)/;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

test("only the static, server-key path reads AGENT_MODEL_API_KEY, ANTHROPIC_API_KEY or the saved model keys; a run spec reads them only for a run with no key of its own", () => {
  const readers = new Map();
  for (const path of sources(SRC)) {
    const name = relative(SRC, path);
    readFileSync(path, "utf8").split("\n").forEach((line, i) => {
      if (COMMENT.test(line) || !READ.test(line)) return;
      if (!readers.has(name)) readers.set(name, []);
      readers.get(name).push({ at: i + 1, line: line.trim() });
    });
  }
  const strangers = [...readers.keys()].filter((name) => !Object.hasOwn(ALLOWED, name));
  assert.deepEqual(strangers, [], `a module reads the server's model keys outside the server-key path: ${strangers.map((name) => `${name}:${readers.get(name).map((r) => r.at).join(",")}`).join("; ")}. Route a run's model env through claim-secrets.ts claimModelEnv, or add the module to ALLOWED with why.`);
  for (const name of GUARDED) {
    for (const { at, line } of readers.get(name) ?? []) {
      if (/\b(savedModelKeys|tierModelKeys|subagentTierKeys)\s*\(/.test(line) && /^export|function /.test(line)) continue;
      assert.match(line, /keyed \? \{\} : await (savedModelKeys|tierModelKeys|subagentTierKeys)\(/, `${name}:${at} reads the server's saved model keys without checking whether the run brought its own key first: ${line}`);
    }
  }
  // The allowlist is not wider than what reads today: a module that stopped reading leaves it.
  const idle = Object.keys(ALLOWED).filter((name) => !readers.has(name));
  assert.deepEqual(idle, [], "every allowed module still reads; remove the rest from ALLOWED");
});
