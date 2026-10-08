// The local Chrome the real-browser tests use: CHROME_PATH or /usr/bin/google-chrome. Without a Chrome, or with one that
// refuses Extensions.loadUnpacked (so Stagehand's extension cannot load), a test skips with that reason;
// AGENTRUN_REQUIRE_LOCAL_CHROME=1 (CI) turns every one of those skips into a failure.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
export const REQUIRED = process.env.AGENTRUN_REQUIRE_LOCAL_CHROME === "1";
/** The `skip` option of a test that needs a Chrome binary. */
export const NO_CHROME = REQUIRED ? false : !existsSync(CHROME) ? `needs Chrome at ${CHROME}` : false;
export const chromeVersion = () => { try { return execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(); } catch { return CHROME; } };
/** Call with an error from a step that loads Stagehand's extension: when this Chrome cannot load it and the run does not
 *  require one, the test skips and this returns true (the caller returns); anything else is the caller's to throw. */
export function skipIncapable(t, error) {
  if (REQUIRED || (error?.cause?.method !== "Extensions.loadUnpacked" && !/does not support Extensions.loadUnpacked/.test(String(error?.message)))) return false;
  t.skip(`${chromeVersion()} refuses Extensions.loadUnpacked, so Stagehand's extension cannot load`);
  return true;
}
/** Stagehand's extension posts traces to example.com unless told otherwise; every Stagehand a test creates takes the package's
 *  own loopback endpoint (a closed port: nothing listens, nothing leaves the host), the one source for it. */
export { STAGEHAND_TELEMETRY as LOCAL_TELEMETRY } from "../../dist/driver/stagehand.js";

/** A process's state and command line through `ps`, which Linux and macOS share (the tests never read /proc, as the provider does not). */
const ps = (pid, field) => { try { return execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], { encoding: "utf8" }).trim(); } catch { return ""; } };
/** Alive and not a zombie. */
export const isRunning = (pid) => { const state = ps(pid, "stat"); return state !== "" && !state.startsWith("Z"); };
export const commandLine = (pid) => ps(pid, "args");
