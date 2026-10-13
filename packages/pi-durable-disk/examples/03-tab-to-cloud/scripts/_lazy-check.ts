// scratch: does wllama 3.6.1's llama.cpp honour grammar_lazy + grammar_triggers?
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";
const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODEL_DISK = process.env.MODEL_DISK!;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "lazy-"));
const port = await freePort();
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", "lz", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/model/"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
const page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?configure=1&threads=6#"));
try {
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  const dest = join(dir, "runs", "lz", "work/home/model");
  mkdirSync(dest, { recursive: true });
  for (const n of readdirSync(join(MODEL_DISK, "home/model")).sort((a, b) => (a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b)))) copyFileSync(join(MODEL_DISK, "home/model", n), join(dest, n));
  await page.until("demo.brain().swapped === true", 400_000, 1000);
  for (const variant of ["none", "lazy-with-trigger", "lazy-without-trigger"]) {
    const r = await page.evaluate<unknown>(`demo.probe("Write hello.js that prints hi, then run it.", ${JSON.stringify(variant)}).catch((e) => ({ error: String(e) }))`);
    console.log(`### ${variant}\n${JSON.stringify(r, null, 1).slice(0, 1500)}`);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
