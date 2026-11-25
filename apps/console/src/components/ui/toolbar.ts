/** The bar across the top of a page: 48px with `control-sm` controls in it, so its bottom edge meets the edge under the
 *  navigation's logo row (Shell, h-12). Its padding leaves room for a 32px control and no more; where the bar is too
 *  narrow, its controls wrap onto more rows and it grows. Add the page's own `px-*`, `gap-*` and `flex-wrap`.
 *  Beside the sidebar (`roomy:`) the bar stays where it is: its page's frame fills the page and never scrolls
 *  (`roomy:h-full roomy:min-h-0`), and what is under the bar scrolls in a pane of its own (`roomy:min-h-0 roomy:flex-1
 *  roomy:overflow-auto`). A bar that scrolled with its page would leave that edge as soon as the page moved (the
 *  `top-bars` browser flow measures every page). A smaller window has no logo row to meet and little height to give a
 *  bar whose actions wrap: there the page scrolls as a whole, bar and all. */
export const pageToolbarClass = "flex min-h-12 shrink-0 items-center border-b py-1.5";

/** A section's name in its page's top bar (Mission Control, Runs, Triggers): mono caps at body size, after its 16px icon.
 *  A bar that names one thing (an agent, a run) shows that name in its own type instead. */
export const pageTitleClass = "caps flex items-center gap-2 text-body font-semibold";
