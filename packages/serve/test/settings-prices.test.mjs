// GET /v2/settings/prices: the prices this server meters computer and browser time at, as the meters read them
// (compute-cost.ts computeRate, browser-cost.ts browserPrice), each a decimal string with its source: the operator's
// setting, a list price built in, or unpriced (none, or a setting that can't be read).
import assert from "node:assert/strict";
import { test } from "node:test";
import { serve, withEnv } from "./support.mjs";

/** Every price setting these tests set or clear. */
const NAMES = [
  "AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_DAYTONA",
  "AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_DAYTONA",
  "AGENTRUN_COMPUTE_USD_PER_DISK_GB_MONTH_DAYTONA",
  "AGENTRUN_COMPUTE_USD_PER_GPU_SECOND_DAYTONA_H100",
  "AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_E2B",
  "AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_DOCKER",
  "AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_MORPH",
  "AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_MORPH",
  "AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_GROUNDBOX",
  "AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_GROUNDBOX",
  "AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_ORGO",
  "AGENTRUN_BROWSER_USD_PER_HOUR_BROWSERBASE",
  "AGENTRUN_BROWSER_USD_PER_HOUR_KERNEL",
  "AGENTRUN_BROWSER_USD_PER_HOUR_ACME",
  "AGENTRUN_BROWSER_USD_PER_HOUR_LOCAL_CHROME",
];

const pricesOf = async (t, vars) => {
  withEnv(t, vars, NAMES);
  const s = await serve(t, { runner: false });
  const res = await s.api("GET", "/settings/prices");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const compute = (body, provider, resource, gpuType = null) => body.compute.find((row) => row.provider === provider && row.resource === resource && row.gpu_type === gpuType);
const browser = (body, provider) => body.browser.find((row) => row.provider === provider);

test("compute prices: a setting as written with source setting, an unset resource unpriced, an unreadable setting unpriced, a GPU type a setting names its own row", async (t) => {
  const body = await pricesOf(t, {
    AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_DAYTONA: " 0.0000140 ",
    AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_DAYTONA: "0.0000045",
    AGENTRUN_COMPUTE_USD_PER_GPU_SECOND_DAYTONA_H100: "0.0011",
    AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_E2B: "1e-5",
  });
  assert.deepEqual(compute(body, "daytona", "vcpu"), { provider: "daytona", resource: "vcpu", gpu_type: null, unit: "vcpu_second", usd: "0.0000140", source: "setting" });
  assert.deepEqual(compute(body, "daytona", "memory"), { provider: "daytona", resource: "memory", gpu_type: null, unit: "gib_second", usd: "0.0000045", source: "setting" });
  assert.deepEqual(compute(body, "daytona", "disk"), { provider: "daytona", resource: "disk", gpu_type: null, unit: "gb_month", usd: null, source: "unpriced" });
  assert.deepEqual(compute(body, "daytona", "gpu", "H100"), { provider: "daytona", resource: "gpu", gpu_type: "H100", unit: "gpu_second", usd: "0.0011", source: "setting" });
  // The meters read no exponent: that setting is unpriced, never $0.00001.
  assert.deepEqual(compute(body, "e2b", "vcpu"), { provider: "e2b", resource: "vcpu", gpu_type: null, unit: "vcpu_second", usd: null, source: "unpriced" });
  // No GPU row for a provider no GPU setting names.
  assert.equal(body.compute.filter((row) => row.provider === "e2b" && row.resource === "gpu").length, 0);
  // Sorted by provider, then vcpu, memory, disk, then each GPU type.
  const providers = body.compute.map((row) => row.provider);
  assert.deepEqual(providers, [...providers].sort());
  assert.deepEqual(body.compute.filter((row) => row.provider === "daytona").map((row) => row.resource), ["vcpu", "memory", "disk", "gpu"]);
});

test("a provider that bills nothing is $0 from the list for every compute resource, whatever a setting says; its browser row follows a browser setting", async (t) => {
  const body = await pricesOf(t, { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_DOCKER: "0.5", AGENTRUN_BROWSER_USD_PER_HOUR_LOCAL_CHROME: "0.5" });
  assert.deepEqual(browser(body, "local-chrome"), { provider: "local-chrome", unit: "hour", usd: "0.5", minimum_s: 0, source: "setting" });
  for (const resource of ["vcpu", "memory", "disk"]) assert.deepEqual(compute(body, "docker", resource), { provider: "docker", resource, gpu_type: null, unit: { vcpu: "vcpu_second", memory: "gib_second", disk: "gb_month" }[resource], usd: "0", source: "list" });
});

test("a metered provider whose computers say no size is unpriced for every compute resource, whatever its setting: its time can't be measured, so a caller counts it as uncounted", async (t) => {
  const body = await pricesOf(t, {
    AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_MORPH: "0.00001",
    AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_MORPH: "0.000003",
    AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_GROUNDBOX: "0.0000111",
    AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_GROUNDBOX: "0.000002",
    AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_ORGO: "0.0000128",
  });
  for (const resource of ["vcpu", "memory", "disk"]) assert.deepEqual(compute(body, "morph", resource), { provider: "morph", resource, gpu_type: null, unit: { vcpu: "vcpu_second", memory: "gib_second", disk: "gb_month" }[resource], usd: null, source: "unpriced" }, resource);
  // A provider whose create says the size it runs at is priced by its setting.
  assert.deepEqual(compute(body, "groundbox", "vcpu"), { provider: "groundbox", resource: "vcpu", gpu_type: null, unit: "vcpu_second", usd: "0.0000111", source: "setting" });
  assert.deepEqual(compute(body, "groundbox", "memory"), { provider: "groundbox", resource: "memory", gpu_type: null, unit: "gib_second", usd: "0.000002", source: "setting" });
  assert.deepEqual(compute(body, "orgo", "vcpu"), { provider: "orgo", resource: "vcpu", gpu_type: null, unit: "vcpu_second", usd: "0.0000128", source: "setting" });
  // The meter reads the same: no rate for the provider that says no size, so none of its time is held or booked at a guess.
  const { computeRate } = await import("../dist/compute-cost.js");
  const env = { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_MORPH: "0.00001", AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_GROUNDBOX: "0.0000111" };
  assert.equal(computeRate("morph", "vcpu", null, env), null);
  assert.equal(computeRate("groundbox", "vcpu", null, env), 0.0000111);
});

test("every metered computer provider says whether its create answers the size it runs at: the ones that do are priced, the rest unpriced (a new provider is decided here)", async () => {
  const { PROVIDERS } = await import("@parcha/agentrun-computer");
  const computers = PROVIDERS.filter((entry) => entry.metered && entry.kinds.some((kind) => kind === "sandbox" || kind === "desktop"));
  assert.deepEqual(computers.filter((entry) => entry.sized === true).map((entry) => entry.id).sort(), ["agent37", "daytona", "e2b", "fly", "groundbox", "instabox", "modal", "orgo", "render"]);
  assert.deepEqual(computers.filter((entry) => entry.sized !== true).map((entry) => entry.id).sort(), ["boxd", "cloudflare", "morph", "smolcloud", "sprites", "vercel"]);
});

test("browser prices: the setting wins over the list, the list where none is set, an unreadable setting unpriced, a provider only a setting names", async (t) => {
  const body = await pricesOf(t, { AGENTRUN_BROWSER_USD_PER_HOUR_BROWSERBASE: "0.10", AGENTRUN_BROWSER_USD_PER_HOUR_KERNEL: "cheap", AGENTRUN_BROWSER_USD_PER_HOUR_ACME: "0.2" });
  assert.deepEqual(browser(body, "browserbase"), { provider: "browserbase", unit: "hour", usd: "0.10", minimum_s: 60, source: "setting" });
  assert.deepEqual(browser(body, "kernel"), { provider: "kernel", unit: "hour", usd: null, minimum_s: 0, source: "unpriced" });
  assert.deepEqual(browser(body, "cdp"), { provider: "cdp", unit: "hour", usd: "0", minimum_s: 0, source: "list" });
  assert.deepEqual(browser(body, "local-chrome"), { provider: "local-chrome", unit: "hour", usd: "0", minimum_s: 0, source: "list" });
  assert.deepEqual(browser(body, "acme"), { provider: "acme", unit: "hour", usd: "0.2", minimum_s: 0, source: "setting" });
});

test("browser list prices with no setting, each as a decimal string", async (t) => {
  const body = await pricesOf(t, {});
  assert.deepEqual(browser(body, "browserbase"), { provider: "browserbase", unit: "hour", usd: "0.12", minimum_s: 60, source: "list" });
  assert.deepEqual(browser(body, "kernel"), { provider: "kernel", unit: "hour", usd: "0.06", minimum_s: 0, source: "list" });
  assert.equal(browser(body, "acme"), undefined);
  for (const row of [...body.compute, ...body.browser]) if (row.usd !== null) assert.match(row.usd, /^\d+(\.\d+)?$/);
});

test("a price is written in digits, its shortest form, never with an exponent", async () => {
  const { decimalOf } = await import("../dist/prices.js");
  assert.deepEqual([0.12, 0.06, 0, 3, 1e-7, 1.5e-8, 2e21].map(decimalOf), ["0.12", "0.06", "0", "3", "0.0000001", "0.000000015", "2000000000000000000000"]);
});
