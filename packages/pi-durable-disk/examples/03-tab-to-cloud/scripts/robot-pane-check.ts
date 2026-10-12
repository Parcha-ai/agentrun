// The robot in the agent's page, in real Chrome, end to end: the creature page runs in an iframe under /tab/ and reads and writes its files through the page's workspace. The agent's robot tools
// (the cloud model is scripted: the tools are real) edit creature/robot.json; the creature redraws; a body change stumbles; do(skill) switches the policy live; then the run is checked out, the
// network cut, and the robot still redraws and walks, with the assets from the service worker's cache; a reload offline keeps the changes.
//   [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/robot-pane-check.ts
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
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/files/", "--no-restore", "home/model/"], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "inherit"] });
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
type Item = { kind: string; text?: string; name?: string; status?: string; output?: string };
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
const until = (expr: string, ms = 30_000) => page!.until(expr, ms, 300);
try {
  const phone = process.env.PHONE === "1"; // PHONE=1: the same check in a 375 px wide page
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?robot=1&brain=off#"), phone ? { width: 375, height: 760 } : undefined);
  await page.until("globalThis.demo && demo.state.mode === 'writer'", 300_000, 500);
  await until(`!!document.getElementById("creature").contentWindow.__walks`, 60_000);
  ok("the creature page runs in the agent's page, under /tab/ on the same origin", await ev<boolean>(`document.getElementById("creature").contentWindow.location.pathname === "/tab/"`));
  if (phone) {
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

  // a skill
  await script([call("do", { skill: "sprint" })]);
  const t3 = await say("sprint!");
  await until(`document.getElementById("creature").contentWindow.__walks.skill() === "sprint"`).catch(() => undefined);
  ok("do(sprint): the agent's tool accepted a skill that came home, and the creature page switched to it", t3.some((i) => i.kind === "tool" && i.name === "do" && i.status === "done") && (await walks<string>("w.skill()")) === "sprint", t3.map((i) => `${i.name ?? i.kind}:${i.status ?? ""}:${(i.output ?? "").slice(0, 80)}`));
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
  // The teaching threads render inside the teach_skills call, each with its own tool calls (the same lines and bodies), and a long command output shows its last lines.
  const log = Array.from({ length: 20 }, (_, i) => `step ${i + 1} reward 0.${i}`).join("\n");
  const longLog = Array.from({ length: 3000 }, (_, i) => `epoch ${i + 1} reward ${i}`).join("\n"); // far more than the 6,000 characters a body keeps of a short output
  const entries = JSON.stringify([
    { id: "t-u", kind: "pi.user", model: [{ role: "user", content: "You are thread 3 of 8, with GPU 3 of your own. Your skill: spin.\n\nBrief: spin in place.", timestamp: 1 }] },
    { id: "t-a1", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "tw", name: "write", arguments: { path: "train/spin_reward.py", content: "def reward(s):\n    return s.spin\n" } }] }] },
    { id: "t-r1", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tw", toolName: "write", content: [{ type: "text", text: "wrote" }] }] },
    { id: "t-a2", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "tb", name: "bash", arguments: { command: "pi-run spin -- python train.py" } }] }] },
    { id: "t-r2", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tb", toolName: "bash", content: [{ type: "text", text: log }] }] },
    { id: "t-a3", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "tl", name: "bash", arguments: { command: "tail -f train.log" } }] }] },
    { id: "t-r3", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tl", toolName: "bash", content: [{ type: "text", text: longLog }] }] },
  ]);
  await ev(`(() => { const chat = demo.state.chat; chat.apply({ type: "entry_appended", entry: { id: "ts-a", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "ts1", name: "teach_skills", arguments: { skills: [{ name: "spin", brief: "spin in place" }] } }] }] } }); demo.thread({ kind: "thread", conversation: 41, teach: 14, name: "spin", gpu: 3, status: "running", snapshot: { type: "snapshot", entries: ${entries}, tools: [] } }); const d = [...document.querySelectorAll("details.tool")].find((t) => /^teach_skills/.test(t.textContent)); d.open = true; return !!d; })()`);
  const rows = await ev<string[]>(`[...document.querySelectorAll("details.thread > summary")].map((s) => s.textContent.replace(/\\s+/g, " ").trim())`);
  ok("each thread is a row inside the teach_skills call: its GPU, its name and how far it is", rows.length === 1 && /GPU 3\s*spin\s*\d+ calls/.test(rows[0]), rows);
  await ev(`document.querySelector("details.thread").open = true`);
  await until(`!!document.querySelector("details.thread details.tool .diff")?.firstElementChild?.shadowRoot`, 15_000).catch(() => undefined);
  await ev(`[...document.querySelectorAll("details.thread details.tool")].forEach((d) => { d.open = true; })`);
  await until(`!!document.querySelector("details.thread .tool .diff")?.firstElementChild?.shadowRoot && document.querySelector("details.thread .tool .diff").firstElementChild.shadowRoot.textContent.includes("def reward")`, 30_000).catch(() => undefined);
  const inThread = await ev<{ brief: string; diff: string; tail: string; more: string; bash: string[] }>(`(() => { const t = document.querySelector("details.thread"); return { brief: t.querySelector(".brief")?.textContent ?? "", diff: (t.querySelector(".diff")?.firstElementChild?.shadowRoot?.textContent ?? "").replace(/\\s+/g, " "), tail: t.querySelector(".output pre")?.textContent ?? "", more: t.querySelector(".output .more")?.textContent ?? "", bash: [...t.querySelectorAll("details.tool")].map((d) => d.className + " :: " + d.innerHTML.slice(0, 240)) }; })()`);
  ok("opening a thread shows its brief and its own tool calls: the training code as a diff", /Brief: spin in place/.test(inThread.brief) && /def reward/.test(inThread.diff), inThread);
  ok("a long command output shows its last 8 lines and how many came before", /^step 13 /.test(inThread.tail) && /step 20 reward/.test(inThread.tail) && inThread.more === "12 earlier lines", inThread);
  const longTail = await ev<{ tail: string; more: string; full: string }>(`(() => { const o = [...document.querySelectorAll("details.thread .output")].find((x) => /epoch/.test(x.textContent)); const more = o.querySelector(".more"); const tail = o.querySelector("pre").textContent; const label = more.textContent; more.click(); return { tail, more: label, full: o.querySelector("pre").textContent }; })()`);
  ok("a log far longer than a body keeps shows its newest lines (the last 8, counted from the whole output), not its first", /epoch 3000 reward 2999$/.test(longTail.tail) && /^epoch 2993 /.test(longTail.tail) && longTail.more === "2992 earlier lines", longTail);
  ok("and asking for all of it ends at the real end of the log", /epoch 3000 reward 2999$/.test(longTail.full), longTail.full.slice(-80));
  await ev(`document.querySelector("details.thread .output .more").click()`);
  ok("and asking for it shows all of it", await ev<boolean>(`document.querySelector("details.thread .output pre").textContent.startsWith("step 1 ")`));
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
  await ev("document.getElementById('offline').click()");
  await page.until("demo.state.mode === 'offline' || /could not take it offline/.test(demo.state.banner)", 300_000, 500);
  ok("the run was checked out (the creature page's files are cached with the page)", (await ev<string>("demo.state.mode")) === "offline", await ev("demo.state.banner"));
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
  ok("offline reload: the body is the changed one, with its brain flagged", (await walks<string>("w.app.bodySha")) === changes && (await walks<boolean>("w.fits()")) === false, { sha: await walks("w.app.bodySha"), want: changes });
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
