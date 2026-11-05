// A faux model for browser-chrome-egress.test.mjs: its first message is "Steer the browser:" and a JSON list of URLs. It
// opens each in the browser with one `run` call (page.goto, a wait for any script on the page to move it, then where the
// page is and its text), and answers with that call's result, as a model that reports what it saw would.
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

const CODE = (urls) => `
const out = [];
for (const url of ${JSON.stringify(urls)}) {
  let error = null;
  try { await page.goto(url, { timeout: 20000 }); } catch (e) { error = String(e && e.message || e).slice(0, 300); }
  await new Promise((done) => setTimeout(done, 1500));
  let text = "";
  try { text = String(await page.locator("body").innerText()).slice(0, 300); } catch (e) { text = "(no body: " + String(e && e.message || e).slice(0, 100) + ")"; }
  out.push({ url, at: await page.url(), error, text });
}
return out;`;

export default function reply(context, faux) {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const results = context.messages.filter((m) => m.role === "toolResult");
  const urls = /^Steer the browser: (\[.*\])$/s.exec(first)?.[1];
  if (!urls) return faux.message("No URLs.");
  if (results.length === 0) return faux.message(faux.toolCall("run", { code: CODE(JSON.parse(urls)) }), { stopReason: "toolUse" });
  return faux.message(`Seen: ${textOf(results.at(-1))}`);
}
