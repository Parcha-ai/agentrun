// The emoji font in real Chrome, on the pages the viewer sees (episode 2's stage, the obsession stage, and the tab app inside them): every emoji the models emit
// is painted in colour, whatever system font sits earlier in the page's own font stack.
//   [CDP_URL=http://127.0.0.1:9444] node scripts/emoji-render-check.mjs
// A system font that has its own plain glyph for an emoji wins over a web font that is later in the stack: on the recording machine "system-ui" is DejaVu Sans,
// which has an outline circle for U+1F315, so the full moon showed as a hollow circle while its neighbours (which DejaVu lacks) were in colour. The check draws each emoji on
// a canvas with the page's OWN computed font stack, so it fails exactly when a page's stack lets a text font take an emoji, and it checks that ordinary text (digits,
// "#", "*", "(c)", arrows) is still set by the text font.
import "./own-chrome.mjs"; // starts (and always closes) a Chrome of its own when CDP_URL is not set
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, openTab, sleep, waitForStage } from "./cdp.mjs";

const show = join(dirname(fileURLToPath(import.meta.url)), "..");
const tabDist = process.env.TAB_DIR ?? join(show, "..", "tab", "dist");
const port = await freePort();
let failed = 0;
const expect = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};
const stage = spawn(process.execPath, [join(show, "serve.ts")], { cwd: show, env: { ...process.env, SHOW_PORT: String(port), SHOW_SCENARIO: "ep2", TAB_DIR: tabDist }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;

// The moon phases (U+1F311 to U+1F318), the moon faces, and the others the models emit (freeze transcripts): pizza, sparkles, faces, earth, wave, rocket, heart, star.
const EMOJI = [0x1f311, 0x1f312, 0x1f313, 0x1f314, 0x1f315, 0x1f316, 0x1f317, 0x1f318, 0x1f319, 0x1f31a, 0x1f31b, 0x1f31c, 0x1f31d, 0x1f31e, 0x1f355, 0x2728, 0x1f60a, 0x1f605, 0x1f602, 0x1f30d, 0x1f30a, 0x1f680, 0x2764, 0x2b50];
// Text that must stay in the page's text font: digits, "#", "*", "(c)", "(R)", "(TM)", and the arrows a caption uses.
const TEXT = ["0123456789", "#*", "©®™", "→←↔"];

/** Runs in the page: draws on a canvas with the page's own font stack, with and without the emoji family, and reports coloured pixels and ink. */
const probe = `(async () => {
  const stacks = { sans: getComputedStyle(document.body).fontFamily, mono: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || getComputedStyle(document.body).fontFamily };
  const c = document.createElement("canvas"); c.width = 400; c.height = 80;
  const g = c.getContext("2d", { willReadFrequently: true });
  const paint = async (stack, text) => {
    await document.fonts.load('40px ' + stack, text);
    g.clearRect(0, 0, c.width, c.height); g.fillStyle = "#000"; g.font = '40px ' + stack; g.textBaseline = "top"; g.fillText(text, 4, 4);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let colored = 0, ink = 0, h = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 40) ink++; if (d[i + 3] > 40 && (Math.abs(d[i] - d[i + 1]) > 24 || Math.abs(d[i + 1] - d[i + 2]) > 24)) colored++; h = (h * 31 + d[i + 3]) >>> 0; }
    return { colored, ink, h };
  };
  const noEmoji = (stack) => stack.split(",").map((s) => s.trim()).filter((s) => !/Noto Color Emoji/.test(s)).join(", ");
  const out = { stacks, emoji: {}, text: {} };
  for (const cp of ${JSON.stringify(EMOJI)}) out.emoji[cp.toString(16)] = (await paint(stacks.sans, String.fromCodePoint(cp))).colored;
  for (const t of ${JSON.stringify(TEXT)}) { const a = await paint(stacks.sans, t), b = await paint(noEmoji(stacks.sans), t); out.text[t] = { same: a.h === b.h, ink: a.ink, coloured: a.colored }; }
  return out;
})()`;

try {
  await waitForStage(port, stage);
  for (const [name, path] of [["episode 2 stage", "/ep2/"], ["obsession stage", "/obsession/"], ["tab app", "/tab/?clean=1&banner=1&episode=2"]]) {
    const tab = await openTab(new URL(path, base).href, { width: 1600, height: 900 });
    try {
      await sleep(1500);
      const r = JSON.parse(await tab.eval(`${probe}.then(JSON.stringify)`));
      const flat = Object.entries(r.emoji).filter(([, n]) => n < 150).map(([cp, n]) => `U+${cp.toUpperCase()}: ${n}px`);
      expect(`${name}: every emoji is drawn in colour with the page's own font stack (full moon and all moon phases included)`, flat.length === 0, { uncoloured: flat, stack: r.stacks.sans });
      const moved = Object.entries(r.text).filter(([, v]) => !v.same || v.coloured > 0).map(([t]) => t);
      expect(`${name}: digits, "#", "*", (c)(R)(TM) and arrows are still set by the text font, not the emoji font`, moved.length === 0, { moved, text: r.text });
    } finally {
      await tab.close();
    }
  }
} finally {
  stage.kill();
}
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all checks passed");
