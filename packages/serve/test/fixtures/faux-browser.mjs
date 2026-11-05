// The `browser` tool's provider and driver for the tests: pi-browser's fake backend, with one page and no network or
// key. Each call it answers is appended to $FAUX_BROWSER_LOG, so a test reads what the run's process did; its first
// line says whether the Browserbase variables reached it in the env the real provider gets (never their values), its
// second which vendor the run's plane named (`browserbase`, `kernel`, or why it is unavailable) and whether Kernel's key
// reached it. The page names the vendor too, so the run's answer says which browser it got. Kernel's provider keeps
// no downloads, and neither does this one when the vendor is Kernel. A run handed its agent's saved sign-in (over its
// pipe) gets a line naming it, and whether that ref is anywhere in its environment (process.env, the env the provider
// gets with its hidden properties, and the environment the kernel shows); each session that asks for a profile logs
// the profile's name and whether it saves. Profiles are kept, as Browserbase's and Kernel's are.
import { appendFileSync, readFileSync } from "node:fs";
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

export default function browser(env = process.env, vendor = "browserbase", signIn = undefined) {
  const log = process.env.FAUX_BROWSER_LOG;
  const seen = (name) => (env[name] ? "set" : "unset");
  if (log) appendFileSync(log, `${JSON.stringify({ op: "env", BROWSERBASE_API_KEY: seen("BROWSERBASE_API_KEY"), BROWSERBASE_PROJECT_ID: seen("BROWSERBASE_PROJECT_ID") })}\n`);
  if (log) appendFileSync(log, `${JSON.stringify({ op: "vendor", vendor, KERNEL_API_KEY: seen("KERNEL_API_KEY") })}\n`);
  if (log && signIn) {
    const values = (object) => Object.getOwnPropertyNames(object).map((name) => String(object[name]));
    const kernelEnv = (() => { try { return readFileSync("/proc/self/environ", "utf8"); } catch { return ""; } })();
    const inEnv = [...values(process.env), ...values(env), kernelEnv].some((value) => value.includes(signIn.ref));
    appendFileSync(log, `${JSON.stringify({ op: "sign-in", provider: signIn.provider, ref: signIn.ref, save: signIn.save, ref_in_env: inEnv })}\n`);
  }
  const start = "https://example.test/";
  const backend = new FakeBackend({ start, caps: { profiles: true }, pages: { [start]: fixturePage(start, `The answer is forty-two. This browser is ${vendor}'s.`, "Example") }, ...(log ? { logFile: log } : {}) });
  const { downloads: _, ...withoutDownloads } = backend.provider;
  const provider = vendor === "kernel" ? withoutDownloads : backend.provider;
  const create = (spec, signal) => (log && spec.profile && appendFileSync(log, `${JSON.stringify({ op: "profile", name: spec.profile.name, save: spec.profile.save })}\n`), provider.create(spec, signal));
  return { provider: { ...provider, create }, driver: fakeDriver(backend) };
}
