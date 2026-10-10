// Import this first in a check script: `import "./own-chrome.mjs";`. A check should never leave a browser running.
//   CDP_URL set     -> someone else's Chrome: the check uses it and never closes it (it only opens and closes its own tabs).
//   CDP_URL not set -> this module starts a headless Chrome of its own (software GL, a free port, a profile kept per script so the tab app's compiled wasm and its HTTP cache
//                      stay warm between runs: a cold profile on a loaded box made the tab late), points CDP_URL at it before the CDP client is loaded, and closes it (the whole
//                      process group) whenever the script ends: normally, on a failed check, on an uncaught error, on Ctrl-C or SIGTERM.
// (Only a SIGKILL of the script itself can leave it behind; `node scripts/chrome.mjs --stop` is for a Chrome started by hand.)
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";

if (!process.env.CDP_URL) {
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  // One profile per script (two runs of the same script at once would share it: run them one after the other, or give each its own CDP_URL).
  const profile = process.env.SHOW_CHECK_PROFILE ?? join(homedir(), ".cache", "agentrun-show-check", basename(process.argv[1] ?? "check", ".mjs"));
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    process.env.CHROME ?? "/usr/bin/google-chrome",
    ["--headless=new", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--window-size=1600,900", "about:blank"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      process.kill(-child.pid, "SIGKILL"); // the whole process group: the GPU and renderer processes too
    } catch {}
  };
  process.on("exit", close);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));
  process.on("uncaughtException", (e) => {
    console.error(e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    console.error(e);
    process.exit(1);
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    close();
    throw new Error("could not start a Chrome for the check");
  }
  process.env.CDP_URL = `http://127.0.0.1:${port}`;
}
