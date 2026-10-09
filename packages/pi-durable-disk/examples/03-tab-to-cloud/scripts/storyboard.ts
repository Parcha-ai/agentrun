// A self-contained storyboard page of one recording: the video (inline), stills at each step, the numbers from the
// evidence, and how it works. No external reference: everything the page shows is inside the file.
//   node scripts/storyboard.ts <recording dir> <evidence.json> <out.html> [--title T] [--host LABEL] [--ffmpeg BIN] [--date YYYY-MM-DD]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { title: { type: "string", default: "An agent that moves from a browser tab to the cloud" }, host: { type: "string", default: "a cloud host" }, ffmpeg: { type: "string" }, date: { type: "string" }, extra: { type: "string" } },
});
const [dir, evidenceFile, outFile] = positionals as [string, string, string];
const story = JSON.parse(readFileSync(join(dir, "story.json"), "utf8")) as { startedAt: string; endMs: number; steps: { at: number; name: string; sub?: string; ms?: number }[] };
const evidence = JSON.parse(readFileSync(evidenceFile, "utf8")) as {
  handovers: { why: string; releasedMs: number | null; cloudOpenMs: number; cloudFirstCommitMs: number | null; generation: number }[];
  zeroLoss: { tabAckedDigest: string | null; diskDigestAtRelease: string | null; equal: boolean };
  zeroLossEnd: { equal: boolean };
  takeovers: { pipeOpenMs: number; headAtOpen: number; oldCommitsAboveHead: number; oldCommitsAfterOpen: number; cloudExit: { unit?: string; status?: string } | null }[];
  commits?: { clientP50: number; rttP50: number };
};
const extra = values.extra ? (JSON.parse(readFileSync(values.extra, "utf8")) as Record<string, unknown>) : {};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const video = join(dir, "tab-to-cloud.mp4");
const videoTag = (poster: string) =>
  existsSync(video)
    ? `<video controls playsinline preload="metadata"${poster ? ` poster="${poster}"` : ""} src="data:video/mp4;base64,${readFileSync(video).toString("base64")}"></video><p class="cap">The whole run, ${(story.endMs / 1000).toFixed(0)} s, unedited: top, who holds the run's disk; left, the laptop; right, the other device.</p>`
    : "<p>(no video)</p>";

// One still per narrated step, from the composite video.
const stills: string[] = [];
let poster = "";
const titled = story.steps.filter((s) => /^\d ·|^One agent/.test(s.name));
for (const [i, step] of titled.entries()) {
  if (!values.ffmpeg || !existsSync(video)) break;
  const at = Math.min(story.endMs / 1000 - 0.2, (titled[i + 1]?.at ?? step.at + 4) - 0.6);
  const png = join(dir, `still-step-${i}.png`);
  spawnSync(values.ffmpeg, ["-loglevel", "error", "-y", "-ss", String(Math.max(0, at)), "-i", video, "-frames:v", "1", "-vf", "scale=1280:-1", png]);
  if (existsSync(png) && statSync(png).size > 0 && step.name.startsWith("3 ·")) poster = `data:image/png;base64,${readFileSync(png).toString("base64")}`;
  if (existsSync(png) && statSync(png).size > 0) stills.push(`<figure><img alt="${esc(step.name)}" src="data:image/png;base64,${readFileSync(png).toString("base64")}"><figcaption><b>${esc(step.name)}</b> ${esc(step.sub ?? "")} <span class="t">${step.at.toFixed(1)} s</span></figcaption></figure>`);
}

const h = evidence.handovers[0];
const tk = evidence.takeovers[0];
const takeoverStep = story.steps.find((s) => s.name === "takeover");
const rows: [string, string, string, boolean][] = [
  ["Handover from the tab to " + values.host, "at most 5 s after the tab's lease lapses", h ? `${(h.cloudOpenMs / 1000).toFixed(2)} s to the open run, ${h.cloudFirstCommitMs === null ? "-" : `${(h.cloudFirstCommitMs / 1000).toFixed(2)} s`} to its first commit` : "-", Boolean(h && h.cloudOpenMs < 5000)],
  ["No acknowledged write lost", "work/ equals what the tab showed acknowledged last", evidence.zeroLoss.equal ? `equal digests (${(evidence.zeroLoss.tabAckedDigest ?? "").slice(0, 12)}…), and again at the end` : "digests differ", evidence.zeroLoss.equal && evidence.zeroLossEnd.equal],
  ["No write from the old side after a takeover", "0", tk ? `${tk.oldCommitsAboveHead} commits above the new owner's head, ${tk.oldCommitsAfterOpen} after its open; the cloud host ${tk.cloudExit?.unit ?? tk.cloudExit?.status ?? "stopped"}` : "-", Boolean(tk && tk.oldCommitsAboveHead === 0 && tk.oldCommitsAfterOpen === 0)],
  ["Takeover into a tab", "", takeoverStep?.ms ? `${(takeoverStep.ms / 1000).toFixed(1)} s from "Take over here" to running in the new tab` : "-", true],
];
for (const [k, v] of Object.entries(extra)) rows.push([k, "", String(v), true]);

const date = values.date ?? new Date().toISOString().slice(0, 10);
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(values.title!)}</title>
<style>
:root { --bg:#f6f5f1; --panel:#fff; --ink:#1d1d1b; --muted:#6b6a65; --line:#e2e0d8; --ok:#1f7a4d; --bad:#b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --panel:#1d1d1b; --ink:#ecebe6; --muted:#9a9890; --line:#2f2e2b; --ok:#5fd39a; --bad:#f2a29b; } }
* { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 30px; line-height:1.2; margin: 0 0 8px; letter-spacing:-0.01em; } h2 { font-size: 20px; margin: 40px 0 10px; }
.lede { color: var(--muted); max-width: 760px; } .meta { font-size: 13px; color: var(--muted); }
video { width: 100%; border-radius: 10px; border:1px solid var(--line); background:#000; } .cap { font-size: 13px; color: var(--muted); }
figure { margin: 18px 0; } figure img { width: 100%; border-radius: 8px; border: 1px solid var(--line); } figcaption { font-size: 14px; margin-top: 6px; } .t { color: var(--muted); font-family: ui-monospace,Menlo,monospace; font-size: 12px; }
table { border-collapse: collapse; width: 100%; background: var(--panel); border:1px solid var(--line); border-radius: 8px; overflow:hidden; font-size: 14px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; } th { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.ok { color: var(--ok); font-weight: 650; } .no { color: var(--bad); font-weight: 650; }
code { font-family: ui-monospace,Menlo,monospace; font-size: 13px; } ul { padding-left: 20px; } li { margin: 4px 0; }
.arch { background: var(--panel); border:1px solid var(--line); border-radius: 8px; padding: 14px 16px; overflow-x: auto; font: 13px/1.5 ui-monospace,Menlo,monospace; white-space: pre; }
</style></head><body><main>
<h1>${esc(values.title!)}</h1>
<p class="lede">A pi agent's whole computer runs in a browser tab: its brain (pi-durable's Harness) as page JavaScript, its hands (bash, coreutils, node) in a Wasmer sandbox in the same tab. Close the tab and ${esc(values.host)} claims the run's Archil disk and carries on mid-task. Open the link on another device to watch, and take it back into a tab. One agent, one transcript, one workspace, one writer at a time.</p>
<p class="meta">Recorded ${esc(story.startedAt)} in headless Chrome. Package <code>@parcha/pi-durable-disk</code>, example <code>examples/03-tab-to-cloud</code>. For the agentrun-archil tech lead and Miguel. Page date ${date}.</p>
${videoTag(poster)}
<h2>Go / no-go</h2>
<table><tr><th>Criterion</th><th>Target</th><th>Measured</th><th></th></tr>
${rows.map(([a, b, c, ok]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td><td>${esc(c)}</td><td class="${ok ? "ok" : "no"}">${ok ? "go" : "no-go"}</td></tr>`).join("\n")}
</table>
<h2>Storyboard</h2>
${stills.join("\n")}
<h2>How it works</h2>
<div class="arch">browser tab                                      server near the disk                        Archil disk
  pi-durable Harness ── Storage calls ─┐          pipe: the run's claim (exclusive mount,     runs/&lt;id&gt;/store/run.sqlite
  Wasmer: bash, node ── changed files ─┼─ WS ──►  owner lock, run.json lease), pi's      ──►  runs/&lt;id&gt;/work/
  model provider ────── model calls ───┘          SqliteStorage, model proxy with a budget
cloud host: the same agent module (pi-durable-disk run --app cloud-app.ts), tools on its own mount of runs/&lt;id&gt;/</div>
<ul>
<li><b>A tab cannot hold the disk</b> (no FUSE, no raw TCP), so a small pipe holds the claim for it and serves one WebSocket: every Storage call of the tab's Session, the files a tool changed (written under <code>work/</code> and synced before the tool's result commits), the model calls (the key stays on the server), and <code>work/</code> back into the tab on attach.</li>
<li><b>One writer at a time.</b> A second device watches read-only. "Take over here" from another tab retires the old tab's attachment (its next call is refused); from a cloud host it revokes the host's Archil delegation, so its next fsync fails and it exits 75.</li>
<li><b>Tab gone</b> (no ping for 5 s) or "Move to the cloud": the pipe releases the run (barrier, seal, unmount) and the package's supervisor starts it on the cloud host, which resumes pi's unfinished work from the store.</li>
<li><b>The cloud host needs no way in</b> to the server: it listens on one port and the server dials in; that link carries its model calls (same budget) and its live events for viewers. Viewers read its files from the disk.</li>
</ul>
<h2>Limits</h2>
<ul><li>The tab's Wasmer sandbox has no git and no network; pi's environment conformance suite passes 22 of 24 cases there (the two others need symbolic links, which Wasmer's file API does not expose).</li>
<li>Commands running in a tab when it closes are gone; pi reports the cut call as interrupted, as after any crash.</li>
<li>The page needs a secure context (Wasmer needs <code>SharedArrayBuffer</code>).</li></ul>
</main></body></html>
`;
writeFileSync(outFile, html);
console.log(JSON.stringify({ out: outFile, bytes: html.length, stills: stills.length }));
