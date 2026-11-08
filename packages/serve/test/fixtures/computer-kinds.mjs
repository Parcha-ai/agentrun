// A stand-in for the computer package's kind registry (kinds.ts: SETTING_KINDS, PROVIDERS, testConnection) and the
// kernel registry's capabilityToolDefs, shaped as their SHAPE.md says, for serve's Settings → Computers tests. Nothing
// here calls a provider: test() answers from the keys it is handed.
export const KINDS = {
  none: { required: [], optional: [] },
  sandbox: { required: ["exec", "files", "processes"], optional: [] },
  desktop: { required: ["screen", "input.pointer", "input.keys"], optional: ["exec", "files", "processes", "apps", "stream"] },
  phone: { required: ["screen", "input.touch", "apps"], optional: ["input.keys", "apps.install", "apps.ui_tree", "stream"] },
  browser: { required: ["cdp"], optional: ["stream", "downloads"] },
};

export const PROVIDERS = [
  { id: "docker", label: "Docker", kinds: ["sandbox", "desktop"], keys: [], mounts: ["bind"], metered: false },
  { id: "daytona", label: "Daytona", kinds: ["sandbox"], keys: [{ name: "DAYTONA_API_KEY", required: true }, { name: "DAYTONA_API_URL", required: false }], mounts: ["archil"], metered: true },
  { id: "e2b", label: "E2B", kinds: ["sandbox", "desktop"], keys: [{ name: "E2B_API_KEY", required: true }], mounts: ["archil"], metered: true },
  { id: "phone-harness", label: "Phone harness", kinds: ["phone"], keys: [{ name: "PHONE_HARNESS_API_KEY", required: true }], mounts: [], metered: true },
  { id: "browserbase", label: "Browserbase", kinds: ["browser"], keys: [{ name: "BROWSERBASE_API_KEY", required: true }, { name: "BROWSERBASE_PROJECT_ID", required: true }], mounts: [], metered: true },
];

const TOOLS = { none: [], sandbox: ["bash_background"], desktop: ["screenshot", "computer_input"], phone: ["phone_screenshot", "phone_tap"], browser: ["browser"] };

/** The registry, with each account check recorded: a key spelled "good-..." passes, anything else is unauthorized. */
export function standInRegistry() {
  const tested = [];
  return {
    tested,
    registry: {
      kinds: KINDS,
      providers: PROVIDERS,
      tools: (kind) => TOOLS[kind],
      async test(providerId, { keys }) {
        tested.push([providerId, Object.keys(keys).sort()]);
        return Object.values(keys).every((value) => value.startsWith("good-")) ? { ok: true, value: { detail: `${providerId}: account read` } } : { ok: false, error: { code: "unauthorized", message: `${providerId} refused the key` } };
      },
    },
  };
}
