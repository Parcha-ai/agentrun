// A pushback turn's drafts in the agent's page, in real Chrome: the edited model's provider marks the message with a typed
// steered-drafts diagnostic (gg-onemore/pi/use-model.ts), and the page shows three labeled boxes, each one draft's own
// thinking, under a status line in its own voice; then Jev's pick: the others fold to a line, the picked one stays, the
// answer follows. A reload mid-turn and the saved message draw the same boxes. Screenshots in SHOTS.
//   [CDP=http://127.0.0.1:9334] [SHOTS=/tmp] [TMPDIR=<roomy dir>] node scripts/drafts-check.ts
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp.ts";

const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS ?? "/tmp";
let failed = 0;
const ok = (name: string, pass: boolean, got?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got: ${JSON.stringify(got)}`}`); if (!pass) failed++; };
const here = import.meta.dirname;
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "drafts-check-"));
const port = await freePort();
const RUN = "dr";
mkdirSync(join(dir, "runs", RUN, "work"), { recursive: true });
const server = spawn(process.execPath, ["serve.ts", "--port", String(port), "--parent-pid", String(process.pid), "--local", dir, "--run", RUN, "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000", "--no-restore", "home/files/"], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "inherit"] });
let link = "";
server.stdout!.on("data", (d) => { const m = /(\/run\/[\w.-]+#[\w-]+)/.exec(String(d)); if (m && !link) link = m[1]; });
for (let i = 0; i < 100 && !link; i++) await sleep(100);
if (!link) throw new Error("the server printed no run link");
const cdp = await Cdp.connect(process.env.CDP ?? "http://127.0.0.1:9334");
const device = await cdp.device();
let page: Awaited<ReturnType<typeof device.open>> | undefined;
const ev = <T>(e: string) => page!.evaluate<T>(e);
type Drawn = { status: string; boxes: { cls: string; label: string; text: string; open: boolean }[]; answer: string; picked: boolean; columns: number };
// what the page draws for the turn: its status line, each box (class, label, its thinking), the answer, the grid's columns
const drawn = () => ev<Drawn>(`(() => {
  demo.renderChat();
  const turn = [...document.querySelectorAll("#chat .turn.agent")].find((t) => t.querySelector(".drafts"));
  if (!turn) return null;
  const grid = turn.querySelector(".drafts");
  const boxes = [...grid.children].map((b) => ({ cls: b.className, label: (b.querySelector("summary") ?? b).textContent.trim(), text: b.querySelector("pre")?.textContent ?? "", open: b.open === true }));
  const answer = [...turn.querySelectorAll(":scope > p")].map((p) => p.textContent).join(" ");
  return { status: turn.querySelector(".drafts-status")?.textContent ?? "", boxes, answer, picked: grid.classList.contains("picked"), columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length };
})()`);
const T = ["Draft one weighs Paris, then the towers. ", "Draft two sees the bridge in the fog, and laughs. ", "Draft three thinks of fog over the bay. "];
const diag = (details: Record<string, unknown>) => [{ type: "steered-drafts", timestamp: Date.now() - 12_000, details }];
const msg = (content: unknown[], details: Record<string, unknown>) => ({ role: "assistant", provider: "steered", model: "qwen3.5-27b", api: "openai-completions", content, diagnostics: diag(details), usage: {}, stopReason: "stop", timestamp: Date.now() });
const thinking = T.map((t) => ({ type: "thinking", thinking: t }));
const PICK = { of: 3, picked: 2, copies: 0.1, topic: 0.6, tries: 0.9, funny: 0.8 };
const ANSWER = "You got me! My bridge brain needs a tune-up. Wait, Paris.";
try {
  page = await device.open(`http://127.0.0.1:${port}${link}`.replace("#", "?brain=off#"), { width: 1200, height: 900 });
  await page.until("globalThis.demo && demo.state.chat && demo.state.mode === 'writer'", 300_000, 500);
  // live: the first partial already holds the three drafts' blocks and the diagnostic
  await ev(`(() => { demo.state.chat.apply({ type: "message_start", message: ${JSON.stringify(msg(thinking, { of: 3, blocks: [0, 1, 2] }))} }); return true; })()`);
  await ev(`(() => { demo.state.chat.apply({ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta: "Draft one is sure now. " }] }); return true; })()`);
  const live = await drawn();
  ok("live: three labeled boxes, each one draft's own thinking, side by side, under the page's status line", live.boxes.length === 3 && live.boxes.every((b, k) => b.label === `Draft ${k + 1} of 3 · thinking` && b.text.startsWith(T[k]!)) && live.boxes[0]!.text.endsWith("Draft one is sure now. ") && /^Writing 3 replies at once; Jev picks the one that doesn't repeat itself\. \d+ s$/.test(live.status) && live.columns === 3 && !live.picked, live);
  ok("nothing is added to any draft's thinking", live.boxes.every((b, k) => b.text === T[k] + (k === 0 ? "Draft one is sure now. " : "")), live.boxes.map((b) => b.text));
  await page.screenshot(join(shots, "drafts-1-live.png"));
  // a reload mid-turn: the page's next snapshot carries the same partial
  const before = live.boxes;
  await ev(`(() => { demo.state.chat.apply({ type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage: {}, generation: { message: ${JSON.stringify(msg([{ type: "thinking", thinking: T[0] + "Draft one is sure now. " }, thinking[1], thinking[2]], { of: 3, blocks: [0, 1, 2] }))} } }); return true; })()`);
  const reloaded = await drawn();
  ok("a reload mid-turn draws the same boxes", JSON.stringify(reloaded.boxes) === JSON.stringify(before) && /^Writing 3 replies/.test(reloaded.status), { before, after: reloaded.boxes });
  // the pick: the provider's next partial carries it, with the answer
  await ev(`(() => { demo.state.chat.apply({ type: "message_update", changes: [{ type: "message", message: ${JSON.stringify(msg([...thinking, { type: "text", text: ANSWER }], { ...PICK, blocks: [0, 1, 2] }))} }] }); return true; })()`);
  const picked = await drawn();
  ok("the pick: the others fold to one line, the picked draft stays labeled, the answer follows, the status line says why", picked.picked && picked.columns === 1 && picked.boxes.length === 3
    && picked.boxes[0]!.cls === "draft out" && picked.boxes[0]!.label === "Draft 1 of 3 · not picked" && picked.boxes[2]!.label === "Draft 3 of 3 · not picked"
    && picked.boxes[1]!.cls === "draft picked" && picked.boxes[1]!.label === "Draft 2 of 3 · picked · thinking" && picked.boxes[1]!.text === T[1]
    && picked.answer.includes("Wait, Paris.") && picked.status === "Jev picked draft 2 of 3: the best mix of not repeating itself, still answering and being funny (Jev: repeats 10%, tries 90%, funny 2.4 of 3).", picked);
  await page.screenshot(join(shots, "drafts-2-picked.png"));
  // saved: the message holds only the picked draft's thinking; the page draws the same boxes
  await ev(`(() => { demo.state.chat.apply({ type: "message_end", entry: { id: "dr-1", kind: "pi.assistant", model: [${JSON.stringify(msg([thinking[1], { type: "text", text: ANSWER }], { ...PICK, blocks: [null, 0, null] }))}] } }); return true; })()`);
  const saved = await drawn();
  ok("saved: the same boxes as at the pick", JSON.stringify(saved.boxes) === JSON.stringify(picked.boxes) && saved.status === picked.status && saved.answer === picked.answer, { picked: picked.boxes, saved: saved.boxes });
  // the picked draft folds on a tap and stays folded across redraws
  const fold = await ev<{ closed: boolean; reopened: boolean }>(`(async () => {
    const box = () => [...document.querySelectorAll("#chat .draft.picked")].at(-1);
    box().open = false; await new Promise((r) => setTimeout(r, 0)); demo.renderChat();
    const closed = box().open === false;
    box().open = true; await new Promise((r) => setTimeout(r, 0)); demo.renderChat();
    return { closed, reopened: box().open === true };
  })()`);
  ok("the picked draft's thinking folds on a tap and stays folded across redraws", fold.closed && fold.reopened, fold);
  // an answer without the diagnostic draws as before: one thinking, no boxes
  const plain = await ev<{ boxes: number; thinking: number }>(`(() => { demo.state.chat.apply({ type: "entry_appended", entry: { id: "plain-1", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "An ordinary thought." }, { type: "text", text: "An ordinary answer." }] }] } }); demo.renderChat(); const t = [...document.querySelectorAll("#chat .turn.agent")].at(-1); return { boxes: t.querySelectorAll(".draft").length, thinking: t.querySelectorAll("details.thinking").length }; })()`);
  ok("an answer without the diagnostic draws as before: one thinking, no draft boxes", plain.boxes === 0 && plain.thinking === 1, plain);
  await page.screenshot(join(shots, "drafts-3-saved.png"));
} finally {
  await device.close().catch(() => undefined);
  cdp.close();
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all drafts checks passed");
process.exit(0);
