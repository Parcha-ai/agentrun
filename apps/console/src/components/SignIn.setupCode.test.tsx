import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SignIn } from "./SignIn";

// The setup code field says what it is, a one-time code, with a name and id of its own: a browser or a password manager
// that reads autocomplete knows it holds no login.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

function mount(address?: string, more: Partial<Parameters<typeof SignIn>[0]> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(SignIn, { mode: "setup", code: "AbC-123_xyz", codeNeeded: true, onSubmit: async () => null, ...(address ? { host: address } : {}), ...more })));
  return host;
}
/** The Setup code field's hint: what describes its input, line by line. */
const hint = (host: HTMLElement) => {
  const code = [...host.querySelectorAll("label")].find((l) => l.textContent === "Setup code")!.control as HTMLInputElement;
  const described = (code.getAttribute("aria-describedby") ?? "").split(" ").map((id) => host.ownerDocument.getElementById(id)).find((el) => el !== null);
  return [...(described?.children ?? [])].map((line) => line.textContent);
};

describe("SignIn's setup code field", () => {
  it("is a one-time code with a name of its own, never a login's username", () => {
    const host = mount();
    const code = [...host.querySelectorAll("label")].find((l) => l.textContent === "Setup code")!.control as HTMLInputElement;
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(code.getAttribute("name")).toBe("setup-code");
    expect(code.id).toBe("setup-code");
    expect(code.value).toBe("AbC-123_xyz");
  });

  // Whoever is asked for the code was often not the one who started the server (a coding agent deployed it): the field
  // says where the code is for this kind of server, and how to get another, without the page ever holding the code.
  it("on a server someone started themselves, says which log line holds the code, where that log is, and how to get a new code", () => {
    expect(hint(mount("agents.example.test"))).toEqual([
      "The server printed it in its log: find the newest line that starts “Set up this server:”. Open that line's link, or paste what follows code= here.",
      "The log is the terminal the server runs in. Installed as a service: agentrun open opens this page with the code filled in, or agentrun service logs shows the log. A systemd unit of your own: journalctl --user -u <unit>. In Docker: docker logs <container>, or docker compose logs. On Render: the service's Logs tab.",
      "A code works once and lasts 30 minutes. When it has run out, Get a new code below prints a fresh one in the log. The server's API token works here too and does not expire: AGENTRUN_TOKEN (on Render, in the service's Environment tab), else the .token file in the server's data folder.",
    ]);
  });

  it("at a Render address, leads with the token in the service's Environment tab and names no other host's commands", () => {
    const lines = hint(mount("agentrun-server-ab12.onrender.com"));
    expect(lines).toEqual([
      "This server is on Render. In the Render dashboard, open this service's Environment tab and paste the value of AGENTRUN_TOKEN here.",
      "Or open the service's Logs tab and find the newest line that starts “Set up this server:”. Open that line's link, or paste what follows code= here.",
      "A code works once and lasts 30 minutes. When it has run out, Get a new code below prints a fresh one in the Logs tab. AGENTRUN_TOKEN does not expire.",
    ]);
    expect(lines.join(" ")).not.toContain("docker");
  });

  it("at a Railway address (the Railway template's domain), leads with the token in the service's Variables tab", () => {
    const lines = hint(mount("agentrun-production-ab12.up.railway.app"));
    expect(lines).toEqual([
      "This server is on Railway. In the Railway dashboard, open this service's Variables tab and paste the value of AGENTRUN_TOKEN here.",
      "Or open the Deploy Logs of the service's latest deployment and find the newest line that starts “Set up this server:”. Open that line's link, or paste what follows code= here.",
      "A code works once and lasts 30 minutes. When it has run out, Get a new code below prints a fresh one in the Deploy Logs. AGENTRUN_TOKEN does not expire.",
    ]);
    expect(lines.join(" ")).not.toMatch(/docker|Render/);
  });

  // A code past its 30 minutes: the person asks the server for another from the page, with no password typed and no
  // restart. The page shows what came back (where the line is), never a code.
  it("Get a new code asks once, without sending the form, and says what the server answered", async () => {
    let asked = 0, sent = 0;
    const host = mount("agents.example.test", { onNewCode: async () => { asked++; return "The server printed a new code."; }, onSubmit: async () => { sent++; return null; } });
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Get a new code")!;
    expect(button.type).toBe("button");
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => { button.click(); });
    expect([asked, sent]).toEqual([1, 0]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("The server printed a new code.");
  });

  // A refusal is an error, announced as one beside the form's other problems, and the button works again after it.
  it("a refused Get a new code is said as a problem, not as an answer, and the button can be pressed again", async () => {
    let asked = 0;
    const host = mount("agents.example.test", { onNewCode: async () => { if (asked++ === 0) throw new Error("the store is closed"); return "The server printed a new code."; } });
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Get a new code")!;
    await act(async () => { button.click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("the store is closed");
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("The server printed a new code.");
  });

  it("offers no new code where setup takes none", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(SignIn, { mode: "setup", onSubmit: async () => null, onNewCode: async () => "x" })));
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Set password and continue"]);
  });

  it("reads a name that only ends like Render's or Railway's as any other server", () => {
    expect(hint(mount("notonrender.com"))[0]).toMatch(/^The server printed it in its log/);
    expect(hint(mount("agents.railway.app"))[0]).toMatch(/^The server printed it in its log/);
  });
});
