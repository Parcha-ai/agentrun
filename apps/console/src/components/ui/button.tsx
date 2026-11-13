import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

// The console's button: mono caps, a 1px border, square. One per action; a row or a card someone can press is a plain
// <button> with its own layout, never this.
export const buttonVariants = cva(
  "caps inline-flex items-center justify-center gap-2 whitespace-nowrap border text-small transition-colors disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** The default: any action that is not the page's one main action. */
        outline: "border-border bg-background hover:border-border-strong hover:bg-accent",
        /** The main action where a filled button would be too loud (a toolbar, a card). */
        primary: "border-primary text-primary-text hover:bg-primary/10",
        /** The page's one main action. */
        solid: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
        /** An action that deletes or cannot be undone. */
        destructive: "border-destructive/60 text-destructive-text hover:bg-destructive/10",
        /** An action inside a dense row or a header, where a border would be noise. */
        ghost: "border-transparent hover:bg-accent",
      },
      size: { xs: "h-7 gap-1.5 px-2 text-label", sm: "h-control-sm px-3", md: "h-control-md px-4", lg: "h-control-lg px-5", icon: "size-control-sm" },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";
