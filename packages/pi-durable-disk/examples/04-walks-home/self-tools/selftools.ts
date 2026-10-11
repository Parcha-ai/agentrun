// The agent's one program for "train yourself a small model that can use your tools", run on the GPU box: practice
// runs with the teacher (pi's own loop and tools, each run kept only if its code check passes), the LoRA on the small
// model, and the tab's home disk (base + adapter, gguf-base-adapters-v1). The stage reads DIR/progress.jsonl.
//
//   node selftools.ts --out DIR --base BASE.gguf --base-model <repo>@<revision> [--per-template 24] [--templates a,b|all]
//       [--concurrency 64] [--salt run1] [--dry]
//
// Runs only in the self-tools sandbox (the teacher's commands execute here). Each stage is an existing piece run as a
// subprocess, so nothing here re-implements one: plan (tasks.ts), teach (drive.ts), keep (export.ts), train
// (train_tools.py), home disk (make-home-disk.mjs).
//
// progress.jsonl events, each with `t` (seconds since start):
//   start          the plan: templates, kept runs wanted per template, runs to try
//   teach.run      one tried run: template, the request, the check it was held to (named), passed, kept
//   teach.progress every 25 runs: tried, passed, kept, templates full, teacher cost
//   teach.done     the teacher stopped (every template full, or the plan ran out)
//   keep           the training set: rows, templates, why runs were left out
//   train.step     training progress (step, of, loss, eta_s); train.done the adapter and the merged model
//   home           the home disk's manifest and the adapter's size and sha256
//   done           wall time per stage; error: what failed (the run stops there)

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { TOOLS, renderTranscript } from "../../03-tab-to-cloud/tab/tool-format.ts";
import { canonical } from "./export.ts";
import { requireSandbox } from "./sandbox.ts";
import { checkName, makeInstances, TEMPLATES, type Instance } from "./tasks.ts";

requireSandbox("selftools.ts");

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    base: { type: "string" },
    // The model the base's weights were converted from (the stock GGUF itself is pinned by its sha256 on the disk); every
    // adapter on the disk must have been trained on it.
    "base-model": { type: "string", default: "google/gemma-3-1b-it@dcc83ea841ab6100d6b47a070329e1ba4cf78752" },
    "per-template": { type: "string", default: "24" },
    templates: { type: "string", default: "all" },
    concurrency: { type: "string", default: "64" },
    salt: { type: "string", default: `live-${Date.now().toString(36)}` },
    tools: { type: "string", default: "read,write,bash,go_online" },
    policy: { type: "string", default: "offline3o" },
    path: { type: "string", default: "/opt/offline-bin" },
    "max-chars": { type: "string", default: "12000" },
    "home-disk-script": { type: "string", default: join(here, "..", "tab", "scripts", "make-home-disk.mjs") },
    // The checkpoint the LoRA trains on; --base-model must name it (the home disk checks every adapter against it).
    "train-base": { type: "string", default: "/opt/gg/models/gemma-3-1b-it" },
    "no-home": { type: "boolean", default: false },
    "adapter-topic": { type: "string", default: "pi's tools: read, write, bash and go_online" },
    "min-share": { type: "string", default: "0.97" },
    "teach-deadline-s": { type: "string", default: "300" },
    // One practice run's limit: a run still going after this is a straggler (the teacher's runs take 5-30 s).
    "run-timeout-s": { type: "string", default: "120" },
    dry: { type: "boolean", default: false },
  },
});
// Children run in this file's directory: every path the caller gave is resolved against where it was launched.
const out = resolve(a.out ?? "");
if (!a.out) { console.error("--out is required"); process.exit(2); }
const basePath = a.base ? resolve(a.base) : undefined;
const homeScript = resolve(a["home-disk-script"]!);
const trainBase = resolve(a["train-base"]!);
mkdirSync(out, { recursive: true });
const progressPath = join(out, "progress.jsonl");
const T0 = Date.now();
const emit = (event: string, fields: Record<string, unknown> = {}) =>
  appendFileSync(progressPath, JSON.stringify({ event, t: Math.round((Date.now() - T0) / 100) / 10, ...fields }) + "\n");
const fail = (stage: string, why: string): never => { emit("error", { stage, why }); console.error(`${stage}: ${why}`); process.exit(1); };

// What the end needs is checked before anything is paid for.
const DEFAULT_TRAIN_BASE = "/opt/gg/models/gemma-3-1b-it", DEFAULT_MODEL = "google/gemma-3-1b-it@dcc83ea841ab6100d6b47a070329e1ba4cf78752";
if (!existsSync(join(trainBase, "config.json"))) fail("plan", `--train-base ${trainBase} is not a model directory`);
if (trainBase === DEFAULT_TRAIN_BASE && a["base-model"] !== DEFAULT_MODEL) {
  fail("plan", `the training checkpoint is ${DEFAULT_MODEL}; --base-model ${a["base-model"]} needs its own weights in --train-base`);
}
if (!a["no-home"]) {
  if (!existsSync(homeScript)) fail("plan", `no home-disk script at ${homeScript} (or pass --no-home)`);
  if (!basePath || !existsSync(basePath)) fail("plan", `--base (the stock base GGUF the tab caches) is required for the home disk${basePath ? `: no ${basePath}` : ""}`);
}
const wall: Record<string, number> = {};
const timed = async <T>(stage: string, f: () => Promise<T>): Promise<T> => { const t = Date.now(); const v = await f(); wall[stage] = Math.round((Date.now() - t) / 100) / 10; return v; };

/** A subprocess whose lines go to `onLine` as they come; resolves with its exit code. */
function run(cmd: string, args: string[], onLine: (line: string) => void = () => undefined, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(cmd, args, { cwd: here, env, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "", err = "";
  child.stdout.on("data", (d) => { buf += d; for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  // The head of stderr carries the error's message, the tail its stack: keep both.
  child.stderr.on("data", (d) => { err += d; if (err.length > 4000) err = err.slice(0, 2500) + "\n[...]\n" + err.slice(-1000); });
  // A program that cannot start (missing, not executable) ends the same way as one that fails.
  const done = new Promise<{ code: number; err: string }>((res) => {
    child.on("error", (e) => res({ code: -1, err: `${cmd} could not start: ${e.message}` }));
    child.on("close", (code) => res({ code: code ?? -1, err }));
  });
  return { child, done };
}

// ---- plan: instances per template, sized by each template's measured keep rate --------------------------------------
const target = Number(a["per-template"]);
const rates: Record<string, number> = JSON.parse(readFileSync(join(here, "keep-rates.json"), "utf8")).rates;
const practised = TEMPLATES.filter((t) => !t.unseen).map((t) => t.name);
const wanted = a.templates === "all" ? practised : a.templates!.split(",");
for (const t of wanted) if (!practised.includes(t)) fail("plan", `no practised template ${t}`);
const plan: Instance[] = [];
for (const t of wanted) {
  const n = Math.ceil((target / Math.max(0.15, rates[t] ?? 0.5)) * 1.2);
  for (let k = 0; k < n; k++) plan.push(makeInstances("train", 1, `-${a.salt}-${k}`).find((x) => x.template === t)!);
}
// Interleave templates, so every template fills at about the same pace.
plan.sort((x, y) => Number(x.id.split("-").pop()) - Number(y.id.split("-").pop()) || x.template.localeCompare(y.template));
writeFileSync(join(out, "plan.jsonl"), plan.map((x) => JSON.stringify(x)).join("\n") + "\n");
emit("start", { program: "self-tools", teacher: "gpt-6-luna", student: "gemma-3-1b-it", tools: a.tools!.split(","), templates: wanted.length,
  per_template: target, to_try: plan.length, check: "every run is kept only if its code check passes (files, a script's output, or the value the answer states)" });

if (a.dry) {
  // What a live run would cost, from the measured teacher runs (offline policy, three or four tools): about $0.0002 and
  // 6 s of wall per run, run --concurrency at a time.
  const perRun = 0.0002, perRunS = 6;
  const s = Math.round((plan.length * perRunS) / Number(a.concurrency));
  emit("dry", { to_try: plan.length, teacher_usd: +(plan.length * perRun).toFixed(2), teach_s_estimate: s });
  console.log(JSON.stringify({ to_try: plan.length, teacher_usd: +(plan.length * perRun).toFixed(2), teach_s_estimate: s }));
  process.exit(0);
}

// ---- teach: the teacher drives pi's loop on every planned task; runs are kept as they pass -------------------------
const specs = TOOLS.filter((t) => a.tools!.split(",").includes(t.name));
const keptBy: Record<string, number> = {};
let tried = 0, passed = 0, kept = 0, cost = 0, seen = 0;
const runsPath = join(out, "runs.jsonl");
const full = () => wanted.every((t) => (keptBy[t] ?? 0) >= target);
// Enough: every template full, or nearly all wanted runs kept (the last few templates are the slowest to fill), or the
// teaching deadline: the export caps per template, so a template a little short only trains on what it has.
let teachStart = Date.now();
const enough = () => full() || kept >= Number(a["min-share"]) * target * wanted.length || (Date.now() - teachStart) / 1000 > Number(a["teach-deadline-s"]);
writeFileSync(runsPath, "");
await timed("teach", async () => {
  const drive = run(process.execPath, ["drive.ts", "--instances", join(out, "plan.jsonl"), "--out", runsPath, "--brain", "luna", "--policy", a.policy!,
    "--tools", a.tools!, "--path", a.path!, "--concurrency", a.concurrency!, "--work", join(out, "work"), "--timeout-s", a["run-timeout-s"]!]);
  teachStart = Date.now();
  const drain = () => {
    const lines = readFileSync(runsPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(seen)) {
      const r = JSON.parse(line);
      tried++;
      cost += r.usage?.cost ?? 0;
      const c = r.ok ? canonical(r.messages ?? [], true) : { reject: "the check failed" };
      const ok = !("reject" in c) && renderTranscript(specs, c.messages).text.length <= Number(a["max-chars"]);
      if (r.ok) passed++;
      const counts = ok && (keptBy[r.template] ?? 0) < target;
      if (counts) { kept++; keptBy[r.template] = (keptBy[r.template] ?? 0) + 1; }
      emit("teach.run", { n: tried, template: r.template, request: r.prompt, check: checkName(r.template), passed: r.ok, kept: counts,
        ...(r.ok ? (ok ? {} : { left_out: "reject" in c ? c.reject : "too long" }) : { why: r.why }) });
      if (tried % 25 === 0) emit("teach.progress", { tried, passed, kept, wanted: target * wanted.length, templates_full: wanted.filter((t) => (keptBy[t] ?? 0) >= target).length, of: wanted.length, teacher_usd: +cost.toFixed(3) });
    }
    seen = lines.length;
  };
  const tail = setInterval(() => { drain(); if (enough()) drive.child.kill("SIGTERM"); }, 1000);
  const { code, err } = await drive.done;
  clearInterval(tail);
  drain(); // the runs written after the last tick
  if (code !== 0 && !enough()) fail("teach", `drive.ts exited ${code}: ${err.slice(0, 600)}`);
});
emit("teach.done", { tried, passed, kept, stopped: full() ? "every template full" : kept >= Number(a["min-share"]) * target * wanted.length ? "nearly all kept" : "deadline", templates_full: wanted.filter((t) => (keptBy[t] ?? 0) >= target).length, of: wanted.length, teacher_usd: +cost.toFixed(3), s: wall.teach });

// ---- keep: the training set (the export's own filter and cap) -------------------------------------------------------
const trainText = join(out, "train-text.jsonl");
await timed("keep", async () => {
  let summary: any;
  const ex = run(process.execPath, ["export.ts", "--runs", runsPath, "--out", trainText, "--cap", String(target), "--offline-only", "--tools", a.tools!, "--max-chars", a["max-chars"]!],
    (line) => { try { summary = JSON.parse(line); } catch { /* not the summary */ } });
  const { code, err } = await ex.done;
  if (code !== 0 || !summary) fail("keep", `export.ts exited ${code}: ${err.slice(0, 600)}`);
  emit("keep", { rows: summary.kept, templates: summary.templates, left_out: summary.rejected, per_template_min: summary.per_template_min });
});

// ---- train: the LoRA, merged model and f16 GGUF adapter ------------------------------------------------------------
const trainDir = join(out, "train");
await timed("train", async () => {
  mkdirSync(trainDir, { recursive: true });
  // The adapter's model: what it was trained on, the model the base was converted from (the home disk checks they match).
  const tr = run("python3", ["train_tools.py", "--data", trainText, "--out", trainDir, "--base", trainBase, "--adapter-gguf", "f16", "--adapter-topic", a["adapter-topic"]!, "--base-ref", a["base-model"]!], (line) => {
    try {
      const e = JSON.parse(line);
      const { event, t: _t, ...rest } = e;
      if (event === "step") emit("train.step", { step: e.step, of: e.of, loss: e.loss, eta_s: e.eta_s });
      else if (["data", "start", "merged", "adapter.gguf", "done"].includes(event)) emit(`train.${event}`, rest);
    } catch { /* not an event */ }
  });
  const { code, err } = await tr.done;
  if (code !== 0) fail("train", `train_tools.py exited ${code}: ${err.slice(0, 600)}`);
});

// ---- home disk: the stock base plus the adapter, laid out the way the tab reads it ---------------------------------
await timed("home", async () => {
  const adapter = join(trainDir, "adapter-f16.gguf");
  if (a["no-home"]) { emit("home.skipped", { why: "--no-home" }); return; }
  const args = [homeScript, join(out, "disk"), "--base", basePath!, "--base-model", a["base-model"]!, "--adapter", adapter, "--fields", join(trainDir, "adapter-f16.json")];
  const hd = run(process.execPath, args);
  const { code, err } = await hd.done;
  if (code !== 0) fail("home", `make-home-disk exited ${code}: ${err.slice(0, 600)}`);
  const summary = JSON.parse(readFileSync(join(trainDir, "summary.json"), "utf8"));
  emit("home", { manifest: join(out, "disk", "home", "manifest.json"), adapter_bytes: statSync(adapter).size, adapter_sha256: summary.adapter_sha256 });
});

emit("done", { kept, templates: wanted.length, wall_s: wall, total_s: Math.round((Date.now() - T0) / 100) / 10, teacher_usd: +cost.toFixed(3) });
