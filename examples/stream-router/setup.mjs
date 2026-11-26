// Sets up the Stream router on an AgentRun server: the stream-router workflow agent (made, or its definition revised)
// and a webhook trigger signed `stream` that starts it for every note Stream sends. It prints the trigger's hook_url (paste
// it into Stream) and the console page where the owner gives the trigger Stream's secret: the API token may not write a
// secret, so that step is the owner's.
//
//   AGENTRUN_BASE_URL=https://your-server/v2 AGENTRUN_API_KEY=... node examples/stream-router/setup.mjs
import { readFileSync } from "node:fs";

const base = process.env.AGENTRUN_BASE_URL?.replace(/\/+$/, "");
const key = process.env.AGENTRUN_API_KEY;
if (!base || !key) {
  console.error("Set AGENTRUN_BASE_URL (the server's /v2 address) and AGENTRUN_API_KEY (its API token).");
  process.exit(2);
}
const AGENT = "stream-router";
const TRIGGER = "Stream ring";
const workflow = JSON.parse(readFileSync(new URL("./router.workflow.json", import.meta.url), "utf8"));
const definition = {
  id: AGENT, name: "Stream router", workflow,
  // Its runs start unattended from the ring: the specialists hold read-only tools alone (web search for research), so
  // nothing waits on a person's approval and nothing is sent, posted or changed outside the run.
  approvals: "never",
  // A note Jev routes to none costs one decision; a specialist's step is capped by its own budget_usd beneath this.
  max_cost_usd: 1,
};

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body: json ?? text };
}
const fail = (what, answer) => {
  console.error(`${what}: ${answer.status} ${JSON.stringify(answer.body?.error ?? answer.body).slice(0, 600)}`);
  process.exit(1);
};

// The router: made, or, when it exists, its definition revised under the read's ETag.
const existing = await call("GET", `/agents/${AGENT}`);
if (existing.status === 404) {
  const made = await call("POST", "/agents", { definition: { ...definition, version: 1 } });
  if (made.status !== 201) fail("Making the stream-router agent", made);
  console.log("Made the agent stream-router.");
} else if (existing.status === 200) {
  // No version: the server numbers the revision (the same definition again makes none), and If-Match refuses an edit made
  // since the read.
  const revised = await call("PUT", `/agents/${AGENT}/definition`, { definition, note: "Stream router from examples/stream-router" }, existing.headers.get("etag") ? { "if-match": existing.headers.get("etag") } : {});
  if (![200, 201].includes(revised.status)) fail("Revising the stream-router agent", revised);
  console.log("Revised the agent stream-router.");
} else fail("Reading the stream-router agent", existing);

// The trigger: each note its own run (accept), at most five at once, each capped.
const source = { kind: "webhook", signature: "stream", accept: [{ event: "interaction" }] };
const target = { kind: "start_run", agent_id: AGENT, input: { content: "A voice note arrived from the Stream ring." }, max_cost_usd: 1 };
const listed = await call("GET", "/triggers");
if (listed.status !== 200) fail("Listing the triggers", listed);
const kept = listed.body.triggers.find((trigger) => trigger.name === TRIGGER);
let trigger;
if (kept && kept.source?.signature !== "stream") fail(`A trigger named "${TRIGGER}" exists with another signature; rename or delete it first`, { status: 409, body: kept.source });
if (kept) {
  const changed = await call("PATCH", `/triggers/${kept.id}`, { source, target, max_active_runs: 5 });
  if (changed.status !== 200) fail("Changing the trigger", changed);
  trigger = changed.body;
  console.log(`Pointed the trigger "${TRIGGER}" at stream-router.`);
} else {
  const made = await call("POST", "/triggers", { name: TRIGGER, source, target, max_active_runs: 5 });
  if (made.status !== 201) fail("Making the trigger", made);
  trigger = made.body;
  console.log(`Made the trigger "${TRIGGER}".`);
}
const read = await call("GET", `/triggers/${trigger.id}`);
const page = new URL(`/#/triggers/${trigger.id}`, base).href;
console.log(`
Paste this URL into Stream (iPhone: Stream's Developer (Webhook) screen, under Other Tools in its settings):
  ${read.body.hook_url ?? `${base}/hooks/${trigger.id}`}
Turn on Sign requests there, copy the secret Stream shows, and give it to the trigger with Set secret on its page:
  ${page}
${read.body.secret?.set ? "The trigger already holds a secret: Set secret replaces it." : "Until then every note to the URL is refused."}`);
