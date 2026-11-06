// The `browser` tool's provider and driver for the tests: pi-browser's fake backend, with one page and no network or
// key. Each call it answers is appended to $FAUX_BROWSER_LOG, so a test reads what the run's process did; its first
// line says whether the Browserbase variables reached it in the env the real provider gets (never their values), its
// second which vendor the run's plane named (`browserbase`, `kernel`, `chrome`, or why it is unavailable) and whether
// Kernel's key reached it; on `chrome`, a third names the Chrome the server handed it. The page names the vendor too, so
// the run's answer says which browser it got. Kernel's provider keeps no downloads, and neither does this one when the
// vendor is Kernel. Its provider is named for the vendor, so the run prices its session time as that vendor's, or
// $FAUX_BROWSER_PROVIDER's. A run handed its agent's saved sign-in (over
// its pipe) gets a line naming it, and whether that ref is anywhere in its environment (process.env, the env the
// provider gets with its hidden properties, and the environment the kernel shows); each session that asks for a
// profile logs the profile's name and whether it saves. Profiles are kept, as Browserbase's and Kernel's are.
import { appendFileSync, readFileSync } from "node:fs";
import { BrowserFailureError, browserFailure } from "@parcha/pi-browser";
import { FakeBackend, fakeDriver, fixturePage } from "@parcha/pi-browser/testing";

export default function browser(env = process.env, vendor = "browserbase", signIn = undefined) {
  const log = process.env.FAUX_BROWSER_LOG;
  const seen = (name) => (env[name] ? "set" : "unset");
  if (log) appendFileSync(log, `${JSON.stringify({ op: "env", BROWSERBASE_API_KEY: seen("BROWSERBASE_API_KEY"), BROWSERBASE_PROJECT_ID: seen("BROWSERBASE_PROJECT_ID") })}\n`);
  if (log) appendFileSync(log, `${JSON.stringify({ op: "vendor", vendor, KERNEL_API_KEY: seen("KERNEL_API_KEY") })}\n`);
  // A local Chrome's run: the Chrome the server handed its process, if any.
  if (log && vendor === "chrome") appendFileSync(log, `${JSON.stringify({ op: "chrome", path: env.AGENTRUN_SERVE_BROWSER_CHROME ?? null })}\n`);
  if (log && signIn) {
    const values = (object) => Object.getOwnPropertyNames(object).map((name) => String(object[name]));
    const kernelEnv = (() => { try { return readFileSync("/proc/self/environ", "utf8"); } catch { return ""; } })();
    const inEnv = [...values(process.env), ...values(env), kernelEnv].some((value) => value.includes(signIn.ref));
    appendFileSync(log, `${JSON.stringify({ op: "sign-in", provider: signIn.provider, ref: signIn.ref, save: signIn.save, ref_in_env: inEnv })}\n`);
  }
  // A run's process that dies naming its sign-in's pointer in its last log line (what a run's failure message is made of).
  if (signIn && process.env.FAUX_BROWSER_DIE_WITH_REF) {
    process.stderr.write(`the browser died holding ${signIn.ref}\n`);
    process.exit(3);
  }
  const start = "https://example.test/";
  const backend = new FakeBackend({ name: process.env.FAUX_BROWSER_PROVIDER || vendor, start, caps: { profiles: true }, pages: { [start]: fixturePage(start, `The answer is forty-two. This browser is ${vendor}'s.`, "Example") }, ...(log ? { logFile: log } : {}) });
  const { downloads: _, ...withoutDownloads } = backend.provider;
  const provider = vendor === "kernel" ? withoutDownloads : backend.provider;
  const create = (spec, signal) => {
    if (log && spec.profile) appendFileSync(log, `${JSON.stringify({ op: "profile", name: spec.profile.name, save: spec.profile.save })}\n`);
    // A saving session refused in the words pi-browser's one-saver rule uses, which name the vendor's profile (Kernel's
    // name is the run's pointer).
    if (signIn && spec.profile?.save && process.env.FAUX_BROWSER_REFUSE_WITH_REF) throw new BrowserFailureError(browserFailure("refused", `browser profile "${signIn.ref}": one session at a time may save to a profile, and another session is saving to it now. Wait for it to end, or start without saving. No session was started.`));
    return provider.create(spec, signal);
  };
  return { provider: { ...provider, create }, driver: fakeDriver(backend) };
}
