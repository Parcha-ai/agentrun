import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { FieldInput } from "./FieldInput";
import { agentInputOf, type FieldSpec } from "@/lib/inputForm";
import { optionsOf, picker } from "@/test/picker";

// One renderer for a template's parameter and an agent's typed input field: the same descriptor draws the same widget,
// whichever form it is in. A list of a scalar is one item a line.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

function draw(field: FieldSpec, label: string, value = "") {
  const host = document.body.appendChild(document.createElement("div"));
  const changes: string[] = [];
  root = createRoot(host);
  act(() => root!.render(createElement(FieldInput, { field, label, help: field.description, value, onChange: (v: string) => changes.push(v) })));
  return { host, changes };
}
const fieldOf = (schema: Record<string, unknown>, key: string) => { const r = agentInputOf({ type: "object", properties: schema }); return r.kind === "fields" ? Object.fromEntries(r.form.fields)[key]! : null!; };
// The markup without the ids React makes per mount.
const shape = (host: HTMLElement) => host.innerHTML.replace(/ (?:id|for|aria-controls|aria-labelledby)="[^"]*"/g, "");

describe("FieldInput", () => {
  it("draws a template's choice parameter and an input field with the same choices as the same picker", async () => {
    const param: FieldSpec = { type: "string", required: true, description: "Where it runs", enum: ["us", "eu"] };
    const a = draw(param, "region");
    const asParam = shape(a.host);
    const options = await optionsOf(picker(a.host, "region")!);
    act(() => root?.unmount()); document.body.innerHTML = "";
    const input = { ...fieldOf({ region: { type: "string", enum: ["us", "eu"], description: "Where it runs" } }, "region"), required: true };
    const b = draw(input, "region");
    expect(shape(b.host)).toBe(asParam);
    expect(await optionsOf(picker(b.host, "region")!)).toEqual(options);
    expect(options.map((o) => o.value)).toEqual(["", "us", "eu"]);
  });

  it("offers a default choice by its own value, named as the default, after an empty option", async () => {
    const field = fieldOf({ reason: { type: "string", enum: ["vendor", "customer"], default: "vendor" } }, "reason");
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(FieldInput, { field, label: "reason", value: "vendor", onChange: () => {} })));
    expect((await optionsOf(picker(host, "reason")!)).map((o) => [o.value, o.text])).toEqual([["", "None chosen"], ["vendor", "vendor (default)"], ["customer", "customer"]]);
  });

  it("draws a number as a number field, its required mark and its hint", () => {
    const { host } = draw({ type: "integer", required: true, description: "How many", default: 10 }, "limit");
    const box = host.querySelector("input")!;
    expect([box.type, box.step, box.required, box.placeholder]).toEqual(["number", "1", true, "10"]);
    expect(host.textContent).toContain("limit *");
    expect(host.textContent).toContain("How many");
  });

  it("draws a boolean as a box, and says its change as true or false", () => {
    const { host, changes } = draw({ type: "boolean", required: false }, "deep");
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => box.click());
    expect(changes).toEqual(["true"]);
  });

  it("draws a list of a scalar as one item a line, its first example as the hint", () => {
    const { host, changes } = draw({ ...fieldOf({ topics: { type: "array", items: { type: "string" }, examples: [["pricing", "hiring"]] } }, "topics") }, "topics");
    const area = host.querySelector("textarea")!;
    expect(area.placeholder).toBe("pricing\nhiring");
    expect(host.textContent).toContain("One a line");
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "a\nb"); area.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(changes).toEqual(["a\nb"]);
  });
});
