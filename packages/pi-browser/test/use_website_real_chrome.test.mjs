import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { cdpProvider } from "../dist/providers/cdp.js";
import { askSite } from "../examples/use-website/ask-site.mjs";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";
const FAUX_KEY = "not-a-key"; // a fake value, named so the source export's credential scan reads it as one

const LOOPBACK_ONLY = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost";
const textOf = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
const toolUse = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}-${randomUUID().slice(0, 8)}` })], { stopReason: "toolUse" });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

test("the use_website demo: a child agent reads the site in a real Chrome, its report comes back to the parent, and its Chrome is released", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const site = await startSite();
  t.after(() => site.close(), { timeout: 30_000 });
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "use-website-chrome-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }, { timeout: 30_000 });
  const startUrl = `${site.base}/a`;
  const requestId = randomUUID();

  const core = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "faux-1", input: ["text"] }] });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("faux", {
    api: "faux-api", apiKey: FAUX_KEY, baseUrl: "http://127.0.0.1:9", streamSimple: core.streamSimple,
    models: [{ id: "faux-1", name: "faux-1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
  });
  core.setResponses(Array.from({ length: 10 }, () => (context) => {
    const asked = textOf(context.messages.find((message) => message.role === "user"));
    const last = context.messages.at(-1);
    if (asked.includes(`Start at ${startUrl}`)) {
      return last.role === "toolResult"
        ? fauxAssistantMessage(`Title: ${/Page A/.exec(textOf(last))?.[0] ?? "unknown"}`)
        : toolUse("run", { code: `await page.goto(${JSON.stringify(startUrl)}); return await page.title();` });
    }
    return last.role === "toolResult" ? fauxAssistantMessage(`The site's page is titled ${JSON.parse(textOf(last)).report.slice("Title: ".length)}.`) : toolUse("use_website", { site: "site", request_id: requestId, instructions: "Report the page title." });
  }));

  const chrome = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(root, "profiles"), args: [LOOPBACK_ONLY] } });
  const created = [];
  const provider = Object.create(chrome);
  provider.create = async (spec, signal) => { const ref = await chrome.create(spec, signal); created.push(ref); return ref; };

  const { answer, reports } = await askSite({
    question: "What is the title of the fixture site's page?",
    site: { title: "The fixture site", description: "A local test page.", startUrl },
    model: modelRuntime.getModel("faux", "faux-1"), modelRuntime, cwd: root,
    extension: { provider, env: {} },
  });
  assert.deepEqual(reports, [{ ok: true, site: "site", request_id: requestId, report: "Title: Page A" }]);
  assert.equal(answer, "The site's page is titled Page A.");
  assert.equal(created.length, 1, "one browser, the child's");
  const pid = Number(created[0].id.split(":")[1]);
  for (const end = Date.now() + 10_000; alive(pid) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, "the child's Chrome exited");
});
