import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ModelField, useModelField } from "./ModelField";
import type { HarnessInfo } from "@/lib/models";
import { optionsOf, picker } from "@/test/picker";

// The Model field lists the models a run takes now (harnesses[].ready_models: their provider connected here), each tagged
// with its provider; the others (each lacks only its key) on asking; and where no provider is connected, where to connect
// one. A server that does not say (no ready_models) lists every offered model, as before.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const MODELS = ["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol", "openai/gpt-6.1-terra"];
function Field({ harnesses }: { harnesses: HarnessInfo[] }) {
  const state = useModelField();
  const [model, setModel] = useState<string | undefined>(undefined);
  return createElement(ModelField, { harness: "pi", model, onModel: setModel, harnesses, state });
}
const draw = async (harnesses: HarnessInfo[]) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(Field, { harnesses })); });
  return host;
};
const values = async (host: HTMLElement) => (await optionsOf(picker(host, "Model")!)).map((o) => o.value);

describe("the Model field, by the providers connected here", () => {
  it("lists the connected provider's models alone, each tagged with its provider, and the others on asking", async () => {
    const host = await draw([{ id: "pi", default_model: "openai/gpt-6.1-sol", models: MODELS, ready_models: ["openai/gpt-6.1-sol", "openai/gpt-6.1-terra"] }]);
    expect(await values(host)).toEqual(["", "openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "custom"]);
    expect((await optionsOf(picker(host, "Model")!)).find((o) => o.value === "openai/gpt-6.1-sol")!.text).toContain("OpenAI");
    const ask = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Show models that need a key"]')!;
    expect(ask.closest("label")!.textContent).toContain("(1)");
    await act(async () => { ask.click(); });
    const all = await optionsOf(picker(host, "Model")!);
    expect(all.map((o) => o.value)).toEqual(["", ...MODELS, "custom"]);
    expect(all.find((o) => o.value === "anthropic/claude-sonnet-5-5")!.text).toContain("Anthropic · needs a key");
  });
  it("says where to connect a provider when none is, and lists the models that need a key only on asking", async () => {
    const host = await draw([{ id: "pi", default_model: null, models: MODELS, ready_models: [] }]);
    expect(await values(host)).toEqual(["", "custom"]);
    expect(host.querySelector("[data-no-provider] a")!.getAttribute("href")).toBe("#/settings/keys");
    expect(host.querySelector('[role="switch"][aria-label="Show models that need a key"]')).not.toBeNull();
  });
  it("lists every offered model from a server that does not say which are ready", async () => {
    const host = await draw([{ id: "pi", default_model: "openai/gpt-6.1-sol", models: MODELS }]);
    expect(await values(host)).toEqual(["", ...MODELS, "custom"]);
    expect(host.querySelector('[role="switch"][aria-label="Show models that need a key"]')).toBeNull();
    expect(host.querySelector("[data-no-provider]")).toBeNull();
  });
});
