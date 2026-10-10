// Start (or reuse) this lane's own headless Chrome for recording (the checks no longer need it: a check started without CDP_URL runs its own Chrome and closes it, see own-chrome.mjs): node scripts/chrome.mjs [port=9444]
// The shared Chrome on :9222 has WebGL disabled, so the tab app's MuJoCo view cannot start there. This one renders in
// software (SwiftShader). Its profile lives in D5_CHROME_PROFILE (default ~/tmp-d5/chrome-profile); stop it with
// `node scripts/chrome.mjs --stop`. Use it with CDP_URL=http://127.0.0.1:9444.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 9444);
const dir = process.env.D5_CHROME_DIR ?? join(homedir(), "tmp-d5");
const profile = process.env.D5_CHROME_PROFILE ?? join(dir, "chrome-profile");
const pidFile = join(dir, "chrome.pid");
mkdirSync(profile, { recursive: true, mode: 0o755 });

if (process.argv.includes("--stop")) {
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")));
    } catch {}
    rmSync(pidFile, { force: true });
  }
  process.exit(0);
}

const up = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false);
if (!up) {
  const bin = process.env.CHROME ?? "/usr/bin/google-chrome";
  const child = spawn(
    bin,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--window-size=1600,900",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}
console.log(`chrome ready on 127.0.0.1:${port}`);
