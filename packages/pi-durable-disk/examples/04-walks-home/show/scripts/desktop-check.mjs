// The live-desktop path in real Chrome, with a stand-in for D4's 03 server (no Modal machines): a ticket route that wants
// the run's secret, an MJPEG stream of real JPEG frames, and a desktop that is "not up yet" for the first seconds. The stage
// plays its scripted run, which is on a VM from 0:40. Checks that the picture appears once the host has one, moves, never
// carries the secret to the page, and goes away (closing the host's stream) when the run leaves the VM.
//   CDP_URL=http://127.0.0.1:9444 node scripts/desktop-check.mjs [shots-prefix]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openTab, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const show = join(here, "..");
const shots = process.argv[2];
const SECRET = `s3cret-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const TICKET = `tkt${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const until = async (fn, ms) => {
  for (let t = 0; t < ms; t += 250) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return false;
};

// Real JPEG frames: screenshots of a page that says FRAME n.
const frames = [];
const frameSrc = createServer((_, res) => res.end(`<!doctype html><body style="margin:0;background:#123;color:#fff;font:700 120px sans-serif"><div style="padding:240px 100px">DESKTOP FRAME <span id=n></span></div><script>document.getElementById("n").textContent=new URLSearchParams(location.search).get("n")</script>`));
await new Promise((r) => frameSrc.listen(0, "127.0.0.1", r));
const grab = await openTab(`http://127.0.0.1:${frameSrc.address().port}/?n=0`, { width: 1280, height: 720 });
for (let n = 1; n <= 6; n++) {
  await grab.send("Page.navigate", { url: `http://127.0.0.1:${frameSrc.address().port}/?n=${n}` });
  await sleep(500);
  frames.push(Buffer.from((await grab.send("Page.captureScreenshot", { format: "jpeg", quality: 70 })).data, "base64"));
}
await grab.close();
frameSrc.close();

// The stand-in for the 03 server.
const readyAt = Date.now() + 6000;
const host = { tickets: 0, refused: 0, streams: 0, open: 0, unauthenticatedStreams: 0 };
const fake = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/run/stage/desktop-ticket") {
    if (req.headers.authorization !== `Bearer ${SECRET}` || Date.now() < readyAt) {
      host.refused++;
      return void res.writeHead(404).end();
    }
    host.tickets++;
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: `/desktop/${TICKET}.mjpeg`, ttlMs: 600000 }));
  }
  if (req.method === "GET" && req.url === `/desktop/${TICKET}.mjpeg`) {
    host.streams++;
    host.open++;
    if (req.headers.authorization) host.unauthenticatedStreams++;
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cross-origin-resource-policy": "same-origin" });
    let i = 0;
    const send = () => res.write(Buffer.concat([Buffer.from(`--frame\r\ncontent-type: image/jpeg\r\ncontent-length: ${frames[i % 6].length}\r\n\r\n`), frames[i++ % 6], Buffer.from("\r\n")]));
    send();
    const t = setInterval(send, 250);
    req.on("close", () => (clearInterval(t), host.open--));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const root = join(homedir(), "tmp-d5", `desk-${Date.now().toString(36)}`);
mkdirSync(root, { recursive: true, mode: 0o755 });
const linkFile = join(root, "link");
writeFileSync(linkFile, `http://127.0.0.1:${fake.address().port}/run/stage#${SECRET}\n`, { mode: 0o600 });

const port = 8798;
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_DESKTOP_LINK_FILE: linkFile, SHOW_START: "44", SHOW_AUTOKILL: "off" }, stdio: "ignore" });
let tab;
try {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok).catch(() => false)), 20_000);
  tab = await openTab(`http://127.0.0.1:${port}/`, { width: 1600, height: 900 });
  const ev = (s) => tab.eval(s);
  const visible = () => ev(`!document.getElementById("desktop").hidden`);
  expect("the desktop panel appears when the run is on a VM", await until(visible, 15_000));
  expect("while the host has no desktop the panel says so and shows no picture", (await ev(`!document.querySelector("#desktop .dnote").hidden && document.querySelector("#desktop img").hidden`)) === true);
  if (shots) await tab.screenshot(`${shots}-desktop-0-waiting.png`);
  expect("the picture appears once the host has one (frames decoded at 1280 wide)", await until(async () => (await ev(`(() => { const i = document.querySelector("#desktop img"); return !i.hidden && i.naturalWidth === 1280 })()`)), 30_000));
  const src = await ev(`document.querySelector("#desktop img").getAttribute("src")`);
  expect("the picture is a same-origin ticket path", src === `/desktop/${TICKET}.mjpeg`, src);
  const hash = () => ev(`(() => { const i = document.querySelector("#desktop img"); const c = document.createElement("canvas"); c.width = 160; c.height = 90; const g = c.getContext("2d"); g.drawImage(i, 0, 0, 160, 90); return c.toDataURL("image/png").slice(-400); })()`);
  const seen = new Set();
  for (let k = 0; k < 8; k++) (seen.add(await hash()), await sleep(300));
  expect("the picture moves (more than one distinct frame in 2.4 s)", seen.size > 1, seen.size);
  if (shots) await tab.screenshot(`${shots}-desktop-1-live.png`);
  // Everything the page can read: its markup, the URLs it loaded, its storage, and what the stage's own API tells it.
  const S = JSON.stringify(SECRET);
  const leaked = await ev(`(async () => JSON.stringify({
    html: document.documentElement.outerHTML.includes(${S}),
    resources: performance.getEntriesByType("resource").some((r) => r.name.includes(${S})),
    storage: JSON.stringify([localStorage, sessionStorage]).includes(${S}),
    api: (await (await fetch("/api/desktop")).text()).includes(${S}),
  }))()`);
  expect("the run's secret is nowhere the page can see it", leaked && !Object.values(JSON.parse(leaked)).some(Boolean), leaked);
  expect("the host saw the secret only on the ticket request, never on the stream", host.unauthenticatedStreams === 0 && host.tickets >= 1 && host.refused >= 1, host);
  expect("the host's stream is open while the picture is shown", host.open >= 1, host);
  expect("the panel goes away when the run leaves the VM, and the host's stream is closed", await until(async () => (await ev(`document.getElementById("desktop").hidden`)) && host.open === 0, 45_000), host);
  const bad = tab.logs.filter((l) => /error|exception/i.test(l) && !/status of (404|409)|favicon/.test(l));
  expect("no console errors on the stage", bad.length === 0, bad);
} catch (error) {
  console.log(`FAIL ${error.message}`);
  failed++;
} finally {
  await tab?.close().catch(() => {});
  stage.kill("SIGTERM");
  fake.close();
}
process.exit(failed ? 1 : 0);
