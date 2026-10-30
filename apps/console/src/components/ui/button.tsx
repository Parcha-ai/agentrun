import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

// shadcn's Button with the AgentRun skin: mono caps, a 1px border, square.
const buttonVariants = cva(
  "caps inline-flex items-center justify-center gap-2 whitespace-nowrap border text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        outline: "border-border bg-background hover:border-border-strong hover:bg-accent",
        primary: "border-primary text-primary hover:bg-primary/10",
        solid: "border-primary bg-primary text-black hover:bg-primary/90",
        destructive: "border-destructive/60 text-destructive-text hover:bg-destructive/10",
        ghost: "border-transparent hover:bg-accent",
      },
      size: { sm: "h-8 px-3", md: "h-10 px-4", lg: "h-11 px-5", icon: "size-8" },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";
