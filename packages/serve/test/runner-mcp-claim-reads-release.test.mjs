// A claim's MCP is let go when a read the runner makes after its claim opened fails (runner/mcp-run.ts mcpForClaim): the
// run's workspace and the stored MCP mode, read to decide each pinned server's rule. mcpForClaim rejects, so its caller
// never gets a release; the claim's signal is aborted there instead, and a github_app token minted at the claim has its
// refresh timer cleared and mints nothing again.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

const { mcpForClaim } = await import("../dist/runner/mcp-run.js");
const { heldRedactor, keepText } = await import("../dist/runner/redact.js");
const { API_ONLY_MCP_ORIGINS_KEY } = await import("../dist/mcp-api-only-origins.js");

const KEY = randomBytes(32);
const HOUR = 3_600_000;
const ORIGIN = "https://gh.example.test";

/** `store` with `runs.workspace` or the MCP mode's settings read failing once a github_app token has been minted. */
function failingAfterMint(store, which) {
  const state = { minted: false };
  const broken = new Error(`the ${which} read failed`);
  const runs = new Proxy(store.runs, {
    get: (target, key) => (key === "workspace" && which === "workspace" ? async (...args) => (state.minted ? Promise.reject(broken) : target.workspace(...args)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]),
  });
  const settings = new Proxy(store.settings, {
    get: (target, key) => (key === "get" && which === "settings" ? async (name, ...rest) => (state.minted && name === API_ONLY_MCP_ORIGINS_KEY ? Promise.reject(broken) : target.get(name, ...rest)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]),
  });
  const wrapped = new Proxy(store, {
    get: (target, key) => (key === "runs" ? runs : key === "settings" ? settings : typeof target[key] === "function" ? target[key].bind(target) : target[key]),
  });
  return { wrapped, state, broken };
}

for (const which of ["workspace", "settings"]) {
  test(`a claim's MCP is let go when the ${which === "workspace" ? "run's workspace" : "stored MCP mode"} read after the claim fails: mcpForClaim rejects, its github_app token's refresh timer is cleared and nothing is minted again`, async (t) => {
    const { store, dir } = await storeOn(t);
    await store.mcp.put({ name: "gh", url: `${ORIGIN}/mcp`, auth: "github_app", tools: [{ name: "add", input_schema: { type: "object" } }], sealed: null });
    const row = await store.mcp.server("gh");
    await queued(store, "run-1", { mcpPin: { gh: { url: row.url, tools: row.tools.map(({ input_schema, ...tool }) => ({ ...tool, inputSchema: input_schema })) } } });
    const claim = await store.claim("run-1", "runner-a", { leaseMs: 10 * HOUR });
    const { wrapped, state, broken } = failingAfterMint(store, which);
    let mints = 0;
    const armed = [];
    const access = {
      target: { repo: "acme/widgets" },
      mint: async () => {
        mints++;
        state.minted = true;
        return { ok: true, token: `not-a-secret-github-${mints}`, expires_at: Date.now() + HOUR };
      },
      revoke: async () => undefined,
    };
    await assert.rejects(
      mcpForClaim({
        claim, store: wrapped, sealKey: KEY, grants: ["mcp:gh/add"], harness: { commit: async () => undefined }, work: () => dir, redact: heldRedactor(keepText),
        githubAppAccess: async () => access, githubMcpOrigin: ORIGIN,
        githubTimer: (fire) => {
          const timer = { fire, cleared: false, clear: () => (timer.cleared = true) };
          armed.push(timer);
          return timer;
        },
      }),
      (error) => error === broken,
    );
    assert.equal(mints, 1, "the claim minted its token");
    assert.ok(armed.length > 0, "its refresh was armed");
    assert.deepEqual(armed.map((timer) => timer.cleared), armed.map(() => true), "every timer the claim armed is cleared");
    for (const timer of armed) timer.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mints, 1, "a refresh that fires anyway mints nothing");
  });
}
