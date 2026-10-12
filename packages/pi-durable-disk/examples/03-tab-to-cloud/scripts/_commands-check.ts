// scratch (not for a PR): which shell commands exist and behave on the in-browser computer with the network off.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "cmds-"));
const port = await freePort();
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--local", dir, "--run", "cmd", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
const page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?brain=off#"));
const ev = <T>(e: string) => page.evaluate<T>(e);
type R = { exitCode?: number; output?: string; error?: string };
const run = (c: string) => ev<R>(`demo.exec(${JSON.stringify(c)})`);
try {
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await ev("document.getElementById('offline').click()");
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 300_000, 500);
  server.kill("SIGKILL");
  await new Promise((r) => server.once("exit", r));
  await page.send("Network.enable");
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
  await page.send("Page.reload");
  await sleep(1000);
  await page.until("globalThis.demo && demo.state.mode === 'offline' && demo.computer() !== null", 300_000, 500);
  const comp = await ev<{ booted: boolean }>("demo.computer()");
  console.log(`offline, computer booted: ${comp.booted}`);
  // existence
  const names = "grep wc sed head tail ls mv cp rm mkdir printf sort uniq cat echo test [ node npm touch chmod find awk tr cut tee xargs diff basename dirname date env pwd cd true false python3 git curl sh bash seq expr tac rev nl paste comm join split stat du df file less more tree jq".split(" ");
  const exist = await run(`for c in ${names.join(" ")}; do if command -v "$c" >/dev/null 2>&1; then echo "$c=yes"; else echo "$c=NO"; fi; done`);
  console.log("EXIST:", (exist.output ?? "").trim().split("\n").join(" "));
  const setup = await run(`printf 'apple\\nbanana\\napple pie\\ncherry\\n' > f.txt; printf 'zzz\\n' > g.txt; printf '{"n": 41, "name": "x"}\\n' > data.json; printf 'b\\na\\nb\\nc\\na\\nb\\n' > dup.txt; printf '10\\n9\\n100\\n' > nums.txt; echo setup-done`);
  console.log("setup:", setup.exitCode, (setup.output ?? "").trim());
  const probes: [string, string][] = [
    ["c5: unhandled rejection", "printf 'Promise.reject(new Error(\\\"rej\\\"))\\n' > app5.js; cat app5.js; node app5.js > o5 2> e5; echo exit=$?; echo stderr_lines=$(wc -l < e5); head -5 e5"],
    ["c6: process.exit(2) inside", "printf 'console.log(1); process.exit(2)\\n' > app6.js; node app6.js; echo exit=$?"],
  ];
  for (const [name, cmd] of probes) {
    const r = await run(cmd);
    console.log(`### ${name}\n${(r.output ?? r.error ?? "").slice(0, 3500)}`);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
