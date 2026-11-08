// A stand-in for the computer package's kind registry (kinds.ts: SETTING_KINDS, PROVIDERS, servingRefusals), by its own
// names and shapes, and the kernel registry's capabilityToolDefs, for serve's Settings → Computers tests. The rows copy
// kinds.ts's, except daytona and e2b, which mount the owner's disk here so Mode 2 offers a sandbox (kinds.ts gives them
// archil mounts once D6 lands). Nothing here calls a provider.
const SANDBOX = { kind: "linux", groups: ["exec", "files", "processes"] };
const LINUX_DESKTOP = { kind: "desktop", groups: ["screen", "input.pointer", "input.keys", "exec", "files", "processes"] };

export const SETTING_KINDS = {
  none: { machineKinds: [], required: [], optional: [] },
  sandbox: { machineKinds: ["linux"], required: ["exec", "files", "processes"], optional: [] },
  desktop: { machineKinds: ["desktop"], required: ["screen", "input.pointer", "input.keys"], optional: ["exec", "files", "processes", "apps", "stream"] },
  phone: { machineKinds: ["android", "ios"], required: ["screen", "input.touch", "apps"], optional: ["input.keys", "apps.install", "apps.ui_tree", "stream"] },
  browser: { machineKinds: ["browser"], required: ["cdp"], optional: ["stream", "downloads"] },
};

/** Why capabilities do not serve a setting kind, in words (kinds.ts's servingRefusals). */
export function servingRefusals(capabilities, kind) {
  const spec = SETTING_KINDS[kind];
  const refusals = [];
  if (!spec.machineKinds.includes(capabilities.kind)) refusals.push(`kind ${kind} is a ${spec.machineKinds.join(" or ")} machine, not a ${capabilities.kind} one`);
  for (const group of spec.required) if (!capabilities.groups.includes(group)) refusals.push(`kind ${kind} needs the group ${group}`);
  return refusals;
}

const entry = (fields) => ({ ...fields, kinds: Object.keys(SETTING_KINDS).filter((kind) => kind !== "none" && fields.capabilities.some((one) => servingRefusals(one, kind).length === 0)) });

export const PROVIDERS = [
  entry({ id: "docker", label: "Docker", keys: [], mounts: ["bind"], metered: false, capabilities: [SANDBOX, LINUX_DESKTOP] }),
  entry({ id: "daytona", label: "Daytona", keys: [{ name: "DAYTONA_API_KEY", required: true }, { name: "DAYTONA_API_URL", required: false }, { name: "DAYTONA_TARGET", required: false }], mounts: ["archil"], metered: true, capabilities: [SANDBOX] }),
  entry({ id: "modal", label: "Modal", keys: [{ name: "MODAL_TOKEN_ID", required: true }, { name: "MODAL_TOKEN_SECRET", required: true }], mounts: [], metered: true, capabilities: [SANDBOX] }),
  entry({ id: "e2b", label: "E2B", keys: [{ name: "E2B_API_KEY", required: true }], mounts: ["archil"], metered: true, capabilities: [SANDBOX, LINUX_DESKTOP] }),
  entry({ id: "phone-harness", label: "Phone harness", keys: [{ name: "PHONE_HARNESS_API_KEY", required: true }], mounts: [], metered: true, capabilities: [{ kind: "android", groups: ["screen", "input.touch", "apps"] }] }),
  entry({ id: "browserbase", label: "Browserbase", keys: [{ name: "BROWSERBASE_API_KEY", required: true }, { name: "BROWSERBASE_PROJECT_ID", required: true }], mounts: [], metered: true, capabilities: [{ kind: "browser", groups: ["cdp"] }] }),
];

const TOOLS = { none: [], sandbox: ["bash_background"], desktop: ["screenshot", "computer_input"], phone: ["phone_screenshot", "phone_tap"], browser: ["browser"] };
export const tools = (kind) => TOOLS[kind];

/** The kind registry as createComputerRoutes takes it. */
export const KINDS = { SETTING_KINDS, PROVIDERS, servingRefusals };

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
