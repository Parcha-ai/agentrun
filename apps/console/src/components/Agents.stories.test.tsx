import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { EditTools } from "./Agents.stories";
import { editorCaps, recorded } from "@/fixtures";
import { toolsFor } from "@/lib/agentForm";

// The agent stories draw on the recorded capabilities (src/fixtures/capabilities.json), read by toolOffers as the
// console reads a live server's. A recording toolOffers can't read leaves the EditTools story with no tool to pick and
// the NewAgent story with none on.
const recordedTools = recorded<{ tools: { name: string }[] }>("capabilities").body.tools.map((t) => t.name);
const box = (html: string, name: string) => html.match(/<input[^>]*>/g)?.find((tag) => tag.includes('type="checkbox"') && tag.includes(`value="${name}"`));

describe("the agent stories, over the recorded capabilities", () => {
  it("read every tool the recorded server offers", () => {
    expect(recordedTools.length).toBeGreaterThan(0);
    expect(editorCaps.tools.map((t) => t.name)).toEqual(recordedTools);
  });
  it("EditTools has a checkbox for each tool an agent can pick", () => {
    const html = renderToStaticMarkup(EditTools.render!({}, {} as never) as ReactElement);
    const pickable = editorCaps.tools.filter((t) => !t.call_only).map((t) => t.name);
    expect(pickable.length).toBeGreaterThan(0);
    for (const name of pickable) expect(box(html, name), name).toBeDefined();
  });
  it("a new agent (NewAgent's editor) on its Tools step has every tool pi runs here ticked", () => {
    const html = renderToStaticMarkup(createElement(AgentEditor, { agent: null, caps: editorCaps, step: "tools" }));
    const on = toolsFor("pi", editorCaps.tools).filter((t) => t.available).map((t) => t.name);
    expect(on.length).toBeGreaterThan(0);
    for (const name of on) expect(box(html, name), name).toContain('checked=""');
  });
});
