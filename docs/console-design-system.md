# The console's design system

How the AgentRun console (`apps/console`) looks and behaves, and how to keep a change inside it. Read this before
you add or restyle anything a person sees there.

- **Tokens** are in `apps/console/src/tokens.css`: every colour, size, duration and layer has one value, there.
- **Primitives** are in `apps/console/src/components/ui`: one component for each control and message.
- **The catalogue** is the Storybook (`npm run storybook` in `apps/console`, port 6006), under "Design system".
  It shows every token and every primitive in the light and the dark theme, side by side.
- **The checks** are `src/design-system.test.ts`, `src/design-system.sources.test.ts`, `src/lib/utils.test.ts` and
  `src/components/ui/primitives.test.tsx`. `npm test` in `apps/console` runs them, and a line that breaks a rule
  fails with what to write instead.

## The look, in six rules

1. **Rounded actions, square fields and surfaces.** Every action button uses the same 8px radius.
2. **One line weight.** Borders are 1px. 2px marks the open tab and where the
   keyboard is (the focus ring). Nothing else is thicker.
3. **Mono for structure, sans for prose.** JetBrains Mono for labels, buttons, chips, ids, numbers and code. Schibsted
   Grotesk for sentences. Two weights: 400 and 600.
4. **Orange means AgentRun is acting or you can act.** Each toolbar or form has at most one highlighted main action,
   with a translucent orange fill (`Button variant="primary"`), including coding-agent handoffs. Place it last at the
   far right of the toolbar, after secondary actions. Secondary controls stay
   neutral; destructive actions use their own tone. Do not give adjacent actions equal primary emphasis.
   Orange words are `text-primary-text`. Never use orange for decoration.
5. **Flat.** One shadow exists (`shadow-float`), only under what floats over the page.
6. **Light and dark are equals.** Every token has both values, and every story shows both.

## Before you write UI

1. Find the need in [Which primitive](#which-primitive). Use that primitive.
2. If nothing fits, look for the nearest pattern in the Storybook and compose primitives.
3. Add a primitive only when a control or a message appears in two places and no primitive covers it. A new
   primitive comes with a story in `Primitives.stories.tsx`, a test of what it promises a keyboard and a screen
   reader, and a row in this guide.
4. Use token classes only. If a value you need has no token, the answer is nearly always an existing step. A new
   token is a change to this guide, to `tokens.css`, to `tailwind.config.ts` and to `src/design/tokens.ts` together.

## Tokens

### Colour

A colour class is a token name: `bg-card`, `text-muted-foreground`, `border-border-strong`. Any of them takes an
alpha: `bg-primary/10`. Never write a hex value, `rgb()`, `hsl()`, `white`, `black` or a Tailwind palette colour
(`gray-500`).

| Token | Class | For |
| --- | --- | --- |
| `background`, `foreground` | `bg-background`, `text-foreground` | The page and its text. |
| `card`, `card-foreground` | `bg-card` | A panel raised off the page: a card, a banner bar, a toast. |
| `muted`, `muted-foreground` | `bg-muted`, `text-muted-foreground` | A quiet surface (inline code); secondary text. |
| `accent`, `accent-foreground` | `hover:bg-accent` | The hover surface of a neutral control. |
| `overlay` | `bg-overlay/70` | What dims the page under a dialog. |
| `primary`, `primary-foreground` | `bg-primary text-primary-foreground` | The brand fill and the text on it. |
| `primary-text` | `text-primary-text` | Orange words and icons on a page surface. |
| `primary-action-text` | `text-primary-action-text` | Primary action labels, readable on the 10% fill and 20% hover/open fill. |
| `success`, `warning`, `destructive`, `info` | `bg-success/10`, `border-warning/50` | A tone's fill, border or dot. |
| `success-text`, `warning-text`, `destructive-text`, `info-text` | `text-success-text` | Words in a tone. |
| `border`, `border-strong` | `border`, `border-border-strong` | A dividing line; the edge of a hovered or floating thing. |
| `input` | `border-input` | A field's own edge. It is 3:1 against the page. |
| `ring` | (the global focus rule) | The keyboard focus ring. |
| `run-active`, `run-error-surface` | `text-run-active`, `bg-run-error` | A working run; a failed run's panel. |
| `wf-jev`, `wf-parallel`, `wf-openrouter`, `wf-tool`, `wf-exit` | `text-wf-jev` | The workflow graph: who does a step's work. |
| `chart-agent`, `chart-handed-back`, `chart-workflow` | `fill-chart-agent` | A chart's series, in this order: the path a run took. Marks only; words stay `text-foreground`. |
| `trace-model`, `trace-tool` | `bg-trace-model` | A run's trace: a model request's bar and a tool call's. Marks only; a word beside each says which, and a failed span is `destructive`. A mark is never told by its hue alone: one that failed is striped (`trace-hatch`), one that waits is hollow, and a light part has an edge. Every mark carries `trace-mark`, an edge that shows only under forced colours, where a fill is not drawn. |

**A tone is a pair.** The bare name fills, borders and dots. The `-text` name writes words. `text-success` on a
white page fails contrast; `text-success-text` passes. The same holds for orange: `text-primary` is for a mark on a
dark fill only, and words are `text-primary-text`.

**Tone is never colour alone.** A status also has a word (a Chip's text) or an icon (a Banner's).

### Type

| Class | Size | For |
| --- | --- | --- |
| `text-micro` | 10px | A chip, a badge on the workflow graph. |
| `text-label` | 11px | A caps label, a table heading, the smallest button. |
| `text-small` | 12px | A button, a tab, a note under a field, metadata. |
| `text-body` | 13px | The console's text: rows, fields, paragraphs in a panel. |
| `text-lead` | 14px | A page's opening sentence, prose in a card. |
| `text-prose` | 15px | Long text someone reads: an answer, a note. |
| `text-base` | 16px | A report's paragraphs, a callout's first line. |
| `text-lg` | 18px | A section heading. |
| `text-xl` | 20px | A panel or dialog title, a run's title. |
| `text-figure` | 22px | A headline number, the wordmark. |
| `text-2xl` | 24px | The page title: one `h1` a page. |
| `text-display` | 32px | A report's title. |

- These are the only sizes. `text-sm`, `text-xs` and `text-[13px]` are not on the scale.
- `.caps` is mono, uppercase and tracked: buttons, tabs, chips and small labels. Never write `uppercase
  tracking-*` by hand.
- Weights are `font-normal` and `font-semibold`. The bundled fonts carry no other weight.
- A page has one `h1`. Headings go down in order: `h1`, `h2`, `h3`.
- A heading under the title is one of three: a section's (`text-lg font-semibold`), a panel's label (`caps text-small
  font-semibold`), or a card's name for the thing it holds (`text-prose font-semibold`).

### Space and size

Space is Tailwind's 4px scale. These habits keep pages alike:

| Where | Class |
| --- | --- |
| A page's gutter | `p-5 md:p-8` (or `px-5 md:px-8` on a full-width bar). Every page's text starts on it and its content ends on it: a page fills the width it has, and a row of tabs puts its first label on it |
| Between a page's panels | `gap-6` or `space-y-6` |
| Inside a panel or a card | `p-4` |
| Between controls in a row | `gap-2`; between a control and its words, `gap-3` |
| Between a label and its field | `mb-2` (the `Field` primitive sets it) |

| Token | Class | Value | For |
| --- | --- | --- | --- |
| `control-sm` | `h-control-sm` | 32px | A toolbar, a table row, a dialog's footer. |
| `control-md` | `h-control-md` | 40px | A form's fields and buttons. The default. |
| `control-lg` | `h-control-lg` | 44px | The one action of an empty page or the sign-in page. |
| `sidebar-width` | `w-sidebar` | 220px | The navigation. |
| `page-width` | `max-w-page` | 1100px | A page that is one message: what a template made. |
| `page-width-wide` | `max-w-page-wide` | 1600px | Kept for a panel that must not grow past it. No page uses it: a page fills its width. |

Controls in one row share one height. A target someone taps is at least 24px each way, and 44px in the navigation;
a small link in a row gets there with padding the layout does not see (`-my-1 py-1`).

### Lines, corners, shadow

- `border` is the 1px line in `--border`. Use `border-border-strong` for the edge of a hovered or floating thing and
  `border-input` for a field.
- `border-b-2` marks the open tab. The active sidebar item uses a rounded tint without a leading bar.
- The stylesheet squares fields and surfaces by default. `Button` and `buttonVariants` use `!rounded-action`
  (`--radius-action: 0.5rem`) for every action, including links, icon buttons and menu triggers. The coding-agent
  action uses the same radius on its single outer edge; its main action and chooser stay square inside that edge.
  Its tinted main action and chooser share the foreground, hover, open and focus treatment across the whole group,
  with no internal divider. Compact row actions keep the neutral secondary treatment.
- `shadow-float` goes under a menu, a picker's list, a tip, a toast and a dialog. Nothing in the page's flow has a
  shadow.

### Layers

| Class | For |
| --- | --- |
| `z-raised` | Over its neighbours in one panel: a chart's hover label. |
| `z-sticky` | Stays while the page scrolls under it. |
| `z-overlay` | A scrim of your own over the page. `Dialog` draws its own. |
| `z-dialog` | A dialog's panel, a full-screen viewer. |
| `z-popover` | A menu, a picker's list, a tip. Above a dialog, which can open one. |
| `z-toast` | A toast, over everything. |

Never write a number (`z-50`, `z-[60]`).

### Motion

| Class | Value | For |
| --- | --- | --- |
| `duration-fast` | 150ms | A hover, a switch, a colour change. The default of `transition-*`. |
| `duration-base` | 250ms | A panel, a toast or a menu arriving. |
| `duration-slow` | 400ms | A state settling: a graph node changing colour, a bar growing. |

- Motion says that something changed. It is never decoration, and nothing loops except "work in progress".
- The stylesheet turns every animation and transition off for someone whose OS asks for reduced motion. Do not
  work around it. A spinner then stands still, so the words beside it must say what is happening.

The AgentRun wordmark is a transparent SVG. Its lettering uses the foreground token, and its orange mark stays fixed.

## Themes

The console follows the OS (light or dark) until the person picks Light or Dark in the sidebar; the pick is kept in
this browser (`src/lib/theme.ts`). The theme is a class on `<html>`: `dark` or `light`. A dark OS paints dark before
any script runs.

- Tokens change with the theme. A component never checks the theme and never uses a `dark:` variant for colour.
- Check every change in both themes. The Storybook's design-system stories show them side by side.

## Which primitive

Import from `@/components/ui`.

| Need | Use | Not |
| --- | --- | --- |
| An action | `Button`: `primary` (one translucent-orange main action per toolbar or form, last at the far right in top toolbars; `solid` is a legacy alias), `outline` (default), `ghost`, `destructive`; sizes `xs`, `sm`, `md`, `lg`, `icon` | A `<button>` with its own border and caps. |
| A row or a card someone presses | A plain `<button>` or `<a>` with `hover:bg-accent` and `text-left` | `Button`. |
| A state or a kind | `Chip` with a tone; a run's state through `StatusBadge` | A hand-built span. |
| A text field | `Field` around `Input` or `Textarea`. `note` goes before the control, `hint` after it | A bare `<input>` with its own classes. |
| A field with an icon or buttons inside its edge | A box with `fieldBoxClass` around `<Input bare>` or `<Textarea bare>` | A field with `outline-none` and no focus of its own. |
| A choice from a list | `Picker` (opens under its field), for every list; inside a `Field` the label, hint and error are wired to it. An option's `description` shows a visible explanation below its label, including why a disabled choice is unavailable. `steady` where the field is sized by its words: it keeps the width of its longest option whatever is picked, and no option wraps in its list | A bare `<select>`. |
| A choice from a long list (a toolkit's events, its actions) | `SearchPicker`: a `Picker` whose field is a search box. Typing filters its open list by every word typed, in an option's words or its `keywords` (a slug, a description); the chevron opens the whole list; Enter never submits the form; `nothing(query)` says when nothing matches | A filter box of its own beside a `Picker`. |
| One value out of a run of whole steps (a revision) | `Slider`: a native range, quiet (a thin `border-strong` track, a small `foreground` dot), with a `label` and a `valueText` in words | A bare `<input type="range">`. |
| One choice of a few, all in view | `Segmented`; `Radio`s in a `<Field group>` when each needs a sentence | Buttons that look like tabs. |
| Any of several | `Checkbox`; a native input with `accent-primary` where a row has its own layout | |
| On or off, taking effect at once | `Switch` | A checkbox. |
| A page's views | `Tabs`, with `tabPanelProps(id, value)` on the panel so each names the other. A row of links that reads as tabs (Settings) uses `tabListClass` and `tabClass` | |
| A place in the navigation | `NavItem` | |
| A message that stays until its cause is gone | `Banner`; `bar` for the strip across the top of the shell | A coloured paragraph. |
| A word that what you just did worked | `useToast()` | A banner that removes itself. |
| A task that must finish or be dropped first | `Dialog` | A fixed `div`. |
| "Are you sure?" before something that cannot be undone | `ConfirmDialog`; for one row's action, an inline `role="alertdialog"` in the row, as below | `window.confirm`. |
| Actions behind one button | `Menu` with `MenuItem`s | A `Picker`. |
| A few more words on hover | `Tip` | A `title` as the only way to learn something. |
| Work with no length to show | `Spinner`, with words beside it | A spinner alone. |

### Patterns built from primitives

- **A toned panel** is a card that asks for something: an approval, a question, a paused run. It is
  `border border-warning/50 bg-warning/5 p-4` with a `caps text-label text-warning-text` heading, and holds
  `Button`s and fields. A message with no controls of its own is a `Banner`.
- **A read that failed** is `<Banner tone="error" actions={<Button size="xs">Try again</Button>}>` with the server's
  words in a `font-mono` paragraph.
- **An inline confirm** replaces a row's button with the question, the action by name and Cancel, in a
  `role="alertdialog"` with an `aria-label`. The keyboard starts on Cancel, Escape cancels, and the focus returns to
  the button. The shell's "Sign out everywhere" is the model.
- **The file viewer** (`RunFiles.tsx`) is a native `<dialog>` opened with `showModal()`. It predates `Dialog` and
  keeps its own press-outside rule; new dialogs use `Dialog`.

### Messages: which one

| The person needs to… | Use | Role |
| --- | --- | --- |
| know that their last action worked | Toast, neutral or success | `status` |
| know that their last action failed, with nothing to fix on the page | Toast, error (it stays) | `alert` |
| fix a field | The `Field`'s `error` | `alert` |
| know a part of the page could not be read, and try again | `Banner tone="error"` with a "Try again" `Button` | `alert` |
| know a standing condition (no model key, offline) | `Banner` (`bar` in the shell) | `status` |
| decide before something irreversible | `ConfirmDialog` | dialog |

An error says what happened, why if the server said, and what to do next. It never only says "Something went wrong".

### States every control has

| State | Treatment |
| --- | --- |
| Hover, neutral control | `hover:bg-accent`; an outlined control also `hover:border-border-strong` |
| Hover, toned control | A primary action's wash strengthens from 10% to 20% (`hover:bg-primary/20`); destructive actions use `hover:bg-destructive/10` |
| Hover, quiet text action | `text-muted-foreground hover:text-foreground` |
| Hover, link in prose | `underline underline-offset-2` always; links are not marked by colour alone |
| Focus (keyboard) | The global ring: 2px, the text colour, 2px off the control. A field's ring sits on its edge. |
| Selected, in a set | Inverted (`bg-foreground text-background`) in a `Segmented`; a brand underline in `Tabs`; a rounded brand wash in `NavItem` |
| Disabled | `disabled:opacity-45 disabled:cursor-not-allowed`, and say why nearby when it is not obvious |
| Busy | `aria-busy`, the control disabled, its label saying what is happening ("Saving") |
| Refused field | `aria-invalid`, a red edge, and the `Field`'s error under it |

Never write `outline-none` without a `focus-visible:` replacement drawn with the ring tokens.

## Layout and responsiveness

- **The shell** is a 220px sidebar and a main column. The `roomy:` variant shows the sidebar at 768px wide and 501px tall; smaller or shorter windows use a top bar with a menu.
  Banners sit above the page, outside its scroller.
- **A page's top bar stays in view beside the sidebar.** A page with a top bar (`pageToolbarClass`) is `pageClass`:
  where the sidebar shows (`roomy:`) it is exactly as tall as `main`, the bar first, then the body in `pageBodyClass`
  (marked `data-page-body`), the box that scrolls. `main` never scrolls such a page there, or the bar would go with it.
  In a window too small for the sidebar (a phone, upright or on its side) a `pageClass` page scrolls in `main` as a
  whole, bar and all: there is no logo row for the bar to meet, and a bar whose actions wrap would hold much of the
  screen (Triggers' is 197px at 390px wide). A page made of panes (Mission Control, a run, an agent, the
  Playground) scrolls each pane in its own box under the bar. A Settings page scrolls in its own `h-full overflow-auto`
  box under the Settings tabs. A page with no top bar (Build an agent, a trigger's page) scrolls in `main`. A run's page
  on a `short:` window scrolls as a whole, so its panels are not squeezed to nothing. `e2e/flows/page-frames.mjs`
  measures every page with a bar.
- **Breakpoints** are Tailwind's: write mobile first and add `md:` for the desktop layout. `max-sm:` tightens a
  phone. `short:` is for a viewport at most 500px tall (a phone on its side). `roomy:` combines a minimum width of 768px and height of 501px for the desktop shell. Do not add a breakpoint.
- **A part beside a panel** is laid out by the width of its pane, not the window's: a panel that takes part of the page
  leaves the rest a width no breakpoint knows. Put `@container` on the pane and `@4xl:` (the pane is 56rem wide) or
  `@5xl:` (64rem) on the part. The Dev tools table shows its time axis and its Size column this way beside an open call.
  The stylesheet writes these before the breakpoints, so one never undoes a breakpoint's class: write the breakpoint's
  side as a range (`hidden max-xl:table-cell @4xl:table-cell`). Do not add a width.
- **Widths.** A page fills the width it has, so nothing is left empty beside it on a wide screen. What changes with
  the width is how its parts are laid out, never a margin:
  - A page of data (Mission Control, a list, a table) is fluid: its tables stretch and its card grids take more columns.
  - A form's fields flow in columns: `formColumnsClass` on the box that holds them (one column, two from `xl`, three
    from `2xl`), filled top to bottom so the order read is the order Tab takes.
  - A Settings page keeps its title and sentence above, then its sections one under another, each a
    `SettingsSection`: from `xl` a row with the section's name, sentence and adding actions on the left and its
    settings on the right. Every box on every Settings page starts at one edge and has one width. One that is a
    table (Tools) is full width.
  - A reading column (a run's report and timeline) is centred, at most `max-w-4xl`.
  - A run's Screen tab is the reading column's width while its screen is alone. With the run's steps beside the screen
    (from `xl`) it is at most `max-w-7xl`: wider by about the list, so the screen keeps the size it had alone and
    grows no further.
  - A line of prose is at most `max-w-prose`. Never write a width as a number (`max-w-[1100px]`).
- A page works at 390px wide with no sideways scroll. A wide table scrolls inside its own panel, and so does a row
  of tabs (`tabListClass`).

## Accessibility

These hold for every change. The primitives already do them; keep them when you compose.

- Text passes 4.5:1 and a field's edge and the focus ring pass 3:1, in both themes. The test measures every pair in
  `src/design/tokens.ts`. Add a pair there when you put a text token on a new surface.
- Everything works from the keyboard, in reading order, with a visible focus ring. The shell's first stop is "Skip to
  the page". A set of like things (a chart's days, a row of tabs) is one stop, and the arrows move inside it.
- A box that scrolls and holds no control (a wide table, a block of code) takes the focus itself: `tabIndex={0}` with
  a `role="region"` and a name.
- The browser's tab names the place ("Runs · AgentRun"); the shell sets it.
- A control has a name: a `<label>`, visible text, or `aria-label` on an icon button. An icon beside words is
  `aria-hidden`.
- A dialog traps the keyboard, closes on Escape and gives the focus back to what opened it.
- A message that appears is announced: `role="alert"` for an error, `role="status"` for the rest.
- Colour is never the only signal.
- Motion respects the OS's reduced-motion setting.

## Checks

| Check | What it holds |
| --- | --- |
| `src/design-system.test.ts` | Every colour token has a light and a dark value. Tailwind names only tokens. The type scale, layers, durations and weights match this guide. Every text pair is 4.5:1 and every edge pair 3:1, in both themes. |
| `src/design-system.sources.test.ts` | The console's own sources: no literal or palette colour, no size off the type scale, no weight but the two, no numbered layer, no unscoped rounded corner, no shadow but `shadow-float`, no duration off the scale, no page width as a number, no `uppercase` by hand, no `dark:` variant, no `outline-none` without a replacement, no hand-built button or field outside `components/ui`, and no checkbox or radio without `accent-primary`. An exception is listed in the test with its reason, and a listed exception that no longer applies fails. |
| `src/lib/utils.test.ts` | `cn()` knows the console's scales, so `text-body text-primary-text` keeps both classes. |
| `src/components/ui/primitives.test.tsx` | Each primitive's keyboard and screen-reader contract, and that every design-system story renders in both themes. |

After a change to a token, also look: `npm run storybook`, then "Design system / Foundations / Contrast".

## The catalogue over MCP, and stories as tests

`npm run storybook` in `apps/console` also serves the catalogue to coding agents over MCP, at
`http://127.0.0.1:6006/mcp` (Streamable HTTP; add it to an agent as an HTTP MCP server, on an AgentRun started with
`AGENTRUN_MCP_ALLOW_LOOPBACK=1`, which a server needs before it takes an MCP server on loopback: set it only on a machine
you alone use). Its tools list the components
and stories (`docs-list`), show a component's or a story's documentation (`docs-show`, `docs-show-story`), find the
stories that render a source file (`stories-find-by-component`) or that changed (`stories-changed`), give a story's
preview URL (`stories-preview`), say how to write a story (`get-storybook-story-instructions`), and run story tests
(`test-run`).

`npm run test-storybook` runs every story as a test in headless Chromium: a story passes when it renders without an
error. The first run on a machine needs the browser: `npx playwright install chromium`. `npm test` does not run them;
CI's console job builds the Storybook but does not run its stories.
