// Hill 4's gaps, in real Chrome (no model, no cloud: `?brain=off`, the computer alone, the run checked out by the button): what the page does when a check-in does not go cleanly.
//   1. the server took the check-in and its reply was lost (CDP fails the response): the page sends it again, the server answers from its receipt, and the page comes home;
//   2. the server answers NOT_CHECKED_OUT (CDP fulfils the request with that): the page keeps its copy, says so, nothing is deleted, and pressing Go online again works;
//   3. the page is reloaded while the request is held on its way (the server never saw it): the reloaded page sends the saved check-in and comes home;
//   4. the page is reloaded after the server took the check-in and before the page saw the reply: the reloaded page sends the same bytes, the server answers from its receipt, and it comes home.
// Each ends with the files written offline on the server's disk, the mark gone, and the page the server's writer on the same conversation.
//   [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/checkin-resume-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const shots = process.env.SHOTS ?? "/tmp";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "resume-"));
const port = await freePort();
const RUN = "rs";
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000"], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
let link = "";
const serverLog: string[] = [];
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; serverLog.push(String(d)); });
server.stderr!.on("data", (d) => serverLog.push(String(d)));
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
const url = `http://127.0.0.1:${port}${link}`.replace("#", "?brain=off&golive=1#");
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
const work = join(dir, "runs", RUN, "work");
const mark = join(dir, "runs", RUN, "store", "checkout.json");
const receipt = join(dir, "runs", RUN, "store", "checkin.json");
const fileOnServer = (name: string) => (existsSync(join(work, name)) ? readFileSync(join(work, name), "utf8") : null);
const checkpoints = (n: number) => ev<number>("demo.checkins().length").then((c) => c >= n);

/** Check the run out with the button and write `name` while it is checked out. */
const goOffline = async (name: string) => {
  await ev("document.getElementById('offline').click()");
  await page!.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 300_000, 500);
  if ((await ev<string>("demo.state.mode")) !== "offline") throw new Error(`checkout failed: ${await ev<string>("demo.state.banner")}`);
  await page!.until("demo.computer() !== null && demo.computer().booted", 120_000, 500);
  await ev(`demo.writeFile(${JSON.stringify(name)}, ${JSON.stringify(`from ${name}`)})`);
};
/** `n`: check-ins this page load has seen (a reload starts again from 0). */
const home = async (n: number, scenario: string) => {
  await page!.until(`(demo.state.mode === 'writer' && demo.checkins().length >= ${n}) || /could not go online/.test(demo.state.banner)`, 180_000, 500).catch(() => undefined);
  const mode = await ev<string>("demo.state.mode");
  ok(`${scenario}: the page is the server's writer again`, mode === "writer", { mode, banner: await ev("demo.state.banner") });
};
const intercept = (handler: (p: { requestId: string; request: { url: string; method: string }; responseStatusCode?: number }) => Promise<void>) => {
  cdp.on("Fetch.requestPaused", (params, session) => { if (session === page!.sessionId) void handler(params as never).catch(() => undefined); });
};
let onPaused: ((p: { requestId: string; request: { url: string; method: string }; responseStatusCode?: number }) => Promise<void>) | undefined;
intercept(async (p) => { if (onPaused) await onPaused(p); else await page!.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => undefined); });

try {
  page = await device.open(url);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  const root = await ev<string>("String(demo.state.active.id)");
  const sameConversation = async (scenario: string) => ok(`${scenario}: the same conversation, on the cloud model`, (await ev<string>("String(demo.state.active.id)")) === root && /^pipe\//.test((await ev<{ model: string }>("demo.agent()")).model));

  // ---- 0. the ordinary cycle
  await goOffline("zero.txt");
  await ev("document.getElementById('online').click()");
  await home(1, "an ordinary check-in");
  ok("an ordinary check-in: the file is on the server's disk and the mark is gone", fileOnServer("zero.txt") === "from zero.txt" && !existsSync(mark), { mark: existsSync(mark) });
  await sameConversation("an ordinary check-in");

  // ---- 1. the reply is lost
  await goOffline("one.txt");
  let seen = 0;
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/checkin", requestStage: "Response" }] });
  onPaused = async (p) => {
    if (!p.request.url.endsWith("/checkin")) return void (await page!.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => undefined));
    seen++;
    if (seen === 1) await page!.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionReset" }); // the server answered; the page never hears it
    else await page!.send("Fetch.continueRequest", { requestId: p.requestId });
  };
  await ev("document.getElementById('online').click()");
  await home(2, "a lost reply");
  await page.send("Fetch.disable");
  onPaused = undefined;
  ok("a lost reply: the page sent the check-in again (2 requests) and the server answered the second from its receipt", seen === 2 && serverLog.join("").includes("checkin.replayed"), { seen });
  ok("a lost reply: the file is on the server's disk, the mark is gone, the receipt is there", fileOnServer("one.txt") === "from one.txt" && !existsSync(mark) && existsSync(receipt));
  await sameConversation("a lost reply");

  // ---- 2. the server says NOT_CHECKED_OUT (and is wrong): the page keeps its copy and says so; pressing the button again works
  await goOffline("two.txt");
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/checkin", requestStage: "Request" }] });
  let fulfilled = 0;
  onPaused = async (p) => {
    if (!p.request.url.endsWith("/checkin")) return void (await page!.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => undefined));
    fulfilled++;
    await page!.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 409, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ error: "the run is not checked out", code: "NOT_CHECKED_OUT" })).toString("base64") });
  };
  await ev("document.getElementById('online').click()");
  await page.until("/could not go online/.test(demo.state.banner)", 120_000, 500);
  await page.until("demo.state.mode === 'offline' && !demo.state.checkingIn", 120_000, 500);
  const banner = await ev<string>("demo.state.banner");
  ok("NOT_CHECKED_OUT: the page says so and keeps its copy", /not checked out/.test(banner) && /keeps its copy/.test(banner) && fulfilled === 1, { banner, fulfilled });
  ok("NOT_CHECKED_OUT: it is offline again, with the file still in its copy and on the computer", (await ev<string>("demo.state.mode")) === "offline" && (await ev<{ path: string }[]>("demo.saved()")).some((f) => f.path === "two.txt"), await ev("demo.state.mode"));
  ok("NOT_CHECKED_OUT: nothing reached the server's disk, which is still checked out", fileOnServer("two.txt") === null && existsSync(mark));
  await page.send("Fetch.disable");
  onPaused = undefined;
  await page.until("demo.net().online === true", 20_000, 250);
  await ev("document.getElementById('online').click()");
  await home(3, "a retry after NOT_CHECKED_OUT");
  ok("a retry after NOT_CHECKED_OUT: the file is on the server's disk and the mark is gone", fileOnServer("two.txt") === "from two.txt" && !existsSync(mark));
  await sameConversation("a retry after NOT_CHECKED_OUT");

  // ---- 3. reloaded while the request is on its way (the server never gets it)
  await goOffline("three.txt");
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/checkin", requestStage: "Request" }] });
  let held = false;
  onPaused = async (p) => { if (p.request.url.endsWith("/checkin")) held = true; else await page!.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => undefined); };
  await ev("document.getElementById('online').click()");
  for (let i = 0; i < 120 && !held; i++) await sleep(250);
  ok("a reload mid check-in: the request is on its way and held", held);
  ok("the server has not seen it: still checked out, file not there", existsSync(mark) && fileOnServer("three.txt") === null);
  onPaused = undefined;
  await page.send("Fetch.disable");
  await page.send("Page.reload");
  await sleep(1500);
  await page.until("globalThis.demo && (demo.state.mode === 'writer' || demo.state.mode === 'offline' || demo.state.mode === 'lost')", 300_000, 500);
  await home(1, "a reload mid check-in");
  ok("a reload mid check-in: the reloaded page sent the saved check-in; the file is on the server's disk and the mark is gone", fileOnServer("three.txt") === "from three.txt" && !existsSync(mark), { file: fileOnServer("three.txt"), mark: existsSync(mark) });
  ok("a reload mid check-in: the same conversation, on the cloud model", (await ev<string>("String(demo.state.active.id)")) === root && /^pipe\//.test((await ev<{ model: string }>("demo.agent()")).model));

  // ---- 4. reloaded after the server took it and before the page saw the reply
  await goOffline("four.txt");
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/checkin", requestStage: "Response" }] });
  let answered = 0;
  onPaused = async (p) => { if (p.request.url.endsWith("/checkin")) answered = p.responseStatusCode ?? 0; else await page!.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => undefined); };
  await ev("document.getElementById('online').click()");
  for (let i = 0; i < 120 && !answered; i++) await sleep(250);
  ok("a reload after the server took it: the server answered 200 and the page has not seen it", answered === 200 && fileOnServer("four.txt") === "from four.txt" && !existsSync(mark), { answered });
  onPaused = undefined;
  await page.send("Fetch.disable");
  await page.send("Page.reload");
  await sleep(1500);
  await page.until("globalThis.demo && (demo.state.mode === 'writer' || demo.state.mode === 'offline' || demo.state.mode === 'lost')", 300_000, 500);
  await home(1, "a reload after the server took it");
  ok("a reload after the server took it: the reloaded page sent the same bytes and the server answered from its receipt", serverLog.join("").split("checkin.replayed").length >= 3, serverLog.join("").split("checkin.replayed").length - 1);
  ok("a reload after the server took it: the file is still on the server's disk, the same conversation is on the cloud model", fileOnServer("four.txt") === "from four.txt" && (await ev<string>("String(demo.state.active.id)")) === root && /^pipe\//.test((await ev<{ model: string }>("demo.agent()")).model));
  await page.screenshot(join(shots, "resume-final.png"));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors in the page", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, net: demo.net(), banner: demo.state.banner, checkingIn: demo.state.checkingIn, checkins: demo.checkins() }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-12).join("\n"));
    await page.screenshot(join(shots, "resume-failed.png")).catch(() => undefined);
  }
  console.log(serverLog.join("").split("\n").filter((l) => /checkin|checkout|error/i.test(l)).slice(-12).join("\n"));
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
