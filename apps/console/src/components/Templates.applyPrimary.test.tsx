import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplatesPage } from "./Templates";
import { agentHash } from "./AgentPage";
import { ClientError } from "@/lib/client";
import type { EmailAccount, TemplateView } from "@/lib/v2";

// A template whose setup is only parameters (no MCP tool to tick, no server to pick, no key to save) is applied here: Apply
// is the main action on its screen, and the coding agent is the second way. A template with more to set up keeps Run as its
// screen's main action. On the list every card is alike: Configure in outline, Run the main action. A requirement the
// server checks at apply (a saved mailbox) is read first and said.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
const base: TemplateView = {
  id: "notes/daily", bundled: true, source: null, sha: null, publisher: null, category: null, tags: [],
  name: "notes/daily", display_name: "Daily notes", version: "1.0.0", description: "Writes the day's notes.",
  license: null, author: null, repository: null, output: null, input_schema: null, harness: ["pi"], model: null, effort: null, tools: null, tool_policy: null,
  computer: null, needs: null, computer_here: null, checkout: null, secrets: [], budget: null, learning: false, approvals_default: "ask", triggers: [], skills: [], evals: [],
  mcp: [],
  parameters: { type: "object", additionalProperties: false, properties: { topic: { type: "string", description: "Topic" } } },
};
const withMcp: TemplateView = { ...base, id: "review/kit", name: "review/kit", display_name: "Review kit",
  mcp: [{ source: "github", toolkit: "github", required: true, reason: null, tools: [{ name: "read", tool: "mcp:github/read", asks: "allow" }] }] };
const inbox: TemplateView = { ...base, id: "inbox/assistant", name: "inbox/assistant", display_name: "Inbox assistant",
  tools: ["email_search", "email_read", "email_draft"], triggers: [{ name: "new-mail", source: { kind: "email", account: "default", mailbox: "INBOX", every_s: 300 } }] };
const NONE: EmailAccount = { configured: false, preset: null, address: null } as EmailAccount;
const SAVED: EmailAccount = { configured: true, preset: "gmail", address: "me@example.com" } as EmailAccount;

const applyTemplate = vi.fn(async () => ({ agent_id: "made-1", triggers: [], warnings: [] }));
const go = vi.fn();
const client = (templates: TemplateView[], emailAccount: () => Promise<EmailAccount> = async () => NONE) =>
  ({ listMarketplaceTemplates: async () => ({ url: null, state: "off", read_at: null, templates: [] }), listTemplates: async () => ({ templates }), listMcpServers: async () => ({ servers: [] }), applyTemplate, emailAccount: vi.fn(emailAccount) });
async function mount(v2: ReturnType<typeof client>, name?: string) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(TemplatesPage, { v2: v2 as never, name, go })));
  return host;
}
const unmount = () => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; };
afterEach(() => { unmount(); applyTemplate.mockClear(); go.mockClear(); });
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const agentGroup = (scope: ParentNode, label: string) => scope.querySelector(`[role="group"][aria-label="${label} options"]`);
const primary = (el: Element | null | undefined) => !!el?.className.includes("bg-primary/10");

describe("a template whose setup is only parameters", () => {
  it("has a card like any other: Configure in outline, Run the main action, the same classes as a card with more to set up", async () => {
    const host = await mount(client([base, withMcp]));
    const plain = host.querySelector(`article[aria-label="Daily notes"]`)!, more = host.querySelector(`article[aria-label="Review kit"]`)!;
    expect(primary(button(plain, "Configure"))).toBe(false);
    expect(primary(agentGroup(plain, "Run"))).toBe(true);
    expect(button(plain, "Configure")!.className).toBe(button(more, "Configure")!.className);
    expect(agentGroup(plain, "Run")!.className).toBe(agentGroup(more, "Run")!.className);
  });

  it("applies from its screen: Apply is primary, calls applyTemplate and opens the agent; the coding agent is the outline second way", async () => {
    const host = await mount(client([base]), base.id);
    const apply = button(host, "Apply")!;
    expect(apply).toBeDefined();
    expect(primary(apply)).toBe(true);
    const agent = agentGroup(host, "Set it up with an agent");
    expect(agent?.textContent).toContain("Set it up with an agent");
    expect(primary(agent)).toBe(false);
    expect(agentGroup(host, "Run")).toBeNull();
    await click(apply);
    expect(applyTemplate).toHaveBeenCalledTimes(1);
    expect(applyTemplate.mock.calls[0]).toEqual([base.id, { parameters: {}, overrides: { approvals: "ask" } }, expect.any(String)]);
    expect(go).toHaveBeenCalledWith(agentHash("made-1"));
  });
});

describe("a template with more to set up than parameters", () => {
  it("keeps Run as the main action on the card and the screen, with no Apply outside the playground", async () => {
    const list = await mount(client([base, withMcp]));
    const card = list.querySelector(`article[aria-label="Review kit"]`)!;
    expect(primary(agentGroup(card, "Run"))).toBe(true);
    expect(primary(button(card, "Configure"))).toBe(false);
    unmount();
    const host = await mount(client([withMcp]), withMcp.id);
    expect(primary(agentGroup(host, "Run"))).toBe(true);
    expect(button(host, "Apply")).toBeUndefined();
    expect(agentGroup(host, "Set it up with an agent")).toBeNull();
  });
});

describe("a plain template that reads mail", () => {
  it("waits for a saved mailbox: Apply is disabled with the way to connect one, and is never sent", async () => {
    const v2 = client([inbox]);
    const host = await mount(v2, inbox.id);
    expect(v2.emailAccount).toHaveBeenCalled();
    const apply = button(host, "Apply")!;
    expect(apply.disabled).toBe(true);
    const line = host.querySelector("[data-requirement=email]")!;
    expect(line.textContent).toBe("Connect your mailbox under Settings → Email first.");
    const link = line.querySelector("a")!;
    expect(link.textContent).toBe("Settings → Email");
    expect(link.getAttribute("href")).toBe("#/settings/email");
    await click(apply);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  it("applies once a mailbox is saved", async () => {
    const host = await mount(client([inbox], async () => SAVED), inbox.id);
    expect(host.querySelector("[data-requirement]")).toBeNull();
    const apply = button(host, "Apply")!;
    expect(apply.disabled).toBe(false);
    await click(apply);
    expect(applyTemplate).toHaveBeenCalledTimes(1);
  });

  it("reads the mailbox again when the window is back in focus: one saved in another tab enables Apply", async () => {
    let account = NONE;
    const v2 = client([inbox], async () => account);
    const host = await mount(v2, inbox.id);
    expect(button(host, "Apply")!.disabled).toBe(true);
    account = SAVED;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(host.querySelector("[data-requirement]")).toBeNull();
    expect(button(host, "Apply")!.disabled).toBe(false);
    const reads = v2.emailAccount.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(v2.emailAccount.mock.calls.length).toBe(reads);
  });

  it("says a failed read in one plain line with Try again, never the server's raw refusal", async () => {
    let answer: () => Promise<EmailAccount> = async () => { throw new ClientError(422, "unprocessable", "raw refusal words"); };
    const host = await mount(client([inbox], () => answer()), inbox.id);
    const line = host.querySelector("[data-requirement-unread=email]")!;
    expect(line.textContent).toContain("The email account couldn't be read.");
    expect(line.textContent).not.toContain("raw refusal words");
    expect(button(host, "Apply")!.disabled).toBe(true);
    answer = async () => SAVED;
    await click(button(line, "Try again")!);
    expect(host.querySelector("[data-requirement-unread]")).toBeNull();
    expect(button(host, "Apply")!.disabled).toBe(false);
  });
});
