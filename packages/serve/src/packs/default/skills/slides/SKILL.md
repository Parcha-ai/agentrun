---
name: slides
description: Build the run's deck as one self-contained slides.html - a fixed viewport per slide, keyboard and touch navigation, a deliberate visual style, and sourced content. Load it right before writing a slide deck.
---

# Slides

Build the run's deck as **one self-contained HTML file, `slides.html`**: inline CSS and JavaScript, no build step, no
package install, nothing to run. Web fonts from a font service are the only outside request. The file opens in any
browser and presents itself.

Adapted from frontend-slides by Zara Zhang (https://github.com/zarazhangrui/frontend-slides), MIT License; the license
is in `LICENSE.txt` beside this file. Changed for a run that works on its own: no interview and no preview round, no
file conversion, and sources on the slides.

## 1. Plan the deck from the brief

Decide these from the run's brief and research before writing any HTML; ask only if the run lets you ask and the brief
truly leaves one open.

- **Purpose and audience**: a pitch, a briefing, a teaching deck, a findings readout.
- **Length**: short (5 to 10 slides), medium (10 to 20) or long (20 or more), from how much the content needs.
- **Density**: *speaker-led* (one idea per slide, large type, one to three bullets, more slides) when someone presents
  it; *reading-first* (self-contained slides, tables and annotated grids, four to eight bullets) when it is read
  without a presenter. A deck built from the run's research is reading-first unless the brief says otherwise.
- **Outline**: one line per slide (title, one per section, content slides, a closing slide, a Sources slide), each
  content slide stating its point as its title.

## 2. Choose a style, on purpose

Pick one style that suits the purpose and the mood, and commit to it: its fonts, its palette, one signature device.
Never fall back on a default look (a system or Inter-style sans on a grey-white page, purple on white, every slide a
centered stack of identical cards). Use a preset below, or design your own with the same discipline: a display font
with character, a body font that reads at a distance, a dominant colour with one sharp accent, and CSS variables so the
theme lives in one place.

| Preset | Mood, best for | Fonts (display / body) | Palette |
|---|---|---|---|
| Bold Signal | Confident, high impact; pitches, keynotes | Archivo Black / Space Grotesk | `#1a1a1a` ground, `#FF5722` card, white text |
| Electric Studio | Clean, high contrast; professional decks | Manrope 800 / Manrope | `#0a0a0a`, `#ffffff`, `#4361ee` accent |
| Creative Voltage | Energetic, retro-modern; creative pitches | Syne / Space Mono | `#0066ff`, `#1a1a2e`, `#d4ff00` neon |
| Dark Botanical | Elegant, premium | Cormorant / IBM Plex Sans | `#0f0f0f`, `#e8e4df` text, `#d4a574` and `#c9b896` accents |
| Notebook Tabs | Editorial, organized; reports, reviews | Bodoni Moda / DM Sans | `#f8f6f1` page on `#2d2d2d`, pastel section tabs |
| Pastel Geometry | Friendly, approachable; product overviews | Plus Jakarta Sans 800 / 400 | `#c8d9e6` ground, `#faf9f7` card, pastel pills |
| Swiss Modern | Minimal, precise; corporate, data | a neo-grotesk display / the same at 400 | white, black, one red or blue accent on a strict grid |
| Paper and Ink | Literary, thoughtful; storytelling | a high-contrast serif / a book serif | warm off-white, near-black ink, one muted accent |

Use abstract shapes, gradients and type for decoration; no clip-art or illustrations.

## 3. Every slide fits the viewport

Each slide is exactly one viewport tall and never scrolls. Content that does not fit becomes another slide; it is never
shrunk below a readable size.

| Slide type | At most |
|---|---|
| Title | one heading, one subtitle, an optional line |
| Content | one heading and four to six bullets, or one heading and two short paragraphs |
| Grid | one heading and six cards (2×3 or 3×2) |
| Table | one heading and about seven rows of four or five columns |
| Quote | one quote of up to three lines, and its attribution |
| Image or chart | one heading and one visual, at most about 60% of the viewport's height |

Include this base in every deck:

```css
html, body { height: 100%; margin: 0; overflow-x: hidden; }
html { scroll-snap-type: y mandatory; scroll-behavior: smooth; }
.slide { width: 100vw; height: 100vh; height: 100dvh; overflow: hidden; scroll-snap-align: start;
         display: flex; flex-direction: column; position: relative; box-sizing: border-box; padding: var(--slide-padding); }
.slide-content { flex: 1; display: flex; flex-direction: column; justify-content: center; max-height: 100%; overflow: hidden; }
:root {
  --title-size: clamp(1.5rem, 5vw, 4rem);   --h2-size: clamp(1.25rem, 3.5vw, 2.5rem);
  --body-size: clamp(0.75rem, 1.5vw, 1.125rem); --small-size: clamp(0.65rem, 1vw, 0.875rem);
  --slide-padding: clamp(1rem, 4vw, 4rem);  --content-gap: clamp(0.5rem, 2vw, 2rem);
}
img, .visual { max-width: 100%; max-height: min(55vh, 480px); object-fit: contain; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: var(--content-gap); }
@media (max-height: 700px) { :root { --slide-padding: clamp(0.75rem, 3vw, 2rem); --title-size: clamp(1.25rem, 4.5vw, 2.5rem); } }
@media (max-height: 500px) { :root { --slide-padding: clamp(0.4rem, 2vw, 1rem); --body-size: clamp(0.65rem, 1vw, 0.85rem); } }
@media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } html { scroll-behavior: auto; } }
```

Rules that keep slides inside the viewport:

- Every font size and spacing value uses `clamp()` or viewport units; no fixed pixel height on content.
- Containers carry a `max-height`; images and charts a height cap.
- To negate a CSS function, write `calc(-1 * clamp(...))`; a bare `-clamp(...)` is silently ignored.
- **Bullets with custom markers stay in normal flow.** Never make an `li` a grid or flex container: every child (the
  marker, each text run, each `<strong>`) becomes its own item and the text wraps into the marker's column. Give the
  `li` `position: relative; padding-left: 1.6em` and its `::before` marker `position: absolute; left: 0; top: 0`.

## 4. The file

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Deck title</title>
  <link rel="stylesheet" href="(the style's web fonts)">
  <style>/* theme variables, the base above, the style's own rules, .reveal and the navigation */</style>
</head>
<body>
  <div class="progress" aria-hidden="true"></div>
  <nav class="nav-dots" aria-label="Slides"></nav>
  <main>
    <section class="slide" aria-label="Title"><div class="slide-content">
      <h1 class="reveal">The deck's finding, as a title</h1>
      <p class="reveal">Subtitle, date</p>
    </div></section>
    <!-- one <section class="slide"> per slide -->
  </main>
  <script>/* the controller below */</script>
</body>
</html>
```

Comment each block of CSS and script with what it does and how to change it.

## 5. Navigation and motion

Every deck with more than one slide ships keyboard navigation, touch and wheel scrolling (the scroll snap gives these),
navigation dots, a progress bar and reveal-on-view. The slide in view is the single truth about which slide is current:
keys and dots only scroll, and one observer marks the current slide.

```js
const slides = [...document.querySelectorAll('.slide')];
const nav = document.querySelector('.nav-dots');
const bar = document.querySelector('.progress');
let current = 0;
const go = (i) => slides[Math.max(0, Math.min(slides.length - 1, i))].scrollIntoView({ behavior: 'smooth' });
const dots = slides.map((slide, i) => {
  const dot = document.createElement('button');
  dot.type = 'button'; dot.className = 'nav-dot'; dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
  dot.addEventListener('click', () => go(i));
  nav.appendChild(dot);
  return dot;
});
const mark = (i) => {
  current = i;
  dots.forEach((dot, j) => { dot.classList.toggle('is-current', j === i); j === i ? dot.setAttribute('aria-current', 'true') : dot.removeAttribute('aria-current'); });
  bar.style.width = `${((i + 1) / slides.length) * 100}%`;
};
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) e.target.classList.add('visible');
  const top = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (top) mark(slides.indexOf(top.target));
}, { threshold: [0.25, 0.5, 0.75] });
slides.forEach((slide) => observer.observe(slide));
document.addEventListener('keydown', (e) => {
  if (['ArrowDown', 'ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(current + 1); }
  if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(current - 1); }
  if (e.key === 'Home') { e.preventDefault(); go(0); }
  if (e.key === 'End') { e.preventDefault(); go(slides.length - 1); }
});
mark(0);
```

Style the dots with their own contrast, not the deck's accent, so they read on any slide: a light fill inside a dark
ring (`background: rgba(255,255,255,.55); box-shadow: 0 0 0 1.5px rgba(0,0,0,.6)`), a stronger fill and ring for
`.is-current`, and a visible `:focus-visible` outline. Fix the dots to one edge, vertically centered.

Motion: `.reveal` elements start at `opacity: 0; transform: translateY(24px)` and ease in when their slide gets
`.visible`, staggered by `transition-delay` (0.1s steps). Spend motion on a few moments, not every element. Optional
touches that fit a style (a counter that counts up, a soft parallax background) come after the deck works, and never
at the cost of the reduced-motion rule.

## 6. Content and sources

- The title slide states the deck's finding; every content slide's title states its point.
- Every figure, date and named fact on a slide comes from the run's research and carries its source: a short linked
  source line at the foot of the slide (`Source: [Publication, date](url)`), small but readable.
- The last slide is **Sources**: every source the deck cites, one linked line each.
- A chart is drawn with inline SVG or a canvas from the sourced numbers, with its units and source; never invent
  values to complete a series.
- Keep text short: one or two lines per bullet. Split a slide before you shrink it.

## Before you finish

- [ ] `slides.html` opens with no build and no install; its only outside requests are web fonts.
- [ ] One `.nav-dot` per `.slide` (count them), the current dot follows scrolling, the arrow keys and the dots.
- [ ] No slide scrolls or overflows at 1280×720, at 1920×1080 and at a phone size; dense slides were split.
- [ ] One committed style: its fonts, its palette, its signature device, no default look.
- [ ] Every figure on a slide is sourced, and the Sources slide lists them.
- [ ] Reduced motion is honored, the dots are keyboard-focusable, and the slides are `<section>` elements in `<main>`.
