// The `browser` tool's provider and driver for the tests: pi-browser's fake backend, with one page and no network or
// key. Each call it answers is appended to $FAUX_BROWSER_LOG, so a test reads what the run's process did; its first
// line says whether the Browserbase variables reached it in the env the real provider gets (never their values), its
// second which vendor the run's plane named (`browserbase`, `kernel`, or why it is unavailable) and whether Kernel's key
// reached it. The page names the vendor too, so the run's answer says which browser it got.
import { appendFileSync } from "node:fs";
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

export default function browser(env = process.env, vendor = "browserbase") {
  const log = process.env.FAUX_BROWSER_LOG;
  const seen = (name) => (env[name] ? "set" : "unset");
  if (log) appendFileSync(log, `${JSON.stringify({ op: "env", BROWSERBASE_API_KEY: seen("BROWSERBASE_API_KEY"), BROWSERBASE_PROJECT_ID: seen("BROWSERBASE_PROJECT_ID") })}\n`);
  if (log) appendFileSync(log, `${JSON.stringify({ op: "vendor", vendor, KERNEL_API_KEY: seen("KERNEL_API_KEY") })}\n`);
  const start = "https://example.test/";
  const backend = new FakeBackend({ start, pages: { [start]: fixturePage(start, `The answer is forty-two. This browser is ${vendor}'s.`, "Example") }, ...(log ? { logFile: log } : {}) });
  return { provider: backend.provider, driver: fakeDriver(backend) };
}
