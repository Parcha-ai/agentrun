/** A page with a top bar: exactly as tall as the shell's main, so main never scrolls it and the bar stays in view. Put the
 *  bar first, then the body in `pageBodyClass`. */
export const pageClass = "flex h-full min-h-0 flex-col";

/** The body under a page's top bar: the one box that scrolls. Positioned, so what is placed absolutely inside it (an
 *  `sr-only` label) scrolls with it instead of reaching past main and scrolling the page. A centred column goes inside
 *  it, so the scrollbar sits at the page's edge, not the column's. */
export const pageBodyClass = "relative min-h-0 flex-1 overflow-auto";

/** The bar across the top of a page: 48px with `control-sm` controls in it, so its bottom edge meets the edge under the
 *  navigation's logo row (Shell, h-12). Its padding leaves room for a 32px control and no more; where the bar is too
 *  narrow, its controls wrap onto more rows and it grows. Add the page's own `px-*`, `gap-*` and `flex-wrap`. */
export const pageToolbarClass = "flex min-h-12 shrink-0 items-center border-b py-1.5";

/** A section's name in its page's top bar (Mission Control, Runs, Triggers): mono caps at body size, after its 16px icon.
 *  A bar that names one thing (an agent, a run) shows that name in its own type instead. */
export const pageTitleClass = "caps flex items-center gap-2 text-body font-semibold";
