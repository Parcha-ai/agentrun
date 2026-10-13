// The run goes to a second process and comes home, in real Chrome, over a slow link: the server's own home turn (sent about 15 ms after the page says `switched`) must reach the page's conversation. On a
// slow link, or a loaded laptop, the page was not yet the writer when it arrived and dropped it: no home turn, a 60 s wait, then the user's lines behind it (Miguel's practice run, five homes of five).
//   [DELAY_MS=0 one-way latency between the page and the server: 0 reproduces it; a delay slows the whole run and the line below may not leave the page on a loaded box (D4's 80 ms repro covers that)] [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/home-turn-check.ts
import { spawn } from "node:child_process";
import net, { createServer as createNetServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";
import { createServer, type Server } from "node:http";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS ?? "/tmp";
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const DELAY = Number(process.env.DELAY_MS ?? 0);
/** A TCP proxy that adds one-way latency in both directions, order kept: a stand-in for a tunnel to a laptop. */
function delayProxy(listen: number, target: number, oneWay: number): net.Server {
  const pipe = (from: net.Socket, to: net.Socket) => {
    let tail: Promise<void> = Promise.resolve();
    from.on("data", (chunk) => { const at = Date.now() + oneWay; tail = tail.then(() => new Promise<void>((r) => setTimeout(r, Math.max(0, at - Date.now())))).then(() => { if (!to.destroyed) to.write(chunk); }); });
    from.on("end", () => { tail = tail.then(() => new Promise<void>((r) => setTimeout(r, oneWay))).then(() => { to.end(); }); });
    from.on("error", () => to.destroy());
  };
  return net.createServer((client) => { const up = net.connect(target, "127.0.0.1"); up.on("error", () => client.destroy()); pipe(client, up); pipe(up, client); }).listen(listen, "127.0.0.1");
}
/** A model endpoint that answers every request with one short line, on the Responses API the agent uses (SSE). */
async function responsesStub(text: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const body = (() => { try { return JSON.parse(raw) as { input?: { type?: string; role?: string; content?: unknown }[] }; } catch { return {}; } })();
      const input = body.input ?? [];
      const lastUser = [...input].reverse().find((m) => m.role === "user");
      const asked = /do walk/.test(JSON.stringify(lastUser?.content ?? ""));
      const answered = input.some((m) => m.type === "function_call_output");
      res.writeHead(200, { "content-type": "text/event-stream" });
      event("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } });
      if (asked && !answered) {
        // a user line that says "do walk" makes the model call the robot's `do` tool, once
        const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "do", arguments: JSON.stringify({ skill: "walk" }), status: "completed" };
        event("response.output_item.added", { output_index: 0, item: { ...call, arguments: "", status: "in_progress" } });
        event("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: call.arguments });
        event("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: call.arguments });
        event("response.output_item.done", { output_index: 0, item: call });
        event("response.completed", { response: { id: "resp_1", status: "completed", output: [call], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
        res.end();
        return;
      }
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      event("response.content_part.added", { item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      event("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: text });
      event("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text });
      event("response.content_part.done", { item_id: "msg_1", output_index: 0, content_index: 0, part: item.content[0] });
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => new Promise((r) => server.close(() => r())) };
}
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "home-turn-"));
let server: ReturnType<typeof spawn> | undefined, proxy: net.Server | undefined, stub: Awaited<ReturnType<typeof responsesStub>> | undefined, cdp: Cdp | undefined, device: Awaited<ReturnType<Cdp["device"]>> | undefined;
let page: Awaited<ReturnType<Awaited<ReturnType<Cdp["device"]>>["open"]>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
type Item = { kind: string; text?: string; name?: string; status?: string; output?: string };
try {
  stub = await responsesStub("Understood.");
  const port = await freePort(), proxyPort = await freePort();
  const RUN = "home";
  server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", stub.url, "--grace-ms", "3000", "--log", join(dir, "server.log"), "--cloud", "remote-local", "--placer-module", join(import.meta.dirname, "_home-placer.ts")], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"] });
  let link = "";
  server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
  for (let i = 0; i < 100 && !link; i++) await sleep(100);
  if (!link) throw new Error("the server printed no run link");
  proxy = delayProxy(proxyPort, port, DELAY);
  cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
  device = await cdp.device();
  page = await device.open(`http://127.0.0.1:${proxyPort}${link}`.replace("#", "?robot=1&golive=1#"));
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 300);
  // record every `submit` frame the page receives, with the page's mode at that moment, and each `switched` it sends
  await ev(`(() => { window.__spy = []; const O = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.t === "switched") window.__spy.push({ at: performance.now(), sent: "switched", mode: demo.state.mode }); } catch {} return O.call(this, d); }; const A = EventTarget.prototype.addEventListener; EventTarget.prototype.addEventListener = function (t, f, o) { if (t === "message" && this instanceof WebSocket) { return A.call(this, t, (e) => { try { const m = JSON.parse(e.data); if (m.t === "submit") window.__spy.push({ at: performance.now(), got: m.requestId, mode: demo.state.mode }); } catch {} return f.call(this, e); }, o); } return A.call(this, t, f, o); }; return true; })()`);
  // (the page's socket was opened before the spy: the spy covers the next connection, the one the run comes home on)
  const say = async (text: string) => ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await page.until("demo.net().online && demo.state.placed", 60_000, 200); // a line typed before the page knows the server answers goes to its own conversation, not to the server
  await page.until(`!document.getElementById("input").disabled`, 60_000, 200); // a line typed while the composer is disabled is ignored
  for (let tries = 0; tries < 3; tries++) {
    await say("please work on this in the second process");
    if (await page.until("demo.items().length > 0", 8_000, 200).then(() => true, () => false)) break;
  }
  await page.until("demo.state.mode !== 'writer'", 150_000, 200).catch(() => undefined);
  const away = await ev<string>("demo.state.mode");
  if (away === "writer") console.log(`  never left: ${JSON.stringify(await ev("({ items: demo.items().slice(-3), banner: demo.state.banner, net: demo.net(), placed: demo.state.placed })")).slice(0, 600)}`);
  console.log(`  the run left the page: mode ${away}`);
  // home again: the page is the writer once more, and the server's home turn arrives
  await page.until("demo.state.mode === 'writer'", 120_000, 200);
  console.log("  the run is home");
  // the run's two turns are each answered by the stub: the one the user asked for (in the second process) and the home turn, here in the page: two assistant lines, the second one the home turn's
  const answers = `demo.items().filter((i) => i.kind === "assistant" && (i.text ?? "") !== "").length`;
  const homeTurn = await page.until(`${answers} >= 2`, 30_000, 250).then(() => true, () => false);
  console.log(`  assistant lines after coming home: ${await ev<number>(answers)}`);
  const spy = await ev<{ got?: string; sent?: string; mode: string }[]>("window.__spy ?? []");
  console.log(`  frames: ${JSON.stringify(spy)}`);
  const served = spy.find((s) => s.got?.startsWith("server-"));
  ok("the server's home turn arrived at the page", served !== undefined, spy);
  ok("and it ran: the agent answered it within 30 s of coming home", homeTurn, await ev("demo.items().slice(-4)"));
  if (served && served.mode !== "writer") console.log(`  (it arrived while the page was '${served.mode}': the window the fix keeps it through)`);
  // and the page's own tools work on its first turn back: the model calls `do` and the robot's tool answers (any text of its own, "no skill has come home yet" here), never the harness's "Tool do is not available"
  await ev(`(() => { const i = document.getElementById("input"); i.value = "please do walk"; document.getElementById("send").click(); return true; })()`);
  const tool = await page.until(`demo.items().some((i) => i.kind === "tool" && i.name === "do" && i.status !== "running")`, 60_000, 300).then(() => true, () => false);
  const doItem = await ev<Item | undefined>(`demo.items().find((i) => i.kind === "tool" && i.name === "do")`);
  ok("the model's call of the robot's do tool, on the first user turn back, reaches the tool (not 'Tool do is not available')", tool && !/is not available/.test(doItem?.output ?? ""), doItem);
  await page.screenshot(join(shots, "home-turn.png"));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, items: demo.items().slice(-4), spy: window.__spy }) : null)()").catch(() => null)).slice(0, 1500));
} finally {
  if (process.env.SERVER_LOG === "1") { try { console.log(readFileSync(join(dir, "server.log"), "utf8").split("\n").filter((l) => /placement|switch|submit|home|cloud/.test(l)).slice(0, 30).map((l) => l.slice(0, 220)).join("\n")); } catch { /* none */ } }
  await device?.close().catch(() => undefined);
  cdp?.close();
  server?.kill("SIGKILL");
  proxy?.close();
  await stub?.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
