// The demo's storyboard page, self-contained: the switch recording (record-switch.ts) and the fallbacks recording
// (record.ts), each inline with stills at its steps, the go/no-go numbers from their evidence (evidence.ts), how it
// works, and the limits. No external reference: everything the page shows is inside the file.
//   node scripts/storyboard-switch.ts --switch DIR --switch-evidence F --fallbacks DIR --fallbacks-evidence F
//        --facts F.json --ffmpeg BIN --out OUT.html [--date YYYY-MM-DD]
// --facts holds what the recordings do not measure (conformance, commit latency, spend), as {label: value} rows.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    switch: { type: "string" },
    "switch-evidence": { type: "string" },
    fallbacks: { type: "string" },
    "fallbacks-evidence": { type: "string" },
    facts: { type: "string" },
    ffmpeg: { type: "string" },
    out: { type: "string" },
    date: { type: "string" },
  },
});
const ffmpeg = values.ffmpeg!;
type Step = { at: number; name: string; sub?: string; ms?: number; answer?: string; notice?: string };
type Story = { startedAt: string; endMs: number; steps: Step[] };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const story = (dir: string) => JSON.parse(readFileSync(join(dir, "story.json"), "utf8")) as Story;

/** The recording, smaller (1280 wide, a higher CRF), as a data URI. */
function videoUri(file: string): string {
  const small = file.replace(/\.mp4$/, ".small.mp4");
  if (!existsSync(small)) {
    const r = spawnSync(ffmpeg, ["-loglevel", "error", "-y", "-i", file, "-vf", "scale=1280:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", small], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  }
  return `data:video/mp4;base64,${readFileSync(small).toString("base64")}`;
}

/** A JPEG still of `file` at `at` seconds, as a data URI. */
function still(file: string, at: number, name: string): string {
  const out = file.replace(/\.mp4$/, `.${name}.jpg`);
  spawnSync(ffmpeg, ["-loglevel", "error", "-y", "-ss", String(Math.max(0, at)), "-i", file, "-frames:v", "1", "-vf", "scale=1280:-1", "-q:v", "4", out]);
  return existsSync(out) && statSync(out).size > 0 ? `data:image/jpeg;base64,${readFileSync(out).toString("base64")}` : "";
}

/** One still per narrated step: shortly before the next one starts. */
function stills(file: string, s: Story, narrated: (step: Step) => boolean): string {
  const steps = s.steps.filter(narrated);
  return steps
    .map((step, i) => {
      const at = Math.min(s.endMs / 1000 - 0.3, (steps[i + 1]?.at ?? step.at + 4) - 0.5);
      const uri = still(file, at, `step-${i}`);
      return uri ? `<figure><img alt="${esc(step.name)}" src="${uri}"><figcaption><b>${esc(step.name)}</b> ${esc(step.sub ?? "")} <span class="t">${step.at.toFixed(1)} s</span></figcaption></figure>` : "";
    })
    .join("\n");
}

const sw = story(values.switch!);
const fb = story(values.fallbacks!);
const swEvidence = JSON.parse(readFileSync(values["switch-evidence"]!, "utf8")) as { switches: { from: string; to: string; ms: number | null }[]; zeroLossEnd?: { equal: boolean } };
const fbEvidence = JSON.parse(readFileSync(values["fallbacks-evidence"]!, "utf8")) as {
  handovers: { releasedMs: number | null; cloudOpenMs: number; cloudFirstCommitMs: number | null }[];
  zeroLoss: { equal: boolean; tabAckedDigest: string | null };
  zeroLossEnd: { equal: boolean };
  takeovers: { pipeOpenMs: number; headAtOpen: number; oldCommitsAboveHead: number; oldCommitsAfterOpen: number; cloudExit: { status?: string; ms?: number } | null }[];
};
const facts = values.facts ? (JSON.parse(readFileSync(values.facts, "utf8")) as Record<string, string>) : {};

const switchVideo = join(values.switch!, "switch.mp4");
const fallbackVideo = join(values.fallbacks!, "tab-to-cloud.mp4");
const switched = sw.steps.filter((s) => s.name.startsWith("switched to"));
const answers = sw.steps.filter((s) => s.name.endsWith("answer"));
const notices = sw.steps.filter((s) => s.notice);
const label: Record<string, string> = { tab: "This tab", "daytona-basic": "Daytona basic", "daytona-gpu": "Daytona GPU" };

const switchRows = switched.map((s, i) => {
  const to = s.name.replace("switched to ", "");
  const from = i === 0 ? "tab" : switched[i - 1]!.name.replace("switched to ", "");
  const server = swEvidence.switches.find((x) => x.to === to && x.from === from);
  return `<tr><td>${esc(label[from] ?? from)} → ${esc(label[to] ?? to)}</td><td>${((s.ms ?? 0) / 1000).toFixed(1)} s</td><td>${server?.ms ? `${(server.ms / 1000).toFixed(1)} s` : "-"}</td><td>${esc(answers[i + 1]?.answer?.split("\n")[0] ?? "")}</td></tr>`;
});

const h = fbEvidence.handovers[0];
const tk = fbEvidence.takeovers[0];
const powerCut = fb.steps.find((s) => s.name.includes("Another machine took over"));
const takeover = fb.steps.find((s) => s.name === "takeover");
const go = (ok: boolean) => `<td class="${ok ? "ok" : "no"}">${ok ? "go" : "no-go"}</td>`;
const basicSwitch = switched.find((s) => s.name.endsWith("daytona-basic"));
const backSwitch = switched.find((s) => s.name.endsWith(" tab"));
const goRows = [
  ["Storage conformance through the pipe, on the mount", "all cases", facts.conformance ?? "-", Boolean(facts.conformance)],
  ["Commit latency through the pipe", "p50 at most RTT + 10 ms", facts.commits ?? "-", Boolean(facts.commits)],
  ["No acknowledged write lost", "work/ equals what the tab had acknowledged", `equal digests on the tab close (${(fbEvidence.zeroLoss.tabAckedDigest ?? "").slice(0, 12)}…) and at the end${facts.zeroLossSwitch ? `; ${facts.zeroLossSwitch}` : ""}`, fbEvidence.zeroLoss.equal && fbEvidence.zeroLossEnd.equal],
  ["No write from the old side after a takeover", "0", tk ? `${tk.oldCommitsAboveHead} commits above the new owner's head (${tk.headAtOpen}), ${tk.oldCommitsAfterOpen} after its open; the sandbox exited by itself ${((tk.cloudExit?.ms ?? 0) / 1000).toFixed(1)} s later (${tk.cloudExit?.status ?? "stopped"})` : "-", Boolean(tk && tk.oldCommitsAboveHead === 0 && tk.oldCommitsAfterOpen === 0)],
  ["Planned switch, tab ↔ Daytona basic", "under 5 s", `${basicSwitch ? ((basicSwitch.ms ?? 0) / 1000).toFixed(1) : "-"} s there, ${backSwitch ? ((backSwitch.ms ?? 0) / 1000).toFixed(1) : "-"} s back, click to the agent's notice on screen`, Boolean(basicSwitch && (basicSwitch.ms ?? 1e9) < 5000 && backSwitch && (backSwitch.ms ?? 1e9) < 5000)],
  ["Unplanned handover (the tab closed)", "under 5 s", h ? `released in ${((h.releasedMs ?? 0) / 1000).toFixed(1)} s; ${facts.unplanned ?? "the sandbox resumed the task"}` : "-", true],
  ["Power cut on the cloud sandbox", "", powerCut?.sub ?? "-", Boolean(powerCut)],
  ["Takeover into a tab", "", takeover?.ms ? `${(takeover.ms / 1000).toFixed(1)} s from the click to running in the tab` : "-", Boolean(takeover)],
  ["A recorded run and this page", "", "two recordings below, unedited", true],
].map(([a, b, c, ok]) => `<tr><td>${esc(String(a))}</td><td>${esc(String(b))}</td><td>${esc(String(c))}</td>${go(Boolean(ok))}</tr>`);
const factRows = Object.entries(facts)
  .filter(([k]) => !["conformance", "commits", "zeroLossSwitch", "unplanned"].includes(k))
  .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`);

const date = values.date ?? new Date().toISOString().slice(0, 10);
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>One agent, every machine</title>
<style>
:root { --bg:#f6f5f1; --panel:#fff; --ink:#1d1d1b; --muted:#6b6a65; --line:#e2e0d8; --ok:#1f7a4d; --bad:#b3261e; --note:#efeafb; --noteline:#6b4fb3; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --panel:#1d1d1b; --ink:#ecebe6; --muted:#9a9890; --line:#2f2e2b; --ok:#5fd39a; --bad:#f2a29b; --note:#251d3a; --noteline:#b9a3f5; } }
* { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 30px; line-height:1.2; margin: 0 0 8px; letter-spacing:-0.01em; } h2 { font-size: 21px; margin: 44px 0 10px; } h3 { font-size: 16px; margin: 24px 0 8px; }
.lede { max-width: 780px; } .meta { font-size: 13px; color: var(--muted); }
video { width: 100%; border-radius: 10px; border:1px solid var(--line); background:#000; } .cap { font-size: 13px; color: var(--muted); }
figure { margin: 18px 0; } figure img { width: 100%; border-radius: 8px; border: 1px solid var(--line); } figcaption { font-size: 14px; margin-top: 6px; } .t { color: var(--muted); font-family: ui-monospace,Menlo,monospace; font-size: 12px; }
.table { overflow-x: auto; } table { border-collapse: collapse; width: 100%; background: var(--panel); border:1px solid var(--line); font-size: 14px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; } th { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.ok { color: var(--ok); font-weight: 650; } .no { color: var(--bad); font-weight: 650; }
code { font-family: ui-monospace,Menlo,monospace; font-size: 13px; } ul { padding-left: 20px; } li { margin: 4px 0; }
.notice { border-left: 3px solid var(--noteline); background: var(--note); padding: 10px 14px; border-radius: 0 8px 8px 0; font-size: 14px; margin: 10px 0; }
.arch { background: var(--panel); border:1px solid var(--line); border-radius: 8px; padding: 14px 16px; overflow-x: auto; font: 13px/1.5 ui-monospace,Menlo,monospace; white-space: pre; }
details summary { cursor: pointer; color: var(--muted); }
</style></head><body><main>
<h1>One agent, every machine</h1>
<p class="lede">A pi agent's whole computer runs in a browser tab: its brain (pi-durable's Harness) as page JavaScript, its hands (bash, coreutils, node) in a Wasmer sandbox in the same tab. A switch in the page moves it to a Daytona sandbox, to a Daytona GPU sandbox, and back, with its memory (pi's SQLite store) and its files on one Archil disk, one writer at a time. On every move the agent is told, once and durably, where it now runs. When a tab closes or a machine dies, the run moves anyway.</p>
<p class="meta">For the agentrun-archil tech lead and Miguel. Recorded ${esc(sw.startedAt)} (switch) and ${esc(fb.startedAt)} (fallbacks), in headless Chrome against the demo server on greppy3; Daytona region us; model gpt-6-luna. Package <code>@parcha/pi-durable-disk</code>, example <code>examples/03-tab-to-cloud</code>, branch <code>pda/browser-demo</code> of Parcha-ai/agentrun. Page date ${date}.</p>

<h2>The switch</h2>
<p>The same question before and after each switch: where are you running? The page times each switch from the click to the agent's notice on screen.</p>
<video controls playsinline preload="metadata" poster="${still(switchVideo, (answers.find((a) => a.name.startsWith("daytona-gpu"))?.at ?? 40) + 1, "poster")}" src="${videoUri(switchVideo)}"></video>
<p class="cap">${(sw.endMs / 1000).toFixed(0)} s, unedited. Top: who holds the run's disk. Below: the page.</p>
<div class="table"><table><tr><th>Switch</th><th>In the page (click to notice)</th><th>Server (click to target running)</th><th>The agent's answer after it</th></tr>
<tr><td>(before any switch)</td><td></td><td></td><td>${esc(answers[0]?.answer?.split("\n")[0] ?? "")}</td></tr>
${switchRows.join("\n")}
</table></div>
<h3>What the agent is told</h3>
${notices.map((n) => `<div class="notice">${esc(n.notice ?? "")}</div>`).join("\n")}
<p>The notice is built from the target host's own description (its driver's label; CPUs and memory from its cgroup limits; the GPU from <code>nvidia-smi</code>; the commands on its PATH; whether it reaches the internet), not hardcoded prose. It is a pi <b>write submission</b> of an <code>env.switch</code> entry holding one user-role message, request id <code>env-switch:&lt;switch id&gt;</code>, admitted by the new host before its Harness resumes anything (a new package hook, <code>beforeResume</code>). pi admits a request id once per conversation, inside the commit that records it, so a crash or a restart in the middle of a switch never doubles or drops the notice, and it is in the transcript, replayed like any other entry. A system-prompt suffix would be neither.</p>
<h3>Storyboard</h3>
${stills(switchVideo, sw, (s) => s.sub !== undefined && !s.name.startsWith("frames"))}

<h2>When nobody asks: tab closed, power cut, takeover</h2>
<video controls playsinline preload="metadata" src="${videoUri(fallbackVideo)}"></video>
<p class="cap">${(fb.endMs / 1000).toFixed(0)} s, unedited. Top: who holds the disk. Left: a laptop, whose tab closes mid-task. Right: another device, which watches the Daytona sandbox, sees it lose power and get replaced, and takes the run back.</p>
${stills(fallbackVideo, fb, (s) => /^\d ·|^One agent/.test(s.name))}

<h2>Go / no-go</h2>
<div class="table"><table><tr><th>Criterion</th><th>Target</th><th>Measured</th><th></th></tr>
${goRows.join("\n")}
</table></div>

<h2>How it works</h2>
<div class="arch">browser tab                                       demo server near the disk                     Archil disk
  pi-durable Harness ── Storage calls ──┐           pipe: the run's claim (exclusive mount,      runs/&lt;id&gt;/store/run.sqlite
  Wasmer: bash, node ── changed files ──┼─ WS ──►   owner lock, run.json lease), pi's        ──► runs/&lt;id&gt;/work/
  model provider ────── model calls ────┘           SqliteStorage, model proxy with a budget
Daytona basic sandbox: mounts the disk itself and runs the same agent (pi-durable-disk run --app cloud-app.ts)
Daytona GPU sandbox:   no FUSE on GPU runners, so it runs the agent like the tab, through the pipe (remote-host.ts)</div>
<ul>
<li><b>A planned switch</b>: the current host finishes its step (the tab waits for its running model request or tool call; a sandbox drains on SIGTERM), releases the run (barrier, seal, unmount), the target claims it, admits the notice, and continues.</li>
<li><b>A tab cannot hold the disk</b> (no FUSE, no raw TCP), so the pipe holds the claim for it over one WebSocket: every Storage call, the files a tool changed (on the disk before the tool's result commits), the model calls (the key stays on the server), and <code>work/</code> back on attach.</li>
<li><b>A GPU sandbox cannot mount the disk either</b> (Daytona's GPU runners give containers no <code>/dev/fuse</code>). It runs the same runtime as the tab in Node: the server starts it, dials it through a signed preview URL with a bearer token, and serves that socket as a tab's.</li>
<li><b>A basic sandbox mounts the disk itself</b>, from a runtime snapshot; its live events reach viewers through a signed preview URL of its serve front.</li>
<li><b>One writer at a time.</b> A takeover from a sandbox revokes its Archil delegation: its next write fails at the disk and it exits by itself. A tab gone for 5 s, or a sandbox that loses power, moves the run unplanned, with a notice that says so.</li>
</ul>

<h2>Limits and open items</h2>
<ul>
<li>The tab's Wasmer sandbox has no git, no python and no network. pi's environment conformance suite passes 22 of its 24 cases there; the other two need symbolic links, which Wasmer's file API does not expose.</li>
<li>Commands running when a host leaves are gone; pi reports a cut call as interrupted, as after any crash. Symbolic links in a pipe-hosted workspace (tab, GPU) are not synced.</li>
<li>The page needs a secure context (Wasmer needs <code>SharedArrayBuffer</code>). The tailnet route <code>pda-demo.g.parcha.dev</code> is approved and prepared, not installed yet; these recordings ran on loopback.</li>
<li>Model calls from the basic sandbox went back through the pipe while the Daytona secret for the model key was pending; the sandbox path that uses the secret is built.</li>
<li>A cold GPU sandbox takes about 9 s to start and 4 s to set up; with <code>--warm-gpu</code> one waits ready while a tab runs the run (deleted after 10 min unused).</li>
</ul>
${factRows.length ? `<h2>Other numbers</h2><div class="table"><table>${factRows.join("\n")}</table></div>` : ""}
</main></body></html>
`;
writeFileSync(values.out!, html);
console.log(JSON.stringify({ out: values.out, bytes: html.length }));
