import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cdpProvider } from "../../dist/providers/cdp.js";
import { scratch } from "./scratch.mjs";

const spec = { tag: "victim-1", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} };

test("holds a Chrome, a child host and a scratch directory until it is killed", async (t) => {
  const dir = await scratch(t, "victim-");
  const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  t.after(() => host.kill("SIGKILL"));
  let chrome = null;
  if (process.env.VICTIM_CHROME) {
    const provider = cdpProvider({ chrome: { executablePath: process.env.VICTIM_CHROME, profileRoot: path.join(dir, "profiles") } });
    const ref = await provider.create(spec, new AbortController().signal);
    t.after(() => provider.release(ref));
    chrome = ref.id;
  }
  const report = JSON.stringify({ pid: process.pid, host: host.pid, root: process.env.TMPDIR, chrome });
  // The report is written aside and renamed into place, so the test, which waits for the file, never reads it half
  // written. Forced race: VICTIM_SLOW_REPORT_MS pauses between its two halves, as a loaded box can between a file's
  // creation and its contents.
  const partial = `${process.env.VICTIM_READY}.partial`;
  fs.writeFileSync(partial, report.slice(0, report.length >> 1));
  if (process.env.VICTIM_SLOW_REPORT_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.VICTIM_SLOW_REPORT_MS)));
  fs.appendFileSync(partial, report.slice(report.length >> 1));
  fs.renameSync(partial, process.env.VICTIM_READY);
  await new Promise(() => setInterval(() => {}, 1_000));
});
