// AGENTRUN_REQUIRE_LOCAL_CHROME=1 (CI) turns every skip for a missing or incapable Chrome into a failure.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
export const REQUIRED = process.env.AGENTRUN_REQUIRE_LOCAL_CHROME === "1";
export const NO_CHROME = REQUIRED ? false : !existsSync(CHROME) ? `needs Chrome at ${CHROME}` : false;
export const chromeVersion = () => { try { return execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(); } catch { return CHROME; } };
export function skipIncapable(t, error) {
  if (REQUIRED || (error?.cause?.method !== "Extensions.loadUnpacked" && !/does not support Extensions.loadUnpacked/.test(String(error?.message)))) return false;
  t.skip(`${chromeVersion()} refuses Extensions.loadUnpacked, so Stagehand's extension cannot load`);
  return true;
}
/** Stagehand's extension posts traces to example.com unless told otherwise: every test Stagehand takes the package's
 *  closed loopback port. */
export { STAGEHAND_TELEMETRY as LOCAL_TELEMETRY } from "../../dist/driver/stagehand.js";

/** Through `ps`, which Linux and macOS share: the tests never read /proc, as the provider does not. */
const ps = (pid, field) => { try { return execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], { encoding: "utf8" }).trim(); } catch { return ""; } };
export const isRunning = (pid) => { const state = ps(pid, "stat"); return state !== "" && !state.startsWith("Z"); };
export const commandLine = (pid) => ps(pid, "args");
