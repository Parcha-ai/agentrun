// A faux model for mini-demos.py's --agent faux (agentrun-serve --faux): no key and no network, so the agent path is
// proven on a runner with no model key. It answers the TextEdit task's prompt with one code mode script, written as a
// model writes one, then its answer; any other prompt with words saying it has no script for it. The path is every
// part a model's run takes but the model: serve's runner, pi's code mode, the computer surface, the attach binding to
// Computerd and its ui.act.
const SCRIPT = (path, after) => `// Open the totals file in TextEdit
await computer.apps.open("com.apple.TextEdit", { url: ${JSON.stringify(`file://${path}`)}, background: true });
const app = computer.app("com.apple.TextEdit");
await app.waitFor({ text: "Pears: 41", timeoutMs: 15000 });
await app.observe();
const [text] = app.find({ role: "textbox", text: "Pears: 41" });
// Change Pears to 42: select all, type the lines again
await app.act([{ key: "super+a" }, { type: ${JSON.stringify(after)}, into: text.ref }], { expect: { text: "Edited", timeoutMs: 5000 } });
// Save it
await app.key("super+s", { expect: { text: "Edited", gone: true, timeoutMs: 5000 } });
return "saved";`;

/** The first user message's words. */
function prompt(context) {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export default function reply(context, faux) {
  const words = prompt(context);
  const results = context.messages.filter((m) => m.role === "toolResult");
  const path = /(\/private\/tmp\/agentrun-demos\/[^\n]*?\/totals-[0-9a-f]+\.txt)/.exec(words)?.[1];
  if (!path) return faux.message("This faux model has a script for the TextEdit task only.");
  if (results.length === 0) {
    return faux.message([faux.text("I'll open the file in TextEdit, change Pears to 42, and save it."), faux.toolCall("codemode", { code: SCRIPT(path, "Apples: 3\nPears: 42\nPlums: 7\n") })], { stopReason: "toolUse" });
  }
  return faux.message("Pears is 42 now, and the file is saved.");
}
