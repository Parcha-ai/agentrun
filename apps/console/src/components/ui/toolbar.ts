/** A page with a top bar. Beside the sidebar (`roomy:`) it is exactly as tall as the shell's main, so main never scrolls
 *  it and the bar stays in view, its bottom edge on the edge under the navigation's logo row. In a smaller window (a
 *  phone, upright or on its side) there is no logo row to meet, and a bar whose actions wrap is tall (Triggers' is
 *  197px at 390px wide): there the page is at least main's height and scrolls in main as a whole, bar and all. Put the
 *  bar first, then the body in `pageBodyClass`. */
export const pageClass = "flex min-h-full flex-col roomy:h-full roomy:min-h-0";

/** The body under a page's top bar: beside the sidebar, the one box that scrolls. Positioned, so what is placed
 *  absolutely inside it (an `sr-only` label) scrolls with it instead of reaching past main and scrolling the page. A
 *  centred column goes inside it, so the scrollbar sits at the page's edge, not the column's. */
export const pageBodyClass = "relative roomy:min-h-0 roomy:flex-1 roomy:overflow-auto";

/** The bar across the top of a page: 48px with `control-sm` controls in it, so its bottom edge meets the edge under the
 *  navigation's logo row (Shell, h-12). Its padding leaves room for a 32px control and no more; where the bar is too
 *  narrow, its controls wrap onto more rows and it grows. Add the page's own `px-*`, `gap-*` and `flex-wrap`. */
export const pageToolbarClass = "flex min-h-12 shrink-0 items-center border-b py-1.5";

/** A section's name in its page's top bar (Mission Control, Runs, Triggers): mono caps at body size, after its 16px icon.
 *  A bar that names one thing (an agent, a run) shows that name in its own type instead. */
export const pageTitleClass = "caps flex items-center gap-2 text-body font-semibold";
