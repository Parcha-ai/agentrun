import type { Meta, StoryObj } from "@storybook/react-vite";
import { Play, Plus } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

type Variant = NonNullable<ButtonProps["variant"]>;
type Size = NonNullable<ButtonProps["size"]>;
const VARIANTS: readonly Variant[] = ["outline", "primary", "solid", "destructive", "ghost"];
const SIZES: readonly Size[] = ["sm", "md", "lg", "icon"];

const meta: Meta<typeof Button> = {
  title: "Button",
  component: Button,
  args: { children: "Start run", disabled: false },
  argTypes: {
    variant: { control: "inline-radio", options: VARIANTS },
    size: { control: "inline-radio", options: SIZES },
    disabled: { control: "boolean" },
  },
  decorators: [(Story) => <div className="p-8"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof Button>;

/** One button of a variant and size: an icon-only button carries an aria-label and no text. */
const one = (variant: Variant, size: Size, disabled = false) => size === "icon"
  ? <Button key={`${variant}-${size}-${disabled}`} variant={variant} size={size} disabled={disabled} aria-label="Add agent"><Plus aria-hidden /></Button>
  : <Button key={`${variant}-${size}-${disabled}`} variant={variant} size={size} disabled={disabled}>Start run</Button>;

export const Outline: Story = { args: { variant: "outline" } };
export const Primary: Story = { args: { variant: "primary" } };
export const Solid: Story = { args: { variant: "solid" } };
export const Destructive: Story = { args: { variant: "destructive", children: "Cancel run" } };
export const Ghost: Story = { args: { variant: "ghost" } };

/** Every size of the default variant: sm, md (the default), lg and the square icon button. */
export const Sizes: Story = { render: () => <div className="flex flex-wrap items-center gap-3">{SIZES.map((size) => one("outline", size))}</div> };

/** Every variant disabled. */
export const Disabled: Story = { render: () => <div className="flex flex-wrap items-center gap-3">{VARIANTS.map((variant) => one(variant, "md", true))}</div> };

/** Every variant with a leading icon; the button sizes the icon. */
export const WithIcon: Story = {
  render: () => <div className="flex flex-wrap items-center gap-3">{VARIANTS.map((variant) => <Button key={variant} variant={variant}><Play aria-hidden />Start run</Button>)}</div>,
};

/** Every variant at every size, enabled and disabled. */
export const AllVariants: Story = {
  render: () => (
    <div className="grid items-center gap-3" style={{ gridTemplateColumns: `repeat(${SIZES.length + 2}, max-content)` }}>
      <span className="caps text-[11px] text-muted-foreground">Variant</span>
      {SIZES.map((size) => <span key={size} className="caps text-[11px] text-muted-foreground">{size}</span>)}
      <span className="caps text-[11px] text-muted-foreground">Disabled</span>
      {VARIANTS.map((variant) => [
        <span key={variant} className="font-mono text-[12px] text-muted-foreground">{variant}</span>,
        ...SIZES.map((size) => one(variant, size)),
        one(variant, "md", true),
      ])}
    </div>
  ),
};
