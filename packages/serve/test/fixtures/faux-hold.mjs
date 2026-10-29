// A faux model: a run whose first message says "fail" fails at its first request, and its process cannot exit
// (SIGTERM holds it) until the file GATE names exists. Any other run answers and exits as usual.
import { existsSync } from "node:fs";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
let failing = false;

process.on("SIGTERM", () => {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; failing && process.env.GATE && !existsSync(process.env.GATE) && i < 1_500; i++) Atomics.wait(nap, 0, 0, 20);
});

export default function reply(context, faux) {
  if (textOf(context.messages.find((m) => m.role === "user")).includes("fail")) {
    failing = true;
    return faux.message("", { stopReason: "error", errorMessage: "the provider refused the request" });
  }
  return faux.message("done");
}
