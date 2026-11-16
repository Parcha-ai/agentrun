// Settings → Computers' test data: the kind registry is the one stand-in the claim's resolver tests use
// (workspace-kinds-fixture.mjs: SETTING_KINDS, servingRefusals, PROVIDERS, the computer package's own); plus the kernel
// registry's tools per kind and fake provider modules. Nothing here calls a provider.
import { KINDS, PROVIDERS, SETTING_KINDS, servingRefusals } from "../workspace-kinds-fixture.mjs";

export { KINDS, PROVIDERS, SETTING_KINDS, servingRefusals };

const TOOLS = { none: [], sandbox: ["bash_background"], desktop: ["computer_observe", "computer_act"], phone: ["computer_observe", "computer_act"], browser: ["browser"] };
export const tools = (kind) => TOOLS[kind];

/**
 * Fake provider modules' create(), one for every provider in the registry (the factories computer-keys.ts's
 * testConnection takes), each recording the options it was made with. testConnection answers by the key: "good-..."
 * (and the export fake "fake-test-key") passes, "down-..." is unreachable, anything else unauthorized, its message echoing
 * the key so the test sees it scrubbed.
 */
export function fakeFactories() {
  const built = [];
  const fake = (providerId) => (options) => {
    built.push([providerId, options]);
    const key = options.apiKey ?? options.tokenSecret ?? "good-docker";
    return {
      async testConnection() {
        if (key.startsWith("good-") || key === "fake-test-key") return { ok: true, value: { detail: `${providerId}: 2 computers` } };
        if (key.startsWith("down-")) return { ok: false, error: { code: "unreachable", message: `connect ECONNREFUSED for ${key}` } };
        return { ok: false, error: { code: "unauthorized", message: `401 for key ${key}` } };
      },
    };
  };
  const factories = Object.fromEntries(PROVIDERS.map(({ id }) => [id, fake(id)]));
  return { built, factories };
}
