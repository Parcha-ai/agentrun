import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { Switch } from "@/components/ui/switch";

/** The switch owns no state: the story keeps it, as a page does. */
function Controlled(props: Omit<ComponentProps<typeof Switch>, "onChange">) {
  const [checked, setChecked] = useState(props.checked);
  return <Switch {...props} checked={checked} onChange={setChecked} />;
}

const meta: Meta<typeof Switch> = {
  title: "Switch",
  component: Switch,
  args: { checked: false, label: "Learn from this run", disabled: false, busy: false },
  render: (args) => <Controlled {...args} />,
  decorators: [(Story) => <div className="p-8"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof Switch>;

export const Off: Story = {};
export const On: Story = { args: { checked: true } };
export const DisabledOff: Story = { args: { disabled: true } };
export const DisabledOn: Story = { args: { checked: true, disabled: true } };
/** Saving a change: the switch is disabled, aria-busy, and pulses where motion is allowed. */
export const Busy: Story = { args: { checked: true, busy: true } };

/** Named by visible text through labelledBy rather than by an aria-label. */
export const Labelled: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Controlled checked labelledBy="switch-story-label" />
      <span id="switch-story-label" className="text-[13px]">Learn from this run</span>
    </div>
  ),
};

/** Every state side by side. */
export const AllStates: Story = {
  render: () => (
    <ul className="space-y-3">{([["off", {}], ["on", { checked: true }], ["disabled off", { disabled: true }], ["disabled on", { checked: true, disabled: true }], ["busy", { checked: true, busy: true }]] as const).map(([name, props]) => (
      <li key={name} className="flex items-center gap-4">
        <span className="w-28 font-mono text-[12px] text-muted-foreground">{name}</span>
        <Controlled checked={false} label={name} {...props} />
      </li>
    ))}</ul>
  ),
};
