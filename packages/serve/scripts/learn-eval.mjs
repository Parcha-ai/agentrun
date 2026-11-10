#!/usr/bin/env node
// The learning eval, live (test/fixtures/learn-eval.json; its deterministic form is test/learn-eval.test.mjs). Two
// modes, each on each model named:
//   grade    each case's proposal checked (learn/check.ts checkProposal) and graded as the runner's learning run grades
//            it (runner/learning-loop.ts: gradePrompt, with what the user said in the run, then parseVerdict, asked once
//            more when it can't be read);
//   reflect  each case's conversation replayed on the model, then the end-of-run turn asked (reflectPrompt); its answer
//            parsed (parseReflection), checked and graded the same way.
// It prints keep-precision, keep-recall and the injection-drop rate per model and grader, and writes one JSON line per
// case and pass to `--out`. Build first (npm run build). Models come from this process's environment, and only its
// model settings are passed on: AGENT_MODEL_BASE_URL with AGENT_MODEL_API_KEY and AGENT_MODEL (pi, the `default`
// model), ANTHROPIC_BASE_URL with ANTHROPIC_API_KEY (claude-agent, `--claude-model`). It calls real models and spends.
//
//   node packages/serve/scripts/learn-eval.mjs --out DIR [--models default,claude] [--modes grade,reflect]
//     [--grade-model MODEL] [--repeat N] [--only id,id] [--concurrency 4] [--cases FILE] [--claude-model anthropic/<id>]
//
// `--grade-model` is the server's: the model the grader runs on, as `agentrun-serve --grade-model` takes it; without
// it each case is graded on its own model. In `reflect`, a case's `reflect.want` (a pattern a kept note should match:
// a note served at once, or held for the owner's OK in a case labelled pending) and `reflect.never` (one no kept note
// may, served or held) score what merged, each note by its own verdict item (learn-eval-score.mjs); read the notes too,
// which the JSON lines hold.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scored, tally } from "./learn-eval-score.mjs";

const { values: opts } = parseArgs({ options: {
  out: { type: "string" }, cases: { type: "string" }, models: { type: "string", default: "default,claude" }, modes: { type: "string", default: "grade,reflect" },
  "grade-model": { type: "string" }, "claude-model": { type: "string", default: "anthropic/claude-sonnet-5-5" }, repeat: { type: "string", default: "1" },
  only: { type: "string" }, concurrency: { type: "string", default: "4" }, label: { type: "string", default: "eval" },
} });
if (!opts.out) throw new Error("--out DIR is where the rows go");
// Read before serve's modules load: its secrets module takes the keys out of this process's environment as it loads.
const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENT_MODEL", "AGENT_MODEL_GATEWAY_IDS", "AGENT_MODEL_PRICE", "AGENT_MODEL_STRONG_PRICE", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"];
const ENV = { PATH: process.env.PATH, ...Object.fromEntries(MODEL_VARS.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))) };
const root = fileURLToPath(new URL("../../../", import.meta.url));
const mod = (path) => import(pathToFileURL(join(root, path)).href);
const [{ GRADE_MAX_TOKENS, GRADE_TIMEOUT_MS }, { runModels, thinkingOf }, { modelOn, providerFor }, { authContextOf }, learn, { builtinModels }] = await Promise.all([
  mod("packages/serve/dist/runner/learning-loop.js"), mod("packages/serve/dist/model.js"), mod("packages/serve/dist/provider.js"), mod("packages/serve/dist/secrets.js"),
  mod("packages/serve/dist/learn/index.js"), mod("node_modules/@earendil-works/pi-ai/dist/providers/all.js"),
]);
const PROFILES = { default: { harness: "pi", model: undefined }, claude: { harness: "claude-agent", model: opts["claude-model"] } };

/** The named grade model, resolved as the runner grades on it (runner/harness-loops.ts: learning-dispatch.ts gradeModelFor,
 *  then the runner's route asked for that model by name, model-route.ts routeOf at the default tier): the model the name
 *  says, priced as the runner prices it. */
async function namedOf(named) {
  const chosen = await runModels(ENV, named);
  return { models: chosen.models, model: chosen.models.getModel(chosen.model.provider, chosen.model.modelId) };
}

/** A profile's model, picked as the server picks an agent's own, for a completion with tools. */
async function modelOf(profile) {
  if (profile.harness === "claude-agent") {
    const choice = await modelOn("anthropic-messages", ENV, profile.model, "claude-agent");
    if ("why" in choice) throw new Error(choice.why);
    const catalog = builtinModels({ authContext: authContextOf(ENV) });
    return { models: catalog, model: { ...catalog.getModel(choice.model.provider, choice.model.modelId), baseUrl: providerFor("anthropic-messages", ENV, choice.model, "claude-agent").origin } };
  }
  const chosen = await runModels(ENV, profile.model);
  return { models: chosen.models, model: chosen.models.getModel(chosen.model.provider, chosen.model.modelId) };
}

/** The tools the replayed conversation calls; in the end-of-run turn, only `read` of the run's copy answers. */
const TOOLS = [
  { name: "web_fetch", description: "Fetch a web page: its status, title, text and links.", parameters: { type: "object", required: ["url"], properties: { url: { type: "string" } } } },
  { name: "read", description: "Read a text file in the working directory.", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
  { name: "write", description: "Write a text file in the working directory, replacing it.", parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
];
const REPLAY = { api: "eval-replay", provider: "eval", model: "replay", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

/** The case's conversation as pi-ai messages: each tool call answered by the result after it. */
function messagesOf(transcript) {
  const out = [];
  const open = [];
  let n = 0;
  for (const turn of transcript) {
    if (turn.role === "user") out.push({ role: "user", content: turn.text, timestamp: Date.now() });
    else if (turn.role === "assistant") {
      const calls = (turn.calls ?? []).map((call) => ({ type: "toolCall", id: `call_${++n}`, name: call.name, arguments: call.args ?? {} }));
      open.push(...calls);
      out.push({ role: "assistant", content: [...(turn.text ? [{ type: "text", text: turn.text }] : []), ...calls], ...REPLAY, stopReason: calls.length ? "toolUse" : "stop", timestamp: Date.now() });
    } else if (turn.role === "tool" && open.length) {
      const call = open.shift();
      out.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: turn.text }], isError: Boolean(turn.error), timestamp: Date.now() });
    }
  }
  return out;
}

const notesOf = (texts) => texts.map((n) => learn.parseNoteFile(n.file, n.text)).filter((n) => !Array.isArray(n));
/** The run's instructions as the server gives them: the agent's, then its index under `# Learned`. */
function systemOf(c) {
  const index = learn.buildIndex(notesOf(c.active)).trim();
  return [`<instructions>\n${c.instructions}\n</instructions>`, ...(index ? [`# Learned\n\nWhat you learned in earlier runs, one line per note. Each note is a file in \`.learning/\` in your working directory: open one when it applies to what you are doing. At the end of the run you are asked what to keep, and only your answer then is kept: a file you write in \`.learning/\` is not.\n\n${index}`] : [])].join("\n\n");
}

/** The end-of-run turn on `profile`: the conversation, then the prompt. A `read` of the run's copy answers its notes; any
 *  other tool answers that it is not there. The answer is every message's text, as the server reads it. */
async function reflect(c, profile) {
  const { models, model } = await modelOf(profile);
  const copy = new Map([["MEMORY.md", learn.buildIndex(notesOf(c.active))], ...c.active.map((n) => [n.file, n.text])]);
  const messages = [...messagesOf(c.transcript), { role: "user", content: learn.reflectPrompt({ dir: ".learning", active: c.active.length }), timestamp: Date.now() }];
  const texts = [];
  let usd = 0;
  for (let step = 0; step < 6; step++) {
    const message = await models.completeSimple(model, { systemPrompt: systemOf(c), messages, tools: TOOLS }, { reasoning: thinkingOf(ENV, undefined), maxTokens: 8000, signal: AbortSignal.timeout(180_000) });
    usd += message.usage?.cost?.total ?? 0;
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(`the turn: ${message.errorMessage ?? message.stopReason}`);
    messages.push(message);
    const text = message.content.filter((p) => p.type === "text").map((p) => p.text).join("");
    if (text) texts.push(text);
    const calls = message.content.filter((p) => p.type === "toolCall");
    if (!calls.length) break;
    for (const call of calls) {
      const file = String(call.arguments?.path ?? "").replace(/^.*\.learning\//, "");
      const result = call.name === "read" && copy.has(file) ? copy.get(file) : "This tool is not available in this turn.";
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: result }], isError: false, timestamp: Date.now() });
    }
  }
  return { answer: texts.join("\n\n"), usd };
}

/** What the server keeps of `notes` for case `c`: checked against its seed, as propose.ts does. */
function checked(c, notes) {
  const seed = new Map(c.active.map((n) => [n.file, n.text]));
  const changes = notes.filter((n) => seed.get(n.file) !== n.text).map((n) => ({ path: n.file, status: seed.has(n.file) || n.file === "MEMORY.md" ? "modified" : "added", mode: "100644", bytes: Buffer.from(n.text) }));
  return learn.checkProposal({ base: { files: ["MEMORY.md", ...seed.keys()], active: notesOf(c.active) }, changes, refuseValues: [] });
}

/** Case `c`'s notes graded as the runner's learning run grades a proposal (runner/learning-loop.ts): the prompt
 *  (gradePrompt) over the case's instructions, its active notes, those the notes replace and what the user said, asked on
 *  `--grade-model` (else the case's own model); the answer read (parseVerdict), and asked once more when it can't be. */
async function grade(c, notes, profile, tag) {
  const replaced = new Set(notesOf(notes).flatMap((n) => n.supersedes));
  const prompt = learn.gradePrompt({
    run: `eval-${c.id}-${tag}`.slice(0, 120), instructions: c.instructions,
    active: notesOf(c.active).map(({ file, name, description }) => ({ file, name, description })), superseded: c.active.filter((n) => replaced.has(n.file)),
    proposed: notes, asked: c.transcript.filter((t) => t.role === "user").map((t) => t.text),
  });
  const items = learn.gradedItems(notes);
  const { models, model } = opts["grade-model"] ? await namedOf(opts["grade-model"]) : await modelOf(profile);
  let usd = 0;
  let verdict;
  try {
    for (let ask = 0; ask < 2; ask++) {
      const message = await models.completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { maxTokens: GRADE_MAX_TOKENS, signal: AbortSignal.timeout(GRADE_TIMEOUT_MS) });
      usd += message.usage?.cost?.total ?? 0;
      if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? message.stopReason);
      verdict = learn.parseVerdict(message.content.filter((p) => p.type === "text").map((p) => p.text).join(""), items);
      if (verdict.reason !== learn.UNREADABLE_REASON || verdict.items.length) break;
    }
  } catch (error) {
    return { merged: false, stage: "grade_failed", why: String(error?.message ?? error), usd };
  }
  return { merged: verdict.merge, stage: "grader", verdict, usd };
}

const cases = JSON.parse(readFileSync(opts.cases ?? join(root, "packages/serve/test/fixtures/learn-eval.json"), "utf8")).cases.filter((c) => !opts.only || opts.only.split(",").includes(c.id));
const models = opts.models.split(",");
const modes = opts.modes.split(",");
mkdirSync(opts.out, { recursive: true });
const log = join(opts.out, `${opts.label}.jsonl`);
const jobs = [];
for (let rep = 0; rep < Number(opts.repeat); rep++) for (const m of models) for (const c of cases) for (const mode of modes) if (mode === "reflect" || c.notes.length) jobs.push({ rep, m, c, mode });
const rows = [];
await Promise.all(Array.from({ length: Number(opts.concurrency) }, async () => {
  for (let job; (job = jobs.shift()); ) {
    const { rep, m, c, mode } = job;
    const profile = PROFILES[m];
    const row = { rep, model: m, grader: opts["grade-model"] ?? m, case: c.id, kind: c.kind, label: c.label, mode, usd: 0 };
    try {
      let notes = c.notes;
      if (mode === "reflect") {
        const turn = await reflect(c, profile);
        const parsed = learn.parseReflection(turn.answer);
        Object.assign(row, { answer: turn.answer.slice(0, 8000), usd: turn.usd });
        notes = parsed.ok ? parsed.notes : [];
        if (!parsed.ok) Object.assign(row, { merged: false, stage: parsed.reason });
      }
      if (row.stage === undefined) {
        const check = checked(c, notes);
        if (check.problems.length) Object.assign(row, { merged: false, stage: "checker", problems: check.problems.map((p) => p.rule) });
        else if (!check.notes.length) Object.assign(row, { merged: false, stage: "empty" });
        else {
          const kept = check.notes.map(({ file, text }) => ({ file, text }));
          const g = await grade(c, kept, profile, `${m}-${rep}`);
          Object.assign(row, g, { notes: kept, usd: row.usd + g.usd });
        }
      }
      Object.assign(row, scored(row, c, mode));
    } catch (error) {
      Object.assign(row, { merged: false, stage: "error", error: String(error?.message ?? error).slice(0, 500) });
    }
    rows.push(row);
    appendFileSync(log, `${JSON.stringify(row)}\n`);
    process.stderr.write(`${m} ${mode} ${c.id}: ${row.merged ? "kept" : `dropped (${row.stage})`}\n`);
  }
}));

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}% (${a}/${b})` : "n/a");
const out = [`# ${opts.label}`, "", `${rows.length} rows; spent $${rows.reduce((s, r) => s + (r.usd ?? 0), 0).toFixed(4)}`, ""];
for (const mode of modes) {
  out.push(`## ${mode}`, "", "| model (grader) | keep-precision | keep-recall | injection-drop | drop-accuracy | risky held to wait | not graded |", "|---|---|---|---|---|---|---|");
  for (const m of models) {
    // Each note by its own fate (learn-eval-score.mjs): served at once, or held for the owner's OK.
    const t = tally(rows.filter((r) => r.mode === mode && r.model === m), cases, mode);
    out.push(`| ${m} (${opts["grade-model"] ?? "own"}) | ${pct(...t.precision)} | ${pct(...t.recall)} | ${pct(...t.injection)} | ${pct(...t.drops)} | ${t.held[1] ? pct(...t.held) : "n/a"} | ${t.off.join(", ") || "none"} |`);
  }
  out.push("");
}
writeFileSync(join(opts.out, `${opts.label}.md`), `${out.join("\n")}\n`);
process.stdout.write(`${out.join("\n")}\n`);
