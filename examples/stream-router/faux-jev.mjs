// A scripted stand-in for Jev, for offline tests of the Stream router only: it answers a route's choice from the words
// of the note inside <trigger-payload> (never from the question's own criteria), with a fixed confidence. Live routing
// is Jev's judgment, not these rules.
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-typesafe-request-id": "req-faux-router" } });

/** The note's text: the `text` field of the JSON inside the first string that holds a <trigger-payload> block. */
function noteOf(value) {
  if (typeof value === "string") {
    const block = /<trigger-payload[^>]*>\s*([\s\S]*?)\s*<\/trigger-payload>/.exec(value);
    if (!block) return undefined;
    try {
      return String(JSON.parse(block[1]).text ?? "");
    } catch {
      return block[1];
    }
  }
  if (value && typeof value === "object") for (const v of Object.values(value)) { const found = noteOf(v); if (found !== undefined) return found; }
  return undefined;
}

function branchOf(note, options) {
  const said = note.toLowerCase();
  const wanted = /^\s*(hey\s+)?arun\b/.test(said) ? "arun" : /\b(look into|research|find out|compare)\b/.test(said) ? "research" : /\b(repo|bug|pull request|code|test suite)\b/.test(said) ? "code" : "none";
  return options.includes(wanted) ? wanted : options[0];
}

export default async function fauxRouterJev(url, init = {}) {
  if (new URL(String(url)).pathname === "/v1/models") return json({ models: [{ name: "jev-latest", description: "faux", release_date: "2026-09-15" }] });
  const raw = init.body === undefined ? "" : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
  const body = raw ? JSON.parse(raw) : {};
  const note = noteOf(body) ?? "";
  const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, q]) => {
    if (q.type !== "choice") return [id, { type: "noul", noul: 0.5 }];
    const options = Object.keys(q.criteria);
    const choice = branchOf(note, options);
    return [id, { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : 0.1 / Math.max(1, options.length - 1)])) }];
  }));
  return json({ model: "jev-faux-router", answers, usage: { input_tokens: 120, output_tokens: 0 } });
}
