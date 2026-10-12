// The beat as the audience reads it: one entry per thing that happened, time since the start, who or what, and the words.
// The edited model's thinking prints sentence by sentence as the guard releases it; its answer prints when the turn is
// checked. The run's full record stays in timeline.jsonl.
type Data = Record<string, any>;

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
// a sentence ends at . ! or ? followed by space, or at a blank line
const SENTENCE_END = /[.!?]["')\]*_]*\s+|\n\s*\n/g;
const BETWEEN_SENTENCES = /(?<=[.!?]["')\]*_]*)\s+|\n\s*\n/;

export function createStageView(write: (line: string) => void, o: { color?: boolean; width?: number } = {}) {
  const width = o.width ?? 200;
  const dim = (s: string) => (o.color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (o.color ? `\x1b[1m${s}\x1b[0m` : s);
  let thinking = "";
  let thinkingAt = 0;
  // long words wrap under the text, so an answer is read whole
  const line = (t: number, who: string, text: string, style: (s: string) => string = (s) => s) => {
    const rows: string[] = [];
    let row = "";
    for (const word of text.replace(/\s*\n\s*/g, " ").trim().split(" ")) {
      if (row && row.length + 1 + word.length > width) {
        rows.push(row);
        row = word;
      } else row = row ? `${row} ${word}` : word;
    }
    rows.push(row);
    rows.forEach((r, i) => write(`${i === 0 ? `${clock(t).padStart(6)}  ${who.padEnd(9)}` : " ".repeat(17)} ${style(r)}`));
  };
  const flushThinking = (all: boolean) => {
    let end = 0;
    for (const m of thinking.matchAll(SENTENCE_END)) end = m.index! + m[0].length;
    if (all) end = thinking.length;
    // a list's number on a line of its own ("... that:\n1.") goes to the start of the item it numbers; a sentence that
    // ends in a number ("The answer is 42.") keeps it
    let carry = "";
    for (const piece of thinking.slice(0, end).split(BETWEEN_SENTENCES).map((x) => x.trim()).filter(Boolean)) {
      const marker = /(?:^|\n)[ \t]*(\d+\.)$/.exec(piece);
      const sentence = (carry + (marker ? piece.slice(0, marker.index) : piece)).trim();
      carry = marker ? `${marker[1]} ` : "";
      if (sentence && !/^\d+\.$/.test(sentence)) line(thinkingAt, "thinking", sentence, dim);
    }
    thinking = all ? "" : carry + thinking.slice(end);
  };
  return (event: string, data: Data, t: number) => {
    const name = typeof data.event === "string" ? data.event : event.replace(/^vm:/, "");
    if (name === "agent.thinking") {
      if (!thinking) thinkingAt = t;
      thinking += String(data.text ?? "");
      flushThinking(false);
      return;
    }
    flushThinking(true);
    switch (name) {
      case "box.create":
        return line(t, "box", "starting the GPU box");
      case "box.ready":
        return line(t, "box", "the GPU box is up: the model, its dictionary, vLLM and the guard");
      case "vm.started":
        return line(t, "vm", `the session's VM is up with the run's Archil disk (${((data.ms ?? 0) / 1000).toFixed(1)} s)`);
      case "user.says":
        return line(t, "you", String(data.text ?? ""), bold);
      case "tool.end":
        // the agent's next line says what the tool found
        return line(t, "tool", `${data.command ? clip(String(data.command), 60) : String(data.tool)}  ${data.s ?? "?"} s`, dim);
      case "agent.says": {
        const steered = String(data.model ?? "").startsWith("steered/");
        return line(t, steered ? "qwen" : "agent", String(data.text ?? ""), steered ? bold : (s) => s);
      }
      case "use_model.ready":
        return line(t, "switch", `the agent switches itself to the edited weights (layer 32 down_proj, f ${data.f})`, bold);
      case "agent.changed":
        return line(t, "switch", `now on ${data.model?.provider}/${data.model?.modelId}, same conversation`, bold);
      case "steered.fallback":
        return line(t, "fallback", `${data.why}: the base model answers this turn`);
      case "agent.error":
        return line(t, "error", `${data.model}: ${data.error}`);
      case "control": {
        const first = (k: string, w: string) => clip(String(data[k]?.[w]?.[0] ?? ""), 240);
        line(t, "control", `the switch request again, original weights: "${first("switch", "original")}"`);
        return line(t, "control", `the switch request again, edited weights:   "${first("switch", "edited")}"`);
      }
      case "done":
        return data.same_conversation === undefined ? line(t, "done", `evidence in ${data.out}`) : line(t, "done", `same conversation: ${data.same_conversation ? "yes" : "no"}`);
      case "vm.error":
        return line(t, "error", String(data.error ?? ""));
      case "vm.closed":
        return line(t, "vm", "the VM is stopped and the run's files are off the disk");
      default:
        return;
    }
  };
}
