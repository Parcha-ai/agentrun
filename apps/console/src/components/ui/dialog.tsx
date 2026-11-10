import { Description, Dialog as HeadlessDialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";
import type * as React from "react";
import { useRef } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SIZE = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-3xl", full: "h-full max-w-5xl" } as const;

/** A modal dialog: the page dims and stops answering, the keyboard stays inside the panel, Escape or a press outside
 *  closes it, and the focus goes back to what opened it. The title names it for a screen reader and `description`
 *  describes it. `footer`: its actions, the main one last. `initialFocus`: what the keyboard starts on (else the first
 *  control). Use it for a task that must finish or be dropped before anything else; a question about one row of a page
 *  is asked in the page. */
export function Dialog({ open, onClose, title, description, footer, size = "md", initialFocus, hideClose, className, children }: {
  open: boolean; onClose: () => void; title: React.ReactNode; description?: React.ReactNode; footer?: React.ReactNode; size?: keyof typeof SIZE;
  initialFocus?: React.RefObject<HTMLElement | null>; hideClose?: boolean; className?: string; children?: React.ReactNode;
}) {
  return (
    <HeadlessDialog open={open} onClose={onClose} initialFocus={initialFocus as React.MutableRefObject<HTMLElement | null> | undefined} className="relative z-dialog">
      <DialogBackdrop className="fixed inset-0 bg-overlay/70" />
      <div className={cn("fixed inset-0 flex justify-center p-4 md:p-8", size === "full" ? "items-stretch" : "items-start overflow-y-auto pt-[12vh]")}>
        <DialogPanel className={cn("flex w-full flex-col border border-border-strong bg-background text-foreground shadow-float", SIZE[size], className)}>
          <header className="flex items-start gap-3 border-b px-5 py-4">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
              {description && <Description className="mt-1 text-body text-muted-foreground">{description}</Description>}
            </div>
            {!hideClose && <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close"><X aria-hidden /></Button>}
          </header>
          {children && <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-body">{children}</div>}
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</footer>}
        </DialogPanel>
      </div>
    </HeadlessDialog>
  );
}

/** "Are you sure?" for an action that cannot be undone: what will happen, in words, then Cancel and the action by its
 *  own name ("Delete agent", never "OK"). The keyboard starts on Cancel, so Enter never destroys anything by habit.
 *  `busy`: the action is under way; both buttons wait. */
export function ConfirmDialog({ open, title, confirm, cancel = "Cancel", tone = "destructive", busy, onConfirm, onCancel, children }: {
  open: boolean; title: React.ReactNode; confirm: React.ReactNode; cancel?: React.ReactNode; tone?: Extract<ButtonProps["variant"], "destructive" | "solid">;
  busy?: boolean; onConfirm: () => void; onCancel: () => void; children?: React.ReactNode;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onClose={busy ? () => {} : onCancel} title={title} size="sm" hideClose initialFocus={cancelButton}
      footer={<>
        <Button ref={cancelButton} size="sm" onClick={onCancel} disabled={busy}>{cancel}</Button>
        <Button size="sm" variant={tone} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>{confirm}</Button>
      </>}>
      {children}
    </Dialog>
  );
}
