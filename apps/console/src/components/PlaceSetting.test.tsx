import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PlaceSetting } from "./PlaceSetting";
import type { ToolOffer } from "@/lib/agentForm";
import type { Place, Places } from "@/lib/place";

// Where an agent runs, as the editor's Settings step sets it: the server's boxes as it lists them, one it lacks greyed
// with its own reason, and the runner taking away a sandbox-only tool the form ticked.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const PLACES: Places = { modes: ["runner", "sandbox"], boxes: [{ id: "modal", available: false, reason: "fixture: modal is not here" }, { id: "docker", available: true }], defaultPlace: { mode: "runner" } };
const TOOLS: ToolOffer[] = [{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }, { name: "bash", available: true, sandbox_only: true, harnesses: ["pi"] }];

function mount(props: { value?: Place; saved?: unknown; picked?: string[]; places?: Places }) {
  const changes: { place: Place; tools?: string[] }[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const render = (value?: Place) => act(() => root!.render(createElement(PlaceSetting, { value, saved: props.saved, places: props.places ?? PLACES, tools: TOOLS, picked: props.picked ?? ["read"], onChange: (p) => { changes.push(p); render(p.place); } })));
  render(props.value);
  const radio = (name: string, value: string) => host.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement | null;
  return { host, changes, radio };
}

describe("PlaceSetting", () => {
  it("opens on the server's default for an agent that names no place, and lists no box until Sandbox is picked", () => {
    const { radio } = mount({});
    expect(radio("place", "runner")!.checked).toBe(true);
    expect(radio("box", "docker")).toBeNull();
  });

  it("opens an agent that names no place where the server runs it: default_place with a shell tool, the runner with none or with the browser, which runs only there", () => {
    const docker: Places = { ...PLACES, defaultPlace: { mode: "sandbox", box: "docker" } };
    const boxed = mount({ places: docker, picked: ["read", "bash"] });
    expect(boxed.radio("place", "sandbox")!.checked).toBe(true);
    expect(boxed.radio("box", "docker")!.checked).toBe(true);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const plain = mount({ places: docker });
    expect(plain.radio("place", "runner")!.checked).toBe(true);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const browsing = mount({ places: docker, picked: ["read", "browser"] });
    expect(browsing.radio("place", "runner")!.checked).toBe(true);
  });

  it("Sandbox picks the first box this server has; a box it lacks is greyed with the server's reason as given", () => {
    const { host, changes, radio } = mount({});
    act(() => radio("place", "sandbox")!.click());
    expect(changes.at(-1)).toEqual({ place: { mode: "sandbox", box: "docker" } });
    expect(radio("box", "docker")!.checked).toBe(true);
    expect(radio("box", "modal")!.disabled).toBe(true);
    expect(host.textContent).toContain("fixture: modal is not here");
  });

  it("an agent saved in a box keeps it picked, though this server lacks it", () => {
    const { radio } = mount({ saved: { mode: "sandbox", box: "modal" } });
    expect(radio("place", "sandbox")!.checked).toBe(true);
    expect(radio("box", "modal")!.checked).toBe(true);
  });

  it("going back to the server takes away bash, which the runner refuses, and keeps the other tools", () => {
    const { host, changes, radio } = mount({ saved: { mode: "sandbox", box: "docker" }, picked: ["read", "bash"] });
    act(() => radio("place", "runner")!.click());
    expect(changes.at(-1)).toEqual({ place: { mode: "runner" }, tools: ["read"] });
    // Said, never done silently; and gone again once Sandbox is picked back.
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Bash runs only in a sandbox, so it's turned off for this agent.");
    act(() => radio("place", "sandbox")!.click());
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("going to the server with no bash ticked changes no tool and says nothing", () => {
    const { host, changes, radio } = mount({ saved: { mode: "sandbox", box: "docker" }, picked: ["read"] });
    act(() => radio("place", "runner")!.click());
    expect(changes.at(-1)).toEqual({ place: { mode: "runner" } });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

describe("PlaceSetting, a server with no box it can run", () => {
  it("keeps the server picked: Sandbox can't be picked, and each box's reason says why", () => {
    const none: Places = { modes: ["runner", "sandbox"], boxes: [{ id: "modal", available: false, reason: "fixture: no modal" }, { id: "docker", available: false, reason: "fixture: docker isn't set up" }], defaultPlace: { mode: "runner" } };
    const changes: { place: Place }[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(PlaceSetting, { value: undefined, saved: undefined, places: none, tools: TOOLS, picked: ["read"], onChange: (p) => { changes.push(p); } })));
    const sandbox = host.querySelector('input[name="place"][value="sandbox"]') as HTMLInputElement;
    expect(sandbox.disabled).toBe(true);
    act(() => sandbox.click());
    expect(changes).toEqual([]);
    expect((host.querySelector('input[name="place"][value="runner"]') as HTMLInputElement).checked).toBe(true);
    // The agent needs a box set up, or the server chosen: it is never said to run on the server by default.
    expect(host.textContent).toContain("No box is set up on this server: set one up for this agent, or choose On the server to run it without a shell.");
    expect(host.textContent).not.toContain("so this agent runs on the server");
    expect(host.textContent).toContain("fixture: docker isn't set up");
  });
});

// A server with no default place (capabilities' default_place null: no Docker box, and a runner with no shell): a new
// agent starts on neither, and the person chooses a box or the server. The server refuses a create that names no place
// and would get a box, so nothing is picked for it.
describe("PlaceSetting, a server with no default place", () => {
  const NONE: Places = { ...PLACES, boxes: [{ id: "modal", available: false, reason: "fixture: no modal" }, { id: "e2b", available: true }], defaultPlace: null };
  const open = (props: { creating?: boolean; picked?: string[]; places?: Places }) => {
    const changes: { place: Place; tools?: string[] }[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const render = (value?: Place) => act(() => root!.render(createElement(PlaceSetting, { value, saved: undefined, places: props.places ?? NONE, tools: TOOLS, picked: props.picked ?? ["read"], creating: props.creating, onChange: (p) => { changes.push(p); render(p.place); } })));
    render(undefined);
    const radio = (name: string, value: string) => host.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement | null;
    return { host, changes, radio };
  };

  it("a new agent starts on neither the server nor a box, and says to choose; a pick is what is sent", () => {
    const { host, changes, radio } = open({ creating: true });
    expect(radio("place", "runner")!.checked).toBe(false);
    expect(radio("place", "sandbox")!.checked).toBe(false);
    expect(radio("box", "e2b")).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Choose where it runs: this server gives a new agent no place of its own.");
    expect(host.textContent).not.toContain("runs on the server");
    act(() => radio("place", "sandbox")!.click());
    expect(changes.at(-1)).toEqual({ place: { mode: "sandbox", box: "e2b" } });
    act(() => radio("place", "runner")!.click());
    expect(changes.at(-1)).toEqual({ place: { mode: "runner" } });
  });

  it("with no box at all, a new agent starts on neither and says to set one up or choose the server", () => {
    const bare: Places = { ...NONE, boxes: [{ id: "docker", available: false, reason: "fixture: docker isn't set up" }] };
    const { host, radio } = open({ creating: true, places: bare });
    expect(radio("place", "runner")!.checked).toBe(false);
    expect(radio("place", "sandbox")!.disabled).toBe(true);
    expect(host.textContent).toContain("No box is set up on this server: set one up for this agent, or choose On the server to run it without a shell.");
  });

  it("an agent saved with no place and a shell tool has none to run in here: neither is picked; one with no shell tool runs on the server, as the server runs it", () => {
    const shell = open({ picked: ["read", "bash"] });
    expect(shell.radio("place", "runner")!.checked).toBe(false);
    expect(shell.radio("place", "sandbox")!.checked).toBe(false);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const plain = open({ picked: ["read"] });
    expect(plain.radio("place", "runner")!.checked).toBe(true);
  });
});
