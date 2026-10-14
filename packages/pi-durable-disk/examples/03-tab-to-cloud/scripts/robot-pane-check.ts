// The robot in the agent's page, in real Chrome, end to end: the creature page runs in an iframe under /tab/ and reads and writes its files through the page's workspace. The agent's robot tools
// (the cloud model is scripted: the tools are real) edit creature/robot.json; the creature redraws; a body change stumbles; do(skill) switches the policy live; then the run is checked out, the
// network cut, and the robot still redraws and walks, with the assets from the service worker's cache; a reload offline keeps the changes.
//   [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] [GRACE_MS=<writer grace; the server's own default when unset>] node scripts/robot-pane-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS ?? "/tmp";
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const here = import.meta.dirname;
const fixture = join(here, "../../04-walks-home/policy/test/fixtures/policy.json");
const policyText = readFileSync(fixture, "utf8");
const sha = (JSON.parse(policyText) as { mjcf_sha256: string }).mjcf_sha256;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "robot-pane-"));
const port = await freePort();
const RUN = "rp";
const work = join(dir, "runs", RUN, "work");
mkdirSync(join(work, "home/skills"), { recursive: true });
copyFileSync(fixture, join(work, "home/policy.json"));
for (const n of ["walk", "sprint"]) copyFileSync(fixture, join(work, `home/skills/${n}.json`));
writeFileSync(join(work, "home/skills.json"), JSON.stringify({ version: 1, body_mjcf_sha256: sha, default: "walk", skills: { walk: { policy: "skills/walk.json", command: 0.3, label: "walk" }, sprint: { policy: "skills/sprint.json", command: 0.7, label: "sprint" } } }));
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--no-restore", "home/files/", "--no-restore", "home/model/", ...(process.env.GRACE_MS ? ["--grace-ms", process.env.GRACE_MS] : [])], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
/** The creature page's own `__walks`, through the iframe (same origin). */
const walks = <T>(expr: string) => ev<T>(`(() => { const w = document.getElementById("creature").contentWindow.__walks; return ${expr}; })()`);
type Attempt = { id: string; skill: string; learned: boolean; seconds: number };
type Item = { kind: string; text?: string; name?: string; status?: string; output?: string; details?: { attempt?: Attempt } };
const idle = "(async () => { const k = await demo.tasks(); return !demo.state.chat.busy && (k === null || k.every((x) => x.state !== 'running' && x.state !== 'ready' && x.state !== 'waiting')); })()";
const say = async (text: string) => {
  const before = await ev<number>("demo.items().length");
  await ev(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);
  await sleep(2500);
  await page!.until(idle, 120_000, 1000).catch(() => undefined);
  return ev<Item[]>(`demo.items().slice(${before})`);
};
const call = (name: string, args: Record<string, unknown>) => `{ call: { name: ${JSON.stringify(name)}, arguments: ${JSON.stringify(args)} } }`;
const script = async (turns: string[]) => ev(`demo.stubCloud([${turns.join(", ")}, { text: "Done." }])`);
const frameGap = () => ev<string>(`(() => { const f = window.__frames ?? []; let max = 0, at = 0; for (let i = 1; i < f.length; i++) if (f[i] - f[i - 1] > max) { max = f[i] - f[i - 1]; at = f[i - 1]; } return max + " ms (of " + f.length + " frames, " + Math.round(performance.now() - (f[0] ?? 0)) + " ms)"; })()`);
const until = (expr: string, ms = 30_000) => page!.until(expr, ms, 300);
try {
  const phone = process.env.PHONE === "1"; // PHONE=1: the same check in a 375 px wide page
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?robot=1&robotcode=0&brain=off#"), phone ? { width: 375, height: 760 } : undefined);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await until(`!!document.getElementById("creature").contentWindow.__walks`, 60_000);
  ok("the creature page runs in the agent's page, under /tab/ on the same origin", await ev<boolean>(`document.getElementById("creature").contentWindow.location.pathname === "/tab/"`));
  if (phone) {
    // The phone's hint is the brain's phase text, long: set one as the page does and check what is in the field (the page opens with the short robot-mode hint). A textarea's placeholder cannot take
    // text-overflow, so the page cuts the text to the field's width with an ellipsis itself.
    const hint = await ev<{ placeholder: string; fits: boolean; h: number; ws: string; title: string }>(`(() => { const i = document.getElementById("input"); const long = "the session is open; the robot's brain is loading, reading the model's serving file, then restoring its state"; demo.hint(long); const cs = getComputedStyle(i); const c = document.createElement("canvas").getContext("2d"); c.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily; const room = i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); return { placeholder: i.placeholder, fits: c.measureText(i.placeholder).width <= room, h: Math.round(i.getBoundingClientRect().height), ws: getComputedStyle(i, "::placeholder").whiteSpace, title: i.title }; })()`);
    ok("a long hint in the composer is cut to the field's width with an ellipsis, on one line, the whole text kept as the title, and the field keeps its 44 px", hint.placeholder.endsWith("…") && hint.placeholder.length < 60 && hint.fits && hint.h === 44 && hint.ws === "nowrap" && /serving file, then restoring/.test(hint.title), hint);
    const r = await ev<{ chat: { w: number; h: number }; pane: { w: number; h: number; top: number }; chatBottom: number }>(`(() => { const rect = (e) => e.getBoundingClientRect(); const c = rect(document.querySelector("main > section, main > div, #chat") ?? document.querySelector("main").firstElementChild), p = rect(document.getElementById("creature-pane")); return { chat: { w: Math.round(c.width), h: Math.round(c.height) }, pane: { w: Math.round(p.width), h: Math.round(p.height), top: Math.round(p.top) }, chatBottom: Math.round(c.bottom) }; })()`);
    console.log(`  phone layout: ${JSON.stringify(r)}`);
    ok("a phone: the chat keeps the width of the screen and the robot sits under it", r.chat.w >= 340 && r.pane.w >= 340 && r.pane.h >= 190 && r.pane.top >= r.chatBottom - 2, r);
    await page.screenshot(join(shots, "pane-phone.png"));
  }
  await until(`/trained/.test(document.getElementById("creature").contentDocument.getElementById("stateLabel").textContent)`, 90_000); // the policy came through the page's workspace and the creature says it is trained
  console.log(`  creature state: ${JSON.stringify(await walks<unknown>("w.state()")).slice(0, 220)}`);
  ok("it read home/policy.json through the page's workspace: a trained policy drives the creature", /trained/.test(await ev<string>(`document.getElementById("creature").contentDocument.getElementById("stateLabel").textContent`)), await ev(`document.getElementById("creature").contentDocument.getElementById("stateLabel").textContent`));
  await page.screenshot(join(shots, "pane-1-start.png"));

  // looks: the agent's tool writes creature/robot.json, the creature redraws
  await script([call("set_color", { part: "legs", color: "red" }), call("set_face", { face: "happy" })]);
  const t1 = await say("make the legs red and give it a happy face");
  ok("the robot tools ran in the page's computer", t1.filter((i) => i.kind === "tool" && i.status === "done").length >= 2, t1.map((i) => `${i.kind}:${i.name ?? ""}:${i.status ?? ""}`));
  await until(`document.getElementById("creature").contentWindow.__walks.look().face === "happy"`).catch(() => undefined);
  const look = await walks<{ legs: string[]; face: string }>("w.look()");
  // A tool's result the reader opened stays open while the chat redraws (each agent event redraws it).
  await ev("(() => { const d = document.querySelector('details.tool:not(.bare)'); if (d) d.open = true; return !!d; })()");
  await sleep(200);
  await ev("demo.renderChat()");
  ok("a tool result the reader opened stays open when the chat redraws", await ev<boolean>("document.querySelector('details.tool:not(.bare)')?.open === true"));
  ok("looks only: the creature redrew (legs red, a happy face) and the brain still fits", look.legs.every((c) => c === "#d9423b") && look.face === "happy" && (await walks<boolean>("w.fits()")), look);

  // a body change: the old brain drives the new body, the label says so
  await script([call("resize", { part: "leg_length", factor: 1.3 })]);
  await say("make the legs a lot longer");
  await until(`document.getElementById("creature").contentWindow.__walks.fits() === false`).catch(() => undefined);
  ok("a body change: the creature page says its brain no longer fits (it stumbles)", (await walks<boolean>("w.fits()")) === false && /no longer fits/.test(await ev<string>(`document.getElementById("creature").contentDocument.getElementById("stateLabel").textContent`)));
  ok("and the new body was saved through the page: creature/creature.xml is in the workspace", (await ev<{ exitCode?: number; output?: string }>("demo.exec('ls creature')")).output?.includes("creature.xml") === true);

  // a skill: with the flag in the scene, `do` is a request the creature page runs and answers (creature/attempt.json), and the tool returns with that report, so the skill is no longer playing when the
  // tool is done: what shows the page switched to it and ran it is the answer, with the request's own id, in the tool's details and on the disk.
  await script([call("do", { skill: "sprint" })]);
  const t3 = await say("sprint!");
  const sprint = t3.find((i) => i.kind === "tool" && i.name === "do");
  const answered = JSON.parse((await ev<{ output?: string }>("demo.exec('cat creature/attempt.json')")).output || "{}") as Partial<Attempt>;
  ok("do(sprint): the agent's tool accepted a skill that came home, and the creature page ran it and answered the request", sprint?.status === "done" && sprint.details?.attempt?.skill === "sprint" && sprint.details.attempt.learned === true && sprint.details.attempt.seconds > 0 && answered.id === sprint.details.attempt.id, { tool: sprint, answered });
  await page.screenshot(join(shots, "pane-2-online.png"));

  // The chat shows the work: a write and an edit as diffs (@pierre/diffs), bash as its command and output, each one quiet line that opens on tap; a move is one line, never the notice the agent was given.
  const body1 = "export const body = {\n  name: \"dino\",\n  legs: 2,\n};\n";
  await script([call("write", { path: "robot/body.ts", content: body1 }), call("edit", { path: "robot/body.ts", edits: [{ oldText: "legs: 2,", newText: "legs: 2,\n  spikes: 6," }] }), call("bash", { command: "cat robot/body.ts" })]);
  await ev(`document.querySelectorAll("details.tool").forEach((d) => { d.open = false; })`); // (the scripted calls reuse ids; a real run's ids are unique)
  await sleep(300);
  await say("write me a dinosaur body");
  const lines = await ev<{ n: number; open: boolean; h: number[] }>(`(() => { const t = [...document.querySelectorAll("details.tool")].filter((d) => /robot\\/body\\.ts|cat /.test(d.textContent)); return { n: t.length, open: t.some((d) => d.open), h: t.map((d) => d.querySelector("summary").offsetHeight) }; })()`);
  ok("each tool call is one quiet line, closed", lines.n >= 3 && !lines.open && lines.h.every((h) => h < 40), lines);
  ok("a diff is not drawn for a closed row: opening the row draws it", await ev<number>(`document.querySelectorAll("details.tool .diff").length`) === 0);
  await ev(`document.querySelectorAll("details.tool:not(.bare)").forEach((d) => { d.open = true; })`);
  await until(`[...document.querySelectorAll("details.tool .diff")].every((d) => d.firstElementChild && d.firstElementChild.shadowRoot && d.firstElementChild.shadowRoot.textContent.length > 0) && document.querySelectorAll("details.tool .diff").length >= 2`, 60_000).catch(() => undefined);
  const code = await ev<{ diffs: string[]; bash: string; closed: boolean }>(`(() => { const rows = [...document.querySelectorAll("details.tool")]; const text = (d) => (d.querySelector(".diff")?.firstElementChild?.shadowRoot?.textContent ?? "").replace(/\\s+/g, " "); return { diffs: rows.filter((d) => d.querySelector(".diff")).map(text), bash: rows.find((d) => /cat robot/.test(d.textContent))?.querySelector(".tool-body")?.textContent ?? "", closed: false }; })()`);
  ok("a write is a diff of the new file (every line an addition) and an edit a diff of what changed, drawn by the library", code.diffs.length === 2 && /export const body/.test(code.diffs[0]) && /spikes: 6/.test(code.diffs[1]) && !/dino/.test(code.diffs[1]), code.diffs);
  ok("bash shows its command and what it printed", /\$ cat robot\/body\.ts/.test(code.bash) && /name: "dino"/.test(code.bash), code.bash);
  await page.screenshot(join(shots, "pane-3-code.png"));
  await ev(`(() => { const chat = demo.state.chat; chat.apply({ type: "entry_appended", entry: { id: "mv1", kind: "env.switch", model: [{ role: "user", content: "SYSTEM NOTICE: you were moved to a Modal VM; your files came with you.", timestamp: 1 }], data: { switchId: "mv1", from: "your user's browser tab", planned: true, by: "placement", probability: 0.83, facts: { label: "a Modal VM", tools: [] } } } }); demo.renderChat(); return true; })()`);
  const move = await ev<{ lines: string[]; chat: string }>(`({ lines: [...document.querySelectorAll("#chat .move")].map((m) => m.textContent), chat: document.getElementById("chat").textContent })`);
  ok("a move is one quiet line, and the agent's notice is not in the chat", move.lines.includes("→ Modal VM · Jev 0.83") && !/SYSTEM NOTICE|were moved/.test(move.chat), move);
  // The top bar is four things and nothing else: the model, where it runs, Files (an icon) and online/offline (one icon toggle). Moves are asked of the agent, so the switcher is not in the bar.
  const driver = await ev<{ text: string; hidden: boolean }>(`({ text: document.getElementById("driver").textContent, hidden: document.getElementById("driver").hidden })`);
  ok("the header names the model that is answering: 'LLM: <model>'", driver.text === "LLM: stub" && !driver.hidden, driver);
  await page.screenshot(join(shots, "pane-bar.png"));
  const bar = await ev<{ text: string; ids: string[]; where: string; files: { text: string; title: string; svg: boolean; w: number; h: number }; conn: { text: string; title: string; svg: boolean; w: number; h: number; state: string }; height: number; overflow: boolean }>(`(() => {
    const header = document.querySelector("header");
    const shown = (e) => !!e && e.getClientRects().length > 0;
    const box = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return { text: e.textContent.trim(), title: e.title, svg: !!e.querySelector("svg"), w: Math.round(r.width), h: Math.round(r.height), state: e.dataset.state ?? "" }; };
    return { text: header.innerText.replace(/\\s+/g, " ").trim(), ids: ["net", "handover", "offline", "online", "offline-status", "online-status", "switcher", "takeover"].filter((id) => shown(document.getElementById(id))), where: document.getElementById("badge").innerText.replace(/\\s+/g, " ").trim(), files: box("ws-toggle"), conn: box("connection"), height: Math.round(header.getBoundingClientRect().height), overflow: header.scrollWidth > header.clientWidth + 1 };
  })()`);
  ok("the bar reads 'LLM: stub' and 'Running in: browser (Wasm)', with no title, no status words, no 'ONLINE', no 'moved in' and no switcher", /^LLM: stub Running in: browser \(Wasm\)$/.test(bar.text) && bar.ids.length === 0, bar);
  // (a narrow page keeps only the model and the place in the bar: Files is the footer's button there, and the network is the phone's own)
  if (!phone) ok("Files is an icon button with the tooltip 'Files'", bar.files.text === "" && bar.files.svg && bar.files.title === "Files" && bar.files.w >= 28 && bar.files.w <= 44, bar.files);
  if (!phone) ok("online/offline is one icon toggle (tooltip 'Take it offline'), not a text button", bar.conn.text === "" && bar.conn.svg && bar.conn.title === "Take it offline" && bar.conn.state === "online" && bar.conn.w >= 28 && bar.conn.w <= 44, bar.conn);
  ok("the bar is one slim line that does not overflow", bar.height <= 60 && !bar.overflow, bar);
  // The operator fallback is behind the Running-in label's menu: closed until it is opened, closed again by Escape.
  const shown = `((e) => e.getClientRects().length > 0)`;
  const closed = await ev<boolean>(`!${shown}(document.getElementById("switcher"))`);
  await ev(`document.getElementById("badge-text").click()`);
  await sleep(100);
  const opened = await ev<{ open: boolean; envs: string[] }>(`({ open: ${shown}(document.getElementById("switcher")), envs: [...document.querySelectorAll("#switcher button[data-env]")].map((b) => b.textContent) })`);
  await page.screenshot(join(shots, "pane-bar-menu.png"));
  await ev(`document.activeElement?.blur?.()`); // (focus is elsewhere: Escape brings it back to the label, so a keyboard user keeps their place)
  await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(100);
  const menu = { closed, ...opened, escaped: await ev<boolean>(`!${shown}(document.getElementById("switcher"))`), takeover: await ev<string>(`document.getElementById("takeover").textContent`), focus: await ev<string>(`document.activeElement?.id ?? ""`) };
  if (phone) { const m = await ev<{ l: number; r: number; w: number }>(`(() => { document.getElementById("badge-text").click(); const r = document.getElementById("where-menu").getBoundingClientRect(); const o = { l: Math.round(r.left), r: Math.round(r.right), w: innerWidth }; document.getElementById("badge-text").click(); return o; })()`); ok("on a phone the operator menu opens inside the screen", m.l >= 0 && m.r <= m.w, m); await page.screenshot(join(shots, "pane-bar-menu.png")); }
  ok("the 'your browser | Modal VM' switcher is not in the bar: it opens from the Running-in label and Escape closes it", menu.closed && menu.open && menu.envs.length >= 1 && menu.escaped && menu.takeover === "bring it home" && menu.focus === "badge-text", menu);
  // While a move happens the label says so quietly, and a finished move leaves no 'moved in 9.7 s' text.
  const moving = await ev<{ text: string; tone: string; after: string }>(`(() => {
    const s = demo.state; const was = s.placement;
    s.leaving = "cloud"; s.placement = { where: "moving", to: "cloud", env: "cloud", detail: "" }; demo.render();
    const text = document.getElementById("badge-text").textContent, tone = document.getElementById("badge").className;
    s.handovers.push({ switchId: "x", to: "cloud", ms: 9700 }); s.leaving = undefined; s.placement = was; demo.render();
    return { text, tone, after: document.querySelector("header").innerText.replace(/\\s+/g, " ") };
  })()`);
  ok("a move in flight is a quiet state on the label ('moving to ...'), and nothing says how long a move took", /^moving to /.test(moving.text) && /moving/.test(moving.tone) && !/moved|9\.7/.test(moving.after), moving);
  // The longest real labels in the bar at this width (the local model's name, a move in flight to the VM): nothing is pushed past the screen.
  const widest = await ev<{ h: number; overflow: boolean; right: number; w: number; text: string }>(`(() => {
    document.getElementById("driver-name").textContent = "Qwen3.5 0.8B"; document.getElementById("driver").hidden = false;
    document.getElementById("badge-text").textContent = "moving to Modal VM";
    const header = document.querySelector("header"), bar = document.querySelector(".bar").getBoundingClientRect();
    const out = { h: Math.round(header.getBoundingClientRect().height), overflow: header.scrollWidth > header.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth, right: Math.round(bar.right), w: innerWidth, text: header.innerText.replace(/\\s+/g, " ").trim() };
    demo.render(); return out;
  })()`);
  ok("the longest labels ('LLM: Qwen3.5 0.8B', 'Running in: moving to Modal VM') still fit the screen at this width (a narrow page wraps the place to a second line)", widest.h <= 84 && !widest.overflow && widest.right <= widest.w && /LLM: Qwen3\.5 0\.8B/.test(widest.text) && /moving to Modal VM/.test(widest.text), widest);
  // The model stays on the bar through a move and while the page reconnects: the last one known, not a gap (nothing running the run is the one case with no model).
  const steady = await ev<string[]>(`(() => {
    const s = demo.state, saved = { mode: s.mode, leaving: s.leaving, placement: s.placement };
    const llm = () => document.getElementById("driver").hidden ? "(hidden)" : document.getElementById("driver").textContent;
    const out = [];
    demo.render(); out.push(llm());
    s.mode = "connecting"; demo.render(); out.push(llm());
    s.mode = "booting"; demo.render(); out.push(llm());
    s.mode = saved.mode; s.leaving = "cloud"; s.placement = { where: "moving", to: "cloud", env: "cloud", detail: "" }; demo.render(); out.push(llm());
    s.leaving = saved.leaving; s.placement = saved.placement; s.mode = "viewer"; s.placement = { where: "parked" }; demo.render(); out.push(llm());
    s.mode = saved.mode; s.placement = saved.placement; demo.render(); out.push(llm());
    return out;
  })()`);
  ok("the model stays on the bar through connecting, booting and a move, and is gone only when nothing runs the run", steady.join("|") === "LLM: stub|LLM: stub|LLM: stub|LLM: stub|(hidden)|LLM: stub", steady);
  ok("the bar has no title: the page's name is in the tab, and it would be wrong when the run is on the VM", await ev<boolean>(`document.querySelector("header h1") === null`));
  // The one toggle shows the network's state by its icon and says the action it would take by its tooltip: offline with the way back, offline with nothing to do, busy, and the server unreachable.
  const toggle = await ev<Record<string, { state: string; action: string; title: string; svg: string }>>(`(() => {
    const s = demo.state, saved = { mode: s.mode, checkout: s.checkout, checkingIn: s.checkingIn, pendingCheckin: s.pendingCheckin, online: s.net.online, reason: s.net.reason };
    const read = () => { const b = document.getElementById("connection"); return { state: b.dataset.state, action: b.dataset.action, title: b.title, svg: b.innerHTML.length > 0 ? (b.querySelector("path[d^='M3.5 3.5']") ? "off" : "on") : "none" }; };
    const out = {};
    s.mode = "offline"; demo.render(); out.checkedOut = read();
    s.mode = saved.mode; s.checkout = { text: "copying the model into this browser: 40%" }; demo.render(); out.checkingOut = read();
    s.checkout = saved.checkout; s.net.online = false; s.net.reason = "no route"; demo.render(); out.unreachable = read();
    s.net.online = saved.online; s.net.reason = saved.reason; demo.render(); out.restored = read();
    return out;
  })()`);
  ok("the toggle: checked out is the offline icon with nothing to press, busy says what it is doing, an unreachable server is the offline icon with nothing to press (the reason is the tooltip; a checkout needs the server), and it comes back", toggle.checkedOut.state === "offline" && toggle.checkedOut.action === "none" && /^Offline/.test(toggle.checkedOut.title) && toggle.checkedOut.svg === "off" && toggle.checkingOut.action === "none" && /40%/.test(toggle.checkingOut.title) && toggle.unreachable.state === "offline" && toggle.unreachable.action === "none" && /no route/.test(toggle.unreachable.title) && toggle.restored.action === "offline" && toggle.restored.title === "Take it offline" && toggle.restored.svg === "on", toggle);
  // A page that only watches names the model the SESSION is on, from the relayed events (the snapshot's agent, each agent_changed) and the names the host's registry sent: not the server's --model.
  const relay = await ev<string[]>(`(() => {
    const s = demo.state, saved = { mode: s.mode, placement: s.placement, chat: s.chat, relayed: s.relayedModel, names: s.modelNames };
    const llm = () => document.getElementById("driver").hidden ? "(hidden)" : document.getElementById("driver").textContent;
    s.mode = "viewer"; s.placement = { where: "cloud", host: "vm", generation: 1, env: "cloud" };
    const out = [];
    demo.view({ kind: "snapshot", event: { type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: { model: { provider: "proxy", modelId: "gpt-6-sol" } }, usage: {} } }); out.push(llm());
    demo.view({ kind: "models", names: { "steered/qwen3.5-27b": "Qwen3.5-27B (Golden Gate edit)" } });
    demo.view({ kind: "events", events: [{ type: "agent_changed", agent: { model: { provider: "steered", modelId: "qwen3.5-27b" } } }] }); out.push(llm());
    demo.view({ kind: "events", events: [{ type: "agent_changed", agent: { model: { provider: "steered", modelId: "unnamed-1b" } } }] }); out.push(llm());
    s.mode = saved.mode; s.placement = saved.placement; s.chat = saved.chat; s.relayedModel = saved.relayed; s.modelNames = saved.names; demo.render();
    return out;
  })()`);
  ok("a viewer's 'LLM:' follows the session: the snapshot's model, then the model the agent switched to by its registered name, else its id", relay.length === 3 && relay[0] === "LLM: gpt-6-sol" && relay[1] === "LLM: Qwen3.5-27B (Golden Gate edit)" && relay[2] === "LLM: unnamed-1b", relay);
  // The thinking is open by default and folds on a tap; a fold holds across re-renders. The person's words are a filled bubble the agent's are not.
  const think = await ev<{ n: number; opened: boolean; text: string; opacity: string; foldedAfter: boolean; reopenedAfter: boolean; userBg: string; agentBg: string }>(`(async () => {
    const chat = demo.state.chat;
    chat.apply({ type: "entry_appended", entry: { id: "gg-think", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "Considering the bridge." }, { type: "text", text: "Answer." }] }] } });
    chat.apply({ type: "entry_appended", entry: { id: "gg-think-user", kind: "pi.user", model: [{ role: "user", content: "a user line for the bubble check" }] } });
    const grab = () => [...document.querySelectorAll("#chat .turn.agent")].find((t) => /Answer\\./.test(t.textContent) && /Considering/.test(t.textContent));
    const tick = () => new Promise((r) => setTimeout(r, 0));
    demo.renderChat();
    const a = grab(), d = a?.querySelector("details.thinking"), pre = d?.querySelector("pre");
    const out = { n: a?.querySelectorAll("details.thinking").length ?? 0, opened: !!d?.open, text: pre?.textContent ?? "", opacity: pre ? getComputedStyle(pre).opacity : "" };
    d.open = false; await tick(); demo.renderChat();
    const foldedAfter = grab()?.querySelector("details.thinking")?.open === false;
    grab().querySelector("details.thinking").open = true; await tick(); demo.renderChat();
    const reopenedAfter = grab()?.querySelector("details.thinking")?.open === true;
    const user = [...document.querySelectorAll("#chat .turn.user")].find((t) => t.textContent === "a user line for the bubble check");
    return { ...out, foldedAfter, reopenedAfter, userBg: user ? getComputedStyle(user).backgroundColor : "", agentBg: getComputedStyle(a).backgroundColor };
  })()`);
  ok("the thinking is open by default (dimmed), folds on a tap and stays folded across re-renders; the person's line is a filled bubble the agent's turn is not", think.n === 1 && think.opened && /Considering the bridge/.test(think.text) && Number(think.opacity) < 1 && think.foldedAfter && think.reopenedAfter && think.userBg !== "" && think.userBg !== think.agentBg && !/rgba\(0, 0, 0, 0\)|transparent/.test(think.userBg), think);
  const fb = await ev<string[]>(`(() => {
    const chat = demo.state.chat;
    chat.apply({ type: "entry_appended", entry: { id: "gg-fb", kind: "pi.assistant", model: [{ role: "assistant", provider: "openai", model: "gpt-6-luna", content: [{ type: "text", text: "A plain answer." }], diagnostics: [{ type: "steered-fallback", timestamp: 1, details: { why: "was off-topic gibberish", from: "steered/qwen3.5-27b" } }] }] } });
    chat.apply({ type: "entry_appended", entry: { id: "gg-nofb", kind: "pi.assistant", model: [{ role: "assistant", provider: "steered", model: "qwen3.5-27b", content: [{ type: "text", text: "An edited answer." }] }] } });
    demo.renderChat();
    return [...document.querySelectorAll("#chat .turn.agent")].filter((t) => /A plain answer|An edited answer/.test(t.textContent)).map((t) => t.textContent);
  })()`);
  ok("a turn another model answered says so under it, read from the typed diagnostic; a turn without the diagnostic has no such line", fb.length === 2 && fb[0] === "A plain answer.answered by gpt-6-luna: the edited model's turn was off-topic gibberish" && fb[1] === "An edited answer.", fb);
  // An assistant's markdown is shown as what it means: bold, italics, code and lists are elements, the asterisks are gone, and HTML the model wrote is text, never markup.
  const md = await ev<{ html: string; text: string; bad: number }>(`(() => {
    demo.state.chat.apply({ type: "entry_appended", entry: { id: "md-1", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Try **lemon-garlic pasta** with *spinach* and \\\`rice\\\`:\\n- boil **water**\\n- add <img src=x onerror=\\"window.__pwn=1\\"> pasta\\n\\nSee [a link](javascript:1)." }] }] } });
    demo.renderChat();
    const turn = [...document.querySelectorAll("#chat .turn.agent")].find((t) => /lemon-garlic/.test(t.textContent));
    return { html: turn.innerHTML, text: turn.textContent, bad: turn.querySelectorAll("img, a, script").length + (window.__pwn ? 1 : 0) };
  })()`);
  ok("an assistant's markdown reads as bold, italics, code and a list with no asterisks left, and the HTML it wrote is text, not markup", /<strong>lemon-garlic pasta<\/strong>/.test(md.html) && /<em>spinach<\/em>/.test(md.html) && /<code>rice<\/code>/.test(md.html) && /<li>boil <strong>water<\/strong><\/li>/.test(md.html) && !/\*/.test(md.text) && /<img src=x onerror=/.test(md.text) && md.bad === 0, md);
  // A move Jev decided for a message is written just before it; the chat reads it after the message it belongs to.
  await ev(`(() => { const chat = demo.state.chat; chat.apply({ type: "entry_appended", entry: { id: "mv2", kind: "env.switch", model: [{ role: "user", content: "SYSTEM NOTICE: moved", timestamp: 1 }], data: { switchId: "mv2", planned: true, by: "placement", probability: 0.98, phase: "start", facts: { label: "a Modal VM", tools: [] } } } }); chat.apply({ type: "entry_appended", entry: { id: "u-order", kind: "pi.user", model: [{ role: "user", content: "order check line", timestamp: 2 }] } }); demo.renderChat(); return true; })()`);
  const order = await ev<string[]>(`[...document.querySelectorAll("#chat > .turn.user, #chat > .move")].map((n) => n.textContent).filter((t) => /order check line|Jev 0.98/.test(t))`);
  ok("a placed move reads after the message it belongs to, not before it", order.length === 2 && /order check line/.test(order[0]!) && /Jev 0\.98/.test(order[1]!), order);
  // A sent line shows the moment it is sent, with where it is, and is not shown twice once the transcript holds it.
  await script([]);
  const echoed = await ev<{ lines: string[]; state: string[] }>(`(() => { const i = document.getElementById("input"); i.value = "echo check line"; document.getElementById("send").click(); return { lines: [...document.querySelectorAll("#chat .turn.user.sent")].map((n) => n.textContent), state: [...document.querySelectorAll("#chat .sent-state")].map((n) => n.textContent) }; })()`);
  ok("a sent line is in the chat in the same breath, with 'sending…' under it", echoed.lines.length === 1 && echoed.lines[0] === "echo check line" && echoed.state[0] === "sending…", echoed);
  await page.until(`document.querySelectorAll("#chat .turn.user").length > 0 && [...document.querySelectorAll("#chat .turn.user")].some((n) => n.textContent === "echo check line" && !n.classList.contains("sent"))`, 60_000, 300).catch(() => undefined);
  await page.until(idle, 120_000, 1000).catch(() => undefined);
  const once = await ev<{ n: number; sent: number }>(`({ n: [...document.querySelectorAll("#chat .turn.user")].filter((x) => x.textContent === "echo check line").length, sent: document.querySelectorAll("#chat .sent").length })`);
  ok("once the transcript holds the line the echo is gone: it is shown once", once.n === 1 && once.sent === 0, once);
  // grep shows its hits (this page's tool set has no grep yet: the transcript entries are folded in as a host that has it would write them).
  await ev(`(() => { const chat = demo.state.chat; chat.apply({ type: "entry_appended", entry: { id: "g-a", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } }] }] } }); chat.apply({ type: "entry_appended", entry: { id: "g-r", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "g1", toolName: "grep", content: [{ type: "text", text: "src/a.ts:12:const x = 1;\\nsrc/b.ts:3:  return x;" }] }] } }); demo.renderChat(); const d = [...document.querySelectorAll("details.tool")].find((t) => /^grep/.test(t.textContent)); d.open = true; return !!d; })()`);
  const hits = await ev<string[]>(`[...document.querySelectorAll("details.tool .hit .where")].map((h) => h.textContent)`);
  ok("grep shows its hits: where each is (file:line) and the line", hits.includes("src/a.ts:12") && hits.includes("src/b.ts:3"), hits);
  // A big write (a whole robot body, as .mjs) opens as the code it wrote, from the call's own arguments, not as the tool's "Successfully wrote" line.
  const bigBody = Array.from({ length: 400 }, (_, i) => `export const part${i} = { name: "part${i}", size: [${i}, 0.1, 0.1] };`).join("\n") + "\n";
  await script([call("write", { path: "robot/body.mjs", content: bigBody })]);
  await ev(`document.querySelectorAll("details.tool").forEach((d) => { d.open = false; })`);
  await say("write the dinosaur body as code");
  await ev(`[...document.querySelectorAll("details.tool")].filter((d) => /robot\\/body\\.mjs/.test(d.textContent)).forEach((d) => { d.open = true; })`);
  await until(`[...document.querySelectorAll("details.tool")].some((d) => /body\\.mjs/.test(d.textContent) && /part399/.test(d.querySelector(".diff")?.firstElementChild?.shadowRoot?.textContent ?? ""))`, 60_000).catch(() => undefined);
  const bigOpen = await ev<{ code: boolean; onlyResult: boolean }>(`(() => { const d = [...document.querySelectorAll("details.tool")].filter((x) => /body\\.mjs/.test(x.textContent)).at(-1); return { code: /part399/.test(d.querySelector(".diff")?.firstElementChild?.shadowRoot?.textContent ?? ""), onlyResult: /^Successfully wrote/.test(d.querySelector(".tool-body")?.textContent ?? "") }; })()`);
  ok("a write opens as the code it wrote (its content, from the call's arguments), not as the result line", bigOpen.code && !bigOpen.onlyResult, bigOpen);
  // A failed command is its own output plus a quiet status from the harness's typed diagnostics: the <harness> wrapper is never shown.
  await ev(`(() => { const chat = demo.state.chat; const diag = [{ severity: "error", code: "tool_error", message: "Command exited with code 1" }]; chat.apply({ type: "entry_appended", entry: { id: "f-a", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "fc1", name: "bash", arguments: { command: "cp x /workspace/y" } }] }] } }); chat.apply({ type: "entry_appended", entry: { id: "f-r", kind: "pi.tool-result", data: { diagnostics: diag }, model: [{ role: "toolResult", toolCallId: "fc1", toolName: "bash", isError: true, content: [{ type: "text", text: "cp: cannot create regular file '/workspace/y': No such file or directory\\n" }, { type: "text", text: "<harness>\\n[error] Command exited with code 1\\n</harness>" }] }] } }); demo.renderChat(); const d = [...document.querySelectorAll("details.tool")].find((t) => /cp x \\/workspace\\/y/.test(t.textContent)); d.open = true; return !!d; })()`);
  const failed = await ev<{ summary: string; body: string; status: string }>(`(() => { const d = [...document.querySelectorAll("details.tool")].find((t) => /cp x \\/workspace\\/y/.test(t.textContent)); return { summary: d.querySelector("summary").textContent, body: d.querySelector(".tool-body").textContent, status: d.querySelector(".tool-body .status")?.textContent ?? "" }; })()`);
  ok("a failed command shows its own output and the harness's own status in the line, never the <harness> wrapper", !/<harness>|\[error\]/.test(failed.body) && /cannot create regular file/.test(failed.body) && /Command exited with code 1/.test(failed.summary) && /Command exited with code 1/.test(failed.status), failed);
  // The teaching threads render inside the teach_skills call, each with its own tool calls (the same lines and bodies), and a long command output shows its last lines.
  const log = Array.from({ length: 20 }, (_, i) => `step ${i + 1} reward 0.${i}`).join("\n");
  // What pi-run's trainer printed in D4's code4 run (one JSON event per line): the page reads it as quiet lines.
  const trainer = [
    JSON.stringify({ event: "skill.start", skill: "wave", label: "wave", command: 0.5, skill_dir: "/workspace/skills/wave", skill_sha256: "ed7b1ba3", mjcf_sha256: "fbd67cbc414e175f", joints: 8, status: "training", init_from: "", started_at: 1791798913.12, host: "modal", body_name: null }),
    JSON.stringify({ event: "skill.waiting-for-compile", cache: "/root/.cache/pda-skill/body-fbd.tar.gz" }),
    JSON.stringify({ event: "skill.compile-ready", waited_s: 28.8, finished: true }),
    JSON.stringify({ event: "train.start", universe: "wave", generation: 1, impl: "warp", device: "cuda:0", remaining: 12288000, restore: null, compile_cache: "run" }),
    JSON.stringify({ event: "skill.checkpoint", skill: "wave", checkpoint: 3, steps: 2949120, t: 32.4, passes: false, metric: { name: "paw up", value: 0.2, unit: "share of time", target: ">= 0.6" }, fell_at: null }),
    JSON.stringify({ event: "skill.checkpoint", skill: "wave", checkpoint: 4, steps: 3932160, t: 38.6, passes: true, metric: { name: "paw up", value: 1.0, unit: "share of time", target: ">= 0.6" }, fell_at: null }),
  ].join("\n");
  // A huge mixed log (events, long plain lines): the quiet view keeps its limits, and a raw view the reader expanded stays expanded across a redraw.
  const hugeMixed = Array.from({ length: 3000 }, (_, i) => (i % 3 === 0 ? JSON.stringify({ event: "skill.checkpoint", skill: "wave", checkpoint: i, steps: i, t: i, passes: false, metric: { name: "paw up", value: 0.1, unit: "share of time", target: ">= 0.6" }, fell_at: null }) : "x".repeat(900))).join("\n");
  // A log whose start is one giant line (over the 200,000 characters the page reads) and whose last lines are trainer events: shortened, and it says so.
  const giantThenEvents = "y".repeat(300_000) + "\n" + trainer.split("\n").slice(0, 3).join("\n");
  const checkOut = JSON.stringify({ event: "skill.check", policy: "/workspace/runs/wave/policy.json", passes: true, metric: { name: "paw up", value: 0.62, unit: "share of time", target: ">= 0.6" } });
  const longLog = Array.from({ length: 3000 }, (_, i) => `epoch ${i + 1} reward ${i}`).join("\n"); // far more than the 6,000 characters a body keeps of a short output
  const entries = JSON.stringify([
    { id: "t-u", kind: "pi.user", model: [{ role: "user", content: "You are thread 3 of 8, with GPU 3 of your own. Your skill: spin.\n\nBrief: spin in place.", timestamp: 1 }] },
    { id: "t-a0", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "I will write the reward, then train it." }] }] },
    { id: "t-a1", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "tw", name: "write", arguments: { path: "train/spin_reward.py", content: "def reward(s):\n    return s.spin\n" } }] }] },
    { id: "t-r1", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tw", toolName: "write", content: [{ type: "text", text: "wrote" }] }] },
    { id: "t-a2", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "tb", name: "bash", arguments: { command: "pi-run spin -- python train.py" } }] }] },
    { id: "t-r2", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tb", toolName: "bash", content: [{ type: "text", text: log }] }] },
    { id: "t-a5", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "th", name: "bash", arguments: { command: "pi-run wave -- noisy" } }] }] },
    { id: "t-r5", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "th", toolName: "bash", content: [{ type: "text", text: hugeMixed }] }] },
    { id: "t-a6", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "tg", name: "bash", arguments: { command: "pi-run wave -- giant" } }] }] },
    { id: "t-r6", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tg", toolName: "bash", content: [{ type: "text", text: giantThenEvents }] }] },
    { id: "t-a7", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "tk", name: "bash", arguments: { command: "pi-run wave -- train-skill --check /workspace/runs/wave/policy.json" } }] }] },
    { id: "t-r7", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tk", toolName: "bash", content: [{ type: "text", text: checkOut }] }] },
    { id: "t-a4", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "tt", name: "bash", arguments: { command: "pi-run wave -- train-skill --steps 12M" } }] }] },
    { id: "t-r4", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tt", toolName: "bash", content: [{ type: "text", text: trainer }] }] },
    { id: "t-a3", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "tl", name: "bash", arguments: { command: "tail -f train.log" } }] }] },
    { id: "t-r3", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tl", toolName: "bash", content: [{ type: "text", text: longLog }] }] },
  ]);
  await ev(`(() => { const chat = demo.state.chat; chat.apply({ type: "entry_appended", entry: { id: "ts-a", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "ts1", name: "teach_skills", arguments: { skills: [{ name: "spin", brief: "spin in place" }] } }] }] } }); chat.apply({ type: "entry_appended", entry: { id: "ts-r", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "ts1", toolName: "teach_skills", content: [{ type: "text", text: "2 threads finished: 2 passed.\\n- GPU 1 · walk: passed. I trained walk.\\nHome: 2 skills: spin, walk.\\nEach thread's own conversation: read_thread with its skill or GPU number." }], details: { teach: 14, threads: [{ skill: "walk", gpu: 1, conversationId: 16, boxId: "b1", status: "passed", checkpoint: 5, seconds: 93, summary: "I trained walk.", metric: { name: "speed", value: 0.51, unit: "m/s", target: ">= 0.4" } }, { skill: "spin", gpu: 3, conversationId: 41, boxId: "b3", status: "passed", checkpoint: 6, seconds: 70, summary: "spun", metric: { name: "spin rate", value: 1.23, unit: "rad/s", target: ">= 1.0" } }], home: { skills: ["spin", "walk"] } } }] } }); demo.thread({ kind: "thread", conversation: 41, teach: 14, name: "spin", gpu: 3, status: "running", snapshot: { type: "snapshot", entries: ${entries}, tools: [] } }); return true; })()`);
  ok("the teach_skills call opens by itself when it has threads, so their rows are on screen", await until(`[...document.querySelectorAll("details.tool")].some((t) => /^teach_skills/.test(t.textContent) && t.open && !!t.querySelector("details.thread"))`, 10_000).then(() => true, () => false));
  const card = await ev<{ rows: string[]; home: string; text: string }>(`(() => { const d = [...document.querySelectorAll("details.tool")].find((t) => /^teach_skills/.test(t.textContent)); return { rows: [...d.querySelectorAll(".result-card .rc-row")].map((r) => r.textContent), home: d.querySelector(".result-card .rc-home")?.textContent ?? "", text: d.querySelector(".tool-body").textContent }; })()`);
  ok("teach_skills' answer is a compact card from its typed details: a row per thread and what came home; the model's hint is not shown", card.rows.length === 2 && card.rows[0] === "✓ walk · speed 0.51 m/s ≥ 0.4 · checkpoint 5 · 93 s" && card.rows[1] === "✓ spin · spin rate 1.23 rad/s ≥ 1.0 · checkpoint 6 · 70 s" && card.home === "Home: spin, walk" && !/read_thread|Each thread/.test(card.text), card);
  const rows = await ev<string[]>(`[...document.querySelectorAll("details.thread > summary")].map((s) => s.textContent.replace(/\\s+/g, " ").trim())`);
  ok("each thread is a row inside the teach_skills call: its GPU, its name and how far it is", rows.length === 1 && /GPU 3\s*spin\s*\d+ calls?$/.test(rows[0]), rows);
  ok("every thread row is open by itself, so nobody has to click to see them working", await ev<boolean>(`[...document.querySelectorAll("details.thread")].length > 0 && [...document.querySelectorAll("details.thread")].every((d) => d.open && !!d.querySelector(".thread-chat"))`));
  await ev(`document.querySelector("details.thread").open = true`);
  await until(`!!document.querySelector("details.thread details.tool .diff")?.firstElementChild?.shadowRoot`, 15_000).catch(() => undefined);
  await ev(`[...document.querySelectorAll("details.thread details.tool")].forEach((d) => { d.open = true; })`);
  await until(`!!document.querySelector("details.thread .tool .diff")?.firstElementChild?.shadowRoot && document.querySelector("details.thread .tool .diff").firstElementChild.shadowRoot.textContent.includes("def reward")`, 30_000).catch(() => undefined);
  const threadType = await ev<{ font: string; words: string }>(`(() => { const t = document.querySelector("details.thread .thread-chat .turn"); return { font: t ? getComputedStyle(t).fontFamily : "", words: t ? t.textContent : "" }; })()`);
  ok("a thread's own words are set in the body type, not the code type", /I will write the reward/.test(threadType.words) && !/mono|jetbrains/i.test(threadType.font), threadType);
  const inThread = await ev<{ brief: string; diff: string; tail: string; more: string; bash: string[] }>(`(() => { const t = document.querySelector("details.thread"); return { brief: t.querySelector(".brief")?.textContent ?? "", diff: (t.querySelector(".diff")?.firstElementChild?.shadowRoot?.textContent ?? "").replace(/\\s+/g, " "), tail: t.querySelector(".output pre")?.textContent ?? "", more: t.querySelector(".output .more")?.textContent ?? "", bash: [...t.querySelectorAll("details.tool")].map((d) => d.className + " :: " + d.innerHTML.slice(0, 240)) }; })()`);
  ok("opening a thread shows its brief and its own tool calls: the training code as a diff", inThread.brief === "spin in place" && !/Follow your instructions|You are thread/.test(inThread.brief) && /def reward/.test(inThread.diff), inThread);
  ok("a long command output shows its last 8 lines and how many came before", /^step 13 /.test(inThread.tail) && /step 20 reward/.test(inThread.tail) && inThread.more === "12 earlier lines", inThread);
  const longTail = await ev<{ tail: string; more: string; full: string }>(`(() => { const o = [...document.querySelectorAll("details.thread .output")].find((x) => /epoch/.test(x.textContent)); const more = o.querySelector(".more"); const tail = o.querySelector("pre").textContent; const label = more.textContent; more.click(); return { tail, more: label, full: o.querySelector("pre").textContent }; })()`);
  ok("a log far longer than a body keeps shows its newest lines (the last 8, counted from the whole output), not its first", /epoch 3000 reward 2999$/.test(longTail.tail) && /^epoch 2993 /.test(longTail.tail) && longTail.more === "2992 earlier lines", longTail);
  ok("and asking for all of it ends at the real end of the log", /epoch 3000 reward 2999$/.test(longTail.full), longTail.full.slice(-80));
  const quiet = await ev<{ lines: string[]; raw: string; rawAfter: string }>(`(() => { const o = [...document.querySelectorAll("details.thread .output.trainer")].find((x) => /--steps 12M/.test(x.closest("details.tool").textContent)); const lines = [...o.querySelectorAll(".tbody .tl")].map((l) => l.className + " | " + l.textContent); const mode = o.querySelector(":scope > button.more"); const first = mode.textContent; mode.click(); const raw = o.querySelector(".tbody pre")?.textContent ?? ""; return { lines, raw: first, rawAfter: raw }; })()`);
  ok("a trainer's JSON events read as quiet lines: compiling, training on its device, each checkpoint against its target, the passing one marked", quiet.lines.length === 6 && quiet.lines[2] === "tl event | compiled · ready in 28.8 s" && quiet.lines[3] === "tl event | training 12M steps on cuda:0" && quiet.lines[4] === "tl event | checkpoint 3 · paw up 0.2 share of time (target ≥ 0.6) · not yet · 32.4 s" && quiet.lines[5] === "tl pass | checkpoint 4 · paw up 1 share of time (target ≥ 0.6) · ✓ passes · 38.6 s", quiet);
  ok("and the raw output is one click away", quiet.raw === "raw output" && /"event": ?"skill\.checkpoint"/.test(quiet.rawAfter), quiet.rawAfter.slice(0, 120));
  await ev(`[...document.querySelectorAll("details.thread .output.trainer")].find((x) => /--steps 12M/.test(x.closest("details.tool").textContent)).querySelector(":scope > button.more").click()`);
  const huge = await ev<{ rows: number; widest: number; label: string; note: string }>(`(() => { const o = [...document.querySelectorAll("details.thread .output.trainer")].find((x) => /pi-run wave -- noisy|checkpoint 2997/.test(x.closest("details.tool").textContent)); const label = o.querySelector(".tbody .more").textContent; const more = o.querySelector(".tbody .more"); more.click(); const rows = [...o.querySelectorAll(".tbody .tl")]; return { rows: rows.length, widest: Math.max(...rows.map((r) => r.textContent.length)), label, note: rows[0]?.textContent ?? "" }; })()`);
  ok("however much of a huge log the page left unread, the count of earlier lines is exact (3000 lines, 8 shown) and the omitted-lines note says how many the quiet view leaves out", huge.label === "2992 earlier lines" && Number(/^… (\d+) earlier lines not shown here/.exec(huge.note)?.[1]) + (huge.rows - 1) === 3000, huge);
  ok("a huge mixed log keeps the quiet view's limits: at most 400 rows, no line longer than 400 characters (and a note of what is left out)", huge.rows <= 402 && huge.widest <= 460, huge);
  // The quiet view above was expanded; switching to the raw view keeps that choice, and a redraw (more output arriving) keeps it too.
  const checkLine = await ev<string>(`(() => { const o = [...document.querySelectorAll("details.thread .output.trainer")].find((x) => /--check/.test(x.closest("details.tool").textContent)); const l = o.querySelector(".tbody .tl"); return l.className + " | " + l.textContent; })()`);
  ok("a trainer's --check result reads as a quiet line like a checkpoint, passing in green, the raw JSON one click away", checkLine === "tl pass | check · paw up 0.62 share of time (target ≥ 0.6) · ✓ passes", checkLine);
  const giant = await ev<{ note: string; rows: number }>(`(() => { const o = [...document.querySelectorAll("details.thread .output.trainer")].find((x) => /pi-run wave -- giant/.test(x.closest("details.tool").textContent)); return { note: o.querySelector(".tbody .tl.plain")?.textContent ?? "", rows: o.querySelectorAll(".tbody .tl").length }; })()`);
  ok("a shortened log says it is shortened even when what is left is only a few lines: the note names how many earlier lines were not read", /^… 1 earlier line not shown here/.test(giant.note), giant);
  const rawKept = await ev<{ afterSwitch: string; afterRedraw: string }>(`(() => { const find = () => [...document.querySelectorAll("details.thread .output.trainer")].find((x) => /pi-run wave -- noisy/.test(x.closest("details.tool").textContent)); const o = find(); o.querySelector(":scope > button.more").click(); const afterSwitch = find().querySelector(".tbody .more")?.textContent ?? ""; demo.renderChat(); return { afterSwitch, afterRedraw: find().querySelector(".tbody .more")?.textContent ?? "" }; })()`);
  ok("a log the reader expanded stays expanded when switching to the raw view and when the chat redraws", rawKept.afterSwitch === "show the last lines" && rawKept.afterRedraw === "show the last lines", rawKept);
  await ev(`document.querySelector("details.thread .output .more").click()`);
  ok("and asking for it shows all of it", await ev<boolean>(`document.querySelector("details.thread .output pre").textContent.startsWith("step 1 ")`));
  // The chat follows a thread as it grows (the newest tool lines are in view) unless the reader scrolled up.
  const grow = (from: number, to: number) => ev(`(() => { const e = []; for (let i = ${from}; i < ${to}; i++) { e.push({ type: "entry_appended", entry: { id: "g" + i + "a", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "gc" + i, name: "write", arguments: { path: "train/part" + i + ".py", content: Array.from({ length: 30 }, (_, k) => "def f" + k + "(x): return x * " + k).join("\\n") + "\\n" } }] }] } }); e.push({ type: "entry_appended", entry: { id: "g" + i + "r", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "gc" + i, toolName: "write", content: [{ type: "text", text: "wrote" }] }] } }); } demo.thread({ kind: "thread", conversation: 41, teach: 14, name: "spin", gpu: 3, status: "running", events: e }); return true; })()`);
  const atEnd = () => ev<number>(`(() => { const c = document.getElementById("chat"); return c.scrollHeight - c.scrollTop - c.clientHeight; })()`);
  await ev(`document.querySelectorAll("details.thread details.tool").forEach((d) => { d.open = true; })`);
  await ev(`(() => { const c = document.getElementById("chat"); c.scrollTop = c.scrollHeight; c.dispatchEvent(new Event("scroll")); return true; })()`);
  await grow(100, 106);
  await ev(`document.querySelectorAll("details.thread details.tool").forEach((d) => { d.open = true; })`); // their diffs are drawn after the redraw: the page grows after the scroll was set
  await sleep(2500);
  ok("a thread that grows while the reader is at the bottom: the newest lines stay in view", (await atEnd()) < 8, await atEnd());
  await ev(`(() => { const c = document.getElementById("chat"); c.dispatchEvent(new WheelEvent("wheel", { deltaY: -240 })); c.scrollTop = 0; c.dispatchEvent(new Event("scroll")); return true; })()`); // the reader scrolls up
  await grow(106, 112);
  await ev(`document.querySelectorAll("details.thread details.tool").forEach((d) => { d.open = true; })`);
  await sleep(1200);
  ok("and a reader who scrolled up is left where they are", await ev<number>(`document.getElementById("chat").scrollTop`) < 40, await ev(`document.getElementById("chat").scrollTop`));
  await ev(`(() => { const c = document.getElementById("chat"); c.scrollTop = c.scrollHeight; c.dispatchEvent(new Event("scroll")); return true; })()`);
  await page.screenshot(join(shots, "pane-3c-threads.png"));
  // The workspace: the session's files as a live tree (@pierre/trees); a file picked opens read-only.
  await ev(`document.getElementById("ws-toggle").click()`);
  await until(`(() => { const h = document.getElementById("files").firstElementChild; return !!h && !!h.shadowRoot && !!h.shadowRoot.querySelector('[data-item-path="robot/body.ts"]'); })()`, 60_000).catch(() => undefined);
  const treePaths = await ev<string[]>(`[...document.getElementById("files").firstElementChild.shadowRoot.querySelectorAll("[data-item-path]")].map((r) => r.getAttribute("data-item-path"))`);
  ok("the Files panel lists the session's files as a tree, including the one the agent just wrote", treePaths.includes("creature/") && treePaths.includes("robot/body.ts"), treePaths);
  await ev(`(() => { const row = [...document.getElementById("files").firstElementChild.shadowRoot.querySelectorAll("[data-item-path]")].find((r) => r.getAttribute("data-item-path") === "robot/body.ts"); row.click(); return !!row; })()`);
  await until(`document.getElementById("preview-name").textContent.startsWith("robot/body.ts")`, 30_000).catch(() => undefined);
  await until(`!!document.querySelector("#preview .file") && !!document.querySelector("#preview .file").firstElementChild?.shadowRoot && /spikes: 6/.test(document.querySelector("#preview .file").firstElementChild.shadowRoot.textContent)`, 60_000).catch(() => undefined);
  ok("a file picked in the tree opens read-only, with the edit applied", await ev<boolean>(`/spikes: 6/.test(document.querySelector("#preview .file")?.firstElementChild?.shadowRoot?.textContent ?? "") && !document.querySelector("#preview textarea, #preview [contenteditable=true]")`));
  await ev(`Promise.all([demo.select("home/skills.json"), demo.select("robot/body.ts")])`);
  await sleep(1500);
  ok("two picks in a row: the preview is the later one, however the reads finish", await ev<boolean>(`document.getElementById("preview-name").textContent.startsWith("robot/body.ts") && /spikes: 6/.test(document.querySelector("#preview .file")?.firstElementChild?.shadowRoot?.textContent ?? "")`));
  await page.screenshot(join(shots, "pane-3b-workspace.png"));
  await ev(`document.getElementById("ws-close").click()`);
  const changes = await ev<string>(`document.getElementById("creature").contentWindow.__walks.app.bodySha`);

  // offline: checkout, the network cut, the robot still redraws
  await ev("demo.goOffline = demo.goOffline"); // (the page's own button is used below)
  // how long the tab went without a frame to the server (any frame keeps the writer alive; the server retires it after --grace-ms): recorded from the click to the checkout's end
  await ev(`(() => { const send = WebSocket.prototype.send; window.__frames = []; WebSocket.prototype.send = function (...a) { window.__frames.push(Math.round(performance.now())); return send.apply(this, a); }; return true; })()`);
  console.log("  toggle before the click:", JSON.stringify(await ev(`(() => { const b = document.getElementById("connection"); return { action: b.dataset.action, title: b.title, mode: demo.state.mode, checkout: demo.state.checkout ?? null, switching: !!demo.state.switching, brain: demo.state.brain ? "yes" : "no" }; })()`)));
  await ev("document.getElementById('connection').click()");
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 300_000, 500).catch(async (e) => {
    console.log("  largest gap between the tab's frames to the server, click to timeout:", await frameGap().catch(() => "page gone"));
    console.log("  state at the timeout:", JSON.stringify(await ev(`({ mode: demo.state.mode, checkout: demo.state.checkout ?? null, banner: demo.state.banner, progress: demo.state.progress, checkingOut: !!demo.state.checkingOut, action: document.getElementById("connection").dataset.action })`).catch(() => "page gone")));
    throw e;
  });
  console.log("  largest gap between the tab's frames to the server, click to checkout:", await frameGap());
  ok("the run was checked out (the creature page's files are cached with the page)", (await ev<string>("demo.state.mode")) === "offline", await ev("demo.state.banner"));
  // The checkout is one quiet line ("Offline · this browser's brain"); every fact it used to put in the audience's face is one click away.
  await until(`!document.getElementById("checkedout").hidden`, 15_000).catch(() => undefined); // the page draws it on its next render
  await page.screenshot(join(shots, "pane-offline-line.png"));
  const banner = await ev<{ shown: boolean; h: number; open: boolean; line: string; facts: number; text: string }>(`(() => { const s = document.getElementById("checkedout"); const d = s.querySelector("details"); const sum = d ? d.querySelector("summary") : null; const h = Math.round(s.getBoundingClientRect().height); const before = { shown: !s.hidden, h, open: !!d && d.open, line: sum ? sum.textContent.replace(/\\s+/g, " ").trim() : s.textContent.slice(0, 60) }; if (d) d.open = true; return { ...before, facts: document.querySelectorAll("#cannot li").length, text: s.textContent.replace(/\\s+/g, " ") }; })()`);
  ok("checked out: one quiet line, closed, not a banner full of operator text", banner.shown && !banner.open && banner.h <= 44 && /^Offline · this browser's brain/.test(banner.line), banner);
  const offBar = await ev<{ state: string; title: string; where: string; ids: string[] }>(`(() => ({ state: document.getElementById("connection").dataset.state, title: document.getElementById("connection").title, where: document.getElementById("badge").innerText.replace(/\\s+/g, " ").trim(), ids: ["net", "offline", "online"].filter((id) => document.getElementById(id)) }))()`);
  ok("checked out: the one toggle shows offline (its tooltip says so), the label still says where it runs, and no second button appeared", offBar.state === "offline" && /^Offline/.test(offBar.title) && offBar.where === "Running in: browser (Wasm)" && offBar.ids.length === 0, offBar);
  ok("and every fact is one click away: what does not work (six items) and what the checkout is", banner.facts >= 6 && /The live copy of this run is here/.test(banner.text) && /Moves:/.test(banner.text) && /Sync back:/.test(banner.text), banner.text.slice(0, 200));
  await page.screenshot(join(shots, "pane-offline-open.png"));
  await ev(`document.querySelector("#checkedout details").open = false`);
  const cached = await ev<string[]>(`caches.open("walks-home-offline-v1").then((c) => c.keys()).then((ks) => ks.map((k) => new URL(k.url).pathname).filter((p) => p.startsWith("/tab/")))`);
  ok("the service worker holds the creature page and MuJoCo's wasm", cached.includes("/tab/") && cached.includes("/tab/main.js") && cached.some((p) => p.endsWith("mujoco.wasm")), cached);
  await page.send("Network.enable");
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
  await page.until("demo.net().online === false", 20_000, 300);
  await sleep(1000);
  // the offline brain is the computer's tools here (no model in this check): the robot's file is edited with the page's own computer, the way a tool would, and the creature must follow
  const edited = await ev<{ exitCode?: number }>(`demo.exec(${JSON.stringify(`node -e 'const f="creature/robot.json"; const s=JSON.parse(require("fs").readFileSync(f,"utf8")); s.look.torso="blue"; s.name="Offline"; s.edits++; require("fs").writeFileSync(f, JSON.stringify(s));'`)})`);
  await ev("demo.flush()");
  await until(`document.getElementById("creature").contentWindow.__walks.look().torso === "#3b78d9"`, 40_000).catch(() => undefined);
  ok("offline: an edit of the robot's file redraws the creature (the torso is blue)", (await walks<{ torso: string }>("w.look()")).torso === "#3b78d9", { edited, look: await walks("w.look()") });
  ok("offline: the creature is still simulating", await walks<boolean>("w.app.sim.time > 1"));
  await page.screenshot(join(shots, "pane-3-offline.png"));

  // a reload with no network: same robot
  await page.send("Page.reload");
  await sleep(1500);
  await page.until("globalThis.demo && demo.state.mode === 'offline'", 300_000, 500);
  await until(`!!document.getElementById("creature").contentWindow?.__walks`, 120_000);
  await until(`document.getElementById("creature").contentWindow.__walks.look().torso === "#3b78d9"`, 60_000).catch(() => undefined);
  ok("offline reload: the creature page loads from the cache and the robot is the one the agent made", (await walks<{ torso: string; legs: string[] }>("w.look()")).torso === "#3b78d9" && (await walks<{ legs: string[] }>("w.look()")).legs.every((c) => c === "#d9423b"), await walks("w.look()"));
  // robot.json still names sprint, but with the flag in the scene a walk or sprint plays only as a fresh request's run (goal.ts flagPlan): a reload does not send the robot off with nothing measuring it. What the label says after a reload is
  // a race between the page reading the skills and reading home/policy.json ("WALK · SPRINT" standing, or the old brain borrowed and flagged "no longer fits"), so it is printed, not asserted.
  ok("offline reload: the body is the changed one, and the robot stands until it is asked (the skill robot.json names does not start on its own)", (await walks<string>("w.app.bodySha")) === changes && (await walks<string | null>("w.skill()")) === null, { sha: await walks("w.app.bodySha"), want: changes, skill: await walks("w.skill()"), fits: await walks("w.fits()") });
  console.log("  after offline reload:", JSON.stringify({ label: await ev(`document.getElementById("creature").contentDocument.getElementById("stateLabel").textContent`), fits: await walks("w.fits()"), skill: await walks("w.skill()"), policy: await walks("w.state().policy") }));
  await page.screenshot(join(shots, "pane-4-offline-reload.png"));
  // Offline, from the service worker's cache: the libraries' chunks are in it, so a file still opens and a diff still draws.
  await ev(`demo.select("robot/body.ts")`);
  await ev(`document.getElementById("preview").replaceChildren()`);
  await ev(`document.getElementById("preview-name").textContent = ""`);
  await ev(`demo.select("home/skills.json")`);
  await until(`!!document.querySelector("#preview .file")?.firstElementChild?.shadowRoot && document.querySelector("#preview .file").firstElementChild.shadowRoot.textContent.length > 0`, 60_000).catch(() => undefined);
  ok("offline reload: a workspace file opens read-only (the libraries load from the cache)", await ev<boolean>(`(document.querySelector("#preview .file")?.firstElementChild?.shadowRoot?.textContent ?? "").length > 0`));
  const errors = page.console.filter((l) => /Uncaught|unhandled/i.test(l)).slice(-5);
  ok("no uncaught errors", errors.length === 0, errors);
} catch (error) {
  console.log(`FAIL ${(error as Error).message}`);
  failed++;
  if (page) {
    console.log(JSON.stringify(await page.evaluate("(async () => globalThis.demo ? ({ mode: demo.state.mode, banner: demo.state.banner, net: demo.net(), items: demo.items().slice(-4).map(i => ({ kind: i.kind, text: String(i.text ?? i.name ?? '').slice(0, 100) })), creature: document.getElementById('creature')?.contentWindow?.__walks?.state?.() }) : null)()").catch((e: Error) => e.message)));
    console.log(page.console.filter((l) => !l.startsWith("debug")).slice(-10).join("\n"));
    await page.screenshot(join(shots, "pane-failed.png")).catch(() => undefined);
  }
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all checks passed");
