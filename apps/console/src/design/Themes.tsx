import type { ReactNode } from "react";

/** A story shown twice, light beside dark, so a change is seen in both themes at once. Each panel carries its theme's
 *  class, which sets every token under it (tokens.css). */
export function Themes({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen grid-cols-1 xl:grid-cols-2">
      {(["light", "dark"] as const).map((theme) => (
        <section key={theme} data-theme={theme} className={`${theme} min-w-0 bg-background p-6 text-foreground md:p-8`}>
          <p className="caps mb-6 border-b pb-2 text-label text-muted-foreground">{theme}</p>
          <div className="space-y-8">{children}</div>
        </section>
      ))}
    </div>
  );
}

/** A titled block of a design-system story. */
export function Block({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h2 className="caps text-small font-semibold">{title}</h2>
      {note && <p className="mt-1 max-w-prose text-small text-muted-foreground">{note}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}
