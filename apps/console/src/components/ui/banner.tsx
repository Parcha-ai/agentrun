import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

export type BannerTone = "neutral" | "info" | "success" | "warning" | "error";

const TONE: Record<BannerTone, { box: string; text: string; Icon: typeof Info }> = {
  neutral: { box: "border-border bg-card", text: "text-foreground", Icon: Info },
  info: { box: "border-info/50 bg-info/5", text: "text-info-text", Icon: Info },
  success: { box: "border-success/50 bg-success/5", text: "text-success-text", Icon: CircleCheck },
  warning: { box: "border-warning/50 bg-warning/5", text: "text-warning-text", Icon: TriangleAlert },
  error: { box: "border-destructive/50 bg-destructive/5", text: "text-destructive-text", Icon: CircleAlert },
};

/** A message that stays on the page until its cause is gone: what happened, in words, and what to do about it.
 *  The tone is said by an icon as well as by colour (the title's and the border's in a box, the icon's in a bar).
 *  `bar`: a strip across the top of the shell (the link to the server, a failed sign-out) in place of a box in the page.
 *  An error interrupts a screen reader (`role="alert"`); every other tone waits its turn (`role="status"`).
 *  A message that goes away by itself is a toast. */
export function Banner({ tone = "neutral", title, actions, bar, icon, role, className, children, ...rest }: {
  tone?: BannerTone; title?: React.ReactNode; actions?: React.ReactNode; bar?: boolean; icon?: typeof Info | false; role?: "alert" | "status" | "note";
  className?: string; children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title" | "role">) {
  const t = TONE[tone];
  const Icon = icon === false ? null : icon ?? t.Icon;
  return (
    <div role={role ?? (tone === "error" ? "alert" : "status")} {...rest}
      className={cn("flex gap-3 text-body", bar ? "shrink-0 items-center border-b bg-card px-5 py-2 md:px-8" : cn("border p-4", t.box), className)}>
      {Icon && <Icon className={cn("size-4 shrink-0", !bar && "mt-0.5", t.text)} aria-hidden />}
      <div className="min-w-0 flex-1">
        {title && <p className={cn("font-semibold", !bar && "caps text-small", !bar && t.text)}>{title}</p>}
        {children && <div className={cn(title && !bar && "mt-2")}>{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-start gap-2">{actions}</div>}
    </div>
  );
}
