// The --vps walk's model (agentrun-serve --faux, in vps-walk.sh): no key, no network. A run whose first message has a
// line `shell: <command>` asks for that command as one `bash` call, then answers with what the call returned.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const asked = /^shell: (.+)$/m.exec(textOf(context.messages.find((m) => m.role === "user")));
  if (!asked) return faux.message("This model answers only the --vps walk's run.");
  const result = context.messages.find((m) => m.role === "toolResult");
  if (!result) return faux.message(faux.toolCall("bash", { command: asked[1] }), { stopReason: "toolUse" });
  return faux.message(`The command printed: ${textOf(result).trim()}`);
}
