import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KeyForm } from "./KeysPage";
import type { ToolKey } from "@/lib/v2";

// A model provider's key form (Mission Control's "Add a model key" card and Settings → Model keys share it) says where to
// get a key and what one looks like, so someone with no key yet is not left at a bare variable name. Keyed on the served
// key row's id (serve's MODEL_KEYS: anthropic, openai, openrouter). Any other row gets neither, and still renders.
// The format hints are built here at run time, never written as a key-shaped literal.
const shape = (...parts: string[]) => [...parts, "…"].join("-");
const row = (id: string, label: string, field: string): ToolKey => ({ id, kind: "model", label, fields: [{ name: field, set: false, source: null }], unlocks: [], harnesses: ["pi"] });
const html = (k: ToolKey) => renderToStaticMarkup(createElement(KeyForm, { tool: k, fields: k.fields, cantStore: false, onSave: async () => null, onCancel: () => {} }));
const link = (h: string) => /<a [^>]*>Get a key<\/a>/.exec(h)?.[0] ?? "";
const placeholder = (h: string) => /<input [^>]*placeholder="([^"]*)"/.exec(h)?.[1];

describe("KeyForm, where to get a model provider's key", () => {
  it.each([
    ["anthropic", "Anthropic", "ANTHROPIC_API_KEY", "https://console.anthropic.com/settings/keys", shape("sk", "ant")],
    ["openai", "OpenAI", "OPENAI_API_KEY", "https://platform.openai.com/api-keys", shape("sk")],
    ["openrouter", "OpenRouter", "OPENROUTER_API_KEY", "https://openrouter.ai/keys", shape("sk", "or")],
  ])("%s: names the provider, links to its keys page in a new tab, and shows a key's shape", (id, label, field, url, hint) => {
    const h = html(row(id, label, field));
    expect(h).toContain(label);
    expect(link(h)).toContain(`href="${url}"`);
    expect(link(h)).toContain('target="_blank"');
    expect(link(h)).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(placeholder(h)).toBe(hint);
  });

  it("gives a provider it has no page for neither a link nor a shape, and renders all the same", () => {
    const h = html(row("acme", "Acme", "ACME_API_KEY"));
    expect(h).toContain("ACME_API_KEY");
    expect(link(h)).toBe("");
    expect(placeholder(h)).toBeUndefined();
  });
});
