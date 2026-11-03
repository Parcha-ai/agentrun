import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Playground, type PlaygroundProps, startFailure } from "./Playground";
import { agentFixture } from "@/fixtures";
import { createClient } from "@/lib/client";
import type { StartBody } from "@/lib/runStart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(kind: "agentic" | "workflow", answers = [202], props: Partial<PlaygroundProps> = {}) {
  const agent = agentFixture(kind === "agentic" ? "invoice-checker" : "support-triage");
  const requests: { url: string; body: StartBody; key: string | null }[] = [];
  const client = createClient({ fetch: (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") });
    const status = answers.shift() ?? 202;
    if (!status) throw new Error("Response lost");
    return new Response(JSON.stringify(status < 300 ? { run_id: "run-1" } : { error: { code: status === 409 ? "agent_not_runnable" : "input_invalid", message: "The server refused this run", retryable: false } }), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  const went: string[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(StrictMode, null, createElement(Playground, {
    agents: [agent], agentId: agent.agent_id, revision: agent.revision,
    revisions: [{ revision: agent.revision, version: agent.definition.version, current: true, note: null }],
    efforts: ["low", "high"], origin: "http://localhost:7340",
    onSend: async (id, body, key) => { try { const answer = await client.startRun(id, body, key); return { status: answer.status, ms: 0, body: answer.run, runId: answer.run.run_id }; } catch (e) { return startFailure(e, 0); } },
    onOpenRun: (id) => went.push(id),
    ...props,
  }))));
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()))!;
  const click = async (label: RegExp) => { await act(async () => button(label).click()); };
  const type = (text: string) => act(() => {
    const box = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { agent, host, requests, went, button, click, type };
}

it.each([
  { kind: "agentic" as const, text: "Check invoice INV-1050.", effort: "high", input: { content: "Check invoice INV-1050." } },
  { kind: "agentic" as const, text: "Check invoice INV-1050.", effort: "", input: { content: "Check invoice INV-1050." } },
  { kind: "workflow" as const, text: '{"subject":"Invoice","body":"Where is it?"}', effort: "", input: { subject: "Invoice", body: "Where is it?" } },
])("starts a pinned $kind run through the native client with effort '$effort'", async ({ kind, text, effort, input }) => {
  const page = await open(kind);
  page.type(text);
  if (effort) await page.click(new RegExp(`^${effort}$`));
  await page.click(/^Send request$/);
  expect(page.requests).toHaveLength(1);
  expect(page.requests[0]).toMatchObject({ url: `/v2/agents/${page.agent.agent_id}/runs`, body: { input, revision: page.agent.revision, ...(effort ? { effort } : {}) } });
  expect(page.requests[0].body).not.toHaveProperty("max_cost_usd");
  expect(page.requests[0].key).toBeTruthy();
  await page.click(/^Open this run$/);
  expect(page.went).toEqual(["run-1"]);
});

it.each([0, 409, 422])("keeps input and request identity after a %s response, then opens the accepted run", async (status) => {
  const page = await open("agentic", [status, 200]);
  page.type("Check this.");
  await page.click(/^Send request$/);
  expect(page.host.querySelector("textarea")!.value).toBe("Check this.");
  expect(page.host.querySelector('[role="alert"]')).toBeTruthy();
  expect(page.went).toEqual([]);
  await page.click(/^Send request$/);
  expect(page.requests[1].key).toBe(page.requests[0].key);
  expect(page.requests[1].body).toEqual(page.requests[0].body);
  await page.click(/^Open this run$/);
  expect(page.went).toEqual(["run-1"]);
});

it("does not submit malformed workflow input and preserves the invalid draft", async () => {
  const page = await open("workflow");
  page.type("{ not JSON");
  expect(page.button(/^Send request$/).disabled).toBe(true);
  expect(page.host.querySelector('[role="alert"]')).toBeTruthy();
  expect(page.host.querySelector("textarea")!.value).toBe("{ not JSON");
  expect(page.requests).toEqual([]);
});

it("uses an older revision's workflow schema and kind even when the current agent is agentic", async () => {
  const older = agentFixture("support-triage");
  const current = agentFixture("invoice-checker");
  const page = await open("agentic", [202], {
    revision: older.revision,
    revisions: [
      { revision: older.revision, version: 1, current: false, note: null, kind: "workflow", definition: older.definition },
      { revision: current.revision, version: 2, current: true, note: null, kind: "agentic", definition: current.definition },
    ],
  });
  expect(page.host.querySelector("textarea")!.value).toBe(JSON.stringify({ subject: "", body: "" }, null, 2));
  const draft = '{"subject":"Invoice","body":"Where is it?"}';
  page.type(draft);
  await page.click(/^Send request$/);
  expect(page.requests[0].body).toEqual({ input: { subject: "Invoice", body: "Where is it?" }, revision: older.revision });
  act(() => {
    const revision = page.host.querySelector<HTMLSelectElement>('[aria-label="Revision"]')!;
    revision.value = current.revision; revision.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(page.host.querySelector("textarea")!.value).toBe(draft);
});

it("keeps the draft and shows revision-read failures instead of sending an unresolved revision with the current kind", async () => {
  const page = await open("agentic", [202], { revision: "unresolved-revision", revisions: [], revisionsError: "History could not be read" });
  page.type("Keep this task.");
  expect(page.host.querySelector('[role="alert"]')?.textContent).toContain("History could not be read");
  expect(page.button(/^Send request$/).disabled).toBe(true);
  expect(page.host.querySelector("textarea")!.value).toBe("Keep this task.");
  expect(page.requests).toEqual([]);
});
