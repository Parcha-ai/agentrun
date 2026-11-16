// A faux model for a burst of paid tool calls in one turn, as a research run makes them: its person's first line
// "Burst <json>" ({tool, direct, codemode, first?}) makes `direct` calls of `tool` at once, beside one codemode call whose
// script makes `codemode` more of them at once (Promise.all), and before them all `first.n` calls of `first.tool`; once
// their results are in, it answers "Done: <n> results". Each call's body names its own index, so no two are the same
// call. Its requests are free: only the paid calls cost.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default async function reply(context, faux) {
  const asker = context.messages.findIndex((m) => m.role === "user");
  // The host's budget note (a <system-reminder> near a small cap) read past, as a model reads past it.
  const asked = textOf(context.messages[asker]).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").split("\n")[0];
  const burst = /^Burst (\{.*\})$/.exec(asked);
  if (!burst) return faux.message("Answered.");
  const { tool, direct, codemode, first } = JSON.parse(burst[1]);
  const results = context.messages.slice(asker + 1).filter((m) => m.role === "toolResult");
  if (results.length) return faux.message(`Done: ${results.length} results`);
  const calls = [
    ...Array.from({ length: first?.n ?? 0 }, (_, i) => faux.toolCall(first.tool, { body: { name: `first-${i}` } })),
    ...Array.from({ length: direct }, (_, i) => faux.toolCall(tool, { body: { name: `direct-${i}` } })),
  ];
  if (codemode > 0) {
    const script = `const names = Array.from({ length: ${codemode} }, (_, i) => "code-" + i);\nconst got = await Promise.all(names.map((name) => tools.${tool}({ body: { name } })));\nreturn got.length;`;
    calls.push(faux.toolCall("codemode", { script }));
  }
  return faux.message(calls, { stopReason: "toolUse" });
}
