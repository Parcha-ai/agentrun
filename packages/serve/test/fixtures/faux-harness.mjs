// The faux harness's script for serve's tests: one action per paid request, across the session's turns, by what the
// agent's instructions say. The script is read again at every open, so what a later process does can depend on a file.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

/** Told the options the harness's own adapter would be built with (serve's adapters.ts): filed, for a test to see. */
export function opened(harness, options) {
  if (process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED) appendFileSync(process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED, `${JSON.stringify({ harness, options })}\n`);
}

/** An answer of 3,000 characters, longer than the 2,000 a run's summary keeps; its end says it was not cut. */
export const LONG_ANSWER = `${"The long answer goes on. ".repeat(119)}The end.`;

/** The faux harness's `{ cut: true }` (a request admitted, never answered) that writes `signal` the moment the request is
 *  admitted: the faux adapter asks whether an action is a cut right after the request's beforeRequest has passed (and
 *  asks "hang" and "halt" before it), so the file exists only once the session holds the request. */
const cutSignalled = (signal) => new Proxy({ cut: true }, { has(target, key) { if (key === "cut") writeFileSync(signal, ""); return key in target; } });
/** The faux harness's `{ cutBooked: true }` (a request held until the turn is stopped, then booked at `usd`) that writes
 *  `signal` once the request is admitted, as cutSignalled does. */
const cutBookedSignalled = (signal, usd) => new Proxy({ cutBooked: true, usd }, { has(target, key) { if (key === "cutBooked") writeFileSync(signal, ""); return key in target; } });

export function script(spec) {
  const text = spec.system.join("\n");
  if (process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED) appendFileSync(process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED, `${JSON.stringify({ tools: spec.tools.map((tool) => tool.name) })}\n`);
  // A research turn: the session's web_search when it has one as a tool (its harness's own search is not one), then the
  // page with web_fetch, then report.md citing it.
  const research = /Research (.+?) on the web, read (\S+) and write report\.md\./.exec(text);
  if (research) {
    const search = spec.tools.some((tool) => tool.name === "web_search") ? [{ call: "web_search", args: { query: research[1], n: 2 }, usd: 0.001 }] : [];
    return [...search, { call: "web_fetch", args: { url: research[2] }, usd: 0.001 }, { call: "write", args: { path: "report.md", content: `# ${research[1]}\n\nThe answer is forty-two (Public page, ${research[2]}).\n` }, usd: 0.001 }, { say: "Wrote report.md.", usd: 0.001 }];
  }
  // As real harnesses do, a request that goes on calls a tool, and the turn's last request is its answer.
  // One answer that asks for two tools, as a model writing two files in one turn does, then the closing answer.
  if (/Write two files in one answer\./.test(text)) return [{ calls: [{ call: "write", args: { path: "a.md", content: "alpha" } }, { call: "write", args: { path: "b.md", content: "beta" } }], usd: 0.001 }, { say: "Wrote a.md and b.md.", usd: 0.002 }];
  if (/Make three requests\./.test(text)) return [{ call: "read", args: { path: "a.txt" }, usd: 0.001 }, { call: "read", args: { path: "b.txt" }, usd: 0.002 }, { say: "Read it.", usd: 0.004 }];
  if (/Write then read\./.test(text)) return [{ call: "write", args: { path: "note.txt", content: "hello from the tool" }, usd: 0.001 }, { call: "read", args: { path: "note.txt" }, usd: 0.001 }, { say: "Read back.", usd: 0.001 }];
  // Paths at the workspace's edge: one out of it, a file that is not there, then a write into it.
  if (/Touch the edges\./.test(text)) return [{ call: "write", args: { path: "../escape.md", content: "out" }, usd: 0.001 }, { call: "read", args: { path: "missing.md" }, usd: 0.001 }, { call: "write", args: { path: "sub/ok.md", content: "in" }, usd: 0.001 }, { say: "Touched.", usd: 0.001 }];
  // A read of a link out of the workspace, which the test plants while the turn holds; a crash then resumes the turn.
  const link = /Read the link after (\S+)\./.exec(text)?.[1];
  if (link) return [{ call: "write", args: { path: "first.txt", content: "x" }, usd: 0.001 }, ...(existsSync(link) ? [] : [{ hang: true }]), { call: "read", args: { path: "out.txt" }, usd: 0.001 }, { say: "Tried.", usd: 0.001 }];
  const page = /Fetch (\S+) and say its title(?: with (\w+))?\./.exec(text);
  if (page) return [{ call: page[2] ?? "fetch_page", args: { url: page[1] }, usd: 0.001 }, { say: "Fetched.", usd: 0.001 }];
  const query = /Search the web for (.+?) and say what you found\./.exec(text)?.[1];
  if (query) return [{ call: "web_search", args: { query, n: 3 }, usd: 0.001 }, { say: "Searched.", usd: 0.001 }];
  // Calls each tool the line lists, in order, then says so: `Box calls: [{"call": "bash", "args": {...}}, ...]`. `{work}`
  // in a call names the run's work directory on this machine, the harness's cwd (from AGENTRUN_TEST_DATA, the data root).
  const boxed = /^Box calls: (\[.*\])$/m.exec(text)?.[1];
  const work = `${process.env.AGENTRUN_TEST_DATA}/runs/${spec.key.slice("run:".length)}/work`;
  if (boxed) return [...JSON.parse(boxed.replaceAll("{work}", work)).map((step) => ({ ...step, usd: 0.001 })), { say: "Done in the box.", usd: 0.001 }];
  // monid's run, called as a harness calls it: by its wire name.
  const endpoint = /Run monid's (\S+) on Ada\./.exec(text)?.[1];
  if (endpoint) return [{ call: "monid_run", args: { provider: "faux", endpoint, input: { name: "Ada" } }, usd: 0.001 }, { say: "Ran.", usd: 0.001 }];
  if (/Say your thinking\./.test(text)) return [{ say: `Thinking ${spec.thinking}.`, usd: 0.001 }];
  if (/Price unknown\./.test(text)) return [{ say: "Priced unknown.", usd: null }];
  // One request that costs more than its run's cap allows: a native search's input is held at an allowance, not a bound.
  if (/Overspend\./.test(text)) return [{ call: "read", args: { path: "a.txt" }, usd: 0.5 }, { say: "Not sent.", usd: 0.001 }];
  // A chat whose second turn has a request of unknown price.
  // A follow-up whose turn makes one request and shows nothing, as the Claude CLI's /compact does (a summary request, no
  // text): the turn ends with no answer row after the person's message.
  // F2: a request admitted (the signal file says so) and never answered: the turn holds until it is cancelled.
  const unanswered = /Hold a request unanswered \(signal (\S+)\)\./.exec(text)?.[1];
  if (unanswered) return [cutSignalled(unanswered)];
  // The same, after an answer past the store's 2,000-character summary: the run's answer is the whole of it.
  if (/The second turn answers nothing, after a long answer\./.test(text)) return [{ say: LONG_ANSWER, usd: 0.001 }, { end: true, usd: 0.001 }, { end: true, usd: 0.001 }];
  if (/The second turn answers nothing\./.test(text)) return [{ say: "Answer 1.", usd: 0.001 }, { end: true, usd: 0.001 }, { end: true, usd: 0.001 }];
  // A turn that holds in its own process (fetch_page waits for the file, faux-web-hold.mjs), answers, then answers the
  // follow-up the person sent meanwhile in a turn of its own.
  const held = /Hold the answer until (\S+)\./.exec(text)?.[1];
  if (held) return [{ call: "fetch_page", args: { url: `http://public.example/hold?until=${encodeURIComponent(held)}` }, usd: 0.001 }, { say: "Answer 1.", usd: 0.001 }, { end: true, usd: 0.001 }, { say: "Answer 2.", usd: 0.001 }, { end: true, usd: 0.001 }];
  if (/Second turn unpriced\./.test(text)) return [{ say: "Answer 1.", usd: 0.001 }, { end: true, usd: 0.001 }, { say: "Answer 2.", usd: null }, { end: true, usd: 0.001 }];
  // A turn that waits as below, then a second turn that answers a chat sent while the first one worked.
  const chat = /Wait for (\S+), then answer the chat\./.exec(text)?.[1];
  if (chat) return [{ call: "read", args: { path: "a.txt" }, usd: 0.002 }, ...(existsSync(chat) ? [] : [{ hang: true }]), { say: "Done after the wait.", usd: 0.004 }, { end: true, usd: 0.001 }, { say: "Answered the chat.", usd: 0.001 }, { end: true, usd: 0.001 }];
  const wait = /Wait for (\S+) before the answer\./.exec(text)?.[1];
  if (wait) return [{ call: "read", args: { path: "a.txt" }, usd: 0.002 }, ...(existsSync(wait) ? [] : [{ hang: true }]), { say: "Done after the wait.", usd: 0.004 }];
  // A run's end read from its turn's end, not from its rows (turn-record.test.mjs).
  // One answer asks for two fetches, both fail (no such tool here: the bridge has no result text for them, "The tool
  // failed."), and the turn then ends with no text. `booked late`: the answer's cost comes in after its calls ran, as the
  // Claude CLI's does when a tool ends before its response: the results are written before their calls.
  const fetches = /Fetch two pages at once and both fail( \(booked late\))?, then stop\./.exec(text);
  if (fetches) return [{ calls: [{ call: "web_fetch", args: { url: "http://a.example/" } }, { call: "web_fetch", args: { url: "http://b.example/" } }], usd: 0.001, ...(fetches[1] ? { bookAfter: true } : {}) }, { end: true, usd: 0.001 }];
  // A turn the harness ends interrupted on its own, no stop or cancel asked for it, after a call and no text.
  if (/The turn ends interrupted\./.test(text)) return [{ call: "read", args: { path: "a.txt" }, usd: 0.001 }, { end: true, turn: "interrupted", usd: 0.001 }];
  // A long tool phase: two fetches, each held until its file exists (faux-web-hold.mjs), then the answer.
  const gated = /Fetch the pages held until (\S+) and (\S+)\./.exec(text);
  if (gated) return [1, 2].map((n) => ({ call: "fetch_page", args: { url: `http://public.example/hold?until=${encodeURIComponent(gated[n])}` }, usd: 0.001 })).concat([{ say: "Fetched both.", usd: 0.001 }]);
  // A turn held mid-way (a read, then nothing until the file exists), then its answer: a drain cuts it, the next open resumes it.
  const resumed = /Hold mid-turn until (\S+)\./.exec(text)?.[1];
  if (resumed) return [{ call: "read", args: { path: "a.txt" }, usd: 0.001 }, ...(existsSync(resumed) ? [] : [{ hang: true }]), { say: "Resumed and done.", usd: 0.001 }];
  // A cancel's race: an answer, then a request held unanswered (signal written when it is admitted): the answer's row is in, the turn not over.
  const after = /Answer, then hold a request unanswered \(signal (\S+)\)\./.exec(text)?.[1];
  if (after) return [{ say: "Done.", usd: 0.002 }, cutSignalled(after)];
  // The same with a cap: an answer under the cap, then a request held until the cancel cuts it, booked then at $0.002 (over it).
  const booked = /Answer, then hold a request the cancel cuts and books \(signal (\S+)\)\./.exec(text)?.[1];
  if (booked) return [{ say: "Done.", usd: 0.0005 }, cutBookedSignalled(booked, 0.002)];
  // A request admitted and never answered, until the file exists: a crash then cuts it.
  const cut = /Cut until (\S+)\./.exec(text)?.[1];
  if (cut) return [{ call: "read", args: { path: "a.txt" }, usd: 0.002 }, ...(existsSync(cut) ? [] : [{ cut: true }]), { say: "After the cut.", usd: 0.004 }];
  // A request answered and booked with nothing after it until the file exists: no boundary writes its entry.
  const hold = /Hold until (\S+)\./.exec(text)?.[1];
  if (hold) return [{ say: "Halfway.", usd: 0.002 }, ...(existsSync(hold) ? [] : [{ hang: true }]), { say: "Done holding.", usd: 0.004 }];
  // A chat: each turn says its answer and ends.
  return Array.from({ length: 10 }, (_, i) => [{ say: `Answer ${i + 1}.`, usd: 0.001 }, { end: true, usd: 0.001 }]).flat();
}
