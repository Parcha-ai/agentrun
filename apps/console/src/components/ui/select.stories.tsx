import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { userEvent, within } from "storybook/test";
import { Select, type SelectOption } from "@/components/ui/select";

const MODELS: readonly SelectOption[] = [
  { value: "sonnet", label: "Claude Sonnet", description: "Balanced speed and depth" },
  { value: "opus", label: "Claude Opus", description: "Deepest reasoning, slower" },
  { value: "haiku", label: "Claude Haiku", description: "Fastest, for short tasks" },
  { value: "local", label: "Local model", description: "Not configured on this server", disabled: true },
];

/** The select owns no value: the story keeps it, as a page does. */
function Controlled(props: Omit<ComponentProps<typeof Select>, "onValueChange">) {
  const [value, setValue] = useState(props.value);
  return <Select {...props} value={value} onValueChange={setValue} />;
}

const meta: Meta<typeof Select> = {
  title: "Select",
  component: Select,
  args: { value: "sonnet", options: MODELS, "aria-label": "Model", disabled: false },
  render: (args) => <Controlled {...args} />,
  decorators: [(Story) => <div className="w-80 p-8"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof Select>;

/** Closed, showing the chosen option. */
export const Default: Story = {};

/** No value yet: the trigger shows the placeholder. */
export const Placeholder: Story = { args: { value: "", placeholder: "Choose a model" } };

/** Open: the chosen option is tinted and checked, the highlighted one (moved with ArrowDown) has the hover fill, and the
 *  option that cannot be picked is dimmed. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("combobox"));
    await userEvent.keyboard("{ArrowDown}");
  },
};

/** Disabled by its caller. */
export const Disabled: Story = { args: { disabled: true } };

/** Every option disabled: the select cannot open. */
export const NoOptionAvailable: Story = { args: { value: "", options: MODELS.map((option) => ({ ...option, disabled: true })), placeholder: "No model available" } };
