// An llm grader of a run that searched or fetched reads a link check beside its calls: each link the answer cites,
// matched in code against every url the run's web calls answered, so a rubric's "every cited link appears in the run's
// calls" never rests on the grader judging URL equality. A fragment, a trailing slash, the query's order and the case of
// the scheme and host are ignored; the query's keys must be the same, and a value a timeline read elided ("…") matches
// any value for its key. A cited link is shown as a call's is, its query values elided. A run with no web call is graded
// on the prompt it always was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { graderInput } from "../dist/template-eval.js";

const grader = { file: "from-the-calls.md", type: "llm", rubric: "Pass only if every cited link appears in the run's calls." };
const read = { tool: "read", name: "read", arguments: { path: "SKILL.md" }, status: "success", result: "the method" };
const search = (...urls) => ({ tool: "web_search", name: "web_search", arguments: { query: "q" }, status: "success", result: `${JSON.stringify({ provider: "parallel", query: "q", results: urls.map((url, i) => ({ url, title: `Hit ${i + 1}`, snippet: "words" })) })}\nCite the URL of each result you rely on.` });
const fetch = (asked, page) => ({ tool: "web_fetch", name: "web_fetch", arguments: { url: asked }, status: "success", result: JSON.stringify({ ok: true, url: asked, status: 200, title: "A page", text: "Page text.", links: [], ...page }) });
const run = (answer, ...calls) => ({ answer, calls, mcpCalls: [], files: [] });

/** The link check's lines (its intro aside), or undefined when the prompt has none. */
function checked(prompt) {
  const at = prompt.indexOf("<link-check untrusted>\n");
  if (at < 0) return undefined;
  return prompt.slice(at, prompt.indexOf("\n</link-check>", at)).split("\n").slice(2);
}

const G2 = "https://www.g2.com/products/posthog/reviews";

test("a cited link with a query matches a call's url whose query values the timeline elided, with the same keys only", () => {
  const prompt = graderInput(grader, "task", run(`Reviews: ${G2}?_l=en&order=most_recent and ${G2}?_l=en&sort=recent.`, read, search(`${G2}?_l=…&order=…`)));
  assert.deepEqual(checked(prompt), [`${G2}?_l=…&order=… — matches call 2`, `${G2}?_l=…&sort=… — no matching call`]);
  // The block sits next to the calls, after them.
  assert.ok(prompt.indexOf("</tool-calls>") < prompt.indexOf("<link-check untrusted>"));
});

test("a fragment, a trailing slash, the query's order and the case of scheme and host never stop a match; a different path, host, key or value does", () => {
  const answer = [
    "https://vendor.example/a/b/?y=2&x=1#pricing",
    "https://vendor.example/a/c?x=1&y=2",
    "https://other.example/a/b?x=1&y=2",
    "https://vendor.example/a/b?x=1&y=3",
    "https://vendor.example/a/b?x=1",
    "https://vendor.example/docs#install",
  ].join("\n");
  const lines = checked(graderInput(grader, "task", run(answer, search("https://vendor.example/a/b?x=1&y=2", "https://vendor.example/docs/"))));
  assert.deepEqual(lines, [
    "https://vendor.example/a/b/?y=…&x=… — matches call 1",
    "https://vendor.example/a/c?x=…&y=… — no matching call",
    "https://other.example/a/b?x=…&y=… — no matching call",
    "https://vendor.example/a/b?x=…&y=… — no matching call",
    "https://vendor.example/a/b?x=… — no matching call",
    "https://vendor.example/docs — matches call 1",
  ]);
  // The same link twice, once in upper case: one line.
  const cased = checked(graderInput(grader, "task", run("HTTPS://Vendor.Example/a/b?x=1&y=2 and https://vendor.example/a/b?y=2&x=1", search("https://vendor.example/a/b?x=1&y=2"))));
  assert.deepEqual(cased, ["HTTPS://Vendor.Example/a/b?x=…&y=… — matches call 1"]);
});

test("a fetch's asked url, its final url and its page's links all match; a page whose links were cut is named on a link that matches nothing", () => {
  const moved = fetch("http://vendor.example/old", { url: "https://vendor.example/new", links: ["https://vendor.example/blog/post-1"] });
  const cut = fetch("https://news.example/", { links: ["https://news.example/a"], links_cut: 40 });
  const answer = "Sources: http://vendor.example/old, https://vendor.example/new, https://vendor.example/blog/post-1, https://news.example/z, https://news.example/a";
  assert.deepEqual(checked(graderInput(grader, "task", run(answer, read, moved, cut))), [
    "http://vendor.example/old — matches call 2",
    "https://vendor.example/new — matches call 2",
    "https://vendor.example/blog/post-1 — matches call 2",
    "https://news.example/z — no matching call (call 3's links were cut)",
    "https://news.example/a — matches call 3",
  ]);
  const twice = checked(graderInput(grader, "task", run("https://elsewhere.example/x", cut, read, cut)));
  assert.deepEqual(twice, ["https://elsewhere.example/x — no matching call (calls 1 and 3's links were cut)"]);
});

test("a link a fetched JSON page holds (a Statuspage incident's shortlink) matches when the answer cites it, that fetch the only call", async () => {
  const { fakeFetch } = await import("../dist/web-fake.js");
  const url = "https://www.githubstatus.com/api/v2/incidents.json";
  const fixture = { search: { answers: [], default: { results: [] } }, fetch: { answers: [{ url, text: JSON.stringify({ incidents: [{ name: "Degraded Actions", shortlink: "https://stspg.io/abc" }] }) }], default: { error: "fetch failed" } } };
  const page = await fakeFetch(fixture, url);
  const fetched = { tool: "web_fetch", name: "web_fetch", arguments: { url }, status: "success", result: JSON.stringify(page) };
  assert.deepEqual(checked(graderInput(grader, "task", run("GitHub Actions is degraded: https://stspg.io/abc.", fetched))), ["https://stspg.io/abc — matches call 1"]);
});

test("a link a fetched Atom feed holds (a GitHub release's entry link) matches when the answer cites it, that fetch the only call", async () => {
  const { fakeFetch } = await import("../dist/web-fake.js");
  const url = "https://github.com/vitejs/vite/releases.atom";
  const atom = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <entry>\n    <link rel="alternate" type="text/html" href="https://github.com/vitejs/vite/releases/tag/v8.2.6"/>\n    <title>v8.2.6</title>\n    <content type="html">&lt;a href=&quot;https://github.com/vitejs/vite/pull/123&quot;&gt;#123&lt;/a&gt;</content>\n  </entry>\n</feed>`;
  const fixture = { search: { answers: [], default: { results: [] } }, fetch: { answers: [{ url, text: atom }], default: { error: "fetch failed" } } };
  const fetched = { tool: "web_fetch", name: "web_fetch", arguments: { url }, status: "success", result: JSON.stringify(await fakeFetch(fixture, url)) };
  assert.deepEqual(checked(graderInput(grader, "task", run("Vite shipped https://github.com/vitejs/vite/releases/tag/v8.2.6 this week.", fetched))), ["https://github.com/vitejs/vite/releases/tag/v8.2.6 — matches call 1"]);
});

test("a Slack-style link (<url|text>) cited in the answer is its URL alone, and matches the call that returned it", () => {
  const prompt = graderInput(grader, "task", run("Pricing lives on <https://stripe.com/products|Products>.", search("https://stripe.com/products")));
  assert.deepEqual(checked(prompt), ["https://stripe.com/products — matches call 1"]);
});

test("a link a tool other than the web's returned whole (a calendar event's htmlLink) matches when the answer cites it, that call the only one", () => {
  const htmlLink = "https://www.google.com/calendar/event?eid=bWVldGluZzEyMw";
  const calendar = { tool: "calendar_list_events", name: "calendar_list_events", arguments: { day: "2026-11-16" }, status: "success", result: JSON.stringify({ events: [{ summary: "Pipeline review", start: "2026-11-16T10:00:00Z", htmlLink }] }) };
  assert.deepEqual(checked(graderInput(grader, "task", run(`Pipeline review at 10:00 (${htmlLink}).`, calendar))), ["https://www.google.com/calendar/event?eid=… — matches call 1"]);
});

test("a markdown link's target holding a | is cited whole, as a fetched page's links read it, and matches that page", async () => {
  const { fakeFetch } = await import("../dist/web-fake.js");
  const url = "https://maps.example/guide.md";
  const fixture = { search: { answers: [], default: { results: [] } }, fetch: { answers: [{ url, text: "# Stops\n\n[the route](https://maps.example/?markers=a|b)\n" }], default: { error: "fetch failed" } } };
  const fetched = { tool: "web_fetch", name: "web_fetch", arguments: { url }, status: "success", result: JSON.stringify(await fakeFetch(fixture, url)) };
  assert.deepEqual(checked(graderInput(grader, "task", run("Follow [the route](https://maps.example/?markers=a|b).", fetched))), ["https://maps.example/?markers=… — matches call 1"]);
});

test("a tool other than the web's whose result the read cut is named on a cited link that matches nothing, as a page whose links were cut is", async () => {
  const { cut, CALL_RESULT_CHARS } = await import("../dist/timeline/index.js");
  const [first, later] = ["https://www.google.com/calendar/event?eid=Zmlyc3Q", "https://www.google.com/calendar/event?eid=bGF0ZXI"];
  const events = [{ summary: "Standup", htmlLink: first }, ...Array.from({ length: 200 }, (_, i) => ({ summary: `Event ${i}`, description: "words ".repeat(10) })), { summary: "Retro", htmlLink: later }];
  const result = cut(JSON.stringify({ events }), CALL_RESULT_CHARS);
  assert.ok(result.includes(first) && !result.includes(later));
  const calendar = { tool: "calendar_list_events", name: "calendar_list_events", arguments: {}, status: "success", result };
  assert.deepEqual(checked(graderInput(grader, "task", run(`Standup: ${first}\nRetro: ${later}`, calendar))), [
    "https://www.google.com/calendar/event?eid=… — matches call 1",
    "https://www.google.com/calendar/event?eid=… — no matching call (call 1's links were cut)",
  ]);
  // A result the read did not cut names no cut.
  const whole = { ...calendar, result: JSON.stringify({ events: [events[0]] }) };
  assert.deepEqual(checked(graderInput(grader, "task", run(`Retro: ${later}`, whole))), ["https://www.google.com/calendar/event?eid=… — no matching call"]);
});

test("cited links come from the answer's text and every string of its JSON, each once, shown with no query value, fragment or userinfo", () => {
  const key = ["not-a-secret", "cited", "0123456789"].join("-");
  const json = JSON.stringify({ sources: [{ url: "https://vendor.example/report" }, { url: `https://api.example/data?token=${key}&q=x` }], note: "see https://vendor.example/report#p2" }).replaceAll("/", "\\/");
  // A link with userinfo, made at runtime: no credential-shaped literal for the source export.
  const signedIn = new URL("https://vendor.example/private");
  [signedIn.username, signedIn.password] = ["me", key];
  const answer = `Read [the report](https://vendor.example/report). Also ${signedIn.href}.\n\n\`\`\`json\n${json}\n\`\`\``;
  const prompt = graderInput(grader, "task", run(answer, search("https://vendor.example/report")));
  assert.deepEqual(checked(prompt), [
    "https://vendor.example/report — matches call 1",
    "https://vendor.example/private — no matching call",
    "https://api.example/data?token=…&q=… — no matching call",
  ]);
  assert.equal(prompt.slice(prompt.indexOf("<link-check")).includes(key), false);
  // An answer that cites nothing says so; a link with a closing bracket of its own keeps it.
  assert.deepEqual(checked(graderInput(grader, "task", run("No sources found.", search("https://vendor.example/")))), ["(the answer cites no http(s) link)"]);
  assert.deepEqual(checked(graderInput(grader, "task", run("(see https://en.example/wiki/Foo_(bar)).", search("https://en.example/wiki/Foo_(bar)")))), ["https://en.example/wiki/Foo_(bar) — matches call 1"]);
});

test("a URL that ends in punctuation or holds an apostrophe matches whole; punctuation around a link in a sentence never stops a match", () => {
  const calls = search("https://en.example/wiki/Yahoo!", "https://en.example/wiki/O'Reilly_Media", "https://vendor.example/a");
  const json = JSON.stringify({ sources: ["https://en.example/wiki/O'Reilly_Media", "https://en.example/wiki/Yahoo!"] });
  const answer = `Yahoo: https://en.example/wiki/Yahoo!. See https://vendor.example/a. Quoted: 'https://vendor.example/a', and https://vendor.example/zz).\n\n\`\`\`json\n${json}\n\`\`\``;
  assert.deepEqual(checked(graderInput(grader, "task", run(answer, calls))), [
    "https://en.example/wiki/Yahoo! — matches call 1",
    "https://vendor.example/a — matches call 1",
    "https://vendor.example/zz — no matching call",
    "https://en.example/wiki/O'Reilly_Media — matches call 1",
  ]);
  // A JSON field that is one URL, and a markdown link's target, are taken whole: a different path never matches.
  const exact = checked(graderInput(grader, "task", run("See [the report](https://vendor.example/a!).", calls)));
  assert.deepEqual(exact, ["https://vendor.example/a! — no matching call"]);
  const fielded = checked(graderInput(grader, "task", run(JSON.stringify({ url: "https://vendor.example/a." }), calls)));
  assert.deepEqual(fielded, ["https://vendor.example/a. — no matching call"]);
  // An apostrophe before the query never lets a value through.
  const key = ["not-a-secret", "quoted", "0123456789"].join("-");
  const quoted = graderInput(grader, "task", run(`https://vendor.example/O'Reilly?token=${key}`, calls));
  assert.deepEqual(checked(quoted), ["https://vendor.example/O'Reilly?token=… — no matching call"]);
  assert.equal(quoted.slice(quoted.indexOf("<link-check")).includes(key), false);
});

test("a run with no web_search or web_fetch call is graded on the prompt it always was, with no link check", () => {
  const bash = { tool: "bash", name: "bash", arguments: { command: "ls" }, status: "success", result: "notes.md" };
  const prompt = graderInput(grader, "task", run("See https://vendor.example/a", bash));
  assert.equal(prompt, ["Grade this run against the rubric.", `<rubric>\n${grader.rubric}\n</rubric>`, "<task untrusted>\ntask\n</task>", "<answer untrusted>\nSee https://vendor.example/a\n</answer>", '<tool-calls untrusted>\n1. bash {"command":"ls"} -> success: notes.md\n</tool-calls>'].join("\n\n"));
});

test("the link check counts against the prompt's cap: the calls give way, the check stays whole", () => {
  const long = search(...Array.from({ length: 30 }, (_, i) => `https://vendor.example/story-${i}?ref=${"r".repeat(200)}`));
  const answer = `https://vendor.example/story-29?ref=${"r".repeat(200)}`;
  const prompt = graderInput(grader, "task", run(answer, long, long), 6_000);
  assert.ok(prompt.length <= 6_000, String(prompt.length));
  assert.deepEqual(checked(prompt), ["https://vendor.example/story-29?ref=… — matches call 1"]);
});
