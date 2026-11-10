// Records the learning demo's server answers for the console's fixtures, on a server seeded by seed.mjs:
// what the Learning tab reads, a person's edit that loses to a change made meanwhile (412), a note the checks refuse
// (400), the edit made again on the newest version, a retire, an agent with no notes whose switch turns learning on, and
// two of its runs, and what one of them changed. Usage: node record.mjs <server url> <data dir> <out dir> (apps/console/src/fixtures)
// Each file is {request, status, headers, body} as the server answered; no token or password is written.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [base, data, out] = process.argv.slice(2);
const token = readFileSync(join(data, ".token"), "utf8").trim();
mkdirSync(out, { recursive: true });
const KEPT = ["etag", "content-type", "location"];
async function rec(name, method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${base}/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  const parsed = type.includes("json") ? JSON.parse(text) : text;
  const answer = Object.fromEntries(KEPT.filter((k) => res.headers.get(k)).map((k) => [k, res.headers.get(k)]));
  const request = { method, path, ...(Object.keys(headers).length ? { headers } : {}), ...(body !== undefined ? { body } : {}) };
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ request, status: res.status, headers: answer, body: parsed }, null, 2)}\n`);
  if (text.includes(token)) throw new Error(`${name} holds the token`);
  process.stdout.write(`${name} ${res.status}\n`);
  return { status: res.status, body: parsed, etag: res.headers.get("etag") };
}
const A = "/agents/refund-finder";
const FIRST = `${A}/learning/files/try-policies-refund-policy-first.md`;
const MINE = `${A}/learning/files/keep-it-to-three-lines.md`;

await rec("learning.agent", "GET", A);
await rec("learning.view", "GET", `${A}/learning`);
const runs = await rec("learning.runs", "GET", `${A}/runs?limit=50`);
const runOf = (shop) => runs.body.runs.find((r) => r.title.includes(shop)).run_id;
await rec("learning.run-brooklinen", "GET", `/runs/${runOf("brooklinen")}`);
await rec("learning.run-allbirds", "GET", `/runs/${runOf("allbirds")}`);
// What Brooklinen's run changed, with the run as read beside it (a pair: the run page's "What it changed").
await rec("learning.diff-run", "GET", `/runs/${runOf("brooklinen")}`);
await rec("learning.diff", "GET", `/runs/${runOf("brooklinen")}/learning/diff`);
await rec("learning.stats", "GET", `/stats?agent=refund-finder`);

// A person opens the note to edit it; meanwhile someone else saves a change to it.
const opened = await rec("learning.note", "GET", FIRST, { headers: { accept: "text/markdown, application/json" } });
const theirs = opened.body.replace("It answered at once on Taylor Stitch and Brooklinen.", "It answered at once on Taylor Stitch, Brooklinen and Allbirds.");
await rec("learning.note-theirs", "PUT", FIRST, { body: { text: theirs }, headers: { "if-match": opened.etag } });
// The person's save, on the version they opened: refused, it changed since.
const mine = opened.body.replace(/\n\*\*How to apply:\*\*[\s\S]*$/, "\n**How to apply:** fetch it before any search, every time.\n");
await rec("learning.note-stale", "PUT", FIRST, { body: { text: mine }, headers: { "if-match": opened.etag } });
const newest = await rec("learning.note-newest", "GET", FIRST, { headers: { accept: "text/markdown, application/json" } });
// Their edit again on the newest version, first with a hidden character the checks refuse, then clean.
const edited = newest.body.replace(/\n\*\*How to apply:\*\*[\s\S]*$/, "\n**How to apply:** fetch it before any search, every time.\n");
await rec("learning.note-refused", "PUT", FIRST, { body: { text: edited.replace("every time", "every​time") }, headers: { "if-match": newest.etag } });
await rec("learning.note-saved", "PUT", FIRST, { body: { text: edited }, headers: { "if-match": newest.etag } });
await rec("learning.view-edited", "GET", `${A}/learning`);
// They retire their own note.
const three = await rec("learning.mine", "GET", MINE, { headers: { accept: "text/markdown, application/json" } });
await rec("learning.mine-retired", "POST", `${MINE}/retire`, { body: {}, headers: { "if-match": three.etag } });
await rec("learning.view-retired", "GET", `${A}/learning`);

// An agent with no notes and learning off: its tab, and the switch's revision.
const agent = await rec("learning.off-agent", "GET", "/agents/release-notes");
await rec("learning.off-view", "GET", "/agents/release-notes/learning");
await rec("learning.off-runs", "GET", "/agents/release-notes/runs?limit=50");
await rec("learning.off-switch", "PUT", "/agents/release-notes/definition", { body: { definition: { ...agent.body.definition, learning: true, version: agent.body.revisions + 1 }, note: "Learning on" }, headers: { "if-match": agent.etag } });
// The agent read again after the switch, as its page reads it (the definition save answers no `tools`).
await rec("learning.off-agent-after", "GET", "/agents/release-notes");
await rec("learning.off-view-after", "GET", "/agents/release-notes/learning");
process.stdout.write("recorded\n");
