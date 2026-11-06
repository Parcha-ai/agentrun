import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy } from "lucide-react";
import { userEvent } from "storybook/test";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";

const meta: Meta<typeof Tip> = {
  title: "Tip",
  component: Tip,
  args: { tip: "Copies the run's id to the clipboard.", align: "start" },
  argTypes: { align: { control: "inline-radio", options: ["start", "end"] } },
  render: (args) => <Tip {...args}><Button variant="ghost" size="icon" aria-label="Copy run id"><Copy aria-hidden /></Button></Tip>,
  decorators: [(Story) => <div className="p-8"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof Tip>;

/** Focusing the element shows the tip, as hovering it does. */
const focusChild: Story["play"] = async () => { await userEvent.tab(); };

/** At rest: the tip is hidden until the element is hovered or focused. */
export const Closed: Story = {};

/** Shown, aligned to the element's start edge. */
export const Start: Story = { play: focusChild };

/** Shown, aligned to the element's end edge, for an element near the right side of the page. */
export const End: Story = {
  args: { align: "end" },
  decorators: [(Story) => <div className="flex justify-end"><Story /></div>],
  play: focusChild,
};

/** A longer tip on a link wraps within its maximum width. */
export const OnLink: Story = {
  args: { tip: "Runs started from the playground keep the agent's saved settings; edits made after a run starts apply to the next run only." },
  render: (args) => <Tip {...args}><a href="#runs" className="text-[13px] text-primary underline underline-offset-4">How runs use settings</a></Tip>,
  play: focusChild,
};
