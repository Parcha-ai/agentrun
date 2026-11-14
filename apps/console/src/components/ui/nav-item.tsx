import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** One place in the navigation: an icon and a name. The one you are on has a rounded brand wash and says so to a
 *  screen reader (`aria-current="page"`). At least 44px tall, for a thumb. */
export function NavItem({ icon: Icon, active, className, children, ...props }: { icon?: LucideIcon; active?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-current={active ? "page" : undefined} {...props}
      className={cn("flex min-h-11 items-center gap-2.5 p-3 text-left text-body -outline-offset-2 hover:bg-accent", active && "!rounded-action bg-primary/[0.06] text-primary-text hover:bg-primary/10", className)}>
      {Icon && <Icon className="size-4 shrink-0" aria-hidden />} {children}
    </button>
  );
}
