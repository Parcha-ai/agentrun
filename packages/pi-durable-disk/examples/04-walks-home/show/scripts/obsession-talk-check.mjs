// The big centre view of the small model's answer must show the END of a long answer: the joke's punchline is the point (take 7 cut it off at the bottom while the side chat showed it
// all). Answers are played in the tab's own message order, as a real tab sends them, at the recording's size and at laptop sizes; the last characters of the answer must be inside the
// visible box. A long answer shrinks to fit; only an answer too long even for the smallest readable type is cut, and then a visible mark says so.
//   [CDP_URL=...] node scripts/obsession-talk-check.mjs
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { freePort, openTab, sleep, waitForStage } from "./cdp.mjs";

const shots = process.env.SHOTS; // optional: a directory for screenshots
if (shots) mkdirSync(shots, { recursive: true });

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = await freePort();
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "obsession", SHOW_OBSESSION_THINK: "1" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;
const seek = (seconds) => fetch(new URL("/api/dev/seek", base), { method: "POST", body: JSON.stringify({ seconds, paused: true }) });

const THOUGHT = "Okay, full moon phase here! Gotta be silvery and slightly mysterious... Then I need to lean into the lunar goddess connection with a little bit of the moon's glow... Hmm... Okay, full moon it is!";
const JOKE = "Why did the moon go up to the moonshine? ...Because she wanted some moonlight for her tea! \u{1F315}\u{1F319}✨";
const LONG = Array.from({ length: 14 }, (_, i) => `Sentence ${i + 1} about the moon, its tides, and its silvery glow over the quiet sea.`).join(" ") + " THE END OF THE LONG ANSWER.";
const HUGE = Array.from({ length: 90 }, (_, i) => `Line ${i + 1} of a very long answer about the moon and everything it does.`).join(" ") + " THE VERY END.";
const CASES = [["the joke (take 7's frame)", JOKE, "moonlight for her tea!"], ["a long answer", LONG, "THE END OF THE LONG ANSWER."], ["a huge answer, too long for any readable size", HUGE, null]];

try {
  await waitForStage(port, stage);
  for (const [width, height] of [[1600, 900], [1440, 900], [1280, 800]]) {
    await seek(0);
    const tab = await openTab(new URL("/obsession/", base).href, { width, height });
    try {
      await sleep(2500);
      const read = (expr) => tab.eval(`JSON.stringify(${expr})`).then(JSON.parse);
      const fromTab = (message) => tab.eval(`document.getElementById("tab").contentWindow.eval(${JSON.stringify(`parent.postMessage(${JSON.stringify({ ns: "walks-home", ...message })}, "*")`)}); 0`);
      await seek(345); // home, with the chat switched to the small model
      let ready = false;
      for (let w = 0; w < 30_000 && !ready; w += 400) {
        ready = await read(`!document.getElementById("modelbanner").hidden && /talking to the model it trained/.test(document.getElementById("modelbanner").textContent)`);
        if (!ready) await sleep(400);
      }
      expect(`${width}x${height}: at home, talking to the small model`, ready);
      await fromTab({ type: "model-answer", n: 1, judged: "passed" }); // the page now sends questions to the tab, not to its rehearsal
      await tab.eval(`(() => { const w = document.getElementById("tab").contentWindow; window.__sent = []; w.postMessage = function (m) { if (m && m.type === "chat-send") window.__sent.push(m); }; })()`);
      for (const [name, answer, tail] of CASES) {
        const before = (await read(`window.__sent.length`));
        await tab.eval(`(() => { const i = document.getElementById("chatin"); i.value = ${JSON.stringify(name.slice(0, 20))}; document.getElementById("chatform").requestSubmit(); })()`);
        let sent = null;
        for (let w = 0; w < 6000 && !sent; w += 200) {
          await sleep(200);
          const all = await read(`window.__sent`);
          if (all.length > before) sent = all[all.length - 1];
        }
        if (!sent) { expect(`${width}x${height} ${name}: the question reached the tab`, false, null); continue; }
        await fromTab({ type: "chat-start", id: sent.id });
        await fromTab({ type: "chat-thinking", id: sent.id, text: THOUGHT });
        await fromTab({ type: "chat-delta", id: sent.id, text: answer });
        await fromTab({ type: "chat-done", id: sent.id, text: answer, thinking: THOUGHT, refused: false });
        await sleep(900);
        const r = await read(`(() => { const t = document.getElementById("talk"); const a = t.querySelector(".a"); if (!a) return null; const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1; const tr = t.getBoundingClientRect(); const padB = parseFloat(getComputedStyle(t).paddingBottom) * z; const padT = parseFloat(getComputedStyle(t).paddingTop) * z; const ar = a.getBoundingClientRect(); const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT); let last = null; while (walker.nextNode()) last = walker.currentNode; const range = document.createRange(); range.setStart(last, Math.max(0, last.length - 1)); range.setEnd(last, last.length); const lr = range.getBoundingClientRect(); const clipped = a.scrollHeight > a.clientHeight + 1; const mark = t.querySelector(".cliptag")?.textContent ?? null; const kids = [...t.children].filter((c) => !c.hidden); return { text: a.textContent.slice(-30), lastBottom: Math.round(lr.bottom), limit: Math.round(tr.bottom - padB), firstTop: Math.round(kids[0].getBoundingClientRect().top), topLimit: Math.round(tr.top + padT * 0.2), clipped, mark, fontPx: Math.round(parseFloat(getComputedStyle(a).fontSize) * z), zoom: z }; })()`);
        if (r === null) { expect(`${width}x${height} ${name}: the answer is on the pane`, false, r); continue; }
        if (shots) await tab.screenshot(join(shots, `talk-${width}x${height}-${name.split(" ")[1] || "x"}.png`));
        if (tail !== null) {
          expect(`${width}x${height} ${name}: the last characters are inside the visible box (the punchline is not under the clip)`, r.text.includes(tail.slice(-20)) && r.lastBottom <= r.limit && !r.clipped && r.firstTop >= 0, r);
          // In the page's own units (the zoom scales the whole stage): a normal answer stays within 15% of its designed 42 px (the thinking shares the room), a long one never goes below the readable floor (0.4 of 42 px).
          const layoutPx = r.fontPx / r.zoom;
          expect(`${width}x${height} ${name}: ${tail.startsWith("moonlight") ? "a normal answer stays large (within 15% of its designed size)" : "type stays at or above the readable floor"}`, tail.startsWith("moonlight") ? layoutPx >= 36 : layoutPx >= 16.5, r);
        } else {
          expect(`${width}x${height} ${name}: if it must be cut, a visible mark says the rest is in the chat, and what is shown ends inside the box`, r.mark !== null && /chat/.test(r.mark) && r.lastBottom <= r.limit, r);
        }
      }
    } finally {
      await tab.close();
    }
  }
} finally {
  stage.kill();
}
console.log(failed ? `${failed} talk check(s) FAILED` : "obsession talk: all checks passed");
process.exit(failed ? 1 : 0);
