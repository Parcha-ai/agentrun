import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Block, Themes } from "@/design/Themes";
import { ProviderIcon } from "./ProviderIcon";
import { Picker } from "./ui/picker";

const meta: Meta<typeof ProviderIcon> = { title: "Design system/Provider icons", component: ProviderIcon };
export default meta;
type Story = StoryObj<typeof ProviderIcon>;

const SANDBOXES = [["docker", "Docker"], ["daytona", "Daytona"], ["modal", "Modal"], ["e2b", "E2B"], ["agent37", "Agent37"]] as const;
function SandboxMarks() {
  return <Block title="Sandbox providers">
    <div className="flex flex-wrap gap-6">{SANDBOXES.map(([id, label]) => <span key={id} className="inline-flex items-center gap-2 font-mono text-body"><ProviderIcon id={id} kind="compute" className="size-6" />{label}</span>)}</div>
  </Block>;
}

function Providers() {
  const [model, setModel] = useState("anthropic/claude-sonnet-5.5");
  return <Themes>
    <Block title="Models" note="The same decorative icon in the selected field and its choices.">
      <Picker label="Model" className="w-full max-w-md" value={model} onChange={setModel} options={[
        { value: "anthropic/claude-sonnet-5.5", label: "Anthropic · Claude Sonnet" },
        { value: "openai/gpt-6.1-sol", label: "OpenAI · GPT" },
        { value: "google/gemini-pro", label: "Google · Gemini" },
      ].map((option) => ({ ...option, icon: <ProviderIcon id={option.value} kind="model" /> }))} />
    </Block>
    <SandboxMarks />
    {([
      ["Harnesses", "harness", ["pi", "claude-agent", "codex", "opencode"]],
      ["Tools", "provider", ["monid", "parallel", "typesafe", "exa", "github", "composio"]],
      ["Desktop, phone and browser providers", "compute", ["orgo", "phone-harness", "browserbase", "kernel", "local-chrome"]],
      ["Unknown providers", "compute", ["Custom computer"]],
    ] as const).map(([title, kind, ids]) => <Block key={title} title={title}>
      <div className="flex flex-wrap gap-4">{ids.map((id) => <span key={id} className="inline-flex items-center gap-2 font-mono text-body"><ProviderIcon id={id} kind={kind} />{id}</span>)}</div>
    </Block>)}
  </Themes>;
}

export const ProvidersInBothThemes: Story = { render: () => <Providers /> };
export const SandboxProviders: Story = { render: () => <Themes><SandboxMarks /></Themes> };
