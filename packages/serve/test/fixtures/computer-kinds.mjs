// Settings → Computers' test data: the kind registry is the one stand-in the claim's resolver tests use
// (workspace-kinds-fixture.mjs: SETTING_KINDS, servingRefusals, PROVIDERS, copied from the computer package's kinds.ts),
// with ARCHIL_KINDS for a Mode 2 whose remote sandboxes mount the owner's disk; plus the kernel registry's tools per kind
// and fake provider modules. Nothing here calls a provider.
import { ARCHIL_KINDS, KINDS, PROVIDERS, SETTING_KINDS, servingRefusals } from "../workspace-kinds-fixture.mjs";

export { ARCHIL_KINDS, KINDS, PROVIDERS, SETTING_KINDS, servingRefusals };

const TOOLS = { none: [], sandbox: ["bash_background"], desktop: ["screenshot", "computer_input"], phone: ["phone_screenshot", "phone_tap"], browser: ["browser"] };
export const tools = (kind) => TOOLS[kind];

/**
 * Fake provider modules' create(), by provider id (the factories computer-keys.ts's testConnection takes), each
 * recording the options it was made with. testConnection answers by the key: "good-..." passes, "down-..." is
 * unreachable, anything else unauthorized, its message echoing the key so the test sees it scrubbed. No browserbase:
 * serve has no module for it yet.
 */
export function fakeFactories() {
  const built = [];
  const fake = (providerId) => (options) => {
    built.push([providerId, options]);
    const key = options.apiKey ?? options.tokenSecret ?? "good-docker";
    return {
      async testConnection() {
        if (key.startsWith("good-")) return { ok: true, value: { detail: `${providerId}: 2 computers` } };
        if (key.startsWith("down-")) return { ok: false, error: { code: "unreachable", message: `connect ECONNREFUSED for ${key}` } };
        return { ok: false, error: { code: "unauthorized", message: `401 for key ${key}` } };
      },
    };
  };
  const factories = Object.fromEntries(["docker", "daytona", "modal", "e2b", "phone-harness"].map((id) => [id, fake(id)]));
  return { built, factories };
}
