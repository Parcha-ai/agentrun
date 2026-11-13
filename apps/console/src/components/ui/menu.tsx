import { Menu as HeadlessMenu, MenuButton, MenuItem as HeadlessMenuItem, MenuItems } from "@headlessui/react";
import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A list of actions behind one button (the "more" of a row, an account's actions). `trigger` is what the button
 *  shows; `label` names it when that is an icon alone. The list opens under the button and stays in the viewport. Up
 *  and Down move, letters jump, Enter does the action, Escape closes and gives the focus back. A menu holds actions; a
 *  choice of one value is a Picker. */
export function Menu({ trigger, label, variant = "outline", size = "sm", align = "end", className, children }: {
  trigger: React.ReactNode; label?: string; variant?: ButtonProps["variant"]; size?: ButtonProps["size"]; align?: "start" | "end"; className?: string; children: React.ReactNode;
}) {
  return (
    <HeadlessMenu>
      <MenuButton as={Button} variant={variant} size={size} aria-label={label}>{trigger}</MenuButton>
      <MenuItems anchor={align === "end" ? "bottom end" : "bottom start"}
        className={cn("z-popover min-w-[12rem] border border-border-strong bg-background py-1 font-mono text-body shadow-float outline-none [--anchor-gap:2px] [--anchor-padding:8px]", className)}>
        {children}
      </MenuItems>
    </HeadlessMenu>
  );
}

/** One action of a Menu. `tone="destructive"` for the one that deletes; keep it last, under a rule. */
export function MenuItem({ icon: Icon, tone, disabled, onSelect, children }: { icon?: LucideIcon; tone?: "destructive"; disabled?: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <HeadlessMenuItem disabled={disabled}>
      <button type="button" onClick={onSelect}
        className={cn("flex min-h-control-md w-full items-center gap-2 px-3 py-2 text-left data-[disabled]:cursor-not-allowed data-[focus]:bg-accent data-[disabled]:opacity-45", tone === "destructive" && "text-destructive-text")}>
        {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
        <span className="min-w-0">{children}</span>
      </button>
    </HeadlessMenuItem>
  );
}

/** A rule between groups of a Menu's actions. */
export const MenuSeparator = () => <div role="separator" className="my-1 border-t" />;
