// One script, three providers. PI_BROWSER_PROVIDER=cdp (the default, a local Chrome), browserbase or kernel.
// Browserbase needs BROWSERBASE_API_KEY and its SDK installed; Kernel needs KERNEL_API_KEY.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagehandDriver } from "@parcha/pi-browser/driver/stagehand";

const name = process.env.PI_BROWSER_PROVIDER ?? "cdp";
if (!["cdp", "browserbase", "kernel"].includes(name)) throw new Error(`PI_BROWSER_PROVIDER is ${name}; use cdp, browserbase or kernel`);
const key = { browserbase: "BROWSERBASE_API_KEY", kernel: "KERNEL_API_KEY" }[name];
if (key && !process.env[key]) throw new Error(`${key} is not set`);
const root = await mkdtemp(join(tmpdir(), "pi-browser-"));
const providers = {
  cdp: async () => (await import("@parcha/pi-browser/providers/cdp")).cdpProvider({ chrome: { executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", profileRoot: root } }),
  browserbase: async () => (await import("@parcha/pi-browser/providers/browserbase")).browserbaseProvider(),
  kernel: async () => (await import("@parcha/pi-browser/providers/kernel")).kernelProvider(),
};
let provider, session;
try {
  provider = await providers[name]();
  const signal = AbortSignal.timeout(120_000);
  session = await provider.create({ tag: "three-providers", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, signal);
  const driver = await stagehandDriver()(await provider.attach(session), signal);
  await driver.run({ code: `await page.goto(${JSON.stringify(process.argv[2] ?? "https://example.com")})` });
  console.log(`${name}:`, (await driver.snapshot()).split("\n")[0]);
  await driver.close();
} finally {
  if (session) await provider.release(session);
  await rm(root, { recursive: true, force: true });
}
