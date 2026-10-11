// The one-completion decoder (mode "lazy") against the three-completion decoder (mode "grammar") on recorded model turns, through a deterministic fake model that speaks both request styles
// (stop strings, token limits, max tokens): the same parsed call, byte for byte, the same turn text, and one completion where there were three.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LimitTracker } from "../../04-walks-home/tab/src/limits.ts";
import { decodeTurn, llamaServer, type Backend, type CompleteRequest, type CompleteResult } from "../tab/decode.ts";
import { callGrammar, renderPrompt, TOOLS } from "../tab/tool-format.ts";

const MARKER = "<start_of_turn>model\n";
const OPTS = { thinkTokens: 12, answerTokens: 30, callTokens: 60, tools: TOOLS };
const prompt = renderPrompt(TOOLS, [{ role: "user", content: "Write hello.js that prints hi, then run it." }]);

/** A recorded turn: the model's whole text, and what it writes if its thinking is cut and closed for it. */
interface Recorded { name: string; text: string; afterForcedClose?: string }

/** A model that would write `rec.text` from the start of the turn, token = a word with its trailing space. */
function fakeModel(rec: Recorded): { backend: Backend; requests: CompleteRequest[] } {
  const requests: CompleteRequest[] = [];
  const backend: Backend = {
    async complete(req): Promise<CompleteResult> {
      requests.push(req);
      const at = req.prompt.lastIndexOf(MARKER);
      const prefix = req.prompt.slice(at + MARKER.length);
      // from the recorded turn; or, when the thinking was cut and closed for the model, from what it writes after that close (whatever of it the prefix already holds is skipped)
      const closed = prefix.indexOf("</thinking>\n");
      const rest = rec.text.startsWith(prefix) ? rec.text.slice(prefix.length) : rec.afterForcedClose !== undefined && closed >= 0 ? rec.afterForcedClose.slice(prefix.length - (closed + "</thinking>\n".length)) : "";
      const tracker = new LimitTracker(req.limits);
      let text = "", tokens = 0;
      // a token is a word with its trailing space; the tags and the newline are tokens of their own, as in the real vocabulary
      for (const chunk of rest.match(/<\/?tool_call>|<\/?thinking>|\n|\S+ ?|\s/g) ?? []) {
        if (tokens >= req.maxTokens) return { text, stoppedBy: "length", promptTokens: 1, outputTokens: tokens };
        text += chunk;
        tokens++;
        for (const stop of req.stop ?? []) {
          const i = text.indexOf(stop);
          if (i >= 0) return { text: text.slice(0, i), stoppedBy: "stop", promptTokens: 1, outputTokens: tokens };
        }
        const capped = tracker.push(text, tokens);
        if (capped >= 0) return { text, stoppedBy: "length", capped, promptTokens: 1, outputTokens: tokens };
      }
      return { text, stoppedBy: "eog", promptTokens: 1, outputTokens: tokens };
    },
  };
  return { backend, requests };
}

const CALL = (name: string, args: unknown) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
const RECORDED: Recorded[] = [
  // three real turns from the Chrome run with the 71% model
  { name: "write (recorded)", text: "<thinking>I'll create hello.js to print hi, then run it to verify the output.</thinking>\n<tool_call>{\"name\":\"write\",\"arguments\":{\"path\":\"hello.js\",\"content\":\"console.log(\\\"hi\\\");\\n\"}}</tool_call>" },
  { name: "bash (recorded)", text: "<thinking>I'll run hello.js once to confirm it prints the requested text.</thinking>\n<tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"node hello.js\"}}</tool_call>" },
  { name: "answer (recorded)", text: "<thinking>The script ran and printed hi, so the requested task is complete.</thinking>\nCreated hello.js; running it printed hi." },
  { name: "edit with an edits array", text: `<thinking>Fix the text.</thinking>\n${CALL("edit", { path: "a.js", edits: [{ oldText: "x", newText: "y" }, { oldText: "p", newText: "q" }] })}` },
  { name: "a string argument that contains the closing tag", text: `<thinking>Write it.</thinking>\n${CALL("write", { path: "t.txt", content: "a </tool_call> b" })}` },
  { name: "text before the call", text: `<thinking>Plan.</thinking>\nLet me look first.\n${CALL("read", { path: "a.js" })}` },
  { name: "the turn ends inside its thinking", text: "<thinking>I am thinking and then the turn ends" },
  { name: "thinking cut by its cap, the model then calls", text: `<thinking>${"one ".repeat(40)}`, afterForcedClose: `${CALL("bash", { command: "ls" })}` },
  { name: "thinking cut by its cap, the model then answers", text: `<thinking>${"two ".repeat(40)}`, afterForcedClose: "Nothing to do." },
  { name: "an answer that runs past its cap", text: `<thinking>Fine.</thinking>\n${"word ".repeat(80)}` },
  { name: "a call body that runs away", text: `<thinking>Write.</thinking>\n<tool_call>{"name":"write","arguments":{"path":"x","content":"${"zz ".repeat(120)}` },
];

for (const rec of RECORDED) {
  test(`one completion decodes the same turn as three: ${rec.name}`, async () => {
    const three = fakeModel(rec);
    const one = fakeModel(rec);
    const g = await decodeTurn(three.backend, prompt, { mode: "grammar", ...OPTS });
    const l = await decodeTurn(one.backend, prompt, { mode: "lazy", ...OPTS });
    assert.deepEqual(l.parsed, g.parsed, "the same parsed turn");
    if (g.parsed.call) assert.equal(JSON.stringify(l.parsed.call), JSON.stringify(g.parsed.call), "the call is byte-identical");
    assert.equal(l.raw, g.raw, "the same turn text");
    assert.equal(l.thinkingCut, g.thinkingCut);
    assert.equal(l.cut, g.cut, "cut at the same place");
    assert.equal(l.calls, g.thinkingCut ? 2 : 1, "one completion (two when the thinking was cut)");
    assert.ok(g.calls >= 1 && g.calls <= 3, `the three-completion path made ${g.calls}`);
  });
}

test("the lazy request carries the grammar with the trigger word at its root, the lazy trigger, and the three limits", async () => {
  const m = fakeModel(RECORDED[0]!);
  await decodeTurn(m.backend, prompt, { mode: "lazy", ...OPTS });
  const req = m.requests[0]!;
  assert.equal(req.prompt.endsWith(`${MARKER}<thinking>`), true, "it asks from the opened thinking");
  assert.equal(req.grammar, callGrammar(TOOLS, { withOpen: true }));
  assert.match(req.grammar!, /^root ::= "<tool_call>" \(/);
  assert.deepEqual(req.lazy, { trigger: "<tool_call>" });
  assert.deepEqual(req.limits, [{ start: null, end: "</thinking>", tokens: 12 }, { start: "</thinking>", end: "<tool_call>", tokens: 31 }, { start: "<tool_call>", end: "</tool_call>", tokens: 60 }]);
  assert.equal(req.maxTokens, 12 + 30 + 60);
});

test("what follows </thinking> in the recorded turns is exactly a newline (the format's own byte)", () => {
  for (const rec of RECORDED) {
    const at = rec.text.indexOf("</thinking>");
    if (at < 0) continue;
    assert.match(rec.text.slice(at + 11), /^\n(?!\s)/, rec.name);
  }
});

test("llamaServer streams a lazy request: sends grammar_lazy and the trigger, reads the events, and stops at a limit", async () => {
  let sent: Record<string, unknown> = {};
  const events = ["<thinking>", "a ", "b ", "c ", "d "].map((c) => `data: ${JSON.stringify({ content: c })}\n\n`);
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body);
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(e)); c.enqueue(enc.encode(`data: ${JSON.stringify({ content: "", stop: true, stop_type: "eos", timings: { prompt_n: 3, predicted_n: 5 } })}\n\n`)); c.close(); } }), { status: 200 });
  }) as unknown as typeof fetch;
  const backend = llamaServer("http://x", { temperature: 0.2 }, fakeFetch);
  const r = await backend.complete({ prompt: "P", maxTokens: 99, grammar: "root ::= x", lazy: { trigger: "<tool_call>" }, limits: [{ start: null, end: "</thinking>", tokens: 3 }] });
  assert.equal(sent.grammar_lazy, true);
  assert.deepEqual(sent.grammar_triggers, [{ type: 1, value: "<tool_call>" }]);
  assert.equal(sent.stream, true);
  assert.equal(r.stoppedBy, "length");
  assert.equal(r.capped, 0);
  assert.equal(r.text, "<thinking>a b ");
});
