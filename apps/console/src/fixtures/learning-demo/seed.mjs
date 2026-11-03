// Seeds the demo server with a refund-policy finder that learns over six runs, a person's note, and two agents with no
// notes yet (one with learning off, one on). Usage: node seed.mjs <server url> <data dir>
// Reads the server's token from <data>/.token and never prints it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [base, data] = process.argv.slice(2);
const token = readFileSync(join(data, ".token"), "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${base}/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, body: parsed, etag: res.headers.get("etag") };
}
const note = (name, description, type, body, extra = "") => `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n${extra}---\n${body}`;

const FIRST = ["shopify-refund-policy-path.md", note("Shopify refund policy path", "On a Shopify store the refund policy is at /policies/refund-policy", "reference",
  "Shopify stores serve their refund policy at `/policies/refund-policy`.\n\n`/pages/returns` and `/pages/refund-policy` were empty on Taylor Stitch: they hold a returns portal, not the policy.\n")];
const SECOND = ["try-policies-refund-policy-first.md", note("Try /policies/refund-policy first", "Open /policies/refund-policy before any other page; fall back to /pages/returns", "feedback",
  "Open `https://<shop>/policies/refund-policy` first. It answered at once on Taylor Stitch and Brooklinen.\n\n**Why:** most of these shops run on Shopify, which always serves that path.\n\n**How to apply:** fetch it before any search. Only if it's a 404, try `/pages/returns`, then the links in the site's footer.\n",
  "supersedes: [shopify-refund-policy-path.md]\n")];
const PORTAL = ["kith-returns-portal.md", note("Kith returns go through a portal", "Kith's returns start at returns.kith.com, not on the policy page", "project", "Kith sends returns through its own portal at returns.kith.com.\n")];

const instructions = [
  "Find the shop's refund policy page, then sum up its return window and who pays for return shipping, in a few lines.",
  "",
  `Learn on taylorstitch: ${JSON.stringify([FIRST])}`,
  `Learn on brooklinen: ${JSON.stringify([SECOND])}`,
  `Learn on kith: ${JSON.stringify([PORTAL])}`,
  "Drop: kith-returns-portal.md: It's about one shop's returns portal, not a rule other shops share.",
].join("\n");

await api("POST", "/agents", { definition: { id: "refund-finder", version: 1, name: "Refund policy finder", description: "Finds a shop's refund policy page and sums up its terms.", instructions, harness: "pi", tools: ["read", "write"], learning: true, skills: [] } });
await api("POST", "/agents", { definition: { id: "release-notes", version: 1, name: "Release notes writer", description: "Turns merged pull requests into release notes.", instructions: "Write release notes from the pull requests given.", harness: "pi", tools: ["read"], skills: [] } });
await api("POST", "/agents", { definition: { id: "pr-reviewer", version: 1, name: "PR reviewer", description: "Reviews a diff for bugs and risky changes.", instructions: "Review the diff given.", harness: "pi", tools: ["read", "write"], learning: true, skills: [] } });

let n = 0;
async function start(shop) {
  const r = await api("POST", "/agents/refund-finder/runs", { input: { content: `Find this shop's refund policy page: https://www.${shop}.com` } }, { "idempotency-key": `demo-${shop}-${Date.now()}-${n++}` });
  return r.body.run_id;
}
async function settled(id) {
  for (let i = 0; i < 600; i++) {
    const r = (await api("GET", `/runs/${id}`)).body;
    if (["completed", "failed", "cancelled"].includes(r.status) && (!r.learning || ["merged", "dropped"].includes(r.learning.state))) return r;
    await sleep(500);
  }
  throw new Error(`run ${id} did not settle`);
}
const log = (r) => process.stdout.write(`${r.run_id} ${r.status} ${r.learning?.state}${r.learning?.reason ? `/${r.learning.reason}` : ""} ${r.title}\n`);

// Before it learns: two shops at once, both slow; Taylor Stitch's run keeps the first note.
const before = await Promise.all(["taylorstitch", "patagonia"].map(start));
for (const id of before) log(await settled(id));
// Brooklinen reads it, goes straight to the page, and keeps a better note that replaces it.
log(await settled(await start("brooklinen")));
// A person adds a note of their own.
await api("PUT", "/agents/refund-finder/learning/files/keep-it-to-three-lines.md", { text: note("Keep the summary to three lines", "The answer is the URL, the window and who pays shipping; nothing else", "feedback", "Answer with the policy URL, the return window and who pays return shipping. No preamble.\n") }, { "if-none-match": "*" });
for (const shop of ["allbirds", "kith", "everlane"]) log(await settled(await start(shop)));
process.stdout.write("seeded\n");
