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
/** The faux harness's `{ hang: true }` (the turn holds with no request open, until it is aborted) that writes `signal`
 *  once the turn reaches it: the faux adapter asks whether an action is a hang first, after the request before it has
 *  been booked and has shown its text. */
const hangSignalled = (signal) => new Proxy({ hang: true }, { has(target, key) { if (key === "hang") writeFileSync(signal, ""); return key in target; } });
/** A hang the first time the faux adapter asks (writing `signal` then, as hangSignalled does), and `then` from the next:
 *  the adapter reads the script once per open, and a hang keeps its place, so a turn stopped there and a next turn in the
 *  same process come back to it. */
const hangOnceSignalled = (signal, then) => {
  let held = false;
  return new Proxy(then, { has(target, key) { if (key !== "hang") return key in target; if (held) return false; held = true; writeFileSync(signal, ""); return true; } });
};

/** Request `k` of a conversation that grows by a tool call and its result each request, as Claude Sonnet 5.5 bills it
 *  (faux-sonnet-priced.mjs): a 20,000-token prompt that grows 1,100 tokens a request, its body 4 bytes a token (the
 *  input bound the proxy measures), each request reading the previous one's whole prompt from the cache and writing the
 *  rest, 3 tokens of input after the last breakpoint and 300 of output. `miss`: it finds no cache, its whole prompt
 *  written. */
export function grown(k, { miss = false } = {}) {
  const prompt = (n) => 20_000 + 1_100 * n;
  const cacheRead = k === 0 || miss ? 0 : prompt(k - 1);
  const tokens = { input: 3, output: 300, cacheRead, cacheWrite: prompt(k) - cacheRead - 3 };
  const usd = (tokens.input * 2 + tokens.output * 10 + tokens.cacheRead * 0.2 + tokens.cacheWrite * 2.5) / 1e6;
  return { call: "read", args: { path: "a.txt" }, inputTokensMax: prompt(k) * 4, tokens, usd };
}

export function script(spec) {
  const text = spec.system.join("\n");
  if (process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED) appendFileSync(process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED, `${JSON.stringify({ tools: spec.tools.map((tool) => tool.name) })}\n`);
  // "Use the learned workflow <name> on <question>.": the run's learned_workflow, then a closing answer.
  const learned = /Use the learned workflow (\S+) on (.+?)\./.exec(text);
  if (learned) return [{ call: "learned_workflow", args: { name: learned[1], input: { question: learned[2] } }, usd: 0.001 }, { say: "Ran the learned workflow.", usd: 0.001 }];
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
  // Codex's shape: a request that only says something (its tool call is the harness's own, which the host never
  // sees), then the host's tool, then the answer.
  // The same turn, its first answer empty (only whitespace, which the timeline reads as an empty answer).
  // The same turn, its commentary first, then an empty answer, then the call: every earlier answer is a text_block.
  if (/Comment, say nothing, then write\./.test(text)) return [{ say: "I'll check first.", usd: 0.001 }, { say: " ", usd: 0.001 }, { call: "write", args: { path: "note.md", content: "noted" }, usd: 0.001 }, { say: "Wrote note.md.", usd: 0.001 }];
  if (/Say nothing, then write\./.test(text)) return [{ say: " ", usd: 0.001 }, { call: "write", args: { path: "note.md", content: "noted" }, usd: 0.001 }, { say: "Wrote note.md.", usd: 0.001 }];
  if (/Comment, then write\./.test(text)) return [{ say: "I'll write note.md.", usd: 0.001 }, { call: "write", args: { path: "note.md", content: "noted" }, usd: 0.001 }, { say: "Wrote note.md.", usd: 0.001 }];
  // Reads outside the run: a path up out of its directory, and an absolute one elsewhere, both refused.
  if (/Read outside the run\./.test(text)) return [{ call: "read", args: { path: "../../.token" }, usd: 0.001 }, { call: "read", args: { path: "/etc/hostname" }, usd: 0.001 }, { say: "Read none.", usd: 0.001 }];
  // As the Claude CLI sends a path: absolute, under its working directory, which is the run's work/ (the run's
  // process runs with --dir <run dir>); then one outside the run's directory, which the tool refuses.
  if (/Write by the absolute path\./.test(text)) {
    const runDir = process.argv[process.argv.indexOf("--dir") + 1];
    return [{ call: "write", args: { path: `${runDir}/work/hello.md`, content: "hello" }, usd: 0.001 }, { call: "write", args: { path: "/elsewhere/away.md", content: "x" }, usd: 0.001 }, { say: "Wrote hello.md.", usd: 0.001 }];
  }
  // The same two calls, each ending before its request is paid, as with Claude Code, whose cost comes in after its
  // response: each result is stored before the answer that holds its call.
  if (/Write two files while answering\./.test(text)) return [{ calls: [{ call: "write", args: { path: "a.md", content: "alpha" } }, { call: "write", args: { path: "b.md", content: "beta" } }], usd: 0.001, bookAfter: true }, { say: "Wrote a.md and b.md.", usd: 0.002 }];
  // The spend cap's wrap-up across a crash: a request at $0.30, then the turn holds (writing `<file>.held`) with no
  // request open until `<file>` exists, then answers. A process opened once `<file>` exists answers at once.
  const crashAt = /Wrap up across a crash at (\S+)\./.exec(text)?.[1];
  if (crashAt) return [{ call: "read", args: { path: "a.txt" }, usd: 0.3 }, ...(existsSync(crashAt) ? [] : [hangSignalled(`${crashAt}.held`)]), { say: "Done.", usd: 0.01 }];
  // Claude Code on Sonnet 4.5 (faux-sonnet45.mjs): each request asks the CLI's own max_tokens, 32,000. "at its start": a
  // 25,000-token first prompt, then one more request. "on a small cap": a 5,000-token prompt, a $0.01 request and one more.
  // "restarts before the note at <file>": a 5,000-token prompt, a $0.04 request, then a hold (writing `<file>.held`) with
  // no request open until `<file>` exists, then one more request.
  const cc = (inputTokensMax, usd, say) => ({ say, inputTokensMax, outputTokensAsked: 32_000, usd });
  if (/Claude Code at its start\./.test(text)) return [cc(25_000, 0.03, "Working."), cc(26_000, 0.03, "Done.")];
  if (/Claude Code on a small cap\./.test(text)) return [cc(5_000, 0.01, "Working."), cc(5_200, 0.01, "Done.")];
  const restartAt = /Claude Code restarts before the note at (\S+)\./.exec(text)?.[1];
  if (restartAt) return [cc(5_000, 0.04, "Working."), ...(existsSync(restartAt) ? [] : [hangSignalled(`${restartAt}.held`)]), cc(5_200, 0.01, "Done.")];
  // The wrap-up due after a $0.40 request, then an answer whose input (5,990 tokens, $0.599 on input-priced faux) fits
  // what is left of a $1 cap only without the note's bytes.
  if (/Wrap up with no room for the note\./.test(text)) return [{ call: "read", args: { path: "a.txt" }, usd: 0.4 }, { say: "Answered.", inputTokensMax: 5_990, usd: 0.01 }];
  // The wrap-up due after a $0.40 request; the next request, which takes the note, has a side call admitted and answered
  // between that take and its own admission; then one request more.
  if (/Wrap up with a side call in between\./.test(text)) return [{ call: "read", args: { path: "a.txt" }, usd: 0.4 }, { call: "read", args: { path: "b.txt" }, usd: 0.01, sideAfterNote: { usd: 0.0001 } }, { say: "Done.", usd: 0.01 }];
  // The wrap-up due only after a turn's one request ($0.40): the next turn's first request is the first that can take it.
  if (/Wrap up in the next turn\./.test(text)) return [{ end: true, usd: 0.4 }, { say: "Second.", usd: 0.01 }];
  if (/Make three requests\./.test(text)) return [{ call: "read", args: { path: "a.txt" }, usd: 0.001 }, { call: "read", args: { path: "b.txt" }, usd: 0.002 }, { say: "Read it.", usd: 0.004 }];
  // Reads a file the run was given (an upload, copied into its inputs/), then says so.
  const upload = /Read the upload (\S+)\./.exec(text)?.[1];
  if (upload) return [{ call: "read", args: { path: upload }, usd: 0.001 }, { say: "Read the upload.", usd: 0.001 }];
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
  // The turn fails on its first request with the line's text, as a harness passes on a provider's error: `Fail with: <text>`.
  const failWith = /^Fail with: (.*)$/m.exec(text)?.[1];
  if (failWith) return [{ fail: failWith }];
  // Calls each tool the line lists, in order, then says so: `Box calls: [{"call": "bash", "args": {...}}, ...]`. `{work}`
  // in a call names the run's work directory on this machine, the harness's cwd (its run's folder, the --dir it was given).
  const boxed = /^Box calls: (\[.*\])$/m.exec(text)?.[1];
  const work = `${process.argv[process.argv.indexOf("--dir") + 1]}/work`;
  if (boxed) return [...JSON.parse(boxed.replaceAll("{work}", work)).map((step) => ({ ...step, usd: 0.001 })), { say: "Done in the box.", usd: 0.001 }];
  // monid's run called, then the turn holds with no request open (writing the signal) until it is stopped; the next
  // turn's request answers. A hold keeps its place in the script, so it holds once, and that place is the answer after.
  const holdSignal = /Run monid's \/person\/enrich, then hold the turn \(signal (\S+)\)\./.exec(text)?.[1];
  if (holdSignal) return [{ call: "monid_run", args: { provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } }, usd: 0.001 }, hangOnceSignalled(holdSignal, { say: "Ran.", usd: 0.001 })];
  // monid's run called, then called again (once a raised cap's follow-up opens the next turn), then the answer.
  if (/Run monid's \/person\/enrich, called again after a raise\./.test(text)) {
    const call = { call: "monid_run", args: { provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } }, usd: 0.001 };
    return [call, call, { say: "Ran.", usd: 0.001 }];
  }
  // monid's run, called as a harness calls it: by its wire name.
  const endpoint = /Run monid's (\S+) on Ada\./.exec(text)?.[1];
  if (endpoint) return [{ call: "monid_run", args: { provider: "faux", endpoint, input: { name: "Ada" } }, usd: 0.001 }, { say: "Ran.", usd: 0.001 }];
  if (/Say your thinking\./.test(text)) return [{ say: `Thinking ${spec.thinking}.`, usd: 0.001 }];
  if (/Price unknown\./.test(text)) return [{ say: "Priced unknown.", usd: null }];
  // A first request that costs the amount the line names, then an answer: a cap that leaves too little after the first
  // refuses the second.
  const spend = /Spend (\d+\.\d+) on the first request\./.exec(text)?.[1];
  if (spend) return [{ call: "read", args: { path: "a.txt" }, usd: Number(spend) }, { say: "Not sent.", usd: 0.001 }];
  // One request that costs more than its run's cap allows: a native search's input is held at an allowance, not a bound.
  if (/Overspend\./.test(text)) return [{ call: "read", args: { path: "a.txt" }, usd: 0.5 }, { say: "Not sent.", usd: 0.001 }];
  // F2: a request admitted (the signal file says so) and never answered: the turn holds until it is cancelled.
  const unanswered = /Hold a request unanswered \(signal (\S+)\)\./.exec(text)?.[1];
  if (unanswered) return [cutSignalled(unanswered)];
  // An answer, then one more request that says nothing (at $0.001, or at the price named), and the turn holds with no
  // request open until it is cancelled. The second request's start writes the answer's entry, so the answer's row is in
  // while the turn works; the second request's entry waits for the turn's end.
  const answered = /Answer, then hold the turn(?: after a request at \$(\S+))? \(signal (\S+)\)\./.exec(text);
  if (answered) return [{ say: "Done.", usd: 0.001 }, { say: "", usd: answered[1] === undefined ? 0.001 : Number(answered[1]) }, hangSignalled(answered[2])];
  // An answer, then one more request that says nothing (its start writes the answer's entry), then the turn holds with
  // no request open until the file exists, writing the signal when it reaches the hold; then it ends with a request that
  // shows nothing. A process killed in the hold leaves the answer on the root and the turn open: the next one recovers it.
  const saved = /Answer, then hold until (\S+) \(signal (\S+)\), then end showing nothing\./.exec(text);
  if (saved) return [{ say: "Saved answer.", usd: 0.001 }, { say: "", usd: 0.001 }, ...(existsSync(saved[1]) ? [] : [hangSignalled(saved[2])]), { end: true, usd: 0.001 }];
  // A follow-up whose turn makes one request and shows nothing, as the Claude CLI's /compact does (a summary request, no
  // text): the turn ends with no answer row after the person's message. The first, after an answer past the store's
  // 2,000-character summary, which the run reads whole.
  if (/The second turn answers nothing, after a long answer\./.test(text)) return [{ say: LONG_ANSWER, usd: 0.001 }, { end: true, usd: 0.001 }, { end: true, usd: 0.001 }];
  if (/The second turn answers nothing\./.test(text)) return [{ say: "Answer 1.", usd: 0.001 }, { end: true, usd: 0.001 }, { end: true, usd: 0.001 }];
  // A turn that holds in its own process (fetch_page waits for the file, faux-web-hold.mjs), answers, then answers the
  // follow-up the person sent meanwhile in a turn of its own.
  const held = /Hold the answer until (\S+)\./.exec(text)?.[1];
  if (held) return [{ call: "fetch_page", args: { url: `http://public.example/hold?until=${encodeURIComponent(held)}` }, usd: 0.001 }, { say: "Answer 1.", usd: 0.001 }, { end: true, usd: 0.001 }, { say: "Answer 2.", usd: 0.001 }, { end: true, usd: 0.001 }];
  // A chat whose second turn has a request of unknown price.
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
  // A turn held on a fetch until the file exists, so a follow-up waits its place; then each turn answers. A third turn
  // answers too, so a follow-up sent twice shows.
  const queuedBehind = /Queue a follow-up behind a turn held until (\S+)\./.exec(text)?.[1];
  if (queuedBehind) return [{ call: "fetch_page", args: { url: `http://public.example/hold?until=${encodeURIComponent(queuedBehind)}` }, usd: 0.001 }, { say: "Answer 1.", usd: 0.001 }, { end: true, usd: 0.001 }, { say: "Answer 2.", usd: 0.001 }, { end: true, usd: 0.001 }, { say: "Answer 2, sent again.", usd: 0.001 }, { end: true, usd: 0.001 }];
  // A turn held on a fetch until the file exists, so a follow-up waits its place; the turn then fails (its next request
  // does), and the follow-up's turn answers.
  const failedBehind = /Fail a turn held until (\S+), with a follow-up behind it\./.exec(text)?.[1];
  if (failedBehind) return [{ call: "fetch_page", args: { url: `http://public.example/hold?until=${encodeURIComponent(failedBehind)}` }, usd: 0.001 }, { fail: "the faux turn failed" }, { say: "Answer 2.", usd: 0.001 }, { end: true, usd: 0.001 }];
  // The same with a cap: an answer under the cap, then a request held until the cancel cuts it, booked then at $0.002 (over it).
  const booked = /Answer, then hold a request the cancel cuts and books \(signal (\S+)\)\./.exec(text)?.[1];
  if (booked) return [{ say: "Done.", usd: 0.0005 }, cutBookedSignalled(booked, 0.002)];
  // A request admitted and never answered, until the file exists: a crash then cuts it.
  const cut = /Cut until (\S+)\./.exec(text)?.[1];
  if (cut) return [{ call: "read", args: { path: "a.txt" }, usd: 0.002 }, ...(existsSync(cut) ? [] : [{ cut: true }]), { say: "After the cut.", usd: 0.004 }];
  // A request answered and booked with nothing after it until the file exists: no boundary writes its entry.
  const hold = /Hold until (\S+)\./.exec(text)?.[1];
  if (hold) return [{ say: "Halfway.", usd: 0.002 }, ...(existsSync(hold) ? [] : [{ hang: true }]), { say: "Done holding.", usd: 0.004 }];
  // A growing conversation whose requests read the cache (grown), 80 of them: a cap pauses it on the way. "..., missing
  // the cache at request N until F.": request N finds no cache and is held in flight until the file F exists. "..., cut
  // at request 1 until F.": a crash cuts request 1 until F exists; then an answer as large as request 2's.
  const growing = /Grow a cached context(?:, missing the cache at request (\d+) until (\S+)|, cut at request 1 until (\S+))?\./.exec(text);
  if (growing) {
    const [, missAt, missUntil, cutUntil] = growing;
    if (cutUntil) return [grown(0), ...(existsSync(cutUntil) ? [] : [{ ...grown(1), cut: true }]), { say: "After the cut.", inputTokensMax: grown(2).inputTokensMax, tokens: grown(2).tokens, usd: grown(2).usd }];
    return Array.from({ length: 80 }, (_, k) => (missAt !== undefined && k === Number(missAt) ? { ...grown(k, { miss: true }), until: missUntil } : grown(k)));
  }
  // Request 2 answers before its cost is booked (only once the file exists: a provider whose usage comes after its
  // answer, and a process gone before it did), then a next turn's request.
  const bookWhen = /Grow, then answer with its cost booked when (\S+) exists\./.exec(text)?.[1];
  if (bookWhen) {
    const second = grown(1);
    // The next turn's request only in a process opened once `<file>.next` exists (the script is read at each open).
    const next = existsSync(`${bookWhen}.next`) ? [{ say: "Second turn.", inputTokensMax: grown(2).inputTokensMax, tokens: grown(2).tokens, usd: grown(2).usd }] : [];
    return [grown(0), { say: "Answered.", inputTokensMax: second.inputTokensMax, tokens: second.tokens, usd: second.usd, bookWhen }, ...next];
  }
  // A chat: each turn says its answer and ends.
  return Array.from({ length: 10 }, (_, i) => [{ say: `Answer ${i + 1}.`, usd: 0.001 }, { end: true, usd: 0.001 }]).flat();
}
