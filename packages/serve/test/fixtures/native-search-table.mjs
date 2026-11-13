// The harness table for runner-native-search.test.mjs: claude-agent and codex each on its own real adapter, built with
// the options serve's adapters.ts builds it with from the run's plane (nativeOptions, the plane the runner hands the
// run's environment), so a run whose plane resolves web_search to native gets the harness's own search, as in
// production. Everything else is the faux entry's (faux-table.mjs): no install, any model. What the "CLI" does and where
// its requests go is the test's (STATE, on globalThis, since the runner loads this module apart from the test): Claude
// Code on the scripted Agent SDK (no CLI, no key), Codex on its pinned binary against a scripted fetch (no network).
import { fauxEntries } from "./faux-table.mjs";

/** What the test hands the entries: `claude` ({ provider, sdk }) and `codex` ({ fetch, sessionsDir }), and `opened`
 *  (each harness's id and the native options it was built with, as they are built). */
export const STATE = Symbol.for("agentrun.test.native-search-table");
const state = () => {
  const given = globalThis[STATE];
  if (!given) throw new Error("runner-native-search.test.mjs sets globalThis[STATE] before a run");
  return given;
};

export function entries(builtins) {
  const faux = fauxEntries(new URL("./faux-harness.mjs", import.meta.url))(builtins);
  const native = async (id, env) => {
    const { nativeOptions } = await import(new URL("../../dist/adapters.js", import.meta.url).href);
    const options = nativeOptions(builtins[id].facts, env);
    state().opened.push({ harness: id, options });
    return options;
  };
  return {
    ...faux,
    "claude-agent": {
      ...faux["claude-agent"],
      adapter: async (env) => {
        const { claudeAgentAdapter } = await import("@parcha/agentrun-harness-claude");
        const { provider, sdk } = state().claude;
        return claudeAgentAdapter({ model: "claude-test", provider: { origin: provider.url, credential: () => "provider-secret" }, price: () => 0, standIn: { command: process.execPath }, sdk, ...(await native("claude-agent", env)) });
      },
    },
    codex: {
      ...faux.codex,
      adapter: async (env) => {
        const { codexAdapter } = await import("@parcha/agentrun-harness-codex");
        const { fetch, sessionsDir } = state().codex;
        const { webSearch } = await native("codex", env);
        return codexAdapter({ model: "gpt-6.1-terra", provider: { origin: "https://provider.invalid", credential: () => "provider-secret" }, sessionsDir, fetch, price: () => 0, ...(webSearch ? { webSearch } : {}) });
      },
    },
  };
}
