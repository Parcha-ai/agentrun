// Record a CDP tab as a WebM: Page.screencastFrame frames go to ffmpeg at a fixed frame rate (the latest frame is repeated
// while the page is idle, so the video runs in real time). ffmpeg is Playwright's bundled build (VP8/WebM); set FFMPEG to
// use another. Shared by record.mjs (the scripted run) and switch-beat.mjs (the switch beat).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { sleep } from "./cdp.mjs";

export async function startScreencast(tab, { out, fps = 15 }) {
  const ffmpegBin = process.env.FFMPEG ?? `${homedir()}/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux`;
  if (!existsSync(ffmpegBin)) throw new Error(`no ffmpeg at ${ffmpegBin}; set FFMPEG`);
  mkdirSync(dirname(out), { recursive: true });
  const ff = spawn(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0", "-c:v", "libvpx", "-b:v", "3M", "-crf", "10", "-pix_fmt", "yuv420p", "-an", out], { stdio: ["pipe", "inherit", "inherit"] });
  const closed = new Promise((resolve) => ff.on("close", resolve));
  let latest = null;
  let frames = 0;
  tab.listen((m) => {
    if (m.method !== "Page.screencastFrame") return;
    latest = Buffer.from(m.params.data, "base64");
    void tab.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
  });
  // A freshly opened tab is not always attached yet: retry the start for a few seconds before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      await tab.send("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1 });
      break;
    } catch (error) {
      if (attempt >= 10) throw error;
      await sleep(500);
    }
  }
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (!latest || ff.stdin.destroyed) return;
    ff.stdin.write(latest);
    frames++;
  }, 1000 / fps);
  return {
    get frames() {
      return frames;
    },
    seconds: () => (Date.now() - t0) / 1000,
    async stop() {
      clearInterval(timer);
      await tab.send("Page.stopScreencast").catch(() => {});
      ff.stdin.end();
      await closed;
      return { frames, seconds: frames / fps, out };
    },
  };
}
