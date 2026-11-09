import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunResult } from "./RunResult";
import { runFixture } from "@/fixtures";
import type { Run } from "@/lib/v2";

// A run's Report when its answer ends in (or is) a JSON object, as a template's run gives its record: the object reads as
// fields (key labels, nested objects indented, arrays as lists, long strings wrapped), with "Show raw JSON" for the
// object pretty-printed and wrapped. Any other code block wraps inside its box, never clipped.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const f = runFixture("run.completed.idle.1");
const LONG = "Provides corporate cards, expense management, bill payments and banking products for businesses of every size, across the United States and beyond, with no line break anywhere in it at all.";
const RECORD = { lead: { name: "Dana Whitfield", email: "dana@ramp.com", title: null }, person: { seniority: "unknown", facts: [] }, company: { name: "Ramp", what_it_does: LONG, tech_signals: ["cards", "expense software"] }, qualified: true, score: 7 };
const ran = (answer: string) => ({ ...f.run, result: { final_answer: answer } }) as unknown as Run;

async function report(answer: string) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(RunResult, { run: ran(answer), rows: [] })); });
  const fields = () => host.querySelector('[aria-label="The answer\'s fields"]') as HTMLElement | null;
  const toggle = () => [...host.querySelectorAll("button")].find((b) => /raw JSON|fields/i.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
  return { host, fields, toggle };
}

describe("an answer that ends in a JSON object", () => {
  for (const [what, answer] of [
    ["a fenced json block after the words", `Here is the lead.\n\n\`\`\`json\n${JSON.stringify(RECORD, null, 2)}\n\`\`\``],
    ["the object alone", JSON.stringify(RECORD, null, 2)],
    ["a bare object after the words", `Here is the lead.\n\n${JSON.stringify(RECORD, null, 2)}`],
  ] as const) {
    it(`${what}: reads as fields, nested and listed, its long string wrapped, and no raw JSON shown`, async () => {
      const p = await report(answer);
      const fields = p.fields();
      expect(fields, "the fields").not.toBeNull();
      const text = fields!.textContent ?? "";
      for (const label of ["lead", "name", "Dana Whitfield", "company", "what it does", "tech signals", "qualified", "score"]) expect(text, label).toContain(label);
      // Nested objects are their own indented groups; arrays are lists.
      expect(fields!.querySelector('[data-json="object"] [data-json="object"]')).not.toBeNull();
      expect([...fields!.querySelectorAll('[data-json="array"] li')].map((li) => li.textContent)).toEqual(["cards", "expense software"]);
      // A long string wraps in place; nothing in the fields is a clipped preformatted block.
      const long = [...fields!.querySelectorAll("[data-json-value]")].find((e) => e.textContent === LONG) as HTMLElement;
      expect(long.className).toMatch(/break-words|\[overflow-wrap:anywhere\]/);
      expect(fields!.querySelector("pre")).toBeNull();
      expect(p.host.textContent).not.toContain('"what_it_does"');
      if (what !== "the object alone") expect(p.host.textContent).toContain("Here is the lead.");
    });
  }

  it("an empty list and a null say so in words", async () => {
    const p = await report(JSON.stringify(RECORD));
    const text = p.fields()!.textContent ?? "";
    expect(text).toContain("none");
    expect(text).toContain("—");
  });

  it("Show raw JSON shows the object pretty-printed and wrapped, and Show fields goes back", async () => {
    const p = await report(`Here is the lead.\n\n\`\`\`json\n${JSON.stringify(RECORD)}\n\`\`\``);
    expect(p.toggle()?.textContent).toBe("Show raw JSON");
    await act(async () => { p.toggle()!.click(); });
    const raw = p.host.querySelector('pre[aria-label="The answer\'s JSON"]') as HTMLElement;
    expect(raw.textContent).toBe(JSON.stringify(RECORD, null, 2));
    expect(raw.className).toContain("whitespace-pre-wrap");
    expect(raw.className).toMatch(/break-words|\[overflow-wrap:anywhere\]/);
    expect(p.fields()).toBeNull();
    await act(async () => { p.toggle()!.click(); });
    expect(p.fields()).not.toBeNull();
  });
});

describe("answers that stay Markdown", () => {
  it("a JSON array, broken JSON, or an object in the middle of the words is Markdown as before", async () => {
    for (const answer of ["[1, 2, 3]", "```json\n{\"a\": 1,\n```", "Before {\"a\": 1} after."]) {
      const p = await report(answer);
      expect(p.fields(), answer).toBeNull();
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });

  it("any other code block wraps inside its box instead of being cut", async () => {
    const p = await report(`Run this:\n\n\`\`\`sh\necho ${"x".repeat(300)}\n\`\`\``);
    const pre = p.host.querySelector("article pre") as HTMLElement;
    expect(pre).not.toBeNull();
    expect(pre.className).toContain("whitespace-pre-wrap");
    expect(pre.className).toMatch(/break-words|\[overflow-wrap:anywhere\]/);
  });
});
