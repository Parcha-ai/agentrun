// The browser on a local Chrome, with no Chrome started (browser-chrome-egress.test.mjs drives a real one): the operator's
// opt-in alone (`--browser-chrome PATH`, AGENTRUN_SERVE_BROWSER_CHROME), checked as an executable at the start, never
// `auto`'s pick; a run kept on it is unavailable at a launch on a server not given one, never another browser; no saved
// sign-in is made, leased or handed to it, and its provider refuses a profile and offers a vault nothing; Chrome's
// arguments send every request through the egress proxy, with no bypass but its own DevTools socket; the proxy is the
// kernel's, with no host list and a run browser's budgets; and its minutes are the run's spend at the operator's price,
// held under a cap.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BROWSER_MAX_CONNECTIONS, BROWSER_MAX_TUNNELS, browserEgress, egressDir, FAUX_EGRESS_ENV, MAX_TUNNELS } from "../dist/box-egress.js";
import { CHROME_PROFILES, chromeFence, localChrome } from "../dist/local-chrome.js";
import { FAUX_ENV } from "../dist/model.js";
import { browserNeeds, LOCAL_CHROME_ENV, NO_BROWSER_KEY, NO_CHROME, planeFor, recheckPlane, relaunchPlane, resolveCapability } from "../dist/tool-plane.js";
import { TOOLS } from "../dist/tools.js";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_BROWSERBASE = new URL("./fixtures/faux-browserbase-check.mjs", import.meta.url).pathname;
const BROWSE_MANY = new URL("./fixtures/faux-browse-many.mjs", import.meta.url).pathname;
const FAKE_EGRESS = new URL("./fixtures/fake-egress.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY", "AGENTRUN_SEAL_KEY", "FAUX_BROWSER_LOG", "FAUX_BROWSER_PROVIDER", LOCAL_CHROME_ENV, "AGENTRUN_BROWSER_USD_PER_HOUR_CDP"];
const BB = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
/** An executable file on every machine the tests run on, never started: the faux browser stands in for Chrome. */
const EXECUTABLE = process.execPath;
const base = { harness: "pi", gateway: false, parallelKey: false };

const opsOf = async (log) => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("chrome resolves only where the operator gave the server a Chrome; auto never picks it, keys or none; a run kept on it is unavailable at a launch on a server given none, and runs there again once one is", () => {
  const browser = (localChrome, picks = {}, keys = { browserbase: false, kernel: false }) => resolveCapability("browser", { ...base, browserKeys: keys, ...(localChrome === undefined ? {} : { localChrome }), ...picks });
  for (const picks of [{ pick: "chrome" }, { override: "chrome" }]) {
    assert.equal(browser(undefined, picks), NO_CHROME, "none given: refused by name");
    assert.equal(browser(false, picks), NO_CHROME);
    assert.equal(browser(true, picks), "chrome");
  }
  assert.equal(browser(true), NO_BROWSER_KEY, "auto with no vendor's key: unavailable, never the local Chrome");
  assert.equal(browser(true, {}, { browserbase: true, kernel: false }), "browserbase");
  assert.equal(browser(true, { pick: "auto" }, { browserbase: false, kernel: true }), "kernel");
  assert.equal(browser(true, { pick: "chrome", override: "kernel" }, { browserbase: false, kernel: true }), "kernel", "the agent's pick over the server's");
  assert.deepEqual(browserNeeds("chrome"), [], "it takes no key");
  assert.equal(LOCAL_CHROME_ENV, "AGENTRUN_SERVE_BROWSER_CHROME");

  const given = { [LOCAL_CHROME_ENV]: "/opt/chrome/chrome" };
  const tooling = { tools: ["browser"], harness: "pi" };
  const settings = { browser: { provider: "chrome" } };
  assert.equal(planeFor(given, tooling, settings).browser, "chrome");
  assert.equal(planeFor({}, tooling, settings).browser, NO_CHROME);
  assert.equal(planeFor({ ...given, ...BB }, tooling, {}).browser, "browserbase", "given a Chrome, auto still picks the vendor");
  // Kept: chrome stays its choice, unavailable for a launch on a server not given one, never moved to a vendor.
  assert.deepEqual(recheckPlane({ browser: "chrome" }, given), { browser: "chrome" });
  assert.deepEqual(recheckPlane({ browser: "chrome" }, { ...BB }), { browser: NO_CHROME });
  const now = { fresh: { browser: "browserbase" }, permission: () => "allow" };
  assert.deepEqual(recheckPlane({ browser: "chrome" }, { ...BB }, now), { browser: NO_CHROME }, "today's resolution never replaces it");
  assert.deepEqual(recheckPlane({ browser: "chrome" }, { ...given, ...BB }, now), { browser: "chrome" });
  assert.deepEqual(relaunchPlane({ browser: "chrome" }, { ...BB }, tooling, {}), { browser: NO_CHROME });
  assert.deepEqual(relaunchPlane({ browser: "chrome" }, given, tooling, {}), { browser: "chrome" });
});

test("the server refuses, before it serves, a --browser-chrome or AGENTRUN_SERVE_BROWSER_CHROME that is not an executable file; an executable one is taken resolved", async (t) => {
  withEnv(t, {}, KEYS);
  const dir = await scratch(t);
  const plain = join(dir, "plain");
  await writeFile(plain, "not a program", { mode: 0o644 });
  for (const path of [join(dir, "missing"), dir, plain]) {
    await assert.rejects(serve(t, { browserChrome: path }), (error) => error.message === `the browser's Chrome ${path} is not an executable file: name a Chrome or Chromium binary with --browser-chrome (or AGENTRUN_SERVE_BROWSER_CHROME), or leave it out`, path);
  }
  withEnv(t, { [LOCAL_CHROME_ENV]: join(dir, "missing") }, KEYS);
  await assert.rejects(serve(t, {}), /the browser's Chrome .*missing is not an executable file/, "the variable is checked the same");
  withEnv(t, { [LOCAL_CHROME_ENV]: EXECUTABLE }, KEYS);
  const { api } = await serve(t, {});
  assert.equal((await api("PUT", "/settings/tools", { browser: { provider: "chrome" } })).status, 200);
  assert.equal((await api("GET", "/capabilities")).body.features.browser, "chrome", "the variable alone opts in");
});

test("capabilities on a server given a Chrome: chrome picked is available, takes no key and is features.browser; sign_ins is false even with a seal key, since a local Chrome keeps none; given none, it is unavailable by name", async (t) => {
  withEnv(t, { ...BB, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, KEYS);
  const { api } = await serve(t, { browserChrome: EXECUTABLE });
  const view = async () => {
    const caps = (await api("GET", "/capabilities")).body;
    const tool = caps.tools.find((entry) => entry.name === "browser");
    return { available: tool.available, resolves: tool.resolves.pi, why: tool.why.pi, key: tool.key, browser: caps.features.browser, sign_ins: caps.features.sign_ins };
  };
  assert.deepEqual(await view(), { available: true, resolves: "browserbase", why: "Browserbase: its key is set or saved", key: "browserbase", browser: "browserbase", sign_ins: true }, "auto: the vendor, never the local Chrome");
  assert.equal((await api("PUT", "/settings/tools", { browser: { provider: "chrome" } })).status, 200);
  assert.deepEqual(await view(), { available: true, resolves: "chrome", why: "a Chrome on this server, picked in settings: each request held to public addresses", key: undefined, browser: "chrome", sign_ins: false });
  const summary = TOOLS.browser.summary;
  assert.doesNotMatch(summary, /127\.|proxy-server|port/, "what the model reads of it names no address or port");

  withEnv(t, { ...BB }, KEYS);
  const other = await serve(t, {});
  assert.equal((await other.api("PUT", "/settings/tools", { browser: { provider: "chrome" } })).status, 200);
  const tool = (await other.api("GET", "/capabilities")).body.tools.find((entry) => entry.name === "browser");
  assert.deepEqual([tool.available, tool.reason, tool.key], [false, "a local Chrome is not set up on this server", undefined]);
});

test("through the API: a run on the local Chrome is handed the server's resolved Chrome and no saved sign-in, though its agent's vendor has a seal key and keys; a launch on a server given none finds it unavailable, never another browser, and one given it again runs there", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { ...BB, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE, browserChrome: EXECUTABLE });
  assert.equal((await first.api("PUT", "/settings/tools", { browser: { provider: "chrome" } })).status, 200);
  assert.equal((await first.api("POST", "/agents", agent("local", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const started = await first.api("POST", "/agents/local/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  let { after } = await follow(first.api, started.body.run_id, ["completed"]);
  const ops = await opsOf(log);
  assert.deepEqual(ops.filter((op) => op.op === "vendor" || op.op === "chrome").map(({ op, vendor, path }) => (op === "vendor" ? vendor : path)), ["chrome", EXECUTABLE], "the plane's chrome, and the Chrome the server resolved");
  assert.deepEqual(ops.filter((op) => op.op === "sign-in" || op.op === "profile"), [], "no sign-in handed, no profile asked for");
  assert.deepEqual((await first.api("GET", "/agents/local")).body.sign_ins, [], "none made at a vendor for it");
  assert.match((await first.api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, /This browser is chrome's\./);
  const file = join(first.data, "runs", started.body.run_id, "serve.json");
  assert.equal(JSON.parse(await readFile(file, "utf8")).tool_plane.browser, "chrome");
  await first.close();

  // The same data on a server given no Chrome: its next launch's browser is unavailable, and it keeps chrome as its choice.
  const launch = async (api) => {
    const before = (await opsOf(log)).length;
    assert.equal((await api("POST", `/runs/${started.body.run_id}/messages`, { content: "Browse the example page again." })).status, 202);
    ({ after } = await follow(api, started.body.run_id, ["completed"], { after }));
    return (await opsOf(log)).slice(before).filter((op) => op.op === "vendor" || op.op === "chrome").map(({ op, vendor, path }) => (op === "vendor" ? vendor : path));
  };
  const second = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.deepEqual(await launch(second.api), [NO_CHROME], "unavailable, never Browserbase in its place");
  assert.equal(JSON.parse(await readFile(file, "utf8")).tool_plane.browser, "chrome", "kept as its choice");
  await second.close();
  const third = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE, browserChrome: EXECUTABLE });
  assert.deepEqual(await launch(third.api), ["chrome", EXECUTABLE], "given one again, it runs there");
  assert.deepEqual((await third.api("GET", "/agents/local")).body.sign_ins, []);
});

test("the local Chrome's provider: pi-browser's cdp provider, which refuses a profile and offers a vault nothing; its profiles under the run's directory; Chrome's arguments send every request through the proxy, loopback too, with no bypass and no resolution but its own DevTools socket's", async (t) => {
  const root = await scratch(t);
  const local = await localChrome({ executablePath: EXECUTABLE, root, runId: `unit-${randomBytes(4).toString("hex")}`, env: {}, log: () => {} });
  t.after(() => local.close());
  const provider = local.provider;
  assert.equal(provider.name, "cdp", "priced as browser-cost.ts' cdp");
  // A session that names a profile is refused by name before any Chrome starts (pi-browser's profileRefusal, its
  // tools.test.mjs), and none does: the run hands it no sign-in (tools.ts asHanded drops a profile it was not handed).
  assert.equal(provider.caps.profiles, false);
  assert.equal(provider.vault, undefined);
  assert.equal(typeof provider.downloads, "object", "its downloads stay in the session's own directory");
  assert.equal(CHROME_PROFILES, "browser-chrome");

  assert.deepEqual(chromeFence("http://127.0.0.1:41000", 42000), [
    "--proxy-server=http://127.0.0.1:41000", // key-gate: loopback-rule the relay a local Chrome is pointed at
    "--proxy-bypass-list=<-loopback>;127.0.0.1:42000", // key-gate: loopback-rule Chrome own DevTools socket, its one bypass
    "--host-resolver-rules=MAP 127.0.0.1:41000 127.0.0.1:41000, MAP 127.0.0.1:42000 127.0.0.1:42000, MAP * ~NOTFOUND", // key-gate: loopback-rule the two addresses Chrome resolves itself
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ]);
});

test("the local Chrome's way out: the kernel's egress proxy with no host list, on a socket in a 0700 directory of its own, reached over a loopback relay; a run browser's budgets; loopback refused after its lookup; close removes it all", async (t) => {
  assert.ok(BROWSER_MAX_TUNNELS > MAX_TUNNELS && BROWSER_MAX_TUNNELS === 128 && BROWSER_MAX_CONNECTIONS === 100_000, "a browser opens more at once than a box's tools");
  const runId = `egress-${randomBytes(4).toString("hex")}`;
  const lines = [];
  const egress = await browserEgress(runId, { [FAUX_ENV]: "faux", [FAUX_EGRESS_ENV]: FAKE_EGRESS }, (line) => lines.push(line));
  let closed = false;
  t.after(() => (closed ? undefined : egress.close()));
  const relay = new URL(egress.url);
  assert.deepEqual([relay.protocol, relay.hostname], ["http:", "127.0.0.1"]);
  const dir = egressDir(`browser:${runId}`);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.ok((await stat(join(dir, "egress.sock"))).isSocket());
  assert.deepEqual(lines, ["egress start browser"], "its start names no port");

  /** A CONNECT through the relay: the status line it answers, the socket kept open. */
  const sockets = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const tunnel = (target) => new Promise((ok, fail) => {
    const socket = connect({ host: relay.hostname, port: Number(relay.port) });
    sockets.push(socket);
    socket.once("error", fail).once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once("data", (data) => ok(String(data).split("\r\n")[0]));
  });
  // No host list: every public name (the fake network answers each with a public address); loopback, refused by address.
  assert.equal(await tunnel("anything.example:443"), "HTTP/1.1 200 Connection Established");
  assert.equal(await tunnel("127.0.0.1:22"), "HTTP/1.1 403 Egress refused: loopback");
  // Open at once: the browser's cap, past which one more is refused by name.
  for (let open = 1; open < BROWSER_MAX_TUNNELS; open++) assert.equal(await tunnel(`host-${open}.example:443`), "HTTP/1.1 200 Connection Established");
  assert.equal(await tunnel("one-more.example:443"), "HTTP/1.1 429 Egress refused: tunnel cap");
  assert.ok(lines.some((line) => /class=tunnel cap/.test(line)));

  closed = true;
  await egress.close();
  await assert.rejects(stat(dir), { code: "ENOENT" }, "its directory goes with it");
});

test("through the API: the local Chrome's minutes are the run's spend at the operator's price (AGENTRUN_BROWSER_USD_PER_HOUR_CDP), held under its cap; with none set it is free and books nothing", { timeout: 120_000 }, async (t) => {
  const browse = async (env, id, cap) => {
    withEnv(t, { FAUX_BROWSER_PROVIDER: "cdp", ...env }, KEYS);
    const { api, data } = await serve(t, { faux: BROWSE_MANY, fauxBrowser: FAUX_BROWSER, browserChrome: EXECUTABLE });
    assert.equal((await api("PUT", "/settings/tools", { browser: { provider: "chrome" } })).status, 200);
    assert.equal((await api("POST", "/agents", agent(id, { tools: ["browser"] }))).status, 201);
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Browse the example page 3 times." }, ...(cap ? { max_cost_usd: cap } : {}) });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed"]);
    const db = new DatabaseSync(join(data, "runs", started.body.run_id, "store", "run.sqlite"), { readOnly: true });
    const booked = db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === "agentrun.tool_cost").map((entry) => entry.data);
    db.close();
    return { booked, view: (await api("GET", `/runs/${started.body.run_id}`)).body };
  };
  const free = await browse({}, "free");
  assert.deepEqual(free.booked, [], "free: nothing booked");
  assert.equal(free.view.cost.usd, 0);
  // $36 an hour is a cent a second. A call holds two stretches of 210 s (no minimum, the 180 s idle window, 30 s for the
  // release), $4.20: a $50 cap holds each, and a 50-cent one none.
  const priced = await browse({ AGENTRUN_BROWSER_USD_PER_HOUR_CDP: "36" }, "priced", 50);
  assert.ok(priced.booked.length >= 1 && priced.booked.every((row) => row.tool === "browser" && row.charged_by === "cdp" && row.usd > 0), JSON.stringify(priced.booked));
  assert.ok(priced.view.cost.usd > 0 && priced.view.cost.usd <= 50, `booked ${priced.view.cost.usd} within the cap`);
  const tight = await browse({ AGENTRUN_BROWSER_USD_PER_HOUR_CDP: "36" }, "tight", 0.5);
  assert.match(tight.view.result?.final_answer ?? "", /spend_cap_reached: /, "a call the cap cannot hold is not sent");
});
