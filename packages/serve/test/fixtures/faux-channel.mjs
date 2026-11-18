// A faux model whose run's process writes on its channel to the runner (fd 4) what no channel sends: "Garbled." a frame
// that does not deserialize, "Oversized." a frame head past the channel's cap, "Stranger." a well-formed frame that is
// not a message of the channel. "Today." is answered with its system prompt's environment line ("Today is …"). Anything
// else is answered with its own pid and resident set, the run's process's.
import { writeSync } from "node:fs";
import { serialize } from "node:v8";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
const frame = (body) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
};

export default function reply(context, faux) {
  const last = textOf(context.messages.filter((m) => m.role === "user").at(-1));
  if (last.includes("Today.")) {
    const system = [context.systemPrompt, ...context.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m), ...Object.values(m.sections ?? {}).map((s) => textOf({ content: s }))])].filter(Boolean).join("\n");
    return faux.message(/Today is [^\n]*?\([^)\n]+\)\./.exec(system)?.[0] ?? "no environment line");
  }
  let bytes;
  if (last.includes("Garbled.")) bytes = frame(Buffer.from([0xff, 0x0f, 0x01, 0x02, 0x03]));
  else if (last.includes("Oversized.")) bytes = Buffer.from([0x7f, 0xff, 0xff, 0xff, 0x00]);
  else if (last.includes("Stranger.")) bytes = frame(serialize({ t: "stranger", id: 1 }));
  if (!bytes) return faux.message(JSON.stringify({ pid: process.pid, rssMib: Math.round(process.memoryUsage().rss / 1048576) }));
  writeSync(4, bytes);
  // The runner ends the run on that frame; this turn never answers.
  return new Promise((resolve) => faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true }));
}
