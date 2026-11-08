// A stand-in for the computer module's kind registry (its SETTING_KINDS and PROVIDERS, in the agreed shape), for the
// claim's resolver tests until the module's own lands: the setting kinds' machine kinds and groups, and each provider's
// id, label, key names, mounts, static capabilities and the kinds they serve. Test data only.
const SANDBOX = ["exec", "files", "processes"];
const DESKTOP = ["screen", "input.pointer", "input.keys"];

export const SETTING_KINDS = {
  none: { machineKinds: [], required: [], optional: [] },
  sandbox: { machineKinds: ["linux"], required: SANDBOX, optional: [] },
  desktop: { machineKinds: ["desktop"], required: DESKTOP, optional: [...SANDBOX, "apps", "stream"] },
  phone: { machineKinds: ["android", "ios"], required: ["screen", "input.touch", "apps"], optional: ["input.keys", "apps.install", "apps.ui_tree", "stream"] },
  browser: { machineKinds: ["browser"], required: ["cdp"], optional: ["stream", "downloads"] },
};

export const PROVIDERS = [
  { id: "docker", label: "Docker", keys: [], mounts: ["bind"], metered: false, capabilities: [{ kind: "linux", groups: SANDBOX }, { kind: "desktop", groups: [...SANDBOX, ...DESKTOP] }], kinds: ["sandbox", "desktop"] },
  { id: "daytona", label: "Daytona", keys: [{ name: "DAYTONA_API_KEY", required: true }, { name: "DAYTONA_API_URL", required: false }], mounts: ["archil"], metered: true, capabilities: [{ kind: "linux", groups: SANDBOX }], kinds: ["sandbox"] },
  { id: "e2b", label: "E2B", keys: [{ name: "E2B_API_KEY", required: true }], mounts: ["archil"], metered: true, capabilities: [{ kind: "linux", groups: SANDBOX }, { kind: "desktop", groups: [...SANDBOX, ...DESKTOP] }], kinds: ["sandbox", "desktop"] },
  { id: "orgo", label: "Orgo", keys: [{ name: "ORGO_API_KEY", required: true }], mounts: [], metered: true, capabilities: [{ kind: "desktop", groups: DESKTOP }], kinds: ["desktop"] },
  { id: "phone-harness", label: "Phone harness", keys: [{ name: "PHONE_HARNESS_API_KEY", required: true }], mounts: [], metered: true, capabilities: [{ kind: "android", groups: ["screen", "input.touch", "input.keys", "apps"] }], kinds: ["phone"] },
  { id: "browserbase", label: "Browserbase", keys: [{ name: "BROWSERBASE_API_KEY", required: true }, { name: "BROWSERBASE_PROJECT_ID", required: true }], mounts: [], metered: true, capabilities: [{ kind: "browser", groups: ["cdp", "downloads"] }], kinds: ["browser"] },
];

export const KIND_REGISTRY = { settingKinds: SETTING_KINDS, providers: PROVIDERS };
