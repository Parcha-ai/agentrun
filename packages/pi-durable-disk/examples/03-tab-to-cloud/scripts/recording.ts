// What the recording scripts share: a screencast of a page into timed JPEG frames, the ops strip (who holds the run's
// disk, followed from the server's log), and the assembly of the frames into one video with ffmpeg.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "./cdp.ts";

export type Size = { width: number; height: number };

export class Recording {
  readonly t0 = Date.now();
  readonly steps: Record<string, unknown>[] = [];
  readonly out: string;
  constructor(out: string) {
    this.out = out;
    mkdirSync(out, { recursive: true });
  }

  sec(): number {
    return Number(((Date.now() - this.t0) / 1000).toFixed(2));
  }

  step(name: string, data: Record<string, unknown> = {}): void {
    const row = { at: this.sec(), name, ...data };
    this.steps.push(row);
    console.log(JSON.stringify(row));
  }

  /** Every frame Chrome paints for `page`, as JPEG files named by their time in ms since the recording started. */
  async screencast(page: Page, name: string): Promise<() => Promise<void>> {
    const dir = join(this.out, "frames", name);
    mkdirSync(dir, { recursive: true });
    let count = 0;
    page.cdp.on("Page.screencastFrame", (params, session) => {
      if (session !== page.sessionId) return;
      const meta = params.metadata as { timestamp?: number };
      const at = meta.timestamp ? Math.round(meta.timestamp * 1000 - this.t0) : Date.now() - this.t0;
      writeFileSync(join(dir, `${String(Math.max(0, at)).padStart(8, "0")}.jpg`), Buffer.from(String(params.data), "base64"));
      count++;
      void page.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
    });
    await page.send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 });
    // A navigation can move the page to another renderer, which ends its screencast: start it again after each one.
    const navigate = page.navigate.bind(page);
    page.navigate = async (url: string) => {
      await navigate(url);
      await page.send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 }).catch(() => undefined);
    };
    return async () => {
      await page.send("Page.stopScreencast").catch(() => undefined);
      this.steps.push({ at: this.sec(), name: `frames ${name}`, count });
    };
  }

  /** Each stream to a video (each frame shown until the next), then the streams stacked: `layout` is ffmpeg's filter. */
  assemble(ffmpeg: string, streams: [string, Size][], layout: string, file: string): string {
    const endMs = Date.now() - this.t0;
    for (const [name, size] of streams) {
      const dir = join(this.out, "frames", name);
      const frames = spawnSync("ls", [dir], { encoding: "utf8" }).stdout.split("\n").filter((f) => f.endsWith(".jpg")).sort();
      if (frames.length === 0) throw new Error(`no frames for ${name}`);
      const times = frames.map((f) => Number(f.slice(0, -4)));
      const lines: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const from = i === 0 ? 0 : times[i]!;
        const to = i + 1 < frames.length ? times[i + 1]! : endMs;
        lines.push(`file '${join(dir, frames[i]!)}'`, `duration ${Math.max(0.001, (to - from) / 1000).toFixed(3)}`);
      }
      lines.push(`file '${join(dir, frames.at(-1)!)}'`);
      writeFileSync(join(this.out, `${name}.txt`), `${lines.join("\n")}\n`);
      const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(this.out, `${name}.txt`), "-vf", `fps=15,scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", join(this.out, `${name}.mp4`)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`ffmpeg ${name}: ${r.stderr}`);
    }
    const inputs = streams.flatMap(([name]) => ["-i", join(this.out, `${name}.mp4`)]);
    const video = join(this.out, file);
    const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", layout, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-movflags", "+faststart", video], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg compose: ${r.stderr}`);
    console.log(JSON.stringify({ video, seconds: endMs / 1000 }));
    return video;
  }

  save(): void {
    writeFileSync(join(this.out, "story.json"), `${JSON.stringify({ startedAt: new Date(this.t0).toISOString(), endMs: Date.now() - this.t0, steps: this.steps }, null, 1)}\n`);
  }
}

/** A slate page: a title and a line, centered. */
export const slate = (title: string, sub: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#1d1d1b;color:#ecebe6;font:16px -apple-system,system-ui,sans-serif"><div style="text-align:center"><div style="font-size:30px;font-weight:650">${title}</div><div style="margin-top:10px;color:#9a9890">${sub}</div></div></body></html>`)}`;

/** A label in the corner of a page (which device it is). */
export const label = (page: Page, text: string) =>
  page.evaluate(`(() => { let el = document.getElementById("device-label"); if (!el) { el = document.createElement("div"); el.id = "device-label"; el.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9;background:#1d1d1b;color:#ecebe6;font:600 13px system-ui,sans-serif;padding:6px 10px;border-radius:8px;opacity:.88"; document.body.append(el); } el.textContent = ${JSON.stringify(text)}; return true; })()`).catch(() => false);

/** Type a message into the page's composer and send it. */
export const send = (page: Page, text: string) => page.evaluate(`(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; document.getElementById("send").click(); return true; })()`);

/** Follow the server's log and show on the ops strip who holds the disk. */
export function followHolders(ops: Page, serverLog: string, tabs: Map<string, string>): () => void {
  let offset = existsSync(serverLog) ? statSync(serverLog).size : 0;
  let generation = 0;
  const timer = setInterval(() => {
    const text = readFileSync(serverLog, "utf8");
    const fresh = text.slice(offset);
    offset = text.length;
    for (const line of fresh.split("\n")) {
      if (!line.startsWith("{")) continue;
      const e = JSON.parse(line) as Record<string, unknown>;
      let call: string | undefined;
      if (e.event === "pipe.open") generation = Number(e.generation);
      if (e.event === "pipe.attach") call = `ops.holder("tab", ${JSON.stringify(`Tab on ${tabs.get(String(e.tab)) ?? "a device"}`)}, ${JSON.stringify(`generation ${generation} · the pipe holds the claim`)})`;
      else if (e.event === "placement" && e.where === "moving") call = `ops.holder("moving", ${JSON.stringify(`Moving to ${String(e.to)}`)}, ${JSON.stringify(String(e.detail ?? ""))})`;
      else if (e.event === "pipe.released") call = `ops.note(${JSON.stringify(`released and sealed in ${e.ms} ms`)})`;
      else if (e.event === "cloud.started") call = `ops.holder("cloud", ${JSON.stringify(String(e.host))}, ${JSON.stringify(`generation ${generation + 1} · claimed the disk, resuming`)})`;
      else if (e.event === "cloud.exited" && e.how === "fenced") call = `ops.holder("fenced", "Cloud host fenced", ${JSON.stringify(`its claim revoked · ${String(e.unit ?? e.status)}`)})`;
      else if (e.event === "cloud.stopped") call = `ops.note(${JSON.stringify(`drained, released and stopped in ${e.ms} ms`)})`;
      if (e.event === "cloud.started") generation++;
      if (call) void ops.evaluate(call).catch(() => undefined);
    }
  }, 300);
  return () => clearInterval(timer);
}
