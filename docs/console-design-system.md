# The console's design system

How the AgentRun console (`apps/console`) looks and behaves, and how to keep a change inside it. Read this before
you add or restyle anything a person sees there.

- **Tokens** are in `apps/console/src/tokens.css`: every colour, size, duration and layer has one value, there.
- **Primitives** are in `apps/console/src/components/ui`: one component for each control and message.
- **The catalogue** is the Storybook (`npm run storybook` in `apps/console`, port 6006), under "Design system".
  It shows every token and every primitive in the light and the dark theme, side by side.
- **The checks** are `src/design-system.test.ts`, `src/lib/utils.test.ts` and `src/components/ui/primitives.test.tsx`.
  `npm test` in `apps/console` runs them.

## The look, in six rules

1. **Square.** Every corner is 0. No class rounds anything.
2. **One line weight.** Borders are 1px. 2px marks where you are (the open tab, the active nav item) and where the
   keyboard is (the focus ring). Nothing else is thicker.
3. **Mono for structure, sans for prose.** JetBrains Mono for labels, buttons, chips, ids, numbers and code. Schibsted
   Grotesk for sentences. Two weights: 400 and 600.
4. **Orange means AgentRun is acting or you can act.** The fill (`bg-primary`) is for the page's one main button and
   for marks. Orange words are `text-primary-text`. Never use orange for decoration.
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
| `success`, `warning`, `destructive`, `info` | `bg-success/10`, `border-warning/50` | A tone's fill, border or dot. |
| `success-text`, `warning-text`, `destructive-text`, `info-text` | `text-success-text` | Words in a tone. |
| `border`, `border-strong` | `border`, `border-border-strong` | A dividing line; the edge of a hovered or floating thing. |
| `input` | `border-input` | A field's own edge. It is 3:1 against the page. |
| `ring` | (the global focus rule) | The keyboard focus ring. |
| `run-active`, `run-error-surface` | `text-run-active`, `bg-run-error` | A working run; a failed run's panel. |
| `wf-jev`, `wf-parallel`, `wf-openrouter`, `wf-tool`, `wf-exit` | `text-wf-jev` | The workflow graph: who does a step's work. |

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
- A page has one `h1` (`text-2xl font-semibold`). Headings go down in order: `h1`, `h2`, `h3`.

### Space and size

Space is Tailwind's 4px scale. These habits keep pages alike:

| Where | Class |
| --- | --- |
| A page's gutter | `p-5 md:p-8` (or `px-5 md:px-8` on a full-width bar) |
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
| `page-width` | `max-w-page` | 1100px | A page of forms or text. |
| `page-width-wide` | `max-w-page-wide` | 1600px | A page of data: Mission Control, a run. |

Controls in one row share one height. A target someone taps is at least 24px each way, and 44px in the navigation.

### Lines, corners, shadow

- `border` is the 1px line in `--border`. Use `border-border-strong` for the edge of a hovered or floating thing and
  `border-input` for a field.
- `border-b-2` (or an inset 2px bar) marks the open tab and the active nav item. Nothing else.
- No `rounded-*` class. The stylesheet squares every element.
- `shadow-float` goes under a menu, a picker's list, a tip, a toast and a dialog. Nothing in the page's flow has a
  shadow.

### Layers

| Class | For |
| --- | --- |
| `z-raised` | Over its neighbours in one panel: a chart's hover label. |
| `z-sticky` | Stays while the page scrolls under it. |
| `z-overlay` | What dims the page under a dialog. |
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
| An action | `Button`: `solid` (the page's one main action), `primary`, `outline` (default), `ghost`, `destructive`; sizes `xs`, `sm`, `md`, `lg`, `icon` | A `<button>` with its own border and caps. |
| A row or a card someone presses | A plain `<button>` or `<a>` with `hover:bg-accent` and `text-left` | `Button`. |
| A state or a kind | `Chip` with a tone; a run's state through `StatusBadge` | A hand-built span. |
| A text field | `Field` around `Input` or `Textarea` | A bare `<input>` with its own classes. |
| A choice from a list | `Picker` (opens under its field); `NativeSelect` for a short list in a dense row | A bare `<select>`. |
| One choice of a few, all in view | `Segmented`; `Radio`s in a `<Field group>` when each needs a sentence | Buttons that look like tabs. |
| Any of several | `Checkbox` | |
| On or off, taking effect at once | `Switch` | A checkbox. |
| A page's views | `Tabs` | |
| A place in the navigation | `NavItem` | |
| A message that stays until its cause is gone | `Banner`; `bar` for the strip across the top of the shell | A coloured paragraph. |
| A word that what you just did worked | `useToast()` | A banner that removes itself. |
| A task that must finish or be dropped first | `Dialog` | A fixed `div`. |
| "Are you sure?" before something that cannot be undone | `ConfirmDialog` | `window.confirm`. |
| Actions behind one button | `Menu` with `MenuItem`s | A `Picker`. |
| A few more words on hover | `Tip` | A `title` as the only way to learn something. |
| Work with no length to show | `Spinner`, with words beside it | A spinner alone. |

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
| Hover, toned control | The tone at 10%: `hover:bg-primary/10`, `hover:bg-destructive/10` |
| Hover, quiet text action | `text-muted-foreground hover:text-foreground` |
| Hover, link in prose | `underline underline-offset-2` always; links are not marked by colour alone |
| Focus (keyboard) | The global ring: 2px, the text colour, 2px off the control. A field's ring sits on its edge. |
| Selected, in a set | Inverted (`bg-foreground text-background`) in a `Segmented`; the brand colour and a 2px bar in `Tabs` and `NavItem` |
| Disabled | `disabled:opacity-45 disabled:cursor-not-allowed`, and say why nearby when it is not obvious |
| Busy | `aria-busy`, the control disabled, its label saying what is happening ("Saving") |
| Refused field | `aria-invalid`, a red edge, and the `Field`'s error under it |

Never write `outline-none` without a `focus-visible:` replacement drawn with the ring tokens.

## Layout and responsiveness

- **The shell** is a 220px sidebar and a main column. Under `md` (768px) the sidebar becomes a top bar with a menu.
  Banners sit above the page, outside its scroller. `main` is the page's only scroller.
- **Breakpoints** are Tailwind's: write mobile first and add `md:` for the desktop layout. `max-sm:` tightens a
  phone. `short:` is for a viewport under 500px tall (a phone on its side). Do not add a breakpoint.
- **Widths.** A page of forms or text is `max-w-page`; a page of data is `max-w-page-wide`. A line of prose is at
  most `max-w-prose`.
- A page works at 390px wide with no sideways scroll. A wide table scrolls inside its own panel.

## Accessibility

These hold for every change. The primitives already do them; keep them when you compose.

- Text passes 4.5:1 and a field's edge and the focus ring pass 3:1, in both themes. The test measures every pair in
  `src/design/tokens.ts`. Add a pair there when you put a text token on a new surface.
- Everything works from the keyboard, in reading order, with a visible focus ring.
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
| `src/lib/utils.test.ts` | `cn()` knows the console's scales, so `text-body text-primary-text` keeps both classes. |
| `src/components/ui/primitives.test.tsx` | Each primitive's keyboard and screen-reader contract, and that every design-system story renders in both themes. |

After a change to a token, also look: `npm run storybook`, then "Design system / Foundations / Contrast".
