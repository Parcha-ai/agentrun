// The browser on a local Chrome, held to public addresses, on a real Chrome: the one at CHROME_PATH (CI's real-chrome job,
// with AGENTRUN_REQUIRE_LOCAL_CHROME=1, where a missing Chrome fails instead of skipping). Chrome's sandbox stays on.
// A run's browser opens a public page (a name the proxy's test network answers with a public address) that steers it,
// by a redirect, a script or an embed, to this server's own port on loopback, a cloud's metadata addresses, private
// ranges, loopback by name and over IPv6, and a name that resolves inward: each is refused by the egress proxy after its
// lookup, as the run's process log shows, and nothing on this machine is reached; a WebRTC connection it opens against
// STUN servers on loopback and a private address gathers no candidate and sends no packet; and each session's fresh
// profile goes with its release. A browser context given its own proxy setting over Chrome's DevTools socket (direct,
// around the proxy) reaches nothing either: Chrome resolves no name or address itself but its proxy's and its own
// socket's. With AGENTRUN_TEST_UNSANDBOXABLE_CHROME naming a Chrome that cannot start its sandbox here, the start's check
// refuses it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CHROME_PROFILES, checkChrome, localChrome } from "../dist/local-chrome.js";
import { STEER_HOST, REBIND_HOST } from "./fixtures/fake-steer-egress.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const CHROME = process.env.CHROME_PATH;
const REQUIRED = process.env.AGENTRUN_REQUIRE_LOCAL_CHROME === "1";
const SKIP = REQUIRED ? false : CHROME ? false : "needs a real Chrome at CHROME_PATH";
const STEER_MODEL = new URL("./fixtures/faux-chrome-steer.mjs", import.meta.url).pathname;
const STEER_EGRESS = new URL("./fixtures/fake-steer-egress.mjs", import.meta.url).pathname;
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the steering page and the decoy listen here, and the test steers Chrome to it
const METADATA = "169.254.169.254"; // key-gate: denylist the cloud metadata address a page steers the browser to, refused
const PRIVATE_10 = "10.0.0.1"; // key-gate: denylist an RFC 1918 address a page steers the browser to, refused
const PRIVATE_172 = "172.16.0.1"; // key-gate: denylist an RFC 1918 address a page steers the browser to, refused
const PRIVATE_192 = "192.168.0.1"; // key-gate: denylist an RFC 1918 address a page steers the browser to, refused
const METADATA_ALIBABA = "100.100.100.200"; // key-gate: denylist a cloud metadata address a page steers the browser to, refused
const METADATA_V6 = "fd00:ec2::254"; // key-gate: denylist the IPv6 cloud metadata address a page steers the browser to, refused
const METADATA_V6_SAID = "fd00:ec2:0:0:0:0:0:254"; // key-gate: denylist the same address as the proxy writes it in its log

/** An HTTP server on loopback: `handle` answers, and every path asked is kept. */
async function listen(t, handle) {
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    handle(req, res);
  });
  await new Promise((ok) => server.listen(0, LOOPBACK, ok));
  t.after(() => new Promise((ok) => server.close(ok)));
  return { port: server.address().port, asked };
}

/** The steering page: `/redirect?to=URL` (a 302), `/script?to=URL` (a script that moves the page), `/embed?to=URL` (an
 *  image and a frame from it), `/rtc?stun=HOST:PORT,...` (a WebRTC connection that gathers ICE candidates against those
 *  STUN servers and writes what it gathered as the page's text a second on), and `/`, a page of its own. */
const steer = (req, res) => {
  const url = new URL(req.url, "http://steer");
  const to = url.searchParams.get("to") ?? "";
  if (url.pathname === "/redirect") return res.writeHead(302, { location: to }).end();
  res.setHeader("content-type", "text/html");
  if (url.pathname === "/script") return res.end(`<title>moving</title><p>moving</p><script>location.replace(${JSON.stringify(to)})</script>`);
  if (url.pathname === "/embed") return res.end(`<title>embed</title><p>embedding</p><img src="${to}"><iframe src="${to}"></iframe>`);
  if (url.pathname === "/rtc") {
    const servers = (url.searchParams.get("stun") ?? "").split(",").map((at) => ({ urls: `stun:${at}` }));
    return res.end(`<title>rtc</title><p>gathering</p><script>
      const found = [];
      const pc = new RTCPeerConnection({ iceServers: ${JSON.stringify(servers)} });
      pc.createDataChannel("probe");
      pc.onicecandidate = (event) => { if (event.candidate && event.candidate.candidate) found.push(event.candidate.type || "unknown"); };
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      setTimeout(() => { document.body.textContent = "rtc " + JSON.stringify({ state: pc.iceGatheringState, candidates: found }); }, 1000);
    </script>`);
  }
  res.end("<title>Steer</title><p>A public page.</p>");
};

/** The local Chrome's proxy decisions in a run's process log: `{ kind, host, port, ip, class }` each. */
async function decisions(data, runId) {
  const log = await readFile(join(data, "runs", runId, "process.log"), "utf8");
  return log.split("\n").flatMap((line) => {
    let entry;
    try { entry = JSON.parse(line); } catch { return []; }
    const said = entry?.event === "browser_egress" ? /^egress (\w+) host=(\S+) port=(\d+) ip=(\S+) class=(.+)$/.exec(entry.line) : null;
    return said ? [{ kind: said[1], host: JSON.parse(said[2]), port: Number(said[3]), ip: said[4], class: said[5] }] : [];
  });
}

test("a real Chrome is required where CI says so", { skip: !REQUIRED }, () => {
  assert.ok(CHROME, "AGENTRUN_REQUIRE_LOCAL_CHROME=1 needs CHROME_PATH");
});

test("a run's local Chrome, steered by a public page to this server's port, metadata, private and loopback addresses, is refused each by the egress proxy after its lookup, and reaches nothing on this machine", { skip: SKIP, timeout: 240_000 }, async (t) => {
  const page = await listen(t, steer);
  const secret = `/decoy-${randomBytes(8).toString("hex")}`;
  const decoy = await listen(t, (_req, res) => res.end("DECOY REACHED"));
  // A STUN server on loopback: a WebRTC packet the page sends past the proxy would land here.
  const stun = createSocket("udp4");
  let datagrams = 0;
  stun.on("message", () => datagrams++);
  await new Promise((ok) => stun.bind(0, LOOPBACK, ok));
  t.after(() => stun.close());
  withEnv(t, { STEER_PORT: String(page.port) }, ["STEER_PORT", "AGENTRUN_SERVE_BROWSER_CHROME"]);
  const { api, data, port } = await serve(t, { faux: STEER_MODEL, fauxEgress: STEER_EGRESS, browserChrome: CHROME });

  // Picked, and given to this server: the browser resolves to it, with no key to save, and features.browser names it.
  assert.equal((await api("PUT", "/settings/tools", { browser: { provider: "chrome" } })).status, 200);
  const caps = (await api("GET", "/capabilities")).body;
  const tool = caps.tools.find((entry) => entry.name === "browser");
  assert.deepEqual([tool.available, tool.resolves.pi, tool.key, caps.features.browser, caps.features.sign_ins], [true, "chrome", undefined, "chrome", false]);

  const via = (how, to) => `http://${STEER_HOST}/${how}?to=${encodeURIComponent(to)}`;
  const serveUrl = `http://${LOOPBACK}:${port}/v2/capabilities`;
  const urls = [
    `http://${STEER_HOST}/`,
    via("redirect", serveUrl),
    via("script", `http://${METADATA}/latest/meta-data/`),
    via("redirect", `http://${LOOPBACK}:${decoy.port}${secret}`),
    via("redirect", `http://localhost:${port}/v2/capabilities`),
    via("redirect", `http://[::1]:${port}/v2/capabilities`),
    via("redirect", `https://${LOOPBACK}:${port}/v2/capabilities`),
    via("redirect", `http://${PRIVATE_10}/`),
    via("script", `http://${PRIVATE_172}/`),
    via("redirect", `http://${PRIVATE_192}/`),
    via("redirect", `http://${METADATA_ALIBABA}/latest/meta-data/`),
    via("redirect", `http://[${METADATA_V6}]/latest/meta-data/`),
    via("redirect", `http://${REBIND_HOST}/`),
    via("embed", `http://${METADATA}/latest/api/token`),
    `http://${STEER_HOST}/rtc?stun=${LOOPBACK}:${stun.address().port},${PRIVATE_10}:3478`,
  ];
  assert.equal((await api("POST", "/agents", agent("steered", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/steered/runs", { input: { content: `Steer the browser: ${JSON.stringify(urls)}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 180_000 });
  const answer = (await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer;
  const seen = await decisions(data, started.body.run_id);
  const said = JSON.stringify(seen);
  // The evidence, in the TAP: each decision the proxy logged for a page (not Chrome's own background requests, which
  // the test network answers with no address), and what the model was told.
  for (const d of seen.filter((d) => d.class !== "name not resolved")) t.diagnostic(`proxy: ${d.kind} ${d.host}:${d.port} ip=${d.ip} class=${d.class}`);
  t.diagnostic(`model saw: ${answer.replace(/\s+/g, " ").slice(0, 3000)}`);

  // The public page loaded through the proxy: the fence lets the web in.
  assert.match(answer, /A public page\./, answer);
  assert.ok(seen.some((d) => d.host === STEER_HOST && d.ip === "1.1.1.1" && d.class === "ok"), said);
  // Each place the page steered it to: refused by the proxy, by the address it is, after the lookup.
  const refused = (host, port, ip, why) => assert.ok(seen.some((d) => d.host === host && (port === undefined || d.port === port) && d.ip === ip && d.class === why), `${host}:${port ?? "*"} ${why} in ${said}`);
  refused(LOOPBACK, port, LOOPBACK, "loopback");
  refused("localhost", port, LOOPBACK, "loopback");
  refused("::1", port, "0:0:0:0:0:0:0:1", "loopback");
  refused(LOOPBACK, decoy.port, LOOPBACK, "loopback");
  refused(METADATA, 80, METADATA, "link-local");
  refused(PRIVATE_10, 80, PRIVATE_10, "private");
  refused(PRIVATE_172, 80, PRIVATE_172, "private");
  refused(PRIVATE_192, 80, PRIVATE_192, "private");
  refused(METADATA_ALIBABA, 80, METADATA_ALIBABA, "metadata");
  refused(METADATA_V6, 80, METADATA_V6_SAID, "metadata");
  refused(REBIND_HOST, 80, "10.20.30.40", "private"); // key-gate: denylist the private answer a rebinding name gives, refused
  // The proxy let nothing else through, and the decoy on loopback was never asked for its page.
  assert.deepEqual([...new Set(seen.filter((d) => d.class === "ok").map((d) => d.host))], [STEER_HOST], said);
  assert.deepEqual(decoy.asked.filter((path) => path === secret), [], "the decoy on loopback was not reached");
  // The model saw the proxy's refusals, never this server's answer or the decoy's, and never where the proxy listens.
  assert.match(answer, /egress refused: loopback/);
  assert.match(answer, /egress refused: link-local/);
  assert.doesNotMatch(answer, /DECOY REACHED|agentrun\.v2|"contract"/);
  assert.doesNotMatch(answer, /proxy-server|--host-resolver|egress\.sock/);
  const ports = [...answer.matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual([...new Set(ports)].filter((p) => p !== port && p !== decoy.port && p !== stun.address().port), [], `only the steered ports: ${answer}`);
  // WebRTC, which goes around an HTTP proxy over UDP: no candidate gathered, and no STUN packet sent to loopback.
  assert.match(answer, /rtc \{\\?"state\\?":\\?"complete\\?",\\?"candidates\\?":\[\]\}/, "the page gathered no ICE candidate");
  assert.equal(datagrams, 0, "no UDP reached the STUN server on loopback");
  // Each session's profile, under the run's directory, goes with its release once the run lets it go; its downloads
  // folder stays, as pi-browser keeps it for browser_downloads after a release.
  const profiles = join(data, "runs", started.body.run_id, CHROME_PROFILES);
  let left = [];
  for (const until = Date.now() + 15_000; ; await new Promise((done) => setTimeout(done, 200))) {
    left = (await readdir(profiles).catch(() => [])).filter((name) => !name.startsWith(".") && !name.endsWith(".downloads"));
    if (left.length === 0 || Date.now() > until) break;
  }
  assert.deepEqual(left, [], "no session's profile is left");
});

/** The pids of the browser processes (not their renderers, GPU or utility processes, which carry --type) whose profile is under `dir`. */
const browsersUnder = (dir) => {
  let out = "";
  try { out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 16 * 2 ** 20 }); } catch { return []; }
  return out.split("\n").filter((line) => line.includes(`--user-data-dir=${dir}/`) && line.includes("--remote-debugging-port=") && !line.includes(" --type=")).map((line) => Number(line.trim().split(/\s+/)[0]));
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a run's process killed while its local Chrome is open: the run opens again, its surviving Chrome (whose relay died with the process) is released, not kept, and the next browser call opens a fresh Chrome on the new relay; the model is told the session ended", { skip: SKIP, timeout: 240_000 }, async (t) => {
  const page = await listen(t, steer);
  withEnv(t, { STEER_PORT: String(page.port) }, ["STEER_PORT", "AGENTRUN_SERVE_BROWSER_CHROME"]);
  const { api, data } = await serve(t, { faux: STEER_MODEL, fauxEgress: STEER_EGRESS, browserChrome: CHROME });
  assert.equal((await api("PUT", "/settings/tools", { browser: { provider: "chrome" } })).status, 200);
  assert.equal((await api("POST", "/agents", agent("survivor", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const gate = join(await scratch(t), "go");
  const content = `Steer twice: ${JSON.stringify([`http://${STEER_HOST}/`])} then once ${gate} exists ${JSON.stringify([`http://${STEER_HOST}/again`])}`;
  const started = await api("POST", "/agents/survivor/runs", { input: { content } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const profiles = join(data, "runs", runId, CHROME_PROFILES);
  // The first call has answered (the public page loaded), and the run waits on the gate with its Chrome open.
  let old = [];
  for (const until = Date.now() + 90_000; ; await new Promise((done) => setTimeout(done, 200))) {
    old = browsersUnder(profiles);
    const answered = (await api("GET", `/runs/${runId}/timeline`)).body.rows?.some((row) => row.kind === "tool_result");
    if ((old.length && answered) || Date.now() > until) break;
  }
  assert.ok((await decisions(data, runId)).some((d) => d.host === STEER_HOST && d.class === "ok"), "the first page loaded through the proxy");
  assert.equal(old.length, 1, "one Chrome, open");
  t.after(() => { for (const pid of old) if (alive(pid)) process.kill(pid, "SIGKILL"); });
  // The run's process dies the way a crash kills it; its Chrome (its own process group) outlives it, and so would its
  // profile.
  const holder = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8")).holder.pid;
  process.kill(holder, "SIGKILL");
  for (let i = 0; alive(holder); i++) {
    assert.ok(i < 200, "the run's process dies");
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(alive(old[0]), "its Chrome survived the process");
  await writeFile(gate, "go");
  await follow(api, runId, ["completed"], { deadlineMs: 180_000 });
  const answer = (await api("GET", `/runs/${runId}`)).body.result.final_answer;
  t.diagnostic(`model saw: ${answer.replace(/\s+/g, " ").slice(0, 1500)}`);
  // The second call ran on a fresh Chrome behind the new relay: the public page loaded.
  assert.match(answer.slice(0, answer.indexOf("Second:")), /A public page\./, "the first call answered before the kill");
  const second = answer.slice(answer.indexOf("Second:"));
  assert.match(second, /"at": "http:\/\/steer\.example\/again"/, answer);
  assert.match(second, /A public page\./, answer);
  assert.match(second, /Your browser session ended during an interruption/, "told as a released session is");
  // The old Chrome is gone, and so is its profile.
  for (let i = 0; alive(old[0]); i++) {
    assert.ok(i < 300, `the surviving Chrome ${old[0]} is stopped`);
    await new Promise((done) => setTimeout(done, 50));
  }
  const left = (await readdir(profiles)).filter((name) => !name.startsWith(".") && !name.endsWith(".downloads"));
  assert.deepEqual(left, [], "no session's profile is left");
});

test("a browser context given its own proxy setting over Chrome's DevTools socket, direct around the egress proxy, reaches nothing: Chrome resolves no address itself but its proxy's and its own socket's", { skip: SKIP, timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const secret = `/direct-${randomBytes(8).toString("hex")}`;
  const decoy = await listen(t, (_req, res) => res.end("DECOY REACHED"));
  const lines = [];
  const local = await localChrome({ executablePath: CHROME, root, runId: `direct-${randomBytes(4).toString("hex")}`, env: {}, log: (line) => lines.push(line) });
  t.after(() => local.close());
  const provider = local.provider;
  assert.deepEqual([provider.name, provider.caps.profiles, provider.vault], ["cdp", false, undefined], "no saved sign-in, nothing for a vault");
  const ref = await provider.create({ tag: "direct", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} }, new AbortController().signal);
  let released = false;
  t.after(() => (released ? undefined : provider.release(ref)));
  // A fresh profile of the session's own, under the run's directory: nothing loaded into it.
  const profiles = join(root, CHROME_PROFILES);
  assert.deepEqual((await readdir(profiles)).filter((name) => !name.startsWith(".")).sort(), ["direct", "direct.downloads"]);
  const { sdkCdpUrl } = await provider.attach(ref);
  const socket = new WebSocket(sdkCdpUrl);
  await new Promise((ok, fail) => (socket.addEventListener("open", ok), socket.addEventListener("error", fail)));
  t.after(() => socket.close());
  let id = 0;
  const waiting = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message);
  });
  const send = (method, params = {}, sessionId) => new Promise((ok) => {
    waiting.set(++id, ok);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  /** Opens `url` in a new tab of `browserContextId`: Chrome's error for it, or the page's text. */
  const open = async (url, browserContextId) => {
    const { targetId } = (await send("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) })).result;
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })).result;
    const navigated = await send("Page.navigate", { url }, sessionId);
    await new Promise((done) => setTimeout(done, 1_500));
    const text = (await send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true }, sessionId)).result?.result?.value;
    await send("Target.closeTarget", { targetId });
    return navigated.result?.errorText ?? text;
  };
  // Through the proxy, as every page goes: refused by it.
  assert.match(await open(`http://${LOOPBACK}:${decoy.port}${secret}`), /egress refused: loopback/);
  // A context told to go direct, as a page's script with the DevTools socket could ask: no address resolves.
  const direct = (await send("Target.createBrowserContext", { proxyServer: "direct://", proxyBypassList: "*" })).result;
  assert.ok(direct?.browserContextId, "Chrome made the context");
  assert.equal(await open(`http://${LOOPBACK}:${decoy.port}${secret}`, direct.browserContextId), "net::ERR_NAME_NOT_RESOLVED");
  assert.equal(await open(`http://${METADATA}/latest/meta-data/`, direct.browserContextId), "net::ERR_NAME_NOT_RESOLVED");
  assert.deepEqual(decoy.asked.filter((path) => path === secret), [], "the decoy on loopback was not reached");
  assert.ok(lines.some((line) => /host="127\.0\.0\.1" .*class=loopback/.test(line)), lines.join("\n"));
  // Released: its Chrome is gone, and so is its profile.
  socket.close();
  await provider.release(ref);
  released = true;
  assert.equal(await provider.status(ref), "gone");
  assert.deepEqual((await readdir(profiles)).filter((name) => !name.startsWith(".")), ["direct.downloads"], "the profile is removed; only its downloads folder stays, for browser_downloads");
  assert.deepEqual(await readdir(join(profiles, "direct.downloads")), [], "and it holds nothing the session did not download");
});

test("a Chrome that cannot start its sandbox on this machine refuses the server's start, in words that never offer to turn it off", { skip: process.env.AGENTRUN_TEST_UNSANDBOXABLE_CHROME ? false : "needs AGENTRUN_TEST_UNSANDBOXABLE_CHROME, a Chrome that cannot start its sandbox here", timeout: 60_000 }, async () => {
  const chrome = process.env.AGENTRUN_TEST_UNSANDBOXABLE_CHROME;
  await assert.rejects(checkChrome(chrome), (error) => {
    assert.match(error.message, /did not start here with its sandbox on \(No usable sandbox\), and the local Chrome never runs without Chrome's sandbox/);
    assert.doesNotMatch(error.message, /no-sandbox|live dangerously/);
    return true;
  });
});
