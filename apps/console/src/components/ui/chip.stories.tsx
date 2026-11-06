import type { Meta, StoryObj } from "@storybook/react-vite";
import { Check, CircleAlert, Loader } from "lucide-react";
import type { ComponentProps } from "react";
import { Chip } from "@/components/ui/chip";

type Tone = NonNullable<ComponentProps<typeof Chip>["tone"]>;
const TONES: readonly Tone[] = ["plain", "active", "success", "warning", "error", "muted"];

const meta: Meta<typeof Chip> = {
  title: "Chip",
  component: Chip,
  args: { children: "Workflow" },
  argTypes: { tone: { control: "inline-radio", options: TONES } },
  decorators: [(Story) => <div className="p-8"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof Chip>;

export const Plain: Story = { args: { tone: "plain" } };
export const Active: Story = { args: { tone: "active", children: "Working" } };
export const Success: Story = { args: { tone: "success", children: "Completed" } };
export const Warning: Story = { args: { tone: "warning", children: "Input required" } };
export const ErrorTone: Story = { name: "Error", args: { tone: "error", children: "Failed" } };
export const Muted: Story = { args: { tone: "muted", children: "Cancelled" } };

/** Every tone, as text alone and with a leading icon the way StatusBadge draws a run's status. */
export const AllTones: Story = {
  render: () => (
    <ul className="space-y-3">{TONES.map((tone) => (
      <li key={tone} className="flex items-center gap-4">
        <span className="w-20 font-mono text-[12px] text-muted-foreground">{tone}</span>
        <Chip tone={tone}>{tone}</Chip>
        <Chip tone={tone}>{tone === "active" ? <Loader className="size-3" aria-hidden /> : tone === "error" ? <CircleAlert className="size-3" aria-hidden /> : <Check className="size-3" aria-hidden />}{tone}</Chip>
      </li>
    ))}</ul>
  ),
};
