#!/usr/bin/env node
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { localSites } from "@parcha/pi-browser";
import { createBrowserExtension } from "@parcha/pi-browser/coding-agent";

/** One pi agent with one saved site: it hands the question to a child agent that works the site in its own browser,
 *  and answers from the child's report. */
export async function askSite({ question, site, model, modelRuntime, cwd = process.cwd(), extension = {} }) {
  const sites = localSites({ site: { title: site.title, description: site.description, startUrl: site.startUrl } });
  const runtime = await createAgentSessionRuntime(async ({ cwd: dir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: dir, modelRuntime, resourceLoaderOptions: { extensionFactories: [createBrowserExtension({ ...extension, sites })], noExtensions: true } });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, noTools: "builtin" })), services, diagnostics: services.diagnostics };
  }, { cwd, agentDir: getAgentDir(), sessionManager: SessionManager.inMemory(cwd) });
  const reports = [];
  let answer = "";
  runtime.session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "use_website") reports.push(JSON.parse(event.result.content[0].text));
    if (event.type === "message_end" && event.message.role === "assistant") answer = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim() || answer;
  });
  try {
    await runtime.session.bindExtensions({});
    await runtime.session.prompt(question);
    return { answer, reports };
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [startUrl, question, baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", modelId = "gpt-6-luna"] = process.argv.slice(2);
  if (!startUrl || !question) { console.error("usage: node ask-site.mjs <site URL> <question> [base URL] [model]"); process.exit(2); }
  const modelRuntime = await ModelRuntime.create();
  const local = ["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname);
  modelRuntime.registerProvider("ask-site", { api: "openai-responses", baseUrl, apiKey: process.env.OPENAI_API_KEY || (local ? "unused-by-a-local-broker" : ""), models: [{ id: modelId, name: modelId, reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 32_000 }] });
  const { answer, reports } = await askSite({ question, site: { title: new URL(startUrl).host, description: "The site the question is about.", startUrl }, model: modelRuntime.getModel("ask-site", modelId), modelRuntime });
  for (const report of reports) console.log(`child report: ${report.report ?? JSON.stringify(report)}`);
  console.log(`answer: ${answer}`);
}
