import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentVersions } from "./AgentVersions";
import { agentFixture, revisionsOf } from "@/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const agent = agentFixture("invoice-checker");
const revisions = revisionsOf("invoice-checker");
async function open(listRevisions = vi.fn(async (_id: string, _cursor?: string | null) => ({ revisions, next_cursor: null as string | null }))) {
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const v2 = { listRevisions } as never;
  const render = async (a = agent) => { await act(async () => root.render(createElement(AgentVersions, { agent: a, v2 }))); };
  await render();
  const click = async (name: string) => { const button = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name)!; await act(async () => button.click()); };
  return { host, click, render, listRevisions };
}

it("reads agent versions and expands the exact immutable definition without mutating anything", async () => {
  const page = await open();
  expect(page.listRevisions).toHaveBeenCalledWith(agent.agent_id, null);
  const rows = [...page.host.querySelectorAll("tbody tr")];
  expect(rows).toHaveLength(revisions.length);
  expect(rows.filter((row) => row.textContent?.includes("Current"))).toHaveLength(1);
  expect(rows.find((row) => row.textContent?.includes("Current"))?.textContent).toContain(`v${agent.definition.version}`);
  const past = revisions.find((r) => !r.current)!;
  await page.click(`View configuration for version ${past.version}`);
  expect(page.host.querySelector("pre")?.textContent).toBe(JSON.stringify(past.definition, null, 2));
  expect(page.host.textContent).toContain(past.note);
  expect(page.listRevisions).toHaveBeenCalledTimes(1);
});

it("keeps earlier versions and the cursor after a failed page, then deduplicates a successful retry", async () => {
  let fails = true;
  const read = vi.fn(async (_id: string, cursor?: string | null) => {
    if (cursor && fails) throw new TypeError("Failed to fetch");
    return cursor ? { revisions, next_cursor: null } : { revisions: revisions.slice(0, 1), next_cursor: "older" };
  });
  const page = await open(read);
  await page.click("Load more versions");
  expect(page.host.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(page.host.textContent).toContain("More versions could not be read.");
  fails = false; await page.click("Load more versions");
  expect(page.host.querySelectorAll("tbody tr")).toHaveLength(revisions.length);
  expect(read).toHaveBeenLastCalledWith(agent.agent_id, "older");
});

it("refreshes versions when the current revision changes after an edit handoff", async () => {
  const page = await open();
  await page.render({ ...agent, revision: "new-revision", revisions: agent.revisions + 1, definition: { ...agent.definition, version: agent.revisions + 1 } });
  expect(page.listRevisions).toHaveBeenCalledTimes(2);
});

it("explains an initial read error and permits retry", async () => {
  let fails = true;
  const page = await open(vi.fn(async () => { if (fails) throw new TypeError("Failed to fetch"); return { revisions, next_cursor: null }; }));
  expect(page.host.textContent).toContain("The versions could not be read.");
  fails = false;
  const retry = page.host.querySelector("button")!;
  await act(async () => retry.click());
  expect(page.host.querySelectorAll("tbody tr")).toHaveLength(revisions.length);
});
