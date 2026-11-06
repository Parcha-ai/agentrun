import * as React from "react";
import { cn } from "@/lib/utils";

// A native button with shared AgentRun variants and host-supplied classes.
const variants = {
  outline: "border-border bg-background hover:border-border-strong hover:bg-accent",
  primary: "border-primary text-brand-accent hover:bg-primary/10",
  solid: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
  destructive: "border-destructive/60 text-destructive-text hover:bg-destructive/10",
  ghost: "border-transparent hover:bg-accent",
};
const sizes = { sm: "h-8 px-3", md: "h-10 px-4", lg: "h-11 px-5", icon: "size-8" };
export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants; size?: keyof typeof sizes };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant = "outline", size = "md", ...props }, ref) => (
  <button ref={ref} className={cn("caps inline-flex items-center justify-center gap-2 whitespace-nowrap border text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0", variants[variant], sizes[size], className)} {...props} />
));
Button.displayName = "Button";
