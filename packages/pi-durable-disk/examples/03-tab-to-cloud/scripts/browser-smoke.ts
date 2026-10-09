// One device opens a run's link in headless Chrome, the agent boots in the tab, answers one prompt with tools, and the
// files panel shows the files. Prints timings and the page's console; screenshots go to $SHOTS (default /tmp).
//   node scripts/browser-smoke.ts <run link> ["prompt"]
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const link = process.argv[2]!;
const prompt = process.argv[3] ?? "Write a file notes/plan.md with a three-step plan for a tiny todo CLI in node, then create todo.js implementing it and run `node todo.js add milk` and `node todo.js list`.";
const shots = process.env.SHOTS ?? "/tmp";
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
const cdp = await Cdp.connect();
const device = await cdp.device();
let page: Awaited<ReturnType<typeof device.open>> | undefined;
try {
  page = await device.open(link);
  await page!.until("globalThis.demo && demo.state.mode === 'writer'", 90_000, 500);
  console.log(JSON.stringify({ at: at(), event: "writer", boot: await page.evaluate("demo.state.bootMs") }));
  await page!.screenshot(join(shots, "smoke-1-booted.png"));
  await page!.evaluate(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(prompt)}; document.getElementById("send").click(); return true; })()`);
  await page!.until("demo.state.chat.busy === true", 30_000);
  console.log(JSON.stringify({ at: at(), event: "busy" }));
  await page!.until("demo.state.chat.busy === false", 300_000, 1000);
  await new Promise((r) => setTimeout(r, 1500));
  console.log(JSON.stringify({ at: at(), event: "idle", files: await page.evaluate("demo.files()") }));
  const items = await page!.evaluate<{ kind: string; text?: string; name?: string; status?: string; args?: string; output?: string }[]>("demo.items()");
  for (const item of items) console.log(JSON.stringify({ kind: item.kind, name: item.name, status: item.status, text: item.text?.slice(0, 200), ...(item.status === "error" ? { args: item.args?.slice(0, 200), output: item.output?.slice(0, 400) } : {}) }));
  const timings = await page!.evaluate<{ commit: { client: number }[]; files: { client: number }[] }>("demo.timings()");
  const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
  console.log(JSON.stringify({ commits: timings.commit.length, commitP50: p50(timings.commit.map((c) => c.client)), writeThroughs: timings.files.length, writeThroughP50: p50(timings.files.map((c) => c.client)) }));
  await page!.screenshot(join(shots, "smoke-2-done.png"));
  console.log(page!.console.filter((l) => !l.startsWith("debug")).slice(-20).join("\n"));
} catch (error) {
  console.log(JSON.stringify({ at: at(), failed: (error as Error).message }));
  if (page) {
    console.log(JSON.stringify(await page.evaluate("globalThis.demo ? { mode: demo.state.mode, banner: demo.state.banner, placement: demo.state.placement, coi: crossOriginIsolated } : { noDemo: true, coi: crossOriginIsolated, href: location.href }").catch((e) => String(e))));
    console.log(page!.console.slice(-30).join("\n"));
    await page.screenshot(join(shots, "smoke-failed.png")).catch(() => undefined);
  }
  process.exitCode = 1;
} finally {
  await device.close();
  cdp.close();
}
