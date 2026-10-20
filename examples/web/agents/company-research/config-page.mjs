#!/usr/bin/env node
// A static page of the agent's configuration and of which prompt each run loaded: node config-page.mjs --home DIR --out FILE.
// One HTML file with no script and nothing from the network. It reads the agent home (its definition, its prompt variants
// and its runs index) and, for each run, `runs/<id>/prompt.json`, the host's record of how it chose (below), and links
// `runs/<id>/work/brief.md` when there is one. A field that is not recorded is shown as "not recorded".
//
// runs/<id>/prompt.json: { version: 1, question, input, passes: [{ pass, lookup: null | { query, sources: [{ via, url, title }] }, choice,
//   confidence, probabilities, model, cost_usd, latency_ms }], lookup_used, chosen: { label, role, reason }, selected_at }.
// The runs index may also carry prompt: { id, reason }, which the page uses when prompt.json is not there.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizePrompts, readQuestion, ruleText } from "./prompts-lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const USAGE = "usage: config-page.mjs --home DIR --out FILE";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const NONE = '<span class="none">not recorded</span>';
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value, digits) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : null);

/** An address as host and path, with no scheme, query or fragment, so a page shows where a lookup went and nothing else. */
export function where(url) {
  const parsed = URL.parse(String(url ?? ""));
  return parsed ? `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}` : "";
}

function probabilities(pass) {
  if (!isObject(pass.probabilities)) return "";
  const entries = Object.entries(pass.probabilities).filter(([, p]) => typeof p === "number").sort((a, b) => b[1] - a[1]);
  return entries.map(([option, p]) => `${escapeHtml(option)} ${p.toFixed(2)}`).join(" · ");
}

function passCell(pass) {
  if (!isObject(pass)) return "<td>-</td>";
  const choice = typeof pass.choice === "string" ? `<b>${escapeHtml(pass.choice)}</b>` : NONE;
  const confidence = number(pass.confidence, 2);
  const probs = probabilities(pass);
  const meta = [number(pass.cost_usd, 6) === null ? null : `$${number(pass.cost_usd, 6)}`, typeof pass.latency_ms === "number" ? `${Math.round(pass.latency_ms)} ms` : null].filter(Boolean);
  return `<td>${choice}${confidence === null ? "" : ` at ${confidence}`}${probs ? `<small>${probs}</small>` : ""}${meta.length ? `<small>${escapeHtml(meta.join(" · "))}</small>` : ""}</td>`;
}

function lookupCell(record) {
  if (!isObject(record)) return `<td>${NONE}</td>`;
  const passes = Array.isArray(record.passes) ? record.passes : [];
  const used = record.lookup_used === true || passes.some((pass) => isObject(pass) && isObject(pass.lookup));
  if (!used) return "<td>no</td>";
  const lookup = passes.map((pass) => pass?.lookup).find(isObject);
  // The sources a lookup read: `sources: [{ via, url, title }]`, or one page as `{ url, title }`.
  const sources = Array.isArray(lookup?.sources) ? lookup.sources.filter(isObject) : lookup && (lookup.url || lookup.title) ? [lookup] : [];
  const lines = sources.map((source) => [source.via, source.title, where(source.url)].filter(Boolean).map(escapeHtml).join(" · ")).filter(Boolean);
  if (lookup?.query) lines.push(`search: ${escapeHtml(lookup.query)}`);
  return `<td>yes${lines.length ? `<small>${lines.join("<br>")}</small>` : ""}</td>`;
}

function variantCell(run, byId) {
  const chosen = isObject(run.record?.chosen) ? run.record.chosen : null;
  const label = chosen?.label ?? byId.get(run.index?.prompt?.id)?.label ?? run.index?.prompt?.id;
  const reason = chosen?.reason ?? run.index?.prompt?.reason;
  if (!label) return `<td>${NONE}</td>`;
  return `<td><b>${escapeHtml(label)}</b>${chosen?.role ? ` <span class="role">${escapeHtml(chosen.role)}</span>` : ""}${reason ? `<small>${escapeHtml(reason)}</small>` : ""}</td>`;
}

function outcomeCell(run) {
  const index = run.index ?? {};
  const state = index.endedAt ? escapeHtml(index.outcome ?? "ended") : "running";
  const cost = number(index.cost, 4);
  return `<td>${state}${cost === null ? "" : `<small>$${cost}</small>`}</td>`;
}

function runRow(run, byId) {
  const input = run.record?.input ?? run.title;
  const passes = Array.isArray(run.record?.passes) ? run.record.passes : [];
  const [first, second] = [passes[0], passes[1]];
  const result = run.briefHref ? `<a href="${escapeHtml(run.briefHref)}">brief.md</a>` : '<span class="none">no brief</span>';
  const started = run.index?.startedAt ? `<small>${escapeHtml(String(run.index.startedAt).replace("T", " ").replace(/\.\d+Z$/, "Z"))}</small>` : "";
  return `<tr><td>${input ? escapeHtml(input) : NONE}${started}<small class="id">${escapeHtml(run.id)}</small></td>${passCell(first)}${passCell(second)}${lookupCell(run.record)}${variantCell(run, byId)}${outcomeCell(run)}<td>${result}</td></tr>`;
}

function promptBlock(variant, question) {
  const rule = variant.when ? `<span class="rule">loads when ${escapeHtml(ruleText(variant.when))}</span>` : variant.role === "generic" ? '<span class="rule">loads when no overlay reaches its threshold, even after a lookup</span>' : '<span class="rule">always part of the prompt</span>';
  const criterion = variant.when && question?.criteria && Object.hasOwn(question.criteria, variant.when.option) ? `<p class="criterion">${escapeHtml(variant.when.option)}: ${escapeHtml(question.criteria[variant.when.option])}</p>` : "";
  return `<details${variant.role === "base" ? " open" : ""}><summary><b>${escapeHtml(variant.label)}</b> <span class="role">${escapeHtml(variant.role)}</span> ${rule}</summary>${criterion}<pre>${escapeHtml(variant.text)}</pre></details>`;
}

const STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#17171a;--muted:#5b5b66;--line:#d9d9df;--soft:#f3f3f6;--accent:#b45f00}
@media (prefers-color-scheme:dark){:root{--bg:#080809;--fg:#f2f2f2;--muted:#a4a4ad;--line:#2c2c30;--soft:#111113;--accent:#ff8700}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
p{margin:6px 0}.lede{color:var(--muted);max-width:70ch}.none{color:var(--muted)}small{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.id{font-family:ui-monospace,monospace}
details{border:1px solid var(--line);border-radius:6px;margin:8px 0;background:var(--soft)}summary{cursor:pointer;padding:10px 12px}pre{margin:0;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid var(--line);font:13px/1.5 ui-monospace,monospace}
.role{font:12px ui-monospace,monospace;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 5px}.rule{color:var(--accent);font-size:13px}.criterion{margin:0;padding:10px 12px 0;color:var(--muted);font-size:13px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:6px}table{border-collapse:collapse;width:100%;min-width:900px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);background:var(--soft)}tr:last-child td{border-bottom:0}
a{color:var(--accent)}ul{margin:6px 0;padding-left:20px}`;

/**
 * The page as one string. `data` is `{ agent: { id, name, description }, prompts, question, runs: [{ id, title, index, record,
 * briefHref }], generatedAt }`; everything in it is text and is escaped.
 */
export function renderPage(data) {
  const prompts = normalizePrompts(data.prompts);
  const order = { base: 0, overlay: 1, generic: 2 };
  const sorted = [...prompts].sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3));
  const runs = [...(data.runs ?? [])].sort((a, b) => String(b.index?.startedAt ?? "").localeCompare(String(a.index?.startedAt ?? "")) || a.id.localeCompare(b.id));
  const question = data.question;
  const byId = new Map(sorted.map((v) => [v.id ?? v.label, v]));
  const threshold = sorted.find((v) => v.when)?.when;
  const rule = question
    ? `<p class="lede">Before its first turn the host asks Jev one question about the company in the input: <b>${escapeHtml(question.id)}</b>, ${escapeHtml(question.instructions ?? "")} The overlay whose option Jev picks with enough confidence${threshold ? ` (${escapeHtml(threshold.threshold)} or more)` : ""} is added to the base. When no overlay reaches its threshold, the host looks the company up once and asks again. When there is still none, the generic prompt is added to the base.</p>`
    : "";
  const criteria = question?.criteria && Object.keys(question.criteria).length
    ? `<ul>${Object.entries(question.criteria).map(([option, text]) => `<li><b>${escapeHtml(option)}</b>: ${escapeHtml(text)}</li>`).join("")}</ul>`
    : "";
  const head = ["Input", "Jev, first pass", "Jev, second pass", "Lookup", "Prompt loaded", "Outcome", "Result"].map((name) => `<th>${name}</th>`).join("");
  const table = runs.length
    ? `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${runs.map((run) => runRow(run, byId)).join("")}</tbody></table></div>`
    : '<p class="none">No runs yet.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.agent?.name ?? "Agent")} configuration</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(data.agent?.name ?? "Agent")}</h1>
<p class="lede">${escapeHtml(data.agent?.description ?? "")}</p>
<p class="none">${escapeHtml(data.agent?.id ?? "")} · ${sorted.length} prompt variant${sorted.length === 1 ? "" : "s"} · ${runs.length} run${runs.length === 1 ? "" : "s"} · read ${escapeHtml(data.generatedAt ?? "")}</p>
<h2>How a prompt is picked</h2>
${rule || '<p class="none">No question is configured.</p>'}${criteria}
<h2>Prompts</h2>
${sorted.length ? sorted.map((variant) => promptBlock(variant, question)).join("\n") : '<p class="none">No prompts are saved in this home.</p>'}
<h2>Runs</h2>
${table}
</main>
</body>
</html>
`;
}

/** Everything the page shows, read from the agent home at `home`: its state, and each run's directory. */
export async function collect(home, { api, question, out }) {
  const handle = await api.openAgentHome(home);
  const state = await api.readAgentHome(handle);
  const runs = [];
  for (const [id, index] of Object.entries(state.runs ?? {})) {
    const dir = join(home, index.path ?? `runs/${id}`);
    const record = await readFile(join(dir, "prompt.json"), "utf8").then(JSON.parse).catch(() => null);
    const web = await readFile(join(dir, "web.json"), "utf8").then(JSON.parse).catch(() => null);
    const brief = join(dir, "work", "brief.md");
    const briefHref = existsSync(brief) && (await stat(brief)).isFile() ? relative(dirname(resolve(out)), brief).split("\\").join("/") : null;
    runs.push({ id, title: typeof web?.title === "string" ? web.title : "", index, record: isObject(record) ? record : null, briefHref });
  }
  return { agent: { id: state.identity.id, name: state.definition.name, description: state.definition.description }, prompts: state.prompts, question, runs, generatedAt: new Date().toISOString() };
}

/** The page written whole (a temporary file renamed over `out`). Returns the exit code. */
export async function main(argv, { api, out = (line) => console.log(line), err = (line) => console.error(line), dir = HERE } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { home: { type: "string" }, out: { type: "string" } }, allowPositionals: false }));
  } catch (error) {
    err(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (!values.home || !values.out) {
    err(USAGE);
    return 2;
  }
  try {
    api ??= await import("@parcha/pi-durable-agent");
    const home = resolve(values.home);
    if (!existsSync(join(home, "agent.sqlite"))) throw new Error(`${basename(home)} is not an agent home`);
    const question = await readQuestion(join(dir, "question.json")).catch(() => undefined);
    const data = await collect(home, { api, question, out: values.out });
    const target = resolve(values.out);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, renderPage(data));
    await rename(temp, target);
    out(`wrote ${basename(target)}: ${normalizePrompts(data.prompts).length} prompt variants, ${data.runs.length} runs`);
    return 0;
  } catch (error) {
    err(`no page written: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
