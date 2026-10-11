// The tab's own events for the self-tools beats, rendered by the obsession stage in a real Chrome (selftools.ts, selftools-view.ts, page/tab-link.ts).
//  1. The rehearsal (SHOW_OBSESSION_BRAIN=1 SHOW_OBSESSION_SELFTOOLS=1): the homecoming bytes line, ONLINE, OFFLINE with a rule's decision card, the tool strip, the check-in line and caption,
//     the cloud decision card; and that the pieces do not cover the chat input or run outside the window.
//  2. The opener bridge in one origin, with the stage under /show/ and the tab at /run/r1 as the 03 server packages them (a cross-origin opener is severed by COOP, which the real tab needs): a stand-in agent tab, served by the same origin as the stage with the same isolation
//     headers, posts the tab's events to its opener; the stage opens it with window.open, shows them, ignores a forged message from another origin, and after a reload of the stage finds the
//     tab again by name WITHOUT reloading it.
//   [CDP_URL=...] node scripts/obsession-selftools-check.mjs
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { freePort, openTab, sleep, waitForStage } from "./cdp.mjs";

const shots = process.env.SHOTS; // optional: a directory for screenshots
if (shots) mkdirSync(shots, { recursive: true });
const show = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

async function stageServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "obsession", SHOW_OBSESSION_THINK: "1", ...env }, stdio: "ignore" });
  await waitForStage(port, child);
  return { port, child, base: `http://127.0.0.1:${port}/` };
}

// ---- 1. the rehearsal
{
  const s = await stageServer({ SHOW_OBSESSION_BRAIN: "1", SHOW_OBSESSION_SELFTOOLS: "1" });
  const seek = (seconds) => fetch(new URL("/api/dev/seek", s.base), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });
  try {
    await seek(0);
    const tab = await openTab(new URL("/obsession/", s.base).href, { width: 1600, height: 900 });
    try {
      await sleep(2500);
      const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
      const snap = () => read(`(() => { const t = (id) => { const e = document.getElementById(id); return e && !e.hidden ? e.innerText : null; }; const box = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1; return { l: r.left * z, t: r.top * z, r: r.right * z, b: r.bottom * z }; }; return { net: t("net"), netOnline: document.getElementById("net").dataset.online, selftools: t("selftools"), strip: t("toolstrip"), stripBox: box("toolstrip"), cap: document.getElementById("vcaption")?.hidden ? "" : document.getElementById("vcaption")?.querySelector(".txt")?.textContent ?? "", input: box("chatin"), card: document.querySelector(".rc")?.dataset.brain ?? null, w: innerWidth * (parseFloat(getComputedStyle(document.documentElement).zoom) || 1), h: innerHeight * (parseFloat(getComputedStyle(document.documentElement).zoom) || 1) }; })()`);
      const at = async (seconds) => { await seek(seconds); await sleep(1700); return snap(); };
      const done = 14 + 148.4 + 2 + 140.2;
      let r = await at(done + 8);
      expect("home: ONLINE, and the homecoming's bytes with 'base 0 bytes' (the plan said the base was already here)", r.net === "ONLINE" && r.netOnline === "true" && /Came home: 18\.4 MB on the wire in 1\.4 s/.test(r.selftools ?? "") && /base 0 bytes/.test(r.selftools ?? ""), r);
      r = await at(done + 24);
      expect("offline: the pill says OFFLINE, and the decision card says the model in this tab answers, decided by a rule", r.net === "OFFLINE" && r.netOnline === "false" && r.card === "tab-local" && /answering now\s*\n?the model in this tab/i.test(r.selftools ?? "") && /decided by a rule/.test(r.selftools ?? ""), r);
      expect("offline: the caption says it, kept", /The agent's tab is offline: no network and the ping failed/.test(r.cap), r.cap);
      r = await at(done + 35);
      expect("tools: the strip shows write and bash, each done, with the first line of what it printed", /write hello\.js/.test(r.strip ?? "") && /bash node hello\.js/.test(r.strip ?? "") && /hello from the browser/.test(r.strip ?? "") && !/…\n/.test(r.strip ?? ""), r.strip);
      expect("tools: the strip is inside the window and does not reach the chat input", r.stripBox !== null && r.stripBox.l >= 0 && r.stripBox.r <= r.w && r.stripBox.t >= 0 && r.stripBox.b <= r.h && r.stripBox.r < r.input.l, { strip: r.stripBox, input: r.input });
      if (shots) await tab.screenshot(join(shots, "selftools-tools.png"));
      r = await at(done + 49);
      expect("online again: ONLINE, and the check-in line says what came home (1 file, 2 changes, 1.2 s)", r.net === "ONLINE" && /Checked in: 1 file written offline came home, 2 changes, in 1\.2 s/.test(r.selftools ?? ""), r);
      expect("online again: the check-in is a caption", /Checked in: 1 file written offline came home/.test(r.cap), r.cap);
      r = await at(done + 54);
      expect("the cloud decision card: the cloud model answers, 93% sure, decided by Jev", r.card === "cloud" && /the cloud model/.test(r.selftools ?? "") && /decided by Jev, 93% sure, in 396 ms/.test(r.selftools ?? ""), r);
      if (shots) await tab.screenshot(join(shots, "selftools-cloud.png"));
      const before = await tab.eval(`document.getElementById("chatin").getBoundingClientRect().width`);
      expect("the chat input is still usable", before > 100, before);
    } finally {
      await tab.close();
    }
  } finally {
    s.child.kill();
  }
}

// ---- 2. the opener bridge, one origin
{
  const s = await stageServer({});
  let loads = 0;
  let maxN = 0;
  const TAB_HTML = `<!doctype html><title>agent tab</title><script>
const stage = new URL(location.href).searchParams.get("stage");
fetch("/loaded");
const say = (type, detail) => window.opener && stage && window.opener.postMessage({ source: "walks-home-tab", type, run: "r1", ...detail }, stage);
say("net", { online: false, reason: "no network and the ping failed" });
say("brain", { event: "brain.decision", brain: "tab-local", answering: "the model in this tab", reason: "offline: the model in this tab is the only brain", confidence: null, decidedBy: "rule", ms: 0 });
say("checkin", { phase: "done", head: "h-14", files: 3, changes: 5, ms: 1204 });
say("homecoming", { phase: "fetched", prefetch: false, plan: { base: false, adapters: ["a.gguf"], bytes: 18400000 }, fetched_bytes: 18400000, fetch_ms: 1380 });
let n = 0; setInterval(() => { n++; fetch("/hit?n=" + n); }, 500);
</script>`;
  // One origin in front of the stage: it serves the stand-in tab itself and passes everything else to the stage, with the stage's own isolation headers.
  const front = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin" };
    if (url.pathname === "/hit") {
      maxN = Math.max(maxN, Number(url.searchParams.get("n")));
      return void res.writeHead(204, iso).end();
    }
    if (url.pathname === "/loaded") {
      loads++;
      return void res.writeHead(204, iso).end();
    }
    if (url.pathname === "/run/r1") return void res.writeHead(200, { "content-type": "text/html", ...iso }).end(TAB_HTML);
    // The packaging the 03 server gives it: the stage under /show/, the agent's tab at /run/<id>, one origin.
    if (!url.pathname.startsWith("/show/")) return void res.writeHead(404, iso).end();
    const up = request({ host: "127.0.0.1", port: s.port, path: req.url.slice("/show".length), method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${front.address().port}`;
  const tabUrl = `${origin}/run/r1`;
  try {
    const tab = await openTab(`${origin}/show/obsession/?tab=${encodeURIComponent(tabUrl)}`, { width: 1600, height: 900 });
    try {
      await sleep(2500);
      const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
      const snap = () => read(`({ net: document.getElementById("net").hidden ? null : document.getElementById("net").innerText, side: document.getElementById("selftools").innerText, button: !document.getElementById("opentab").hidden })`);
      let r = await snap();
      expect("served under /show/ with ?tab=: the stage offers to open the agent's tab, and shows nothing before the tab has spoken", r.button === true && r.net === null, r);
      const feedOk = await tab.eval(`fetch(new URL("api/state", ${JSON.stringify(origin + "/show/")}), { cache: "no-store" }).then((x) => x.status)`);
      expect("its API is under /show/ too (the state is read from /show/api/state)", feedOk === 200, feedOk);
      const lost = await tab.eval(`document.getElementById("lost").hidden`);
      expect("the page itself reads its feed from under /show/ (it does not say the feed is lost)", lost === true, lost);
      // A real click (a user gesture), so the popup is allowed.
      await tab.send("Runtime.evaluate", { expression: `document.getElementById("opentab").click()`, userGesture: true });
      for (let w = 0; w < 8000 && !(r.net === "OFFLINE" && /Checked in/.test(r.side)); w += 400) {
        await sleep(400);
        r = await snap();
      }
      expect("the tab opened by window.open: its net, decision, check-in and homecoming reached the stage by postMessage, from its origin", r.net === "OFFLINE" && /the model in this tab/.test(r.side) && /Checked in: 3 files written offline came home, 5 changes, in 1\.2 s/.test(r.side) && /Came home: 18\.4 MB on the wire/.test(r.side), r);
      expect("the tab was loaded once", loads === 1, loads);

      // A forged message: another origin (an srcdoc iframe is origin "null") saying the tab is online is not believed.
      await tab.eval(`(() => { const f = document.createElement("iframe"); f.srcdoc = '<script>parent.postMessage({ source: "walks-home-tab", type: "net", online: true, reason: "forged" }, "*")<\\/script>'; document.body.append(f); })()`);
      await sleep(800);
      r = await snap();
      expect("a message from another origin (and not the held window) changes nothing", r.net === "OFFLINE", r);

      // A reload of the stage: the tab is found again by name, not navigated, and keeps posting.
      const n0 = maxN;
      await tab.send("Page.reload");
      await sleep(3500);
      expect("after a reload of the stage the tab is still the same tab: it was not loaded again and its counter went on", loads === 1 && maxN > n0, { loads, n0, maxN });
    } finally {
      await tab.close();
    }
  } finally {
    s.child.kill();
    front.close();
    front.closeAllConnections?.();
  }
}
console.log(failed ? `${failed} selftools check(s) FAILED` : "obsession selftools: all checks passed");
process.exit(failed ? 1 : 0);
