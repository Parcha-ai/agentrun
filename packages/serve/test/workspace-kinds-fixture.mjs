// A stand-in for the computer module's kind registry (packages/computer src/kinds.ts: SETTING_KINDS, servingRefusals,
// PROVIDERS), copied as its names and data stand, for the claim's resolver tests until the module lands on this branch's
// base. Test data only; the resolver takes the module itself. ARCHIL_KINDS is the same table once the remote sandboxes
// take archil mounts (their mounts are [] until then).
export const SETTING_KINDS = {
  none: { machineKinds: [], required: [], optional: [] },
  sandbox: { machineKinds: ["linux"], required: ["exec", "files", "processes"], optional: [] },
  desktop: { machineKinds: ["desktop"], required: ["screen", "input.pointer", "input.keys"], optional: ["exec", "files", "processes", "apps", "stream"] },
  phone: { machineKinds: ["android", "ios"], required: ["screen", "input.touch", "apps"], optional: ["input.keys", "apps.install", "apps.ui_tree", "stream"] },
  browser: { machineKinds: ["browser"], required: ["cdp"], optional: ["stream", "downloads"] },
};
const SETTING_KIND_NAMES = Object.keys(SETTING_KINDS);

export function servingRefusals(capabilities, kind) {
  const spec = Object.hasOwn(SETTING_KINDS, kind) ? SETTING_KINDS[kind] : undefined;
  if (spec === undefined) return [`${JSON.stringify(kind)} is not a setting kind: ${SETTING_KIND_NAMES.join(", ")}`];
  if (spec.machineKinds.length === 0) return [`kind ${kind} is no computer: no provider serves it`];
  const refusals = [];
  if (!spec.machineKinds.includes(capabilities.kind)) refusals.push(`kind ${kind} is a ${spec.machineKinds.join(" or ")} machine, not a ${capabilities.kind} one`);
  const groups = Array.isArray(capabilities.groups) ? capabilities.groups : [];
  const missing = spec.required.filter((group) => !groups.includes(group));
  if (missing.length > 0) refusals.push(`kind ${kind} needs groups ${missing.join(", ")}, which the provider does not declare`);
  return refusals;
}

const SANDBOX = { kind: "linux", groups: ["exec", "files", "processes"] };
const LINUX_DESKTOP = { kind: "desktop", groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"] };
const entry = (fields) => ({ ...fields, kinds: SETTING_KIND_NAMES.filter((kind) => fields.capabilities.some((one) => servingRefusals(one, kind).length === 0)) });

export const PROVIDERS = [
  entry({ id: "docker", label: "Docker", keys: [], mounts: ["bind"], metered: false, capabilities: [SANDBOX, LINUX_DESKTOP] }),
  entry({ id: "daytona", label: "Daytona", keys: [{ name: "DAYTONA_API_KEY", required: true }, { name: "DAYTONA_API_URL", required: false }, { name: "DAYTONA_TARGET", required: false }], mounts: [], metered: true, capabilities: [SANDBOX] }),
  entry({ id: "modal", label: "Modal", keys: [{ name: "MODAL_TOKEN_ID", required: true }, { name: "MODAL_TOKEN_SECRET", required: true }], mounts: [], metered: true, capabilities: [SANDBOX] }),
  entry({ id: "e2b", label: "E2B", keys: [{ name: "E2B_API_KEY", required: true }], mounts: [], metered: true, capabilities: [SANDBOX, LINUX_DESKTOP] }),
  entry({ id: "orgo", label: "Orgo", keys: [{ name: "ORGO_API_KEY", required: true }], mounts: [], metered: true, capabilities: [LINUX_DESKTOP] }),
  entry({ id: "phone-harness", label: "Phone harness", keys: [{ name: "PHONE_HARNESS_API_KEY", required: true }], mounts: [], metered: true, capabilities: [{ kind: "android", groups: ["screen", "input.touch", "input.keys", "apps", "apps.ui_tree"] }] }),
  entry({ id: "browserbase", label: "Browserbase", keys: [{ name: "BROWSERBASE_API_KEY", required: true }, { name: "BROWSERBASE_PROJECT_ID", required: true }], mounts: [], metered: true, capabilities: [{ kind: "browser", groups: ["cdp"] }] }),
  entry({ id: "kernel", label: "Kernel", keys: [{ name: "KERNEL_API_KEY", required: true }], mounts: [], metered: true, capabilities: [{ kind: "browser", groups: ["cdp"] }] }),
];

/** The module as the resolver takes it. */
export const KINDS = { SETTING_KINDS, servingRefusals, PROVIDERS };
/** The same, once Daytona, Modal and E2B mount the run's folder from Archil. */
export const ARCHIL_KINDS = { ...KINDS, PROVIDERS: PROVIDERS.map((one) => (["daytona", "modal", "e2b"].includes(one.id) ? { ...one, mounts: ["archil"] } : one)) };
